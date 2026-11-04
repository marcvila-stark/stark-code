import {
  approvalOptionClass,
  approvalOptionIdClass,
  type OrchestrationV2ApprovalRequestScopeFields,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2RuntimeRequestDelivery,
  type OrchestrationV2RuntimeRequestLoss,
  type OrchestrationV2TurnItem,
  PROVIDER_APPROVAL_FEEDBACK_MAX_LENGTH,
  type ProviderApprovalChoice,
  type ProviderApprovalDecision,
  type ProviderApprovalEffect,
  type ProviderApprovalOption,
  type ProviderApprovalOptionClass,
  type ProviderApprovalOptionId,
  type ProviderApprovalPersistTarget,
  type ProviderApprovalScope,
  type ProviderRequestKind,
  type RuntimeMode,
} from "@starkfuture/contracts";
import { lostRuntimeRequestLabel } from "@starkfuture/shared/orchestrationV2LostRequests";

import type { RespondToThreadApprovalInput } from "../operations/commands.ts";

/*
 * How web and mobile present an approval's choices, its recorded decision and whether the answer
 * reached the agent, from the option ids, recorded choice and delivery state the server sends.
 */

/** What an answer sends beside its decision: the chosen option's id and a typed reason. */
export type ApprovalResponseInput = Pick<RespondToThreadApprovalInput, "optionId" | "feedback">;

type ApprovalRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "approval_request" }>;
type ApprovalRequestScopeKey = keyof typeof OrchestrationV2ApprovalRequestScopeFields;

/** Who asked and what an approval reaches beyond its command or files, as the provider sent it. */
export type ApprovalRequestScope = Pick<ApprovalRequestItem, ApprovalRequestScopeKey>;

const APPROVAL_REQUEST_SCOPE_KEYS = [
  "agentId",
  "agentName",
  "blockedPath",
  "mcpServerSource",
  "defaultToNo",
  "network",
  "requestedPermissions",
  "grantRoot",
] as const satisfies ReadonlyArray<ApprovalRequestScopeKey>;

/** The request's scope fields, or undefined when the provider sent none. */
export function approvalRequestScope(
  item: Partial<ApprovalRequestScope>,
): ApprovalRequestScope | undefined {
  const scope: Record<string, unknown> = {};
  for (const key of APPROVAL_REQUEST_SCOPE_KEYS) {
    if (item[key] !== undefined) scope[key] = item[key];
  }
  return Object.keys(scope).length === 0 ? undefined : (scope as ApprovalRequestScope);
}

/** Why a client without the settings-write grant cannot pick a choice that widens permissions. */
const SETTINGS_PERMISSION_REASON = "Needs settings permission";

/**
 * Why a mode cannot be picked from this client, or undefined when it can. Anything above the
 * narrowest preset widens what runs on the environment, so it needs the settings-write grant
 * (O12); the server refuses such a save, and the editors disable the mode instead of failing.
 */
export function runtimeModeDisabledReason(
  mode: RuntimeMode,
  canWriteSettings: boolean,
): string | undefined {
  return canWriteSettings || mode === "approval-required" ? undefined : SETTINGS_PERMISSION_REASON;
}

/**
 * An explicitly empty option list: the agent offered no choices, so the server refuses every
 * answer and the request closes when the agent stops waiting. Absent (older servers) is not empty.
 */
export function approvalOffersNoChoices(
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
): boolean {
  return options !== undefined && options.length === 0;
}

/** What a card with no choices says instead of buttons. */
export const APPROVAL_NO_CHOICES = {
  title: "No choices offered",
  detail:
    "The agent offered no choices for this request, so it can't be answered. It closes when the agent stops waiting.",
} as const;

/** Older servers send no option list; these are the decisions they accept. */
const LEGACY_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "cancel", label: "Decline and stop" },
];

const OPTION_CLASSES: ReadonlyArray<ProviderApprovalOptionClass> = [
  "once",
  "turn",
  "session",
  "persistent",
  "deny",
  "deny-stop",
];

/** The option's lifetime class: from its server id, else from its scope, effect and decision. */
export function approvalChoiceClass(option: ProviderApprovalOption): ProviderApprovalOptionClass {
  return (
    (option.optionId === undefined ? undefined : approvalOptionIdClass(option.optionId)) ??
    approvalOptionClass(option)
  );
}

