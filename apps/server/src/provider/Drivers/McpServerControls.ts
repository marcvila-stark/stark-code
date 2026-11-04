// @effect-diagnostics nodeBuiltinImport:off -- provider CLI fallback uses argv, never a shell
import * as NodeChildProcess from "node:child_process";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import {
  McpServerSignInStart,
  ServerProviderMcpSource,
  type McpServerStatusEntry,
  ProviderDriverKind,
} from "@starkfuture/contracts";
import * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { cleanHookText } from "./ClaudeHookEvents.ts";
import type * as CodexSchema from "effect-codex-app-server/schema";

export const mcpControlError = (provider: string, method: string) =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: ProviderDriverKind.make(provider),
    detail: `Could not ${method} the MCP server. Check the provider's MCP configuration and retry.`,
  });
export const requireUnlockedMcpServer = (provider: string, name: string) =>
  name === "stark-code"
    ? Effect.fail(
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: ProviderDriverKind.make(provider),
          detail: "Stark Code's application server is locked.",
        }),
      )
    : Effect.void;
const clean = (value: string) => cleanHookText(value, 2048);
const isMcpSource = Schema.is(ServerProviderMcpSource);
const decodeSignIn = Schema.decodeUnknownSync(McpServerSignInStart);

const mcpEndpointHost = (value: string | null | undefined): string | undefined => {
  if (value === undefined || value === null) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    // Hosts are enough for network diagnostics. Never retain credentials or
    // private paths, and omit IPv6 URL brackets for address lookup.
    return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  } catch {
    return undefined;
  }
};

export function claudeMcpStatusEntry(value: McpServerStatus): McpServerStatusEntry {
  const source = isMcpSource(value.source) ? value.source : undefined;
  const config = value.config;
  const endpointHost = mcpEndpointHost(
    config !== undefined && "url" in config ? config.url : undefined,
  );
  return {
    name: clean(value.name),
    ...(endpointHost === undefined ? {} : { endpointHost }),
    ...(source === undefined ? {} : { source }),
    ...(value.scope === undefined ? {} : { scope: clean(value.scope) }),
    status: value.status === "pending" ? "connecting" : value.status,
    ...(value.error === undefined ? {} : { error: clean(value.error) }),
    tools: (value.tools ?? []).map((tool) => ({
      name: clean(tool.name),
      ...(tool.description === undefined ? {} : { description: clean(tool.description) }),
      ...tool.annotations,
    })),
    authKind:
      source === "claudeai" || value.status === "needs-auth"
        ? "oauth"
        : config?.type === "stdio"
          ? "none"
          : "unknown",
    locked: value.name === "stark-code",
    ...(source === "plugin"
      ? {
          pluginName: value.name.startsWith("plugin:")
            ? value.name.split(":")[1] || value.name
            : value.name.split(":")[0] || value.name,
        }
      : {}),
    canSignOut: value.name !== "stark-code",
    canSubmitCallback: source !== "claudeai",
  };
}

export function codexMcpStatusEntry(
  value: CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus,
): McpServerStatusEntry {
  const endpointHost = mcpEndpointHost(value.httpOrigin);
  // The runtime can retain its initialized transport state after discovery fails.
  // An explicit toolsError is stronger evidence than that old Connected label.
  const status =
    value.runtimeStatus === "disabled"
      ? "disabled"
      : value.runtimeStatus === "authenticationRequired" || value.authStatus === "notLoggedIn"
        ? "needs-auth"
        : value.runtimeStatus === "failed" ||
            value.runtimeStatus === "cancelled" ||
            Boolean(value.toolsError)
          ? "failed"
          : value.runtimeStatus === "connected" ||
              (value.runtimeStatus == null && Object.keys(value.tools).length > 0)
            ? "connected"
            : "connecting";
  return {
    name: clean(value.name),
    ...(endpointHost === undefined ? {} : { endpointHost }),
    source: "codex",
    status,
    ...(value.toolsError ? { error: clean(value.toolsError) } : {}),
    tools: Object.values(value.tools).map((tool) => {
      const annotations: Record<string, unknown> =
        typeof tool.annotations === "object" &&
        tool.annotations !== null &&
        !Array.isArray(tool.annotations)
          ? (tool.annotations as Record<string, unknown>)
          : {};
      return {
        name: clean(tool.name),
        ...(tool.description ? { description: clean(tool.description) } : {}),
        ...(typeof annotations.readOnlyHint === "boolean"
          ? { readOnly: annotations.readOnlyHint }
          : {}),
        ...(typeof annotations.destructiveHint === "boolean"
          ? { destructive: annotations.destructiveHint }
          : {}),
        ...(typeof annotations.openWorldHint === "boolean"
          ? { openWorld: annotations.openWorldHint }
          : {}),
      };
    }),
    authKind:
      value.authStatus === "oAuth" || value.authStatus === "notLoggedIn"
        ? "oauth"
        : value.authStatus === "bearerToken"
          ? "bearer"
          : value.authStatus === "unsupported"
            ? "none"
            : "unknown",
    locked: value.name === "stark-code",
    ...(value.pluginId ? { pluginName: clean(value.pluginId) } : {}),
    canSignOut: value.authStatus === "oAuth",
    canSubmitCallback: false,
  };
}

export function decodeMcpSignInStart(value: unknown): typeof McpServerSignInStart.Type {
  if (typeof value !== "object" || value === null) throw new Error("Invalid MCP sign-in result.");
  const fields = value as Record<string, unknown>;
  return decodeSignIn({
    url: fields.authUrl,
    callbackExpected: fields.callbackExpected === true,
    ...(fields.redirectScheme === "localhost" || fields.redirectScheme === "custom"
      ? { redirectScheme: fields.redirectScheme }
      : {}),
    ...(typeof fields.state === "string" ? { state: fields.state } : {}),
    ...(typeof fields.callbackPort === "number" ? { callbackPort: fields.callbackPort } : {}),
  });
}

/** The CLI owns authentication and its credential store. Never retain or log its output. */
export function runMcpCli(input: {
  provider: "claudeAgent" | "codex";
  binary: string;
  action: "login" | "logout";
  name: string;
  cwd: string | null;
  environment: NodeJS.ProcessEnv;
}): Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error> {
  return Effect.callback<void, ProviderAdapter.ProviderAdapterV2Error>((resume) => {
    const child = NodeChildProcess.execFile(
      input.binary,
      ["mcp", input.action, input.name],
      {
        cwd: input.cwd ?? undefined,
        env: input.environment,
        timeout: 120_000,
        maxBuffer: 65_536,
        windowsHide: true,
      },
      (error) =>
        resume(
          error === null
            ? Effect.void
            : Effect.fail(
                mcpControlError(
                  input.provider,
                  input.action === "login" ? "sign in to" : "sign out of",
                ),
              ),
        ),
    );
    return Effect.sync(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
  });
}
