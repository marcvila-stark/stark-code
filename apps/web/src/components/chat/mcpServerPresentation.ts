import { mcpAuthorizationHost, type McpServerStatusEntry } from "@starkfuture/contracts";
import { plainCatalogText } from "./composerSessionCatalog";

export const MCP_SOURCE_LABELS: Record<NonNullable<McpServerStatusEntry["source"]>, string> = {
  sdk: "SDK",
  plugin: "Plugin",
  user: "User",
  project: "Project",
  local: "Local",
  dynamic: "Dynamic",
  managed: "Managed",
  enterprise: "Enterprise",
  claudeai: "claude.ai",
  agent: "Agent",
  codex: "Codex config",
};
export const MCP_STATUS_LABELS: Record<McpServerStatusEntry["status"], string> = {
  connected: "Connected",
  connecting: "Connecting",
  "needs-auth": "Needs sign-in",
  failed: "Failed",
  disabled: "Disabled",
};
export function mcpDisplayText(value: string | undefined, cap = 1000) {
  return plainCatalogText(value, cap)
    .replace(/([?&](?:code|state|token|access_token|refresh_token)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/Authorization\s*:\s*[^\r\n]+/gi, "Authorization: [redacted]");
}
export function mcpConnectionSummary(servers: ReadonlyArray<McpServerStatusEntry>) {
  return {
    connected: servers.filter((server) => server.status === "connected").length,
    warning: servers.some((server) => server.status === "needs-auth" || server.status === "failed"),
  };
}
export function safeMcpBrowserTarget(value: string) {
  const host = mcpAuthorizationHost(value);
  return host ? { url: value, host } : null;
}
export function isLocalMcpDesktopTarget(
  electron: boolean,
  target: { readonly _tag: string; readonly httpBaseUrl?: string },
) {
  if (!electron || target._tag !== "PrimaryConnectionTarget" || !target.httpBaseUrl) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(target.httpBaseUrl).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}