/** Short tag that tells once, turn, session and saved choices apart at a glance. */
const APPROVAL_LIFETIME_TAG: Record<ProviderApprovalOptionClass, string> = {
  once: "Once",
  turn: "This turn",
  session: "This session",
  persistent: "Saved",
  deny: "Deny",
  "deny-stop": "Deny and stop",
};

/** Words in a label that already say what the class's tag would ("Allow for this session"). */
const LABEL_NAMES_LIFETIME: Record<ProviderApprovalOptionClass, RegExp> = {
  once: /\bonce\b/iu,
  turn: /\bturn\b/iu,
  session: /\bsession\b/iu,
  persistent: /\bsave/iu,
  deny: /\b(?:deny|decline|reject|no)\b/iu,
  "deny-stop": /\bstop\b/iu,
};

/** The lifetime tag, unless the label already says it: one label and at most one tag per row. */
function approvalLifetimeTag(
  optionClass: ProviderApprovalOptionClass,
  label: string,
): string | undefined {
  // The saved tag is also the row's risk marker, so it stays beside "Always allow …".
  if (optionClass !== "persistent" && LABEL_NAMES_LIFETIME[optionClass].test(label))
    return undefined;
  return APPROVAL_LIFETIME_TAG[optionClass];
}

const optionalLifetimeTag = (tag: string | undefined) =>
  tag === undefined ? {} : { lifetimeTag: tag };

const PERSIST_LOCATION: Record<ProviderApprovalPersistTarget, string> = {
  "claude-local-settings": "Saved in this project's local Claude settings for later sessions.",
  "codex-rules": "Saved in Codex rules for every project.",
  "codex-network-rules": "Saved in Codex network rules for every project.",
  "mcp-always": "Saved by the app for its later requests.",
};

/** One sentence on how long the choice lasts and what it leaves behind. */
function approvalLifetimeText(
  optionClass: ProviderApprovalOptionClass,
  persistsTo?: ProviderApprovalPersistTarget,
): string {
  switch (optionClass) {
    case "once":
      return "Applies to this request only.";
    case "turn":
      return "Applies until this turn ends.";
    case "session":
      return "Applies until this provider session ends; nothing is saved.";
    case "persistent":
      return persistsTo === undefined ? "Saved for later sessions." : PERSIST_LOCATION[persistsTo];
    case "deny":
      return "The agent is told no and can continue.";
    case "deny-stop":
      return "The agent is told no and the run stops.";
  }
}

export interface ApprovalChoice {
  /** Stable React key: the server id, else the decision. */
  readonly key: string;
  readonly decision: ProviderApprovalDecision;
  readonly optionId?: ProviderApprovalOptionId;
  readonly optionClass: ProviderApprovalOptionClass;
  readonly label: string;
  /** Absent when the label already names the lifetime, such as "Allow for this session". */
  readonly lifetimeTag?: string;
  /**
   * One line on how long the choice lasts. A saved choice's line says where it is kept: the
   * server's warning when it sends one, since that names the exact file or rule set.
   */
  readonly lifetimeText: string;
  /** The server's one-line scope preview, such as the folder a session choice adds. */
  readonly detail?: string;
  readonly rulePreview: ReadonlyArray<string>;
  /** The server's caution. On a saved choice it is also `lifetimeText`, so show it once. */
  readonly warning?: string;
  /** Primary choices are buttons; the rest sit behind "More approval options". */
  readonly placement: "primary" | "more";
  /** Shown but not selectable, with the reason. */
  readonly disabledReason?: string;
  readonly acceptsFeedback: boolean;
}

/**
 * The choices an approval card offers, only from the server's list. A saved (persistent) choice
 * appears only with the exact rule it saves, and needs the settings permission to pick; mobile
 * omits saved choices. The plain deny (or, when none is listed, deny-and-stop) and the narrowest
 * allow (once, else this turn, else this session; never a saved rule) are the buttons.
 */
