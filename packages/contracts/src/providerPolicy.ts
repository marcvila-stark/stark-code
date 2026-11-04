import BRAND from "../../../stark.brand.json" with { type: "json" };
import {
  ChatImageAttachment,
  ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./chatAttachment.ts";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;

export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = BRAND.requireApprovalsByDefault
  ? "approval-required"
  : "full-access";

/**
 * Where a chat's permissions come from. `inherit` sends no permission settings,
 * so the provider applies its own configuration; `override` sends the stored
 * Stark preset every launch or turn. Every record written before this field
 * existed, and every record that omits it, is `override`: a missing value must
 * never widen what a saved chat runs with.
 */
export const PermissionSource = Schema.Literals(["inherit", "override"]);
export type PermissionSource = typeof PermissionSource.Type;
const DEFAULT_PERMISSION_SOURCE: PermissionSource = "override";

/** The permission source of a record, treating a missing value as `override`. */
export const permissionSourceOf = (record: {
  readonly permissionSource?: PermissionSource | undefined;
}): PermissionSource => record.permissionSource ?? DEFAULT_PERMISSION_SOURCE;

export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

/**
 * A chat's permission settings in the provider's terms, as one of three
 * observers sees them:
 * - requested: what the next launch or turn sends (or omits, for `inherit`);
 * - active: what the provider reported for the live session;
 * - configured: what the provider's configuration resolves to for the next
 *   launch. Configuration is never proof of what is running.
 */
export const ProviderPermissionSettings = Schema.Struct({
  permissionSource: PermissionSource,
  /** The Stark preset, for `override`; for `inherit`, the preset used if inheriting is refused. */
  preset: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  /** Claude's `permissionMode` or Codex's approval policy, in the provider's words. */
  nativeMode: Schema.optional(TrimmedNonEmptyString),
  approvalsReviewer: Schema.optional(TrimmedNonEmptyString),
  sandbox: Schema.optional(TrimmedNonEmptyString),
  permissionProfile: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderPermissionSettings = typeof ProviderPermissionSettings.Type;

/** Which provider message reported a live session's permission settings. */
export const ProviderActivePermissionReport = Schema.Literals([
  "session-init",
  "session-status",
  "thread-start",
  "thread-resume",
  "thread-fork",
  "settings-updated",
  "approved-session-update",
]);
export type ProviderActivePermissionReport = typeof ProviderActivePermissionReport.Type;

/**
 * What a provider reported for one live session. The session it belongs to
 * names the provider instance and cwd; a new session starts with none.
 */
export const ProviderActivePermissionSettings = Schema.Struct({
  nativeMode: Schema.optional(TrimmedNonEmptyString),
  interactionMode: Schema.optional(ProviderInteractionMode),
  approvalsReviewer: Schema.optional(TrimmedNonEmptyString),
  sandbox: Schema.optional(TrimmedNonEmptyString),
  permissionProfile: Schema.optional(TrimmedNonEmptyString),
  reportedBy: ProviderActivePermissionReport,
  /** ISO timestamp of the provider's report. */
  reportedAt: TrimmedNonEmptyString,
});
export type ProviderActivePermissionSettings = typeof ProviderActivePermissionSettings.Type;

export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;

export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;

export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;

/** How long an approval answer lasts. `persistent` writes a rule the provider keeps. */
export const ProviderApprovalScope = Schema.Literals(["once", "turn", "session", "persistent"]);
export type ProviderApprovalScope = typeof ProviderApprovalScope.Type;

/** What an approval answer does. `deny_and_stop` also ends the agent's current work. */
export const ProviderApprovalEffect = Schema.Literals(["allow", "deny", "deny_and_stop"]);
export type ProviderApprovalEffect = typeof ProviderApprovalEffect.Type;

/** Where a persistent answer is written. */
export const ProviderApprovalPersistTarget = Schema.Literals([
  "claude-local-settings",
  "codex-rules",
  "codex-network-rules",
  "mcp-always",
]);
export type ProviderApprovalPersistTarget = typeof ProviderApprovalPersistTarget.Type;

/**
 * The class half of an option id. Answering any `persistent` option changes the
 * provider's saved configuration, so it needs the settings-write scope.
 */
export const ProviderApprovalOptionClass = Schema.Literals([
  "once",
  "turn",
  "session",
  "persistent",
  "deny",
  "deny-stop",
]);
export type ProviderApprovalOptionClass = typeof ProviderApprovalOptionClass.Type;

const APPROVAL_OPTION_ID_PATTERN =
  /^(once|turn|session|persistent|deny|deny-stop):(0|[1-9]\d{0,3})$/;

/**
 * A server-issued approval option id, `<class>:<n>`. The adapter that offered
 * the option maps the id to one exact native response; clients only echo it.
 */
export const ProviderApprovalOptionId = TrimmedNonEmptyString.check(
  Schema.isPattern(APPROVAL_OPTION_ID_PATTERN),
);
export type ProviderApprovalOptionId = typeof ProviderApprovalOptionId.Type;

/** Most characters of a reason a user may send with a denial. */
export const PROVIDER_APPROVAL_FEEDBACK_MAX_LENGTH = 2_000;
/** A reason the user typed for the agent, sent only with options that accept one. */
export const ProviderApprovalFeedback = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_APPROVAL_FEEDBACK_MAX_LENGTH),
);
export type ProviderApprovalFeedback = typeof ProviderApprovalFeedback.Type;

export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  /** Provider-supplied caution shown next to the option, such as a prompt injection warning. */
  warning: Schema.optional(TrimmedNonEmptyString),
  /** Exact narrow rules the provider will persist after an explicit user choice. */
  rulePreview: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** One line saying what this choice grants, shown as muted text under the label. */
  detail: Schema.optional(TrimmedNonEmptyString),
  /**
   * Server-issued id bound to one exact native response. Options from older
   * servers have none; clients then answer with `decision` alone.
   */
  optionId: Schema.optional(ProviderApprovalOptionId),
  scope: Schema.optional(ProviderApprovalScope),
  effect: Schema.optional(ProviderApprovalEffect),
  persistsTo: Schema.optional(ProviderApprovalPersistTarget),
  /** The option sends a reason the user types along with the answer. */
  acceptsFeedback: Schema.optional(Schema.Boolean),
  /**
   * The exact native response this option sends, such as Claude's
   * `PermissionUpdate[]` or a Codex decision with its amendment. Recorded on
   * the request when chosen, so the audit shows what the provider received.
   */
  nativePayload: Schema.optional(Schema.Unknown),
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;

/** The class an option id carries, derived from how long it lasts and what it does. */
export function approvalOptionClass(
  option: Pick<ProviderApprovalOption, "decision" | "scope" | "effect">,
): ProviderApprovalOptionClass {
  if (option.scope === "persistent" || option.decision === "acceptAlways") return "persistent";
  const effect =
    option.effect ??
    (option.decision === "decline"
      ? "deny"
      : option.decision === "cancel"
        ? "deny_and_stop"
        : "allow");
  if (effect === "deny") return "deny";
  if (effect === "deny_and_stop") return "deny-stop";
  return option.scope ?? (option.decision === "acceptForSession" ? "session" : "once");
}

/** The class part of an option id, or undefined for a malformed id. */
export function approvalOptionIdClass(optionId: string): ProviderApprovalOptionClass | undefined {
  const match = APPROVAL_OPTION_ID_PATTERN.exec(optionId);
  return match === null ? undefined : (match[1] as ProviderApprovalOptionClass);
}

/**
 * Gives every option its server-issued id, numbering options of the same class
 * in order. An id an adapter already assigned is kept only when its class
 * matches, so an id can never claim a narrower class than its option.
 */
export function withApprovalOptionIds(
  options: ReadonlyArray<ProviderApprovalOption>,
): ReadonlyArray<ProviderApprovalOption> {
  const counts = new Map<ProviderApprovalOptionClass, number>();
  return options.map((option) => {
    const optionClass = approvalOptionClass(option);
    const index = counts.get(optionClass) ?? 0;
    counts.set(optionClass, index + 1);
    if (option.optionId !== undefined && approvalOptionIdClass(option.optionId) === optionClass) {
      return option;
    }
    return { ...option, optionId: `${optionClass}:${index}` };
  });
}

/**
 * The answer recorded on a runtime request: the option the user chose, the
 * exact native response it maps to, and any reason they typed.
 */
export const ProviderApprovalChoice = Schema.Struct({
  optionId: Schema.optional(ProviderApprovalOptionId),
  decision: ProviderApprovalDecision,
  scope: Schema.optional(ProviderApprovalScope),
  effect: Schema.optional(ProviderApprovalEffect),
  persistsTo: Schema.optional(ProviderApprovalPersistTarget),
  nativePayload: Schema.optional(Schema.Unknown),
  feedback: Schema.optional(ProviderApprovalFeedback),
});
export type ProviderApprovalChoice = typeof ProviderApprovalChoice.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const UserInputAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])).pipe(
    Schema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
);
export type UserInputAttachments = typeof UserInputAttachments.Type;

export const UserInputAttachmentAnswerPayload = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments,
});
export type UserInputAttachmentAnswerPayload = typeof UserInputAttachmentAnswerPayload.Type;
