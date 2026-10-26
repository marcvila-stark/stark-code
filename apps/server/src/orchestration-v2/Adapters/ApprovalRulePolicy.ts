import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderApprovalOption } from "@starkfuture/contracts";

const ONCE_OPTIONS = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve once" },
] as const satisfies ReadonlyArray<ProviderApprovalOption>;
const SESSION_OPTION = { decision: "acceptForSession", label: "Allow for this session" } as const;
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

/** Publishing and uploads always require a fresh human decision, including wrapper commands. */
export function isStarkPublishRequest(toolName: string, toolInput: unknown): boolean {
  const values: unknown[] = [toolInput];
  const seen = new Set<object>();
  const parts = [toolName];
  for (let index = 0; index < values.length; index++) {
    if (index > 65_536) return true;
    const value = values[index];
    if (typeof value === "string") parts.push(value);
    else if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      for (const [key, entry] of Object.entries(value)) {
        parts.push(key);
        values.push(entry);
      }
    }
  }
  const text = parts.join(" ");
  return (
    /\bspage\b[\s\S]*\b(?:publish|upload)\b/i.test(text) ||
    /(?:put|upload)[\s\S]*(?:s3|amazonaws)|(?:s3|amazonaws)[\s\S]*(?:put|upload)/i.test(text) ||
    /(?:stark.?pages|spage|pages?)[_: .-]+(?:publish|upload|write|create|update|save|delete|put)|(?:publish|upload|write|create|update|save|delete|put)[_: .-]+(?:stark.?pages|spage|pages?)/i.test(
      text,
    ) ||
    /(?:mcp__)?[^\s]*(?:stark.?pages|spage|pages?)[^\s]*(?:publish|upload|write|create|update|save|delete|put)/i.test(
      toolName,
    ) ||
    /(?:publish|upload|write|create|update|save|delete|put)[^\s]*(?:stark.?pages|spage|pages?)/i.test(
      toolName,
    )
  );
}

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

export function isSafeClaudeSavedRule(toolName: string, ruleContent?: string): boolean {
  if (
    !toolName ||
    /[\p{Cc}\p{Cf}]/u.test(`${toolName}${ruleContent ?? ""}`) ||
    isStarkPublishRequest(toolName, ruleContent)
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
      !/^(?:stark.?pages|spage|pages?)$/i.test(match[1]!) &&
      !isStarkPublishRequest(toolName, ruleContent)
    );
  }
  return !toolName.includes("*") && !toolName.includes("?");
}

export function toPermissionUpdates(
  toolName: string,
  suggestions: ReadonlyArray<PermissionUpdate> | undefined,
  scope: "session" | "project",
): PermissionUpdate[] {
  const updates = (suggestions ?? []).filter(
    (suggestion): suggestion is Extract<PermissionUpdate, { type: "addRules" }> =>
      suggestion.type === "addRules" && suggestion.behavior === "allow",
  );
  if (
    scope === "project" &&
    (updates.length === 0 ||
      updates.some(
        (update) =>
          update.rules.length === 0 ||
          update.rules.some((rule) => !isSafeClaudeSavedRule(rule.toolName, rule.ruleContent)),
      ))
  )
    return [];
  if (updates.length > 0)
    return updates.map((suggestion) => ({
      ...suggestion,
      destination: scope === "project" ? "localSettings" : "session",
    }));
  // Session-only fallback preserves the CLI's old tool scope without saving it to disk.
  return scope === "session"
    ? [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }]
    : [];
}

export function claudeApprovalOptions(input: {
  toolName: string;
  toolInput: unknown;
  suggestions?: ReadonlyArray<PermissionUpdate> | undefined;
  matchedAskRule?: unknown;
  suppressAlwaysAllowRule?: boolean | undefined;
  isWorktree?: boolean | undefined;
}): ProviderApprovalOption[] {
  if (isStarkPublishRequest(input.toolName, input.toolInput)) return [...ONCE_OPTIONS];
  const options: ProviderApprovalOption[] = [...ONCE_OPTIONS, SESSION_OPTION];
  const updates = toPermissionUpdates(input.toolName, input.suggestions, "project");
  if (
    input.matchedAskRule ||
    input.suppressAlwaysAllowRule ||
    updates.length === 0 ||
    (input.suggestions ?? []).some(
      (suggestion) => suggestion.type !== "addRules" || suggestion.behavior !== "allow",
    )
  )
    return options;
  const rulePreview = updates.flatMap((update) =>
    update.type === "addRules"
      ? update.rules.map((rule) =>
          rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName,
        )
      : [],
  );
  return [
    ...options,
    {
      decision: "acceptAlways",
      label: input.isWorktree ? "Always allow in this worktree" : "Always allow in this project",
      rulePreview,
      warning: `Saves these rules in this ${input.isWorktree ? "worktree" : "project"}'s .claude/settings.local.json.`,
    },
  ];
}

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
        !/[\r\n\x00-\x1f\x7f*?;&|`<>]|\$\(/.test(part),
    )
  )
    return null;
  if (
    INTERPRETERS.has(basename(proposal[0]!)) ||
    /^(?:python|node|ruby|perl)\d+(?:\.\d+)*$/.test(basename(proposal[0]!)) ||
    isStarkPublishRequest("Bash", command ?? proposal.join(" "))
  )
    return null;
  return [...proposal];
}

export function codexApprovalOptions(input: {
  proposedExecpolicyAmendment?: unknown;
  command?: string;
  requestKind: string;
}): ProviderApprovalOption[] {
  if (isStarkPublishRequest("Bash", input.command)) return [...ONCE_OPTIONS];
  const options: ProviderApprovalOption[] = [...ONCE_OPTIONS, SESSION_OPTION];
  const proposal =
    input.requestKind === "command"
      ? validatedCodexExecpolicyAmendment(input.proposedExecpolicyAmendment, input.command)
      : null;
  return proposal
    ? [
        ...options,
        {
          decision: "acceptAlways",
          label: "Always allow (Codex, every project)",
          rulePreview: [`prefix_rule(pattern=${JSON.stringify(proposal)}, decision="allow")`],
          warning:
            "Matching commands run outside the sandbox without prompting. This rule applies to every project using this Codex home.",
        },
      ]
    : options;
}
