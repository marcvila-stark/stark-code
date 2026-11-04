import type {
  ProviderApprovalDecision,
  ProviderApprovalEffect,
  ProviderApprovalOption,
  ProviderApprovalOptionClass,
  ProviderApprovalScope,
} from "@starkfuture/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { mayPublishToStarkPages } from "./StarkPagesGuard.ts";

/**
 * One choice on a Codex approval card, bound to exactly what Stark sends Codex
 * when the user picks it. Stark offers only the choices Codex lists for the
 * request; it may drop one (Pages publishing, an unsafe saved rule) but never
 * adds one or changes its payload.
 */
export interface CodexApprovalChoice<Native> {
  /** Server-issued `<class>:<n>` (PLAN-002 §3.1), unique within one request. */
  readonly optionId: string;
  readonly class: ProviderApprovalOptionClass;
  /** How long an allow lasts; denials have none. */
  readonly scope?: ProviderApprovalScope;
  readonly effect: ProviderApprovalEffect;
  /** Where Codex saves the choice beyond this session, for persistent choices. */
  readonly persistsTo?: "codex-rules" | "codex-network-rules";
  /**
   * The decision a client without option ids answers with. Several choices may
   * share one (two saved rules, Deny and a saved block rule); such a client
   * gets the narrowest, and the option id names each exactly.
   */
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
  readonly detail?: string;
  readonly warning?: string;
  readonly rulePreview?: ReadonlyArray<string>;
  /** Exactly what Stark sends Codex when this choice is picked. */
  readonly native: Native;
}

type CodexCommandDecision =
  CodexSchema.CommandExecutionRequestApprovalResponse__CommandExecutionApprovalDecision;
type CodexFileChangeDecision = CodexSchema.FileChangeRequestApprovalResponse["decision"];

type ChoiceDraft<Native> = Omit<CodexApprovalChoice<Native>, "optionId">;

const SESSION_DETAIL = "Codex remembers this approval until its session restarts.";

// Narrowest first, as the orchestrator ranks options for a decision-only answer.
const CLASS_BREADTH: Record<ProviderApprovalOptionClass, number> = {
  "deny-stop": 0,
  deny: 1,
  once: 2,
  turn: 3,
  session: 4,
  persistent: 5,
};

/**
 * Numbers each draft by class from 0, as `withApprovalOptionIds` does, so the
 * orchestrator keeps these ids unchanged. A choice that saves a rule is
 * offered only with the exact rule it saves.
 */
function finalizeChoices<Native>(
  drafts: ReadonlyArray<ChoiceDraft<Native>>,
): ReadonlyArray<CodexApprovalChoice<Native>> {
  const counts = new Map<ProviderApprovalOptionClass, number>();
  return drafts
    .filter((draft) => draft.class !== "persistent" || (draft.rulePreview?.length ?? 0) > 0)
    .map((draft) => {
      const index = counts.get(draft.class) ?? 0;
      counts.set(draft.class, index + 1);
      return { ...draft, optionId: `${draft.class}:${index}` };
    });
}

const allowOnce = <Native>(native: Native): ChoiceDraft<Native> => ({
  class: "once",
  scope: "once",
  effect: "allow",
  decision: "accept",
  label: "Allow once",
  native,
});
const allowForSession = <Native>(native: Native, detail = SESSION_DETAIL): ChoiceDraft<Native> => ({
  class: "session",
  scope: "session",
  effect: "allow",
  decision: "acceptForSession",
  label: "Allow for this session",
  detail,
  native,
});
const deny = <Native>(native: Native): ChoiceDraft<Native> => ({
  class: "deny",
  effect: "deny",
  decision: "decline",
  label: "Deny",
  native,
});
const denyAndStop = <Native>(native: Native): ChoiceDraft<Native> => ({
  class: "deny-stop",
  effect: "deny_and_stop",
  decision: "cancel",
  label: "Deny and stop",
  native,
});

// Executables whose prefix rule would allow arbitrary code, network transfers
// or publishing; Codex's saved rules never start with one.
const UNSAFE_RULE_EXECUTABLES = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "python",
  "python2",
  "python3",
  "node",
  "nodejs",
  "ruby",
  "perl",
  "php",
  "deno",
  "bun",
  "env",
  "sudo",
  "su",
  "rm",
  "xargs",
  "find",
  "eval",
  "exec",
  "spage",
  "curl",
  "wget",
  "http",
  "https",
]);
const basename = (value: string) =>
  value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";