export function presentApprovalChoices(
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
  input: { readonly canRemember: boolean; readonly persistent: "offer" | "omit" },
): ReadonlyArray<ApprovalChoice> {
  const offered = (options ?? LEGACY_APPROVAL_OPTIONS).flatMap((option) => {
    const optionClass = approvalChoiceClass(option);
    const rulePreview = option.rulePreview ?? [];
    if (optionClass === "persistent" && (rulePreview.length === 0 || input.persistent === "omit"))
      return [];
    return [{ option, optionClass, rulePreview }];
  });
  const primaryAllow =
    offered.find((entry) => entry.optionClass === "once") ??
    offered.find((entry) => entry.optionClass === "turn") ??
    offered.find((entry) => entry.optionClass === "session");
  // Codex may list only "Deny and stop"; the card still needs a visible way to refuse.
  const primaryDeny =
    offered.find((entry) => entry.optionClass === "deny") ??
    offered.find((entry) => entry.optionClass === "deny-stop");
  const rank = (entry: (typeof offered)[number]) =>
    entry === primaryDeny
      ? -2
      : entry === primaryAllow
        ? -1
        : OPTION_CLASSES.indexOf(entry.optionClass);
  return offered
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => rank(left.entry) - rank(right.entry) || left.index - right.index)
    .map(({ entry: { option, optionClass, rulePreview } }) => ({
      key: option.optionId ?? option.decision,
      decision: option.decision,
      ...(option.optionId === undefined ? {} : { optionId: option.optionId }),
      optionClass,
      label: option.label,
      ...optionalLifetimeTag(approvalLifetimeTag(optionClass, option.label)),
      // Every saved option's warning names where it is kept, more exactly than the generic line.
      lifetimeText:
        optionClass === "persistent" && option.warning !== undefined
          ? option.warning
          : approvalLifetimeText(optionClass, option.persistsTo),
      ...(option.detail === undefined ? {} : { detail: option.detail }),
      rulePreview,
      ...(option.warning === undefined ? {} : { warning: option.warning }),
      placement:
        option === primaryAllow?.option || option === primaryDeny?.option ? "primary" : "more",
      ...(optionClass === "persistent" && !input.canRemember
        ? { disabledReason: SETTINGS_PERMISSION_REASON }
        : {}),
      acceptsFeedback:
        option.acceptsFeedback === true && (optionClass === "deny" || optionClass === "deny-stop"),
    }));
}

/** The response a choice sends: its server id when it has one, plus an optional reason. */
export function approvalChoiceResponse(
  choice: Pick<ApprovalChoice, "optionId" | "acceptsFeedback">,
  feedback?: string,
): ApprovalResponseInput {
  const reason = choice.acceptsFeedback
    ? feedback?.trim().slice(0, PROVIDER_APPROVAL_FEEDBACK_MAX_LENGTH)
    : "";
  return {
    ...(choice.optionId === undefined ? {} : { optionId: choice.optionId }),
    ...(reason ? { feedback: reason } : {}),
  };
}

export interface ApprovalScopeRow {
  readonly label: string;
  readonly value: string;
  /** Paths, hosts and ids render in a monospace face. */
  readonly code: boolean;
}

/** Codex's non-URL network protocols, by the name its approval context sends. */
const NETWORK_PROTOCOL_LABEL: Record<string, string> = {
  socks5Tcp: "SOCKS5 TCP",
  socks5Udp: "SOCKS5 UDP",
};

/**
 * Where an MCP server was configured, in the user's words, by Claude's `mcpServer.source` id. The
 * set is open; an id not listed here is left out rather than shown raw. `dynamic` and `sdk`
 * servers are the ones Stark Code passes to Claude when it starts the session.
 */
const MCP_SERVER_SOURCE_LABEL: Readonly<Record<string, string>> = {
  user: "Your user settings",
  project: "This project's settings",
  local: "This project's local settings",
  dynamic: "Stark Code",
  sdk: "Stark Code",
  plugin: "A plugin",
  managed: "Managed settings",
  enterprise: "Managed settings",
  claudeai: "Claude.ai connectors",
  agent: "An agent definition",
};

/** `https://host` for web protocols; any other protocol is named after the host. */
function networkHost(network: NonNullable<ApprovalRequestScope["network"]>): string {
  const { host, protocol } = network;
  if (protocol === undefined) return host;
  if (protocol === "http" || protocol === "https") return `${protocol}://${host}`;
  return `${host} (${NETWORK_PROTOCOL_LABEL[protocol] ?? protocol})`;
}

