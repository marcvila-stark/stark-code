import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";

import {
  codexConfiguredPermissions,
  readCodexConfiguredPermissions,
  registerCodexConfigReader,
} from "./CodexEffectivePermissions.ts";

describe("Codex configured permissions", () => {
  it("shows what Codex's configuration and requirements set, in Codex's words", () => {
    const { configured, rows } = codexConfiguredPermissions({
      config: {
        approval_policy: "on-request",
        approvals_reviewer: "auto_review",
        sandbox_mode: "workspace-write",
      },
      requirements: {
        allowedApprovalPolicies: ["untrusted", "on-request"],
        allowedSandboxModes: ["read-only", "workspace-write"],
      },
    });
    assert.deepStrictEqual(configured, {
      permissionSource: "inherit",
      nativeMode: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    });
    assert.deepStrictEqual(
      rows.map((row) => [row.id, row.value, row.nativeValue ?? null, row.origin]),
      [
        [
          "codex-config-approval-policy",
          "Asks when Codex decides it should",
          "on-request",
          "codex-config",
        ],
        [
          "codex-config-approvals-reviewer",
          "Codex automatic review",
          "auto_review",
          "codex-config",
        ],
        ["codex-config-sandbox", "Writes inside the workspace", "workspace-write", "codex-config"],
        ["codex-requirements-approval-policies", "untrusted, on-request", null, "requirements"],
        ["codex-requirements-sandbox-modes", "read-only, workspace-write", null, "requirements"],
      ],
    );
  });

  it("says when a setting is Codex's default, and shows a profile instead of a sandbox", () => {
    const { configured, rows } = codexConfiguredPermissions({
      config: { approval_policy: { granular: { rules: true } }, default_permissions: "locked" },
      requirements: null,
    });
    assert.deepStrictEqual(configured, {
      permissionSource: "inherit",
      nativeMode: "granular",
      permissionProfile: "locked",
    });
    assert.deepStrictEqual(
      rows.map((row) => [row.id, row.value]),
      [
        ["codex-config-approval-policy", "Asks for the categories it lists"],
        ["codex-config-approvals-reviewer", "Not set: Codex's default"],
        ["codex-config-permission-profile", "locked"],
      ],
    );
  });

  it.effect("asks the chat's Codex instance, and reports nothing it cannot prove", () => {
    const asked: Array<string> = [];
    const instanceA = ProviderInstanceId.make("codex-test-a");
    const unregister = registerCodexConfigReader(instanceA, (cwd) =>
      Effect.sync(() => {
        asked.push(cwd);
        return { config: { approval_policy: "untrusted" } };
      }),
    );
    const read = (cwd: string | null, providerInstanceId: ProviderInstanceId) =>
      readCodexConfiguredPermissions({ cwd, providerInstanceId, providerSessionId: null });
    return Effect.gen(function* () {
      assert.equal((yield* read("/workspace", instanceA)).configured?.nativeMode, "untrusted");
      assert.deepStrictEqual(asked, ["/workspace"]);
      // No folder, an instance with no Codex reader, or no answer: unknown.
      assert.isNull((yield* read(null, instanceA)).configured);
      assert.isNull(
        (yield* read("/workspace", ProviderInstanceId.make("codex-missing"))).configured,
      );
      const instanceB = ProviderInstanceId.make("codex-test-b");
      const unregisterSecond = registerCodexConfigReader(instanceB, () =>
        Effect.succeed(undefined),
      );
      yield* Effect.gen(function* () {
        assert.isNull((yield* read("/workspace", instanceB)).configured);
      }).pipe(Effect.ensuring(Effect.sync(unregisterSecond)));
      unregister();
      assert.isNull((yield* read("/workspace", instanceA)).configured);
    }).pipe(Effect.ensuring(Effect.sync(unregister)));
  });
});