/** Whether a command, as text or argv, publishes or may publish to Stark Pages. */
const publishesToPages = (command: string | ReadonlyArray<string> | undefined): boolean =>
  command !== undefined &&
  mayPublishToStarkPages({ toolName: "bash", toolInput: { command: command } });

/**
 * A Codex-proposed execpolicy amendment Stark may offer as "Always allow":
 * an exact argv prefix of at least a command and one argument, with no shell
 * syntax or wildcards, not starting with an interpreter or a network or
 * publishing tool, and never for a Stark Pages publish. Anything else is null.
 */
export function validatedCodexExecpolicyAmendment(
  proposal: unknown,
  command?: string,
): string[] | null {
  if (
    !Array.isArray(proposal) ||
    proposal.length < 2 ||
    proposal.length > 64 ||
    !proposal.every(
      (part): part is string =>
        typeof part === "string" &&
        part.length > 0 &&
        part.length <= 1000 &&
        // eslint-disable-next-line no-control-regex -- A saved rule never carries control characters.
        !/[\r\n\x00-\x1f\x7f*?;&|`<>]|\$\(/.test(part),
    )
  )
    return null;
  if (
    UNSAFE_RULE_EXECUTABLES.has(basename(proposal[0]!)) ||
    /^(?:python|node|ruby|perl)\d+(?:\.\d+)*$/.test(basename(proposal[0]!)) ||
    publishesToPages(command ?? proposal)
  )
    return null;
  return [...proposal];
}

function execpolicyChoice(
  native: CodexCommandDecision,
  amendment: ReadonlyArray<string>,
): ChoiceDraft<CodexCommandDecision> {
  return {
    class: "persistent",
    scope: "persistent",
    effect: "allow",
    persistsTo: "codex-rules",
    decision: "acceptAlways",
    label: "Always allow (Codex, every project)",
    rulePreview: [`prefix_rule(pattern=${JSON.stringify(amendment)}, decision="allow")`],
    warning:
      "Matching commands run outside the sandbox without prompting. This rule applies to every project using this Codex home.",
    native,
  };
}

function networkChoice(
  native: CodexCommandDecision,
  amendment: CodexSchema.CommandExecutionRequestApprovalResponse__NetworkPolicyAmendment,
): ChoiceDraft<CodexCommandDecision> {
  const allow = amendment.action === "allow";
  return {
    class: "persistent",
    scope: "persistent",
    effect: allow ? "allow" : "deny",
    persistsTo: "codex-network-rules",
    // A client without option ids that answers Deny gets the plain decline,
    // which is narrower; only the option id picks the saved block rule.
    decision: allow ? "acceptAlways" : "decline",
    label: allow ? `Always allow ${amendment.host}` : `Always block ${amendment.host}`,
    rulePreview: [
      `network_policy_amendment(host=${JSON.stringify(amendment.host)}, action="${amendment.action}")`,
    ],
    warning: `Saved in this Codex home's network rules, so it applies to every project.`,
    native,
  };
}

/**
 * The choices for a command approval. With `availableDecisions` (Codex 0.163)
 * they are exactly the listed decisions in Codex's order: `decline` is Deny,
 * `cancel` is Deny and stop, and each amendment carries the payload Codex
 * listed. An unsafe execpolicy amendment and, for Stark Pages publishing,
 * every remembered allow are dropped. Without the field Stark falls back to
 * the decisions every Codex accepts for this request.
 */
export function codexCommandApprovalChoices(
  params: Pick<
    CodexSchema.CommandExecutionRequestApprovalParamsV0163,
    "availableDecisions" | "command" | "proposedExecpolicyAmendment"
  >,
): ReadonlyArray<CodexApprovalChoice<CodexCommandDecision>> {
  const command = params.command ?? undefined;
  const publish = publishesToPages(command);
  const listed: ReadonlyArray<CodexCommandDecision> =
    params.availableDecisions ??
    (() => {
      const proposal = validatedCodexExecpolicyAmendment(
        params.proposedExecpolicyAmendment,
        command,
      );
      return [
        "decline",
        "accept",
        "acceptForSession",
        ...(proposal === null
          ? []
          : [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: proposal } }]),
        "cancel",
      ] satisfies ReadonlyArray<CodexCommandDecision>;
    })();
  const drafts = listed.flatMap((decision): ReadonlyArray<ChoiceDraft<CodexCommandDecision>> => {
    if (decision === "accept") return [allowOnce(decision)];
    if (decision === "acceptForSession") return publish ? [] : [allowForSession(decision)];
    if (decision === "decline") return [deny(decision)];
    if (decision === "cancel") return [denyAndStop(decision)];
    if ("acceptWithExecpolicyAmendment" in decision) {
      if (publish) return [];
      const amendment = validatedCodexExecpolicyAmendment(
        decision.acceptWithExecpolicyAmendment.execpolicy_amendment,
        command,
      );
      return amendment === null ? [] : [execpolicyChoice(decision, amendment)];
    }
    const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
    return publish && amendment.action === "allow" ? [] : [networkChoice(decision, amendment)];
  });
  return finalizeChoices(drafts);
}

