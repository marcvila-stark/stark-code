import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { type ProviderApprovalOption, withApprovalOptionIds } from "@starkfuture/contracts";
import { mayPublishToStarkPages } from "./StarkPagesGuard.ts";

/** A rule Stark adds on top of Claude's own settings, with the label the UI shows for it. */
export interface ClaudeStarkPolicy {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

/**
 * Claude's subagents inherit the chat's mode natively; Stark's one exception (O5) is Bypass,
 * which children never get: their tool calls are denied while the parent runs in Bypass.
 */
export const CLAUDE_CHILD_BYPASS_POLICY: ClaudeStarkPolicy = {
  id: "stark-children-never-bypass",
  label: "Stark policy: agents never run in Bypass",
  detail:
    "Child agents cannot use Bypass permissions. Switch this chat to Manual, Accept edits or Auto before starting an agent, and remove Bypass from custom agent definitions.",
};

/** Without the account's opt-in, Stark turns Claude's Bypass mode off natively. */
export const CLAUDE_BYPASS_OPT_IN_POLICY: ClaudeStarkPolicy = {
  id: "stark-bypass-opt-in",
  label: "Stark policy: Bypass is off for this account",
  detail: "Enable Allow Bypass permissions in this Claude account's settings to allow Bypass.",
};

const SESSION_OPTION = { decision: "acceptForSession", label: "Allow for this session" } as const;
/**
 * Claude's answers that grant nothing beyond this call. Both denials can carry a reason the
 * user types for Claude; "Decline and stop" also ends Claude's current work.
 */
const CLAUDE_ONCE_OPTIONS = [
  { decision: "decline", label: "Decline", scope: "once", effect: "deny", acceptsFeedback: true },
  {
    decision: "cancel",
    label: "Decline and stop",
    scope: "once",
    effect: "deny_and_stop",
    acceptsFeedback: true,
  },
  { decision: "accept", label: "Allow once", scope: "once", effect: "allow" },
] as const satisfies ReadonlyArray<ProviderApprovalOption>;
const INTERPRETERS = new Set([
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

function safeCommandPrefix(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized === "*" || /[\n\r;&|`<>]|\$\(|\x00/.test(normalized)) return false;
  const executable = normalized.split(/\s+/)[0]!.replace(/^['"]|['"]$/g, "");
  if (
    INTERPRETERS.has(basename(executable)) ||
    /^(?:python|node|ruby|perl)\d+(?:\.\d+)*$/.test(basename(executable))
  )
    return false;
  // An executable alone grants all its subcommands. Require a concrete subcommand/argument.
  return normalized.split(/\s+/).length >= 2 && normalized.split(/\s+/)[1] !== "*";
}

function isSafeClaudeSavedRule(toolName: string, ruleContent?: string): boolean {
  if (
    !toolName ||
    /[\p{Cc}\p{Cf}]/u.test(`${toolName}${ruleContent ?? ""}`) ||
    mayPublishToStarkPages({
      toolName,
      toolInput:
        ruleContent === undefined ? {} : { command: ruleContent.replace(/(?::\*| \*)$/, "") },
    })
  )
    return false;
  if (toolName === "Bash")
    return typeof ruleContent === "string" && safeCommandPrefix(ruleContent.replace(/:\*$/, " *"));
  if (toolName.startsWith("mcp__")) {
    // A single named server may grant tools; a wildcard server or namespace cannot.
    const match = /^mcp__([^*]+)__(.+)$/.exec(toolName);
    return (
      match !== null &&
      !match[1]!.includes("?") &&
      !match[2]!.includes("*") &&
      !match[2]!.includes("?") &&
      !/^(?:stark.?pages|spage|pages?)$/i.test(match[1]!)
    );
  }
  return !toolName.includes("*") && !toolName.includes("?");
}

interface ClaudeApprovalRequest {
  readonly suggestions?: ReadonlyArray<PermissionUpdate> | undefined;
  readonly matchedAskRule?: unknown;
  readonly suppressAlwaysAllowRule?: boolean | undefined;
}

const formatRule = (rule: { toolName: string; ruleContent?: string }) =>
  rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
// An approved mode switch lasts as long as Claude's session: until the chat's mode, model or
// the app changes, which starts a new Claude process. The adapter does not put it back before
// the next prompt (claudeModeBeforePrompt). bypassPermissions is left out so a session grant
// cannot get around the account's bypass opt-in or the rule that subagents never inherit it.
const SESSION_MODE_DETAILS: Partial<Record<PermissionMode, string>> = {
  acceptEdits: "Edits allowed without asking for this session",
  default: "Asks before each action for this session",
  plan: "Switches to plan mode until you implement a plan",
  dontAsk: "Denies anything not already allowed for this session",
  auto: "Switches to auto mode for this session",
};

/** One line saying what a Claude suggestion does at session scope, or undefined if it cannot be shown truthfully. */
function sessionUpdateDetail(update: PermissionUpdate): string | undefined {
  switch (update.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules": {
      if (update.rules.length === 0) return undefined;
      const rules = update.rules.map(formatRule).join(", ");
      if (update.type === "replaceRules")
        return `Replaces this session's ${update.behavior} rules with ${rules}`;
      if (update.type === "removeRules")
        return `Removes the ${update.behavior} rules ${rules} for this session`;
      return update.behavior === "allow"
        ? `Allows ${rules} for this session`
        : update.behavior === "deny"
          ? `Blocks ${rules} for this session`
          : `Asks before ${rules} for this session`;
    }
    case "setMode":
      return Object.hasOwn(SESSION_MODE_DETAILS, update.mode)
        ? SESSION_MODE_DETAILS[update.mode]
        : undefined;
    case "addDirectories":
    case "removeDirectories": {
      if (update.directories.length === 0) return undefined;
      const directories = update.directories.join(", ");
      return update.type === "addDirectories"
        ? `Adds ${directories} to the allowed folders for this session`
        : `Removes ${directories} from the allowed folders for this session`;
    }
    default:
      return undefined;
  }
}

/**
 * "Allow for this session" answers with exactly Claude's own suggestions, moved to session
 * scope, and never with a rule Stark makes up. There is no session choice when Claude suggested
 * nothing, matched an ask rule, suppressed remembering, or suggested something the card cannot
 * describe.
 */
function claudeSessionGrant(
  input: ClaudeApprovalRequest,
): { readonly updates: PermissionUpdate[]; readonly detail: string } | undefined {
  const suggestions = input.suggestions ?? [];
  if (input.matchedAskRule || input.suppressAlwaysAllowRule || suggestions.length === 0)
    return undefined;
  const details = suggestions.map(sessionUpdateDetail);
  if (details.some((detail) => detail === undefined || /[\p{Cc}\p{Cf}]/u.test(detail)))
    return undefined;
  return {
    updates: suggestions.map((suggestion) => ({ ...suggestion, destination: "session" })),
    detail: details.join("; "),
  };
}

export function toPermissionUpdates(
  input: ClaudeApprovalRequest,
  scope: "session" | "project",
): PermissionUpdate[] {
  if (scope === "session") return claudeSessionGrant(input)?.updates ?? [];
  const updates = (input.suggestions ?? []).filter(
    (suggestion): suggestion is Extract<PermissionUpdate, { type: "addRules" }> =>
      suggestion.type === "addRules" && suggestion.behavior === "allow",
  );
  if (
    updates.length === 0 ||
    updates.some(
      (update) =>
        update.rules.length === 0 ||
        update.rules.some((rule) => !isSafeClaudeSavedRule(rule.toolName, rule.ruleContent)),
    )
  )
    return [];
  return updates.map((suggestion) => ({ ...suggestion, destination: "localSettings" }));
}

/**
 * The answers a Claude permission request offers, each with its server-issued option id
 * (`<class>:<n>`) and what it does. The adapter binds every id to the exact PermissionResult
 * it sends (ClaudeAdapterV2's claudeApprovalChoices).
 */
export function claudeApprovalOptions(
  input: ClaudeApprovalRequest & {
    toolName: string;
    toolInput: unknown;
    isWorktree?: boolean | undefined;
  },
): ProviderApprovalOption[] {
  // A call that publishes or may publish to Stark Pages is decided one call at a time.
  if (mayPublishToStarkPages(input)) return [...withApprovalOptionIds(CLAUDE_ONCE_OPTIONS)];
  const session = claudeSessionGrant(input);
  const options: ProviderApprovalOption[] = [
    ...CLAUDE_ONCE_OPTIONS,
    ...(session
      ? [{ ...SESSION_OPTION, detail: session.detail, scope: "session", effect: "allow" } as const]
      : []),
  ];
  const updates = toPermissionUpdates(input, "project");
  if (
    input.matchedAskRule ||
    input.suppressAlwaysAllowRule ||
    updates.length === 0 ||
    (input.suggestions ?? []).some(
      (suggestion) => suggestion.type !== "addRules" || suggestion.behavior !== "allow",
    )
  )
    return [...withApprovalOptionIds(options)];
  const rulePreview = updates.flatMap((update) =>
    update.type === "addRules" ? update.rules.map(formatRule) : [],
  );
  return [
    ...withApprovalOptionIds([
      ...options,
      {
        decision: "acceptAlways",
        label: input.isWorktree ? "Always allow in this worktree" : "Always allow in this project",
        rulePreview,
        warning: `Saves these rules in this ${input.isWorktree ? "worktree" : "project"}'s .claude/settings.local.json.`,
        scope: "persistent",
        effect: "allow",
        persistsTo: "claude-local-settings",
      },
    ]),
  ];
}
