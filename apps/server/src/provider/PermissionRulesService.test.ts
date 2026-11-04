import { assert, describe, it } from "@effect/vitest";

import { activePermissionRow, starkPolicyRows } from "./PermissionRulesService.ts";

describe("activePermissionRow", () => {
  const reportedAt = "2026-10-30T12:00:00.000Z";

  it("names Claude's reported mode as the picker does and keeps Claude's word beside it", () => {
    assert.deepInclude(
      activePermissionRow("claudeAgent", {
        nativeMode: "acceptEdits",
        interactionMode: "default",
        reportedBy: "session-init",
        reportedAt,
      }),
      {
        value: "Accept edits",
        nativeValue: "acceptEdits",
        origin: "provider-session",
        detail: "Reported by Claude when the session started.",
      },
    );
  });

  it("shows everything Codex reported for the live thread", () => {
    assert.deepInclude(
      activePermissionRow("codex", {
        nativeMode: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        permissionProfile: "deny-secrets",
        reportedBy: "thread-resume",
        reportedAt,
      }),
      {
        value: "on-request",
        nativeValue: "on-request",
        detail:
          "Sandbox: workspace-write · Reviewer: auto_review · Permission profile: deny-secrets. Reported by Codex when the thread resumed.",
      },
    );
  });

  it("says when nothing was reported instead of guessing", () => {
    assert.deepInclude(activePermissionRow("codex", null), {
      value: "Not reported yet",
      origin: "unknown",
    });
  });
});

describe("starkPolicyRows", () => {
  const thread = {
    runtimeMode: "approval-required",
    interactionMode: "default",
    permissionSource: "override",
  } as const;
  const ids = (driver: string, bypassAllowed = false) =>
    starkPolicyRows({ driver, thread, bypassAllowed }).map((row) => row.id);

  it("lists every Stark policy, since clients show the server's list instead of their own", () => {
    const claude = ids("claudeAgent");
    for (const id of [
      "stark-pages",
      "stark-settings-write",
      "stark-child-bypass",
      "stark-bypass-opt-in",
      "stark-saved-rules",
    ])
      assert.include(claude, id);
    const codex = ids("codex");
    for (const id of [
      "stark-pages",
      "stark-settings-write",
      "stark-child-bypass",
      "stark-supervised",
      "stark-codex-decisions",
      "stark-codex-auto-review",
    ])
      assert.include(codex, id);
    for (const list of [claude, codex, ids("opencode")])
      assert.equal(new Set(list).size, list.length, "each policy once");
  });

  it("says whether the account allows Bypass and what Pages does in Claude chats", () => {
    const value = (bypassAllowed: boolean, id: string) =>
      starkPolicyRows({ driver: "claudeAgent", thread, bypassAllowed }).find((row) => row.id === id)
        ?.value;
    assert.include(value(false, "stark-bypass-opt-in"), "Off for this account");
    assert.include(value(true, "stark-bypass-opt-in"), "Allowed for this account");
    assert.include(value(false, "stark-pages"), "may publish asks first");
  });
});
