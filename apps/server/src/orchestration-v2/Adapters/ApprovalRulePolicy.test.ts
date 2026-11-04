import { describe, expect, it } from "@effect/vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { claudeApprovalOptions, toPermissionUpdates } from "./ApprovalRulePolicy.ts";
const suggestion = (toolName = "Bash", ruleContent?: string): PermissionUpdate => ({
  type: "addRules",
  rules: [{ toolName, ...(ruleContent === undefined ? {} : { ruleContent }) }],
  behavior: "allow",
  destination: "session",
});
const always = (options: ReturnType<typeof claudeApprovalOptions>) =>
  options.find((option) => option.decision === "acceptAlways");
const session = (options: ReturnType<typeof claudeApprovalOptions>) =>
  options.find((option) => option.decision === "acceptForSession");
describe("Claude session approval", () => {
  it.each([
    {
      name: "Write with setMode acceptEdits",
      toolName: "Write",
      toolInput: { file_path: "/repo/a.txt", content: "a" },
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      detail: "Edits allowed without asking for this session",
    },
    {
      name: "Bash outside the allowed folders with addDirectories",
      toolName: "Bash",
      toolInput: { command: "printf x > /tmp/out/a.txt" },
      suggestions: [{ type: "addDirectories", directories: ["/tmp/out"], destination: "session" }],
      detail: "Adds /tmp/out to the allowed folders for this session",
    },
    {
      name: "Bash with addRules",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      suggestions: [suggestion("Bash", "npm test:*")],
      detail: "Allows Bash(npm test:*) for this session",
    },
  ] satisfies ReadonlyArray<{
    name: string;
    toolName: string;
    toolInput: unknown;
    suggestions: PermissionUpdate[];
    detail: string;
  }>)("$name sends exactly Claude's suggestion at session scope", (request) => {
    expect(toPermissionUpdates(request, "session")).toEqual(request.suggestions);
    expect(session(claudeApprovalOptions(request))).toEqual({
      decision: "acceptForSession",
      label: "Allow for this session",
      detail: request.detail,
      optionId: "session:0",
      scope: "session",
      effect: "allow",
    });
  });
  it("moves a suggested destination to session and never adds a whole-tool rule", () => {
    const suggestions: PermissionUpdate[] = [
      { ...suggestion("Bash", "git status"), destination: "localSettings" },
      { ...suggestion("Bash", "git diff:*"), destination: "projectSettings" },
    ];
    expect(toPermissionUpdates({ suggestions }, "session")).toEqual([
      suggestion("Bash", "git status"),
      suggestion("Bash", "git diff:*"),
    ]);
    expect(
      session(claudeApprovalOptions({ toolName: "Bash", toolInput: {}, suggestions }))?.detail,
    ).toBe("Allows Bash(git status) for this session; Allows Bash(git diff:*) for this session");
  });
  it.each([
    { name: "no suggestions", suggestions: undefined },
    { name: "an empty suggestion list", suggestions: [] },
    {
      name: "suppressAlwaysAllowRule",
      suggestions: [suggestion("Bash", "npm test:*")],
      suppressAlwaysAllowRule: true,
    },
    {
      name: "a matched ask rule",
      suggestions: [suggestion("Bash", "npm test:*")],
      matchedAskRule: { source: "projectSettings", toolName: "Bash" },
    },
    {
      name: "a bypassPermissions mode switch",
      suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
    },
    {
      name: "an addRules suggestion without rules",
      suggestions: [{ type: "addRules", rules: [], behavior: "allow", destination: "session" }],
    },
    {
      name: "a rule hidden by control characters",
      suggestions: [suggestion("Bash", "npm test\u202e:*")],
    },
  ] satisfies ReadonlyArray<{
    name: string;
    suggestions: PermissionUpdate[] | undefined;
    suppressAlwaysAllowRule?: boolean;
    matchedAskRule?: unknown;
  }>)("offers no session choice for $name", (input) => {
    const request = { toolName: "Bash", toolInput: { command: "npm test" }, ...input };
    expect(toPermissionUpdates(request, "session")).toEqual([]);
    expect(claudeApprovalOptions(request).map((option) => option.decision)).toEqual([
      "decline",
      "cancel",
      "accept",
    ]);
  });
});
describe("Claude approval option ids", () => {
  it("gives every answer a server id of its class, and both denials take a reason", () => {
    const options = claudeApprovalOptions({
      toolName: "Bash",
      toolInput: { command: "npm test" },
      suggestions: [suggestion("Bash", "npm test:*")],
    });
    expect(
      options.map(({ optionId, decision, scope, effect, persistsTo, acceptsFeedback }) => ({
        optionId,
        decision,
        scope,
        effect,
        persistsTo,
        acceptsFeedback,
      })),
    ).toEqual([
      {
        optionId: "deny:0",
        decision: "decline",
        scope: "once",
        effect: "deny",
        persistsTo: undefined,
        acceptsFeedback: true,
      },
      {
        optionId: "deny-stop:0",
        decision: "cancel",
        scope: "once",
        effect: "deny_and_stop",
        persistsTo: undefined,
        acceptsFeedback: true,
      },
      {
        optionId: "once:0",
        decision: "accept",
        scope: "once",
        effect: "allow",
        persistsTo: undefined,
        acceptsFeedback: undefined,
      },
      {
        optionId: "session:0",
        decision: "acceptForSession",
        scope: "session",
        effect: "allow",
        persistsTo: undefined,
        acceptsFeedback: undefined,
      },
      {
        optionId: "persistent:0",
        decision: "acceptAlways",
        scope: "persistent",
        effect: "allow",
        persistsTo: "claude-local-settings",
        acceptsFeedback: undefined,
      },
    ]);
  });
});
describe("narrow remembered approval policy", () => {
  it("keeps only addRules/allow and never converts a mode or directory change into a persistent rule", () => {
    const suggestions: PermissionUpdate[] = [
      suggestion("Bash", "npm run test *"),
      { type: "setMode", mode: "acceptEdits", destination: "session" },
      { type: "addDirectories", directories: ["/"], destination: "session" },
      { type: "removeDirectories", directories: ["/repo"], destination: "session" },
      {
        type: "replaceRules",
        rules: [{ toolName: "Bash" }],
        behavior: "allow",
        destination: "session",
      },
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "deny", destination: "session" },
    ];
    expect(toPermissionUpdates({ suggestions }, "project")).toEqual([
      { ...suggestion("Bash", "npm run test *"), destination: "localSettings" },
    ]);
    expect(toPermissionUpdates({}, "project")).toEqual([]);
    expect(
      always(
        claudeApprovalOptions({ toolName: "Edit", toolInput: {}, suggestions: [suggestions[1]!] }),
      ),
    ).toBeUndefined();
  });
  it("previews exact safe rules and labels worktree-local persistence", () => {
    expect(
      always(
        claudeApprovalOptions({
          toolName: "Bash",
          toolInput: { command: "npm run test" },
          suggestions: [suggestion("Bash", "npm run test *")],
          isWorktree: true,
        }),
      ),
    ).toMatchObject({
      label: "Always allow in this worktree",
      rulePreview: ["Bash(npm run test *)"],
    });
  });
  it.each([
    undefined,
    "*",
    "bash *",
    "/bin/zsh -c *",
    "python *",
    "node *",
    "env *",
    "sudo npm *",
    "rm file",
    "npm *",
    "curl -X PUT *",
    "spage publish *",
    // Only "may publish": the command word is an unresolved variable.
    "$SPAGE_BIN publish *",
  ])("hides broad Bash rule %s", (content) => {
    expect(
      always(
        claudeApprovalOptions({
          toolName: "Bash",
          toolInput: { command: "npm test" },
          suggestions: [suggestion("Bash", content)],
        }),
      ),
    ).toBeUndefined();
  });
  it("hides always for ask/suppression, MCP namespace wildcards and Pages calls; publishing cannot grant a session", () => {
    const base = {
      toolName: "Bash",
      toolInput: { command: "npm test" },
      suggestions: [suggestion("Bash", "npm test")],
    };
    expect(
      always(claudeApprovalOptions({ ...base, matchedAskRule: { source: "project" } })),
    ).toBeUndefined();
    expect(
      always(claudeApprovalOptions({ ...base, suppressAlwaysAllowRule: true })),
    ).toBeUndefined();
    expect(
      always(claudeApprovalOptions({ ...base, suggestions: [suggestion("mcp__*")] })),
    ).toBeUndefined();
    for (const request of [
      { toolName: "mcp__stark_pages__pages_upload_begin", toolInput: {} },
      { toolName: "Bash", toolInput: { command: "spage publish page" } },
      {
        toolName: "Bash",
        toolInput: { command: "curl -X PUT https://vibecoded-apps.s3.amazonaws.com/x" },
      },
      // A command the guard cannot resolve that may publish.
      { toolName: "Bash", toolInput: { command: "$CMD publish ./site" } },
    ]) {
      expect(
        claudeApprovalOptions({ ...request, suggestions: base.suggestions }).map(
          (option) => option.decision,
        ),
      ).toEqual(["decline", "cancel", "accept"]);
    }
  });
});