/** What the request reaches beyond its command or files: who asked, paths, network, origin. */
export function approvalScopeRows(scope: ApprovalRequestScope | undefined): ApprovalScopeRow[] {
  if (scope === undefined) return [];
  const rows: ApprovalScopeRow[] = [];
  // The subagent's name; older servers send only its raw id.
  if (scope.agentName)
    rows.push({ label: "Asked by subagent", value: scope.agentName, code: false });
  else if (scope.agentId)
    rows.push({ label: "Asked by subagent", value: scope.agentId, code: true });
  if (scope.blockedPath)
    rows.push({ label: "Outside allowed folders", value: scope.blockedPath, code: true });
  if (scope.network)
    rows.push({ label: "Network host", value: networkHost(scope.network), code: true });
  const read = scope.requestedPermissions?.readPaths ?? [];
  const write = scope.requestedPermissions?.writePaths ?? [];
  if (read.length > 0) rows.push({ label: "Read access", value: read.join("\n"), code: true });
  if (write.length > 0) rows.push({ label: "Write access", value: write.join("\n"), code: true });
  if (scope.requestedPermissions?.network === true)
    rows.push({ label: "Network access", value: "Requested", code: false });
  if (scope.grantRoot) rows.push({ label: "Grant covers", value: scope.grantRoot, code: true });
  if (scope.mcpServerSource) {
    rows.push({ label: "App", value: scope.mcpServerSource.name, code: true });
    const source = scope.mcpServerSource.source;
    const configuredIn =
      source !== undefined && Object.hasOwn(MCP_SERVER_SOURCE_LABEL, source)
        ? MCP_SERVER_SOURCE_LABEL[source]
        : undefined;
    if (configuredIn !== undefined)
      rows.push({ label: "App configured in", value: configuredIn, code: false });
  }
  return rows;
}

export type PermissionPresentationTone = "neutral" | "success" | "warning" | "error";

export interface DeliveryCaption {
  readonly text: string;
  readonly tone: PermissionPresentationTone;
}

/** Whether a given answer reached the agent. Nothing here says the action ran. */
export function runtimeRequestDeliveryCaption(
  delivery: Pick<OrchestrationV2RuntimeRequestDelivery, "state"> | undefined,
  providerName = "the agent",
): DeliveryCaption | null {
  switch (delivery?.state) {
    case undefined:
      return null;
    case "pending":
      return { text: "Sending your answer to the agent…", tone: "neutral" };
    case "delivered":
      return { text: "Delivered to the agent", tone: "neutral" };
    case "not_delivered":
      return { text: "Answer not delivered: nothing ran", tone: "error" };
    case "uncertain":
      return { text: "Delivery uncertain: check whether it ran", tone: "warning" };
    case "not_needed":
      return { text: `Closed by ${providerName} before your answer arrived`, tone: "neutral" };
  }
}

const DECISION_EFFECT: Record<ProviderApprovalDecision, ProviderApprovalEffect> = {
  accept: "allow",
  acceptForSession: "allow",
  acceptAlways: "allow",
  decline: "deny",
  cancel: "deny_and_stop",
};
const DECISION_SCOPE: Record<ProviderApprovalDecision, ProviderApprovalScope> = {
  accept: "once",
  acceptForSession: "session",
  acceptAlways: "persistent",
  decline: "once",
  cancel: "once",
};

/**
 * "Allowed once", "Declined and stopped", "Always blocked", … from the persisted choice's scope
 * and effect; a choice recorded without them, or only an older decision, reads from the decision.
 * A saved deny is a block rule the provider keeps, such as Codex's "Always block <host>". This is
 * an outcome: use it only once the agent confirmed receiving the answer.
 */
function approvalDecisionLabel(
  chosen: Pick<ProviderApprovalChoice, "decision" | "scope" | "effect">,
): string {
  const effect = chosen.effect ?? DECISION_EFFECT[chosen.decision];
  if (effect === "deny_and_stop") return "Declined and stopped";
  if (effect === "deny") return chosen.scope === "persistent" ? "Always blocked" : "Declined";
  switch (chosen.scope ?? DECISION_SCOPE[chosen.decision]) {
    case "once":
      return "Allowed once";
    case "turn":
      return "Allowed for this turn";
    case "session":
      return "Allowed for this session";
    case "persistent":
      return "Always allowed";
  }
}

/**
 * The choice as the user picked it, "Allow once", "Decline and stop", …: what an answer the
 * agent has not confirmed receiving is called, since nothing may have happened yet.
 */
