import { describe, expect, it } from "@effect/vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeApprovalOptions,
  codexApprovalOptions,
  toPermissionUpdates,
  validatedCodexExecpolicyAmendment,
} from "./ApprovalRulePolicy.ts";
const suggestion = (toolName = "Bash", ruleContent?: string): PermissionUpdate => ({
  type: "addRules",
  rules: [{ toolName, ...(ruleContent === undefined ? {} : { ruleContent }) }],
  behavior: "allow",
  destination: "session",
});
const always = (options: ReturnType<typeof claudeApprovalOptions>) =>
  options.find((option) => option.decision === "acceptAlways");
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
    expect(toPermissionUpdates("Bash", suggestions, "session")).toEqual([
      suggestion("Bash", "npm run test *"),
    ]);
    expect(toPermissionUpdates("Bash", suggestions, "project")).toEqual([
      { ...suggestion("Bash", "npm run test *"), destination: "localSettings" },
    ]);
    expect(toPermissionUpdates("Bash", undefined, "project")).toEqual([]);
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
      { toolName: "mcp__stark_pages__publish", toolInput: {} },
      { toolName: "Bash", toolInput: { command: "spage publish page" } },
      { toolName: "Bash", toolInput: { command: "curl -X PUT https://bucket.s3.amazonaws.com/x" } },
    ]) {
      expect(
        claudeApprovalOptions({ ...request, suggestions: base.suggestions }).map(
          (option) => option.decision,
        ),
      ).toEqual(["decline", "accept"]);
    }
  });
  it("uses only exact Codex-proposed command arrays and warns about sandbox escape", () => {
    const proposal = ["npm", "test"];
    expect(validatedCodexExecpolicyAmendment(proposal)).toEqual(proposal);
    expect(
      codexApprovalOptions({ requestKind: "command", proposedExecpolicyAmendment: proposal }),
    ).toContainEqual(
      expect.objectContaining({
        decision: "acceptAlways",
        rulePreview: ['prefix_rule(pattern=["npm","test"], decision="allow")'],
        warning: expect.stringContaining("outside the sandbox"),
      }),
    );
    expect(
      always(
        codexApprovalOptions({ requestKind: "file-change", proposedExecpolicyAmendment: proposal }),
      ),
    ).toBeUndefined();
    expect(
      always(
        codexApprovalOptions({ requestKind: "permission", proposedExecpolicyAmendment: proposal }),
      ),
    ).toBeUndefined();
    for (const unsafe of [
      [],
      ["git"],
      ["bash", "-c"],
      ["python3", "script.py"],
      ["npm", "*"],
      ["npm", "test; rm -rf /"],
    ])
      expect(validatedCodexExecpolicyAmendment(unsafe)).toBeNull();
  });
});