/**
 * The choices for a file change approval. Codex 0.163 lists no decisions for
 * these, so they are the four it accepts. A session approval that also asks
 * for a grant root says so, since Codex may then allow writes under that root.
 */
export function codexFileChangeApprovalChoices(input: {
  readonly grantRoot?: string | null;
}): ReadonlyArray<CodexApprovalChoice<CodexFileChangeDecision>> {
  const grantRoot = input.grantRoot?.trim();
  return finalizeChoices<CodexFileChangeDecision>([
    deny("decline"),
    allowOnce("accept"),
    allowForSession(
      "acceptForSession",
      grantRoot
        ? `Codex asked to write anywhere under ${grantRoot} for the rest of its session.`
        : SESSION_DETAIL,
    ),
    denyAndStop("cancel"),
  ]);
}

/**
 * The choices for a permissions request: grant exactly the requested profile
 * for this turn or this session, or grant nothing. Codex has no stop decision
 * for these requests.
 */
export function codexPermissionsApprovalChoices(
  permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"],
): ReadonlyArray<CodexApprovalChoice<CodexSchema.PermissionsRequestApprovalResponse>> {
  const scope = describeCodexRequestedPermissions(permissions);
  return finalizeChoices<CodexSchema.PermissionsRequestApprovalResponse>([
    deny({ permissions: {}, scope: "turn" }),
    {
      class: "turn",
      scope: "turn",
      effect: "allow",
      decision: "accept",
      label: "Grant for this turn",
      ...(scope === undefined ? {} : { detail: scope }),
      native: { permissions, scope: "turn" },
    },
    {
      class: "session",
      scope: "session",
      effect: "allow",
      decision: "acceptForSession",
      label: "Grant for this session",
      ...(scope === undefined ? {} : { detail: scope }),
      native: { permissions, scope: "session" },
    },
  ]);
}

/**
 * The choices for an approval from a Codex older than the v2 protocol
 * (`execCommandApproval`, `applyPatchApproval`), which lists no decisions:
 * Deny, Allow once and, except for a Stark Pages publish, Allow for this
 * session. Codex saves no rule for these.
 */
export function codexLegacyApprovalChoices(input: {
  /** The command a legacy exec approval runs; none for a patch. */
  readonly command?: ReadonlyArray<string>;
}): ReadonlyArray<CodexApprovalChoice<ProviderApprovalDecision>> {
  return finalizeChoices<ProviderApprovalDecision>([
    deny("decline"),
    allowOnce("accept"),
    ...(publishesToPages(input.command)
      ? []
      : [allowForSession<ProviderApprovalDecision>("acceptForSession")]),
  ]);
}

/**
 * Wraps a provider option list whose native payload is its decision string,
 * such as MCP elicitations.
 */
export function codexChoicesFromOptions(
  options: ReadonlyArray<ProviderApprovalOption>,
): ReadonlyArray<CodexApprovalChoice<ProviderApprovalDecision>> {
  return finalizeChoices(
    options.map((option): ChoiceDraft<ProviderApprovalDecision> => {
      const optionClass = legacyDecisionClass(option.decision);
      const scope = classScope(optionClass);
      return {
        decision: option.decision,
        label: option.label,
        ...(option.detail === undefined ? {} : { detail: option.detail }),
        ...(option.warning === undefined ? {} : { warning: option.warning }),
        ...(option.rulePreview === undefined ? {} : { rulePreview: option.rulePreview }),
        class: optionClass,
        ...(scope === undefined ? {} : { scope }),
        effect:
          option.decision === "cancel"
            ? "deny_and_stop"
            : option.decision === "decline"
              ? "deny"
              : "allow",
        native: option.decision,
      };
    }),
  );
}

function legacyDecisionClass(decision: ProviderApprovalDecision): ProviderApprovalOptionClass {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "session";
    case "acceptAlways":
      return "persistent";
    case "decline":
      return "deny";
    case "cancel":
      return "deny-stop";
  }
}

function classScope(optionClass: ProviderApprovalOptionClass): ProviderApprovalScope | undefined {
  return optionClass === "deny" || optionClass === "deny-stop" ? undefined : optionClass;
}

