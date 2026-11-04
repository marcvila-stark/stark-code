import * as Schema from "effect/Schema";
import { ProviderSessionId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderActivePermissionSettings, ProviderPermissionSettings } from "./providerPolicy.ts";

export const ReadPermissionRulesInput = Schema.Struct({ threadId: ThreadId });
export type ReadPermissionRulesInput = typeof ReadPermissionRulesInput.Type;
export const ForgetPermissionRuleInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  ruleId: TrimmedNonEmptyString,
});
export type ForgetPermissionRuleInput = typeof ForgetPermissionRuleInput.Type;
export const SavedPermissionRuleFile = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  provider: Schema.Literals(["claudeAgent", "codex"]),
  scope: Schema.Literals(["project", "worktree", "user"]),
  path: TrimmedNonEmptyString,
  exists: Schema.Boolean,
  rules: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, text: TrimmedNonEmptyString })),
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type SavedPermissionRuleFile = typeof SavedPermissionRuleFile.Type;
export const ReadPermissionRulesResult = Schema.Struct({
  files: Schema.Array(SavedPermissionRuleFile),
});
export type ReadPermissionRulesResult = typeof ReadPermissionRulesResult.Type;
export class PermissionRulesError extends Schema.TaggedError<PermissionRulesError>()(
  "PermissionRulesError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Where an effective-permission row's value comes from. `unknown` means the
 * provider does not report it; the row says so instead of guessing.
 */
export const EffectivePermissionOrigin = Schema.Literals([
  "chat",
  "provider-session",
  "managed",
  "user",
  "project",
  "local",
  "codex-config",
  "requirements",
  "stark-policy",
  "unknown",
]);
export type EffectivePermissionOrigin = typeof EffectivePermissionOrigin.Type;

/**
 * One row of a chat's permission inspector:
 * - requested: what the next launch or turn sends;
 * - active: what the provider reported for the live session;
 * - configured: what the provider's configuration resolves to (not proof);
 * - stark-policy: a rule Stark keeps on top of the provider's.
 */
export const EffectivePermissionRow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["requested", "active", "configured", "stark-policy"]),
  label: TrimmedNonEmptyString,
  value: TrimmedNonEmptyString,
  /** The value in the provider's own words, such as `acceptEdits` or `untrusted`. */
  nativeValue: Schema.optional(TrimmedNonEmptyString),
  origin: EffectivePermissionOrigin,
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type EffectivePermissionRow = typeof EffectivePermissionRow.Type;

export const ReadEffectivePermissionsInput = Schema.Struct({ threadId: ThreadId });
export type ReadEffectivePermissionsInput = typeof ReadEffectivePermissionsInput.Type;

/**
 * A chat's permissions as requested, as the provider last reported them for
 * its live session, and as its configuration would resolve them. Observations
 * belong to one provider instance, cwd and session.
 */
export const EffectivePermissions = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  cwd: Schema.NullOr(TrimmedNonEmptyString),
  providerSessionId: Schema.NullOr(ProviderSessionId),
  requested: ProviderPermissionSettings,
  /** Null until the provider reports settings for a live session. */
  active: Schema.NullOr(ProviderActivePermissionSettings),
  /** Null when the provider cannot report its configuration. */
  configured: Schema.NullOr(ProviderPermissionSettings),
  rows: Schema.Array(EffectivePermissionRow),
});
export type EffectivePermissions = typeof EffectivePermissions.Type;