function approvalChoiceName(
  chosen: Pick<ProviderApprovalChoice, "decision" | "scope" | "effect">,
): string {
  const effect = chosen.effect ?? DECISION_EFFECT[chosen.decision];
  if (effect === "deny_and_stop") return "Decline and stop";
  if (effect === "deny") return chosen.scope === "persistent" ? "Always block" : "Decline";
  switch (chosen.scope ?? DECISION_SCOPE[chosen.decision]) {
    case "once":
      return "Allow once";
    case "turn":
      return "Allow for this turn";
    case "session":
      return "Allow for this session";
    case "persistent":
      return "Always allow";
  }
}

type ApprovalDeliveryInput = {
  readonly delivery?: Pick<OrchestrationV2RuntimeRequestDelivery, "state"> | undefined;
  readonly lost?:
    | Pick<OrchestrationV2RuntimeRequestLoss, "cause" | "deliveryUncertain">
    | undefined;
};

/** Delivery states that settle what became of the answer, whatever loss the request recorded. */
function deliverySettled(delivery: ApprovalDeliveryInput["delivery"]): boolean {
  return (
    delivery?.state === "delivered" ||
    delivery?.state === "not_delivered" ||
    delivery?.state === "not_needed"
  );
}

/**
 * Whether an answer did not, or may not, reach the agent. A settled delivery state wins over the
 * request's loss history (a loss the user dismissed stays recorded after delivery is confirmed);
 * a loss decides only while delivery is still open.
 */
export function approvalDeliveryIssue(
  input: ApprovalDeliveryInput,
): "not_delivered" | "uncertain" | null {
  if (deliverySettled(input.delivery))
    return input.delivery?.state === "not_delivered" ? "not_delivered" : null;
  const lost = input.lost;
  if (lost !== undefined && (lost.cause === "delivery_failed" || lost.deliveryUncertain === true))
    return lost.deliveryUncertain === true ? "uncertain" : "not_delivered";
  return input.delivery?.state === "uncertain" ? "uncertain" : null;
}

/**
 * The parts of a runtime request its record reads. A request the provider closed unanswered is
 * `expired`; one it closed after the answer has delivery `not_needed`; one a restart, shutdown,
 * provider exit or failed delivery closed carries `lost`. A permission change waiting on a run is
 * the thread's `permissionChangePending`, not a request state.
 */
export type ApprovalRecordInput = Pick<OrchestrationV2RuntimeRequest, "kind" | "status"> &
  ApprovalDeliveryInput & {
    readonly decision?: ProviderApprovalDecision | undefined;
    readonly chosen?: ProviderApprovalChoice | undefined;
  };

export interface ApprovalRecord {
  readonly label: string;
  readonly detail?: string;
  readonly tone: PermissionPresentationTone;
  /** Only an allow the agent confirmed receiving earns a success mark. */
  readonly success: boolean;
}

/**
 * What became of an approval, for its timeline row: the decision, then whether it reached the
 * agent. Only an answer the agent confirmed receiving reads as done ("Allowed once"); until then
 * the label names the choice as selected and says what is known about its delivery. The label is
 * what the row shows inline, so it carries that on its own; the detail is extra.
 */