/**
 * The options a client sees: every choice, each with its server-issued id and
 * the exact native response it sends. Codex takes no typed reason with an
 * answer, so no option accepts feedback.
 */
export function codexApprovalOptionsForClients(
  choices: ReadonlyArray<CodexApprovalChoice<unknown>>,
): ReadonlyArray<ProviderApprovalOption> {
  return choices.map((choice) => ({
    decision: choice.decision,
    label: choice.label,
    ...(choice.detail === undefined ? {} : { detail: choice.detail }),
    ...(choice.warning === undefined ? {} : { warning: choice.warning }),
    ...(choice.rulePreview === undefined ? {} : { rulePreview: [...choice.rulePreview] }),
    optionId: choice.optionId,
    ...(choice.scope === undefined ? {} : { scope: choice.scope }),
    effect: choice.effect,
    ...(choice.persistsTo === undefined ? {} : { persistsTo: choice.persistsTo }),
    acceptsFeedback: false,
    nativePayload: choice.native,
  }));
}

/**
 * The choice an answer picks: the exact option id when the client sent one
 * (and its decision, if also sent, must match), otherwise the narrowest
 * offered choice with that legacy decision. Anything else picks nothing, so
 * an unoffered or stale decision is refused rather than mapped to a nearby one.
 */
export function resolveCodexApprovalChoice<Native>(
  choices: ReadonlyArray<CodexApprovalChoice<Native>>,
  answer: { readonly decision?: ProviderApprovalDecision; readonly optionId?: string },
): CodexApprovalChoice<Native> | undefined {
  if (answer.optionId !== undefined) {
    const choice = choices.find((candidate) => candidate.optionId === answer.optionId);
    return choice === undefined ||
      (answer.decision !== undefined && answer.decision !== choice.decision)
      ? undefined
      : choice;
  }
  if (answer.decision === undefined) return undefined;
  return choices
    .filter((choice) => choice.decision === answer.decision)
    .toSorted((left, right) => CLASS_BREADTH[left.class] - CLASS_BREADTH[right.class])[0];
}

