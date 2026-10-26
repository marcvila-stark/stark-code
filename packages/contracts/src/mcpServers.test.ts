import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ThreadId, ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  McpServersListInput,
  McpServersReloadInput,
  McpServerStatusEntry,
  mcpAuthorizationHost,
  isExpectedMcpCallback,
} from "./mcpServers.ts";
const decodeStatus = Schema.decodeUnknownSync(McpServerStatusEntry);

describe("MCP control contracts", () => {
  it("requires a single reload target and a boolean force choice", () => {
    const decode = Schema.decodeUnknownSync(McpServersReloadInput);
    expect(decode({ threadId: "thread" })).toEqual({ threadId: "thread" });
    expect(
      decode({ providerInstanceId: "claudeAgent", projectId: "project", force: true }),
    ).toEqual({ providerInstanceId: "claudeAgent", projectId: "project", force: true });
    for (const input of [
      {},
      { projectId: "project" },
      { threadId: "thread", providerInstanceId: "claudeAgent", projectId: "project" },
      { threadId: "thread", force: "yes" },
    ])
      expect(() => decode(input)).toThrow();
  });
  it("requires one unambiguous thread or project target", () => {
    const decode = Schema.decodeUnknownSync(McpServersListInput);
    expect(decode({ threadId: ThreadId.make("thread") })).toEqual({ threadId: "thread" });
    expect(
      decode({
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        projectId: ProjectId.make("project"),
      }),
    ).toEqual({ providerInstanceId: "claudeAgent", projectId: "project" });
    for (const input of [
      {},
      { projectId: "project" },
      { threadId: "thread", projectId: "project" },
    ])
      expect(() => decode(input)).toThrow();
  });
  it.each([
    "javascript:alert(1)",
    "file:///tmp/code",
    "http://example.com/login",
    "https://user:password@example.com",
    "https://example.com/\nlogin",
  ])("refuses unsafe browser address %s", (value) =>
    expect(mcpAuthorizationHost(value)).toBeNull(),
  );
  it.each([
    "https://example.com/oauth",
    "http://localhost:8000/callback",
    "http://127.0.0.1:8000/callback",
  ])("allows system-browser address %s", (value) =>
    expect(mcpAuthorizationHost(value)).not.toBeNull(),
  );
  it("binds pasted callbacks to the pending state, exact port, and loopback host", () => {
    const pending = {
      state: "opaque-state",
      callbackPort: 48391,
      redirectScheme: "localhost" as const,
    };
    expect(
      isExpectedMcpCallback(
        "http://localhost:48391/callback?code=secret&state=opaque-state",
        pending,
      ),
    ).toBe(true);
    for (const value of [
      "http://localhost:48391/callback?code=secret&state=wrong",
      "http://localhost:48392/callback?code=secret&state=opaque-state",
      "https://evil.test:48391/callback?code=secret&state=opaque-state",
      "http://localhost:48391/callback?state=opaque-state",
    ])
      expect(isExpectedMcpCallback(value, pending)).toBe(false);
    expect(
      isExpectedMcpCallback("http://localhost:48391/callback?code=secret&state=opaque-state", {
        ...pending,
        redirectScheme: "custom",
      }),
    ).toBe(false);
  });
  it("decodes status and MCP tool annotation badges", () => {
    const row = {
      name: "stark-code",
      source: "dynamic",
      status: "connected",
      tools: [{ name: "read_page", readOnly: true, destructive: false, openWorld: false }],
      authKind: "none",
      locked: true,
    };
    expect(decodeStatus(row)).toEqual(row);
  });
});
