import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString, NonNegativeInt } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderMcpSource } from "./server.ts";

export const McpServerStatusEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  source: Schema.optional(Schema.Union([ServerProviderMcpSource, Schema.Literal("codex")])),
  scope: Schema.optional(TrimmedNonEmptyString),
  status: Schema.Literals(["connected", "connecting", "needs-auth", "failed", "disabled"]),
  error: Schema.optional(Schema.String),
  // Hostname only. Never expose MCP endpoint paths, credentials, or headers.
  endpointHost: Schema.optional(Schema.String),
  recovery: Schema.optional(
    Schema.Struct({
      state: Schema.Literals([
        "waiting",
        "reconnecting",
        "exhausted",
        "manual",
        "vpn-off",
        "network-unavailable",
      ]),
      attempts: NonNegativeInt,
      // A disconnected VPN is advisory until the endpoint's route dependency is known.
      vpnState: Schema.optional(Schema.Literal("forticlient-disconnected")),
    }),
  ),
  tools: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      description: Schema.optional(Schema.String),
      readOnly: Schema.optional(Schema.Boolean),
      destructive: Schema.optional(Schema.Boolean),
      openWorld: Schema.optional(Schema.Boolean),
    }),
  ),
  authKind: Schema.Literals(["oauth", "bearer", "none", "unknown"]),
  locked: Schema.Boolean,
  pluginName: Schema.optional(TrimmedNonEmptyString),
  canSignOut: Schema.optional(Schema.Boolean),
  canSubmitCallback: Schema.optional(Schema.Boolean),
});
export type McpServerStatusEntry = typeof McpServerStatusEntry.Type;

export const McpServerSignInStart = Schema.Struct({
  url: Schema.optional(TrimmedNonEmptyString),
  browserOpened: Schema.optional(Schema.Boolean),
  completed: Schema.optional(Schema.Boolean),
  callbackExpected: Schema.Boolean,
  redirectScheme: Schema.optional(Schema.Literals(["localhost", "custom"])),
  state: Schema.optional(Schema.String),
  callbackPort: Schema.optional(NonNegativeInt),
});
export type McpServerSignInStart = typeof McpServerSignInStart.Type;

const TargetFields = {
  threadId: Schema.optional(ThreadId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  projectId: Schema.optional(ProjectId),
};
const target = Schema.makeFilter(
  (input: {
    readonly threadId?: unknown;
    readonly providerInstanceId?: unknown;
    readonly projectId?: unknown;
  }) =>
    input.threadId !== undefined
      ? (input.providerInstanceId === undefined && input.projectId === undefined) ||
        "Choose a thread or a project, not both."
      : (input.providerInstanceId !== undefined && input.projectId !== undefined) ||
        "A thread or provider instance and project are required.",
);
export const McpServersListInput = Schema.Struct(TargetFields).check(target);
export type McpServersListInput = typeof McpServersListInput.Type;
export const McpServersListResult = Schema.Struct({
  servers: Schema.Array(McpServerStatusEntry),
  live: Schema.Boolean,
  canReload: Schema.optional(Schema.Boolean),
  reconnectScope: Schema.optional(Schema.Literals(["server", "all"])),
});
export type McpServersListResult = typeof McpServersListResult.Type;
export const McpServersReloadInput = Schema.Struct({
  ...TargetFields,
  force: Schema.optional(Schema.Boolean),
}).check(target);
export type McpServersReloadInput = typeof McpServersReloadInput.Type;
export const McpServersReloadResult = Schema.Struct({
  status: Schema.Literals(["reloaded", "confirmation-required"]),
  failedServers: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(2048),
  ),
  pluginErrors: Schema.optional(NonNegativeInt),
});
export type McpServersReloadResult = typeof McpServersReloadResult.Type;
export const McpServerActionInput = Schema.Struct({
  ...TargetFields,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
}).check(target);
export type McpServerActionInput = typeof McpServerActionInput.Type;
export const McpServerSetEnabledInput = Schema.Struct({
  ...TargetFields,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  enabled: Schema.Boolean,
}).check(target);
export type McpServerSetEnabledInput = typeof McpServerSetEnabledInput.Type;
export const McpServerSubmitCallbackInput = Schema.Struct({
  ...TargetFields,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
}).check(target);
export type McpServerSubmitCallbackInput = typeof McpServerSubmitCallbackInput.Type;
export class McpServerRequestError extends Schema.TaggedError<McpServerRequestError>()(
  "McpServerRequestError",
  {
    reason: Schema.Literals([
      "unavailable",
      "locked",
      "desktop_required",
      "invalid_url",
      "invalid_callback",
      "provider_error",
    ]),
    message: Schema.String,
  },
) {}

/** Only the system browser may open OAuth URLs; metadata is not trusted. */
export function mcpAuthorizationHost(value: string): string | null {
  try {
    if (value.length > 8192 || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
    const url = new URL(value);
    if (url.username || url.password) return null;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.host : null;
  } catch {
    return null;
  }
}

export function isExpectedMcpCallback(
  value: string,
  pending: Pick<McpServerSignInStart, "state" | "callbackPort" | "redirectScheme">,
): boolean {
  try {
    if (
      pending.redirectScheme !== "localhost" ||
      !pending.state ||
      pending.callbackPort === undefined ||
      !mcpAuthorizationHost(value)
    )
      return false;
    const url = new URL(value);
    return (
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()) &&
      url.port === String(pending.callbackPort) &&
      url.searchParams.getAll("state").length === 1 &&
      url.searchParams.getAll("code").length === 1 &&
      url.searchParams.get("state") === pending.state &&
      Boolean(url.searchParams.get("code"))
    );
  } catch {
    return false;
  }
}