function pathList(paths: ReadonlyArray<string> | undefined): string | undefined {
  if (paths === undefined) return undefined;
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown} +${paths.length - 5} more` : shown;
}

function trimmedPaths(
  paths: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> | undefined {
  const named = (paths ?? []).map((path) => path.trim()).filter((path) => path.length > 0);
  return named.length === 0 ? undefined : named;
}

type CodexPermissionProfile =
  | CodexSchema.PermissionsRequestApprovalParams["permissions"]
  | CodexSchema.CommandExecutionRequestApprovalParams__AdditionalPermissionProfile;
type CodexFileSystemPath = CodexSchema.PermissionsRequestApprovalParams__FileSystemPath;

/** How a Codex filesystem path reads on a card: plain paths as they are, special paths and globs named. */
function fileSystemPathLabel(path: CodexFileSystemPath): string | undefined {
  switch (path.type) {
    case "path":
      return path.path.trim() || undefined;
    case "glob_pattern":
      return path.pattern.trim() ? `${path.pattern.trim()} (pattern)` : undefined;
    case "special": {
      const special = path.value;
      switch (special.kind) {
        case "root":
          return "/ (the whole filesystem)";
        case "minimal":
          return "Minimal system paths";
        case "project_roots":
          return special.subpath?.trim()
            ? `Project roots/${special.subpath.trim()}`
            : "Project roots";
        case "tmpdir":
          return "$TMPDIR";
        case "slash_tmp":
          return "/tmp";
        case "unknown": {
          const base = special.path.trim() || "Unrecognised special path";
          return special.subpath?.trim() ? `${base}/${special.subpath.trim()}` : base;
        }
      }
    }
  }
}

/**
 * The paths a profile asks to read, write or keep closed. Codex 0.163 sends
 * `entries` (special paths, globs and access modes) and is retiring the legacy
 * `read`/`write` lists, so entries decide whenever there are any; the legacy
 * lists are read only when a profile carries no entries.
 */
function requestedPaths(permissions: CodexPermissionProfile): {
  readonly read?: ReadonlyArray<string>;
  readonly write?: ReadonlyArray<string>;
  readonly deny?: ReadonlyArray<string>;
} {
  const fileSystem = permissions.fileSystem;
  if (fileSystem == null) return {};
  const entries = (fileSystem.entries ?? []) as ReadonlyArray<{
    readonly access: "read" | "write" | "deny";
    readonly path: CodexFileSystemPath;
  }>;
  if (entries.length === 0) {
    const read = trimmedPaths(fileSystem.read);
    const write = trimmedPaths(fileSystem.write);
    return {
      ...(read === undefined ? {} : { read }),
      ...(write === undefined ? {} : { write }),
    };
  }
  const byAccess = (access: "read" | "write" | "deny") => {
    const labels = [
      ...new Set(
        entries.flatMap((entry) => {
          if (entry.access !== access) return [];
          const label = fileSystemPathLabel(entry.path);
          return label === undefined ? [] : [label];
        }),
      ),
    ];
    return labels.length === 0 ? undefined : labels;
  };
  const read = byAccess("read");
  const write = byAccess("write");
  const deny = byAccess("deny");
  return {
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
    ...(deny === undefined ? {} : { deny }),
  };
}

/** One line naming the sandbox access a Codex permission profile asks for. */
function describeCodexRequestedPermissions(
  permissions: CodexPermissionProfile | null | undefined,
): string | undefined {
  if (permissions == null) return undefined;
  const paths = requestedPaths(permissions);
  const write = pathList(paths.write);
  const read = pathList(paths.read);
  const deny = pathList(paths.deny);
  const parts = [
    ...(write === undefined ? [] : [`Write: ${write}`]),
    ...(read === undefined ? [] : [`Read: ${read}`]),
    ...(deny === undefined ? [] : [`No access: ${deny}`]),
    ...(permissions.network?.enabled === true ? ["Network access"] : []),
  ];
  return parts.length === 0 ? undefined : parts.join(". ");
}

/**
 * What an approval would let Codex do beyond the action itself, in the
 * approval card's scope fields (`OrchestrationV2ApprovalRequestScopeFields`).
 */
export interface CodexApprovalScope {
  readonly network?: { readonly host: string; readonly protocol?: string };
  readonly requestedPermissions?: {
    readonly readPaths?: ReadonlyArray<string>;
    readonly writePaths?: ReadonlyArray<string>;
    readonly network?: boolean;
  };
  readonly grantRoot?: string;
}

/** The extra access a Codex permission profile asks for, as scope fields. */
export function codexRequestedPermissionsScope(
  permissions: CodexPermissionProfile | null | undefined,
): CodexApprovalScope["requestedPermissions"] | undefined {
  if (permissions == null) return undefined;
  const { read: readPaths, write: writePaths } = requestedPaths(permissions);
  const network = permissions.network?.enabled === true;
  if (readPaths === undefined && writePaths === undefined && !network) return undefined;
  return {
    ...(readPaths === undefined ? {} : { readPaths }),
    ...(writePaths === undefined ? {} : { writePaths }),
    ...(network ? { network: true } : {}),
  };
}

/** The network host and extra sandbox access a command approval would allow. */
export function codexCommandApprovalScope(
  params: Pick<
    CodexSchema.CommandExecutionRequestApprovalParamsV0163,
    "networkApprovalContext" | "additionalPermissions"
  >,
): CodexApprovalScope {
  const context = params.networkApprovalContext;
  const host = context?.host.trim();
  const requestedPermissions = codexRequestedPermissionsScope(params.additionalPermissions);
  return {
    ...(host ? { network: { host, protocol: context!.protocol } } : {}),
    ...(requestedPermissions === undefined ? {} : { requestedPermissions }),
  };
}

/** The directory a file change approval would grant writes under, as a scope field. */
export function codexFileChangeApprovalScope(input: {
  readonly grantRoot?: string | null;
}): CodexApprovalScope {
  const grantRoot = input.grantRoot?.trim();
  return grantRoot ? { grantRoot } : {};
}

/**
 * The prompt for a command approval: Codex's reason or the command, and for
 * input to a running command, what it is. The network host and extra access
 * are scope fields (`codexCommandApprovalScope`), not prompt text.
 */
export function codexCommandApprovalPrompt(
  params: Pick<
    CodexSchema.CommandExecutionRequestApprovalParamsV0163,
    "reason" | "command" | "kind"
  >,
): string | undefined {
  const reason = params.reason?.trim() || undefined;
  const command = params.command?.trim() || undefined;
  const headline =
    params.kind === "writeStdin"
      ? `Send input to a running command${command === undefined ? "" : `: ${command}`}`
      : (reason ?? command);
  const lines = [
    ...(headline === undefined ? [] : [headline]),
    ...(params.kind === "writeStdin" && reason !== undefined ? [reason] : []),
  ];
  return lines.length === 0 ? undefined : lines.join("\n");
}
