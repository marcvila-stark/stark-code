import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

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
