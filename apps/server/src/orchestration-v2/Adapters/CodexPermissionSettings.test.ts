import { describe, expect, it } from "@effect/vitest";

import {
  codexActivePermissionSettings,
  codexInheritProof,
  codexPermissionSource,
  codexRuntimeModeTurnDefaults,
  isCodexUntrustedRejection,
} from "./CodexPermissionSettings.ts";

const supervised = codexRuntimeModeTurnDefaults("approval-required");

describe("Codex inherit proof", () => {
  it("fails closed while Codex still reports Stark's override", () => {
    expect(
      codexInheritProof({
        reported: {
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
        },
        override: supervised,
      }).proven,
    ).toBe(false);
  });

  it("proves a reload cleared the override when the settings differ from it", () => {
    expect(
      codexInheritProof({
        reported: {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          activePermissionProfile: { id: ":workspace" },
        },
        override: supervised,
        // The reviewer matches Stark's, so only the user's config proves it.
        configured: { approvals_reviewer: "user" },
      }).proven,
    ).toBe(true);
  });

  it("accepts a value equal to Stark's only when the user's config sets it explicitly", () => {
    const reported = {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly" },
      activePermissionProfile: null,
    };
    const override = codexRuntimeModeTurnDefaults("auto-accept-edits");
    // The policy and reviewer equal the override's, so Codex may still be applying it.
    expect(codexInheritProof({ reported, override }).proven).toBe(false);
    expect(
      codexInheritProof({
        reported,
        override,
        configured: { approval_policy: "on-request", approvals_reviewer: "user" },
      }).proven,
    ).toBe(true);
  });

  it("does not take a legacy sandbox as the user's when a permission profile is configured", () => {
    expect(
      codexInheritProof({
        reported: {
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly" },
          activePermissionProfile: null,
        },
        override: supervised,
        configured: {
          approval_policy: "untrusted",
          approvals_reviewer: "user",
          sandbox_mode: "read-only",
          default_permissions: "deny-env",
        },
      }).proven,
    ).toBe(false);
  });

  it("cannot prove anything Codex did not report", () => {
    expect(codexInheritProof({ reported: undefined, override: supervised }).proven).toBe(false);
  });
});

describe("Codex untrusted fallback", () => {
  it("recognizes Codex rejecting untrusted, and nothing else", () => {
    expect(
      isCodexUntrustedRejection({
        code: -32600,
        errorMessage:
          "Invalid request: unknown variant `untrusted`, expected one of `on-request`, `never`",
      }),
    ).toBe(true);
    expect(isCodexUntrustedRejection({ code: -32600, errorMessage: "Already initialized" })).toBe(
      false,
    );
    expect(
      isCodexUntrustedRejection({ code: -32603, errorMessage: "unknown variant `untrusted`" }),
    ).toBe(false);
  });
});

describe("Codex permission source and reported settings", () => {
  it("treats a policy that names no source as a saved chat's override", () => {
    const policy = {
      runtimeMode: "approval-required",
      interactionMode: "default",
      cwd: null,
    } as const;
    expect(codexPermissionSource(policy)).toBe("override");
    expect(codexPermissionSource({ ...policy, permissionSource: "inherit" })).toBe("inherit");
  });

  it("reports a thread's settings in Codex's own words", () => {
    expect(
      codexActivePermissionSettings(
        {
          approvalPolicy: { granular: { rules: true } },
          approvalsReviewer: "auto_review",
          sandbox: { type: "dangerFullAccess" },
          activePermissionProfile: { id: "builder" },
        },
        "settings-updated",
        "2026-10-30T12:00:00.000Z",
      ),
    ).toEqual({
      nativeMode: "granular",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
      permissionProfile: "builder",
      reportedBy: "settings-updated",
      reportedAt: "2026-10-30T12:00:00.000Z",
    });
    expect(codexActivePermissionSettings({}, "thread-resume", "2026-10-30T12:00:00.000Z")).toEqual({
      reportedBy: "thread-resume",
      reportedAt: "2026-10-30T12:00:00.000Z",
    });
  });
});
