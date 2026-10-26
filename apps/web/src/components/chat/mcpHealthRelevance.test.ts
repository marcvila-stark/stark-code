import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  RunId,
  ThreadId,
  TurnItemId,
  type McpServerStatusEntry,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import { mcpConnectionLabel, relevantMcpFailures } from "./mcpHealthRelevance";

const runId = RunId.make("current");
const server = (
  name: string,
  status: McpServerStatusEntry["status"] = "failed",
): McpServerStatusEntry => ({
  name,
  status,
  tools: [],
  authKind: "oauth",
  locked: false,
});
const call = (
  toolName: string,
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
): OrchestrationV2ProjectedTurnItem => {
  const item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> = {
    type: "dynamic_tool",
    id: TurnItemId.make("call"),
    threadId: ThreadId.make("thread"),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "failed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
    toolName,
    input: {},
    ...overrides,
  };
  return {
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
};

it("keeps unused servers silent, even when the chat mentions their names", () => {
  expect(relevantMcpFailures([server("vercel")], { runId, turnItems: [] })).toEqual([]);
  expect(
    relevantMcpFailures([server("vercel")], {
      runId,
      turnItems: [call("Read", { input: { text: "vercel is down" } })],
    }),
  ).toEqual([]);
});

it.each([
  ["plugin:vercel:vercel", "mcp__plugin_vercel_vercel__deploy"],
  ["Drive", "mcp__Drive__find"],
  ["claude.ai Google Drive", "mcp__claude_ai_Google_Drive__find"],
  ["vercel", "vercel.deploy"],
])("matches %s only when its provider tool was attempted", (name, toolName) => {
  const needed = server(name, "needs-auth");
  expect(
    relevantMcpFailures([needed, server("unrelated")], { runId, turnItems: [call(toolName)] }),
  ).toEqual([needed]);
});

it("accepts the structured MCP source when the tool has no namespace", () => {
  const needed = server("Drive");
  expect(
    relevantMcpFailures([needed], {
      runId,
      turnItems: [
        call("find", {
          toolSource: { key: "mcp:drive", kind: "integration", name: "Google Drive" },
        }),
      ],
    }),
  ).toEqual([needed]);
});

it("ignores old, inherited and cancelled tool calls", () => {
  const failed = call("Drive.find");
  expect(
    relevantMcpFailures([server("Drive")], {
      runId,
      turnItems: [
        call("Drive.find", { runId: RunId.make("older") }),
        { ...failed, visibility: "inherited" },
        call("Drive.find", { status: "cancelled" }),
      ],
    }),
  ).toEqual([]);
  expect(relevantMcpFailures([server("Drive")], { runId: null, turnItems: [failed] })).toEqual([]);
});

it("clears a stale health warning after a successful retry, but retains a new failure", () => {
  const needed = server("Drive");
  const failed = call("Drive.find");
  const retry = call("Drive.find", { status: "completed", ordinal: 2 });
  expect(relevantMcpFailures([needed], { runId, turnItems: [retry, failed] })).toEqual([]);
  expect(
    relevantMcpFailures([needed], {
      runId,
      turnItems: [failed, retry, call("Drive.find", { ordinal: 3 })],
    }),
  ).toEqual([needed]);
});

it.each([
  { isError: true },
  { is_error: true },
  { error: { message: "Disconnected" } },
  { success: false },
])("keeps a completed tool's structured failure visible: %j", (output) => {
  const needed = server("Drive");
  expect(
    relevantMcpFailures([needed], {
      runId,
      turnItems: [call("Drive.find", { status: "completed", output })],
    }),
  ).toEqual([needed]);
});

it("shows an active required connection, even if another call previously succeeded", () => {
  const needed = server("Drive");
  expect(
    relevantMcpFailures([needed], {
      runId,
      turnItems: [
        call("Drive.find", { status: "running" }),
        call("Drive.list", { status: "completed", ordinal: 2 }),
      ],
    }),
  ).toEqual([needed]);
  expect(
    relevantMcpFailures([server("Drive", "connected")], { runId, turnItems: [call("Drive.find")] }),
  ).toEqual([]);
});

it("does not mistake similar server names for each other or guess normalized collisions", () => {
  const needed = server("Drive.extra");
  expect(
    relevantMcpFailures([server("Drive"), needed], {
      runId,
      turnItems: [call("Drive.extra.find")],
    }),
  ).toEqual([needed]);
  expect(
    relevantMcpFailures([server("a.b"), server("a_b")], {
      runId,
      turnItems: [call("mcp__a_b__find")],
    }),
  ).toEqual([]);
  expect(
    relevantMcpFailures([server("Drive")], { runId, turnItems: [call("Driver.find")] }),
  ).toEqual([]);
});

it("shows a readable plugin label without changing the actual connection identity", () => {
  expect(mcpConnectionLabel(server("plugin:vercel:vercel"))).toBe("Vercel");
  expect(mcpConnectionLabel(server("claude.ai Google Drive"))).toBe("Google Drive");
});

it.each([false, 0, "", "  ", null, {}, [], { message: "" }])(
  "accepts a successful retry with a non-error error field: %j",
  (error) => {
    expect(
      relevantMcpFailures([server("Drive")], {
        runId,
        turnItems: [
          call("Drive.find"),
          call("Drive.find", {
            status: "completed",
            ordinal: 2,
            output: { error },
          }),
        ],
      }),
    ).toEqual([]);
  },
);

it("does not use a normalized source key to guess between colliding Claude server names", () => {
  expect(
    relevantMcpFailures([server("a.b"), server("a_b")], {
      runId,
      turnItems: [
        call("mcp__a_b__find", {
          toolSource: { key: "mcp:a_b", kind: "integration", name: "a b" },
        }),
      ],
    }),
  ).toEqual([]);
});

it("retains an explicit case-insensitive MCP source for an unqualified tool", () => {
  const needed = server("Drive");
  expect(
    relevantMcpFailures([needed], {
      runId,
      turnItems: [
        call("find", {
          toolSource: { key: "MCP:DRIVE", kind: "integration", name: "Drive" },
        }),
      ],
    }),
  ).toEqual([needed]);
});

it("prefers an exact qualified namespace and does not guess equal case-folded names", () => {
  const needed = server("Drive.extra");
  expect(
    relevantMcpFailures([server("Drive"), needed], {
      runId,
      turnItems: [
        call("Drive.extra.find", {
          toolSource: { key: "mcp:drive", kind: "integration", name: "Drive" },
        }),
      ],
    }),
  ).toEqual([needed]);
  expect(
    relevantMcpFailures([server("Drive"), server("drive")], {
      runId,
      turnItems: [call("Drive.find")],
    }),
  ).toEqual([]);
});
