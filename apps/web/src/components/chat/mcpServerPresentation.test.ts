import { expect, it } from "vite-plus/test";
import type { McpServerStatusEntry } from "@starkfuture/contracts";
import {
  isLocalMcpDesktopTarget,
  mcpConnectionSummary,
  mcpDisplayText,
  MCP_SOURCE_LABELS,
  safeMcpBrowserTarget,
} from "./mcpServerPresentation";
it("opens only safe system-browser URLs and never trusts a remote or phone UI as the desktop host", () => {
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://example.com/oauth",
    "https://user:pass@example.com/oauth",
  ])
    expect(safeMcpBrowserTarget(url)).toBeNull();
  expect(safeMcpBrowserTarget("https://auth.example.com/oauth?state=private")).toEqual({
    url: "https://auth.example.com/oauth?state=private",
    host: "auth.example.com",
  });
  expect(safeMcpBrowserTarget("http://localhost:3000/callback")?.host).toBe("localhost:3000");
  expect(
    isLocalMcpDesktopTarget(true, {
      _tag: "PrimaryConnectionTarget",
      httpBaseUrl: "http://localhost:5733",
    }),
  ).toBe(true);
  expect(
    isLocalMcpDesktopTarget(false, {
      _tag: "PrimaryConnectionTarget",
      httpBaseUrl: "http://localhost:5733",
    }),
  ).toBe(false);
  expect(
    isLocalMcpDesktopTarget(true, {
      _tag: "RelayConnectionTarget",
      httpBaseUrl: "http://localhost:5733",
    }),
  ).toBe(false);
});
it("redacts callback credentials and renders all sources/status summaries as text", () => {
  expect(mcpDisplayText("\x1b[31mFailed\x1b[0m https://localhost/?code=secret&state=private")).toBe(
    "Failed https://localhost/?code=[redacted]&state=[redacted]",
  );
  expect(Object.keys(MCP_SOURCE_LABELS)).toHaveLength(11);
  expect(MCP_SOURCE_LABELS.claudeai).toBe("claude.ai");
  expect(
    mcpConnectionSummary([
      { status: "connected" },
      { status: "connecting" },
      { status: "needs-auth" },
    ] as McpServerStatusEntry[]),
  ).toEqual({ connected: 1, warning: true });
});