export function approvalRecord(input: ApprovalRecordInput, providerName?: string): ApprovalRecord {
  const chosen =
    input.chosen ??
    (input.decision === undefined
      ? undefined
      : {
          decision: input.decision,
          scope: DECISION_SCOPE[input.decision],
          effect: DECISION_EFFECT[input.decision],
        });
  const choice = chosen === undefined ? undefined : approvalDecisionLabel(chosen);
  const picked = chosen === undefined ? undefined : approvalChoiceName(chosen);
  const youChose = picked === undefined ? "" : `You chose ${picked}. `;
  if (input.lost !== undefined && !deliverySettled(input.delivery)) {
    switch (approvalDeliveryIssue(input)) {
      case "uncertain":
        return {
          label: "Delivery uncertain",
          detail: `${youChose}It may not have reached the agent; check whether it ran.`,
          tone: "warning",
          success: false,
        };
      case "not_delivered":
        return {
          label: "Answer not delivered",
          detail: `${youChose}Nothing ran.`,
          tone: "error",
          success: false,
        };
      case null:
        return {
          label: lostRuntimeRequestLabel({ kind: input.kind, cause: input.lost.cause }),
          tone: "warning",
          success: false,
        };
    }
  }
  switch (input.status) {
    case "pending":
      return { label: "Waiting for your decision", tone: "neutral", success: false };
    case "expired":
      return {
        label: "Expired",
        detail: "The agent stopped waiting before you answered.",
        tone: "neutral",
        success: false,
      };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", success: false };
    case "resolved":
      break;
  }
  const feedback = input.chosen?.feedback ? `Reason: ${input.chosen.feedback}` : undefined;
  const allowed =
    chosen !== undefined && (chosen.effect ?? DECISION_EFFECT[chosen.decision]) === "allow";
  const selected = picked === undefined ? "Answered" : `${picked} selected`;
  const withFeedback = (text: string) => (feedback ? `${feedback} · ${text}` : text);
  switch (input.delivery?.state) {
    case undefined:
      // Older servers record the choice before delivery and never confirm it.
      return {
        label: selected,
        detail: withFeedback("Delivery to the agent was not recorded."),
        tone: "neutral",
        success: false,
      };
    case "pending":
      return {
        label: `${selected} · sending…`,
        detail: withFeedback("Sending to the agent…"),
        tone: "neutral",
        success: false,
      };
    case "delivered":
      return {
        label: choice ?? "Answered",
        ...(feedback ? { detail: feedback } : {}),
        tone: allowed ? "success" : "neutral",
        success: allowed,
      };
    case "not_delivered":
      return {
        label: "Answer not delivered",
        detail: `${youChose}Nothing ran.`,
        tone: "error",
        success: false,
      };
    case "uncertain":
      return {
        label: "Delivery uncertain",
        detail: `${youChose}Check whether it ran.`,
        tone: "warning",
        success: false,
      };
    case "not_needed":
      return {
        label: `Closed by ${providerName ?? "the agent"} before your answer arrived`,
        ...(picked ? { detail: `You chose ${picked}.` } : {}),
        tone: "neutral",
        success: false,
      };
  }
}

/**
 * Whether an approval closed without allowing its action, so the action never ran: declined, or
 * expired, cancelled or lost before an allow was chosen. An allow that may not have reached the
 * agent is not counted; its delivery state says whether it ran.
 */
export function approvalNeverAllowed(
  input: Pick<ApprovalRecordInput, "status" | "decision" | "chosen">,
): boolean {
  if (input.status === "pending") return false;
  const decision = input.chosen?.decision ?? input.decision;
  const effect =
    input.chosen?.effect ?? (decision === undefined ? undefined : DECISION_EFFECT[decision]);
  // A resolved request with no recorded choice says nothing either way.
  if (input.status === "resolved") return effect === "deny" || effect === "deny_and_stop";
  return effect !== "allow";
}

/** The card's headline when nothing more specific is known: what kind of action is asked for. */
export function approvalKindTitle(kind: ProviderRequestKind): string {
  switch (kind) {
    case "command":
      return "Command approval";
    case "file-read":
      return "File read approval";
    case "file-change":
      return "File change approval";
    case "permission":
      return "Permission request";
    case "mcp-elicitation":
      return "App access approval";
  }
}

/** The prefix the server puts on the prompt of an ask a hook forced (ClaudeAdapterV2). */
const HOOK_ASK_PREFIX = "Asked by a hook\n";
/** Stark's own hook's reason for a command that may publish to Stark Pages (StarkPagesGuard). */
const STARK_PAGES_UNCERTAIN_REASON =
  "Stark Code cannot tell whether this command publishes to Stark Pages, which is available only in native Claude shell mode, so it needs your approval.";

/** The card's warning for a command that may publish to Stark Pages; it offers only once-options. */
export const STARK_PAGES_UNCERTAIN_NOTE =
  "May publish to Stark Pages, which is available only in native Claude shell mode, so it needs your approval each time.";

/**
 * An approval prompt split into what the card shows separately: whether a hook forced the ask,
 * whether it is Stark's "may publish to Stark Pages" reason, and the remaining description.
 */
export function approvalPromptParts(prompt: string | undefined): {
  readonly askedByHook: boolean;
  readonly pagesUncertain: boolean;
  readonly text?: string;
} {
  let text = prompt ?? "";
  const askedByHook = text.startsWith(HOOK_ASK_PREFIX);
  if (askedByHook) text = text.slice(HOOK_ASK_PREFIX.length);
  const pagesUncertain = text.includes(STARK_PAGES_UNCERTAIN_REASON);
  if (pagesUncertain) text = text.replace(STARK_PAGES_UNCERTAIN_REASON, "");
  text = text.trim();
  return { askedByHook, pagesUncertain, ...(text ? { text } : {}) };
}
