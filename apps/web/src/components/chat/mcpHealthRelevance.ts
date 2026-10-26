import type {
  McpServerStatusEntry,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  RunId,
} from "@starkfuture/contracts";

export type McpActivityContext = {
  runId: RunId | null;
  turnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
};

type ToolCall = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

function serverForCall(call: ToolCall, servers: ReadonlyArray<McpServerStatusEntry>) {
  const name = call.toolName?.toLowerCase();
  // These are provider namespaces, not words inferred from a reply or command.
  // A disconnected server can have an empty tool catalogue.
  const matches = name
    ? servers.filter((server) => {
        const raw = server.name.toLowerCase();
        const claude = raw.replace(/[^a-z0-9_-]/g, "_");
        return (
          name.startsWith(`mcp__${raw}__`) ||
          name.startsWith(`mcp__${claude}__`) ||
          name.startsWith(`${raw}.`) ||
          name.startsWith(`${raw}:`)
        );
      })
    : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Claude's source key is also normalized, so it cannot disambiguate these.
    // Raw Codex/colon namespaces may contain separators: prefer the longest
    // exact namespace, but never guess between equal case-folded names.
    const exactNamespaces = matches
      .filter(
        (server) =>
          name?.startsWith(`${server.name.toLowerCase()}.`) ||
          name?.startsWith(`${server.name.toLowerCase()}:`),
      )
      .toSorted((a, b) => b.name.length - a.name.length);
    const first = exactNamespaces[0];
    return first && first.name.length !== exactNamespaces[1]?.name.length ? first : undefined;
  }
  if (name?.startsWith("mcp__")) return undefined;
  // Some providers supply a raw tool name plus an explicit MCP source.
  const source = call.toolSource?.key.toLowerCase();
  const sourceMatches = source?.startsWith("mcp:")
    ? servers.filter((server) => `mcp:${server.name.toLowerCase()}` === source)
    : [];
  return sourceMatches.length === 1 ? sourceMatches[0] : undefined;
}

function failedCall(call: ToolCall) {
  if (call.status === "failed") return true;
  if (typeof call.output !== "object" || call.output === null || Array.isArray(call.output)) {
    return false;
  }
  const output = call.output;
  const error = "error" in output ? output.error : undefined;
  const reportedError =
    error === true ||
    (typeof error === "string" && error.trim().length > 0) ||
    (typeof error === "object" &&
      error !== null &&
      !Array.isArray(error) &&
      "message" in error &&
      typeof error.message === "string" &&
      error.message.trim().length > 0);
  return (
    ("isError" in output && output.isError === true) ||
    ("is_error" in output && output.is_error === true) ||
    ("success" in output && output.success === false) ||
    reportedError
  );
}

/** Only interrupt the conversation for a connection an actual tool call needs. */
export function relevantMcpFailures(
  servers: ReadonlyArray<McpServerStatusEntry>,
  { runId, turnItems }: McpActivityContext,
) {
  if (runId === null) return [];
  const activity = new Map<string, { active: boolean; failed: number; succeeded: number }>();
  for (const { item, visibility } of turnItems) {
    if (
      visibility !== "local" ||
      item.runId !== runId ||
      item.type !== "dynamic_tool" ||
      item.status === "cancelled" ||
      item.status === "interrupted"
    )
      continue;
    const server = serverForCall(item, servers);
    if (!server) continue;
    const entry = activity.get(server.name) ?? { active: false, failed: -1, succeeded: -1 };
    if (["pending", "running", "waiting"].includes(item.status)) entry.active = true;
    if (failedCall(item)) entry.failed = Math.max(entry.failed, item.ordinal);
    else if (item.status === "completed") entry.succeeded = Math.max(entry.succeeded, item.ordinal);
    activity.set(server.name, entry);
  }
  return servers.filter((server) => {
    if (server.status !== "needs-auth" && server.status !== "failed") return false;
    const call = activity.get(server.name);
    return call !== undefined && (call.active || call.failed > call.succeeded);
  });
}

export function mcpConnectionLabel(server: McpServerStatusEntry) {
  const name = server.name.startsWith("plugin:")
    ? (server.name.split(":").at(-1) ?? server.name).replace(/[_-]+/g, " ")
    : server.name.replace(/^claude\.ai /, "");
  return name.length ? name[0]!.toUpperCase() + name.slice(1) : server.name;
}
