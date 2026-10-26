import { assert, describe, it } from "@effect/vitest";
import {
  claudeMcpStatusEntry,
  codexMcpStatusEntry,
  decodeMcpSignInStart,
  requireUnlockedMcpServer,
} from "./McpServerControls.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

describe("provider MCP controls", () => {
  it("maps Claude pending/auth and locks the application server", () => {
    assert.equal(
      claudeMcpStatusEntry({ name: "stdio", status: "pending", source: "project" }).status,
      "connecting",
    );
    const row = claudeMcpStatusEntry({
      name: "connector",
      status: "needs-auth",
      source: "claudeai",
      tools: [{ name: "read", annotations: { readOnly: true } }],
    });
    assert.equal(row.authKind, "oauth");
    assert.equal(row.source, "claudeai");
    assert.isTrue(row.tools[0]?.readOnly);
    assert.isTrue(
      claudeMcpStatusEntry({ name: "stark-code", status: "connected", source: "dynamic" }).locked,
    );
    assert.equal(
      claudeMcpStatusEntry({
        name: "plugin:stark-pages:pages",
        status: "connected",
        source: "plugin",
      }).pluginName,
      "stark-pages",
    );
  });
  it("keeps localhost OAuth state and port without inventing a redirect", () => {
    assert.deepEqual(
      decodeMcpSignInStart({
        authUrl: "https://provider.test/oauth",
        callbackExpected: true,
        redirectScheme: "localhost",
        state: "expected",
        callbackPort: 1234,
      }),
      {
        url: "https://provider.test/oauth",
        callbackExpected: true,
        redirectScheme: "localhost",
        state: "expected",
        callbackPort: 1234,
      },
    );
  });
  it("exposes only HTTP endpoint hostnames without URL secrets for either provider", () => {
    const url =
      "https://username:secret@MCP.Example.test:8443/private/customer?token=secret#fragment";
    const claude = claudeMcpStatusEntry({
      name: "private",
      status: "failed",
      config: { type: "http", url, headers: { Authorization: "Bearer secret" } },
    });
    const codex = codexMcpStatusEntry({
      name: "private",
      authStatus: "unsupported",
      httpOrigin: url,
      tools: {},
      resources: [],
      resourceTemplates: [],
    });
    for (const row of [claude, codex]) {
      assert.equal(row.endpointHost, "mcp.example.test");
      assert.notInclude(JSON.stringify(row), "secret");
      assert.notInclude(JSON.stringify(row), "customer");
      assert.notInclude(JSON.stringify(row), "8443");
    }
    assert.equal(
      claudeMcpStatusEntry({
        name: "local",
        status: "failed",
        config: { type: "sse", url: "http://[::1]:8080/mcp" },
      }).endpointHost,
      "::1",
    );
  });
  it.each([
    "not a URL",
    "file:///private/token",
    "data:text/plain,secret",
    "ssh://private.test/path",
  ])("omits unusable endpoint metadata: %s", (url) => {
    assert.isUndefined(
      claudeMcpStatusEntry({
        name: "private",
        status: "failed",
        config: { type: "http", url },
      }).endpointHost,
    );
    assert.isUndefined(
      codexMcpStatusEntry({
        name: "private",
        authStatus: "unsupported",
        httpOrigin: url,
        tools: {},
        resources: [],
        resourceTemplates: [],
      }).endpointHost,
    );
  });
  it("maps Codex statuses and older live servers with tools but no runtimeStatus", () => {
    const base = {
      name: "local",
      authStatus: "unsupported" as const,
      resources: [],
      resourceTemplates: [],
      tools: { read: { name: "read", inputSchema: {}, annotations: { readOnlyHint: true } } },
    };
    assert.equal(codexMcpStatusEntry(base).status, "connected");
    assert.equal(
      codexMcpStatusEntry({ ...base, runtimeStatus: null, toolsError: "Could not list tools" })
        .status,
      "failed",
    );
    assert.equal(
      codexMcpStatusEntry({ ...base, runtimeStatus: "authenticationRequired" }).status,
      "needs-auth",
    );
    assert.equal(codexMcpStatusEntry({ ...base, runtimeStatus: "disabled" }).status, "disabled");
    assert.equal(
      codexMcpStatusEntry({ ...base, runtimeStatus: "disabled", authStatus: "notLoggedIn" }).status,
      "disabled",
    );
    assert.isTrue(codexMcpStatusEntry(base).tools[0]?.readOnly);
  });
  it.effect("refuses direct attempts to control the app's server", () =>
    Effect.gen(function* () {
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(requireUnlockedMcpServer("codex", "stark-code"))),
      );
    }),
  );
});
