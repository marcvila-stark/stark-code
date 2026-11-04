import { assert, describe, it } from "@effect/vitest";
import type { ProviderApprovalOption, RuntimeMode } from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

import {
  codexApprovalOptionsForClients,
  codexCommandApprovalChoices,
} from "./Adapters/CodexApprovalOptions.ts";
import {
  dispatchLimitModes,
  effectiveRuntimeMode,
  isNarrowestPreset,
  isPersistentChoice,
  narrowsPermissions,
  permissionFreezeFor,
  requestedPermissionSettings,
  resolveApprovalChoice,
  supervisedRuntimePolicy,
  switchedPermissionFields,
} from "./PermissionPolicy.ts";

const CLAUDE_WITHOUT_BYPASS = {
  driver: "claudeAgent",
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto"] as const,
};
const CLAUDE_WITH_BYPASS = {
  driver: "claudeAgent",
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"] as const,
};
const CODEX = { driver: "codex", supportedRuntimeModes: undefined };

describe("effectiveRuntimeMode", () => {
  it("is what the provider actually runs, not what is stored", () => {
    assert.equal(effectiveRuntimeMode("full-access", CLAUDE_WITHOUT_BYPASS), "approval-required");
    assert.equal(effectiveRuntimeMode("full-access", CLAUDE_WITH_BYPASS), "full-access");
    assert.equal(effectiveRuntimeMode("auto", CLAUDE_WITHOUT_BYPASS), "auto");
    // Stark runs every non-Claude session Supervised under this brand.
    for (const mode of ["auto-accept-edits", "auto", "full-access"] as const) {
      assert.equal(effectiveRuntimeMode(mode, CODEX), "approval-required");
    }
    // An instance this build does not know keeps its stored mode.
    assert.equal(
      effectiveRuntimeMode("auto", { driver: undefined, supportedRuntimeModes: undefined }),
      "auto",
    );
  });
});

describe("permissionFreezeFor", () => {
  const migratedAt = DateTime.makeUnsafe("2026-10-30T00:00:00.000Z");

  it("freezes a dormant Claude full-access chat while Bypass is off", () => {
    assert.deepStrictEqual(
      permissionFreezeFor({
        thread: { runtimeMode: "full-access" },
        capabilities: CLAUDE_WITHOUT_BYPASS,
      }),
      { from: "full-access", to: "approval-required", reason: "claude-bypass-not-allowed" },
    );
    // With Bypass allowed it already runs Bypass: nothing to freeze.
    assert.isUndefined(
      permissionFreezeFor({
        thread: { runtimeMode: "full-access" },
        capabilities: CLAUDE_WITH_BYPASS,
      }),
    );
  });

  it("aligns clamped providers' stored modes to Supervised", () => {
    assert.deepStrictEqual(
      permissionFreezeFor({ thread: { runtimeMode: "auto" }, capabilities: CODEX }),
      { from: "auto", to: "approval-required", reason: "provider-clamped" },
    );
    assert.isUndefined(
      permissionFreezeFor({ thread: { runtimeMode: "approval-required" }, capabilities: CODEX }),
    );
  });

  it("narrows only full access on an instance this build does not know", () => {
    const unknown = { driver: undefined, supportedRuntimeModes: undefined };
    assert.deepStrictEqual(
      permissionFreezeFor({ thread: { runtimeMode: "full-access" }, capabilities: unknown }),
      { from: "full-access", to: "approval-required", reason: "mode-not-offered" },
    );
    assert.isUndefined(
      permissionFreezeFor({ thread: { runtimeMode: "auto" }, capabilities: unknown }),
    );
  });

  it("never touches an inheriting chat or one already migrated", () => {
    assert.isUndefined(
      permissionFreezeFor({
        thread: { runtimeMode: "full-access", permissionSource: "inherit" },
        capabilities: CLAUDE_WITHOUT_BYPASS,
      }),
    );
    assert.isUndefined(
      permissionFreezeFor({
        thread: {
          runtimeMode: "full-access",
          permissionMigrations: [
            {
              migrationId: "perm-v1",
              from: "full-access",
              to: "approval-required",
              reason: "claude-bypass-not-allowed",
              migratedAt,
            },
          ],
        },
        capabilities: CLAUDE_WITHOUT_BYPASS,
      }),
    );
  });
});

describe("permission changes on one chat", () => {
  it("treats leaving the provider's own settings as a narrowing and entering them as not", () => {
    const override = (runtimeMode: RuntimeMode) => ({
      permissionSource: "override" as const,
      runtimeMode,
    });
    const inherit = {
      permissionSource: "inherit" as const,
      runtimeMode: "approval-required" as const,
    };
    assert.isTrue(narrowsPermissions(override("auto"), override("approval-required")));
    assert.isFalse(narrowsPermissions(override("approval-required"), override("auto")));
    assert.isTrue(narrowsPermissions(inherit, override("full-access")));
    assert.isFalse(narrowsPermissions(override("approval-required"), inherit));
    assert.isTrue(isNarrowestPreset("override", "approval-required"));
    assert.isFalse(isNarrowestPreset("inherit", "approval-required"));
  });

  it("counts an inheriting chat as full access for a limited sender", () => {
    assert.deepStrictEqual(
      dispatchLimitModes({
        runtimeMode: "approval-required",
        interactionMode: "default",
        permissionSource: "inherit",
      }),
      { runtimeMode: "full-access", interactionMode: "default" },
    );
    assert.deepStrictEqual(dispatchLimitModes({ runtimeMode: "auto", interactionMode: "plan" }), {
      runtimeMode: "auto",
      interactionMode: "plan",
    });
  });

  it("requests nothing native for an inheriting chat and today's mapping otherwise", () => {
    assert.deepStrictEqual(
      requestedPermissionSettings({
        driver: "claudeAgent",
        permissionSource: "inherit",
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
      { permissionSource: "inherit", preset: "approval-required", interactionMode: "default" },
    );
    assert.include(
      requestedPermissionSettings({
        driver: "codex",
        permissionSource: "override",
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
      { nativeMode: "untrusted", approvalsReviewer: "user", sandbox: "read-only" },
    );
  });
});

describe("switchedPermissionFields", () => {
  it("stores what the target runs, makes an inherited chat explicit and drops a waiting change", () => {
    assert.deepStrictEqual(switchedPermissionFields({ runtimeMode: "auto" }, CODEX), {
      runtimeMode: "approval-required",
    });
    assert.deepStrictEqual(
      switchedPermissionFields(
        {
          runtimeMode: "auto-accept-edits",
          permissionSource: "inherit",
          permissionChangePending: { requestedAt: DateTime.makeUnsafe(0) },
        },
        CLAUDE_WITHOUT_BYPASS,
      ),
      {
        runtimeMode: "auto-accept-edits",
        permissionSource: "override",
        permissionChangePending: null,
      },
    );
    // A dormant full-access chat moving to a Claude account without Bypass runs Manual.
    assert.equal(
      switchedPermissionFields({ runtimeMode: "full-access" }, CLAUDE_WITHOUT_BYPASS).runtimeMode,
      "approval-required",
    );
  });
});

describe("supervisedRuntimePolicy", () => {
  it("clamps a preset and leaves an allowed inherit to the provider", () => {
    assert.deepStrictEqual(
      supervisedRuntimePolicy({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/w",
        approvalPolicy: "never",
      }),
      { runtimeMode: "approval-required", interactionMode: "default", cwd: "/w" },
    );
    const inherit = {
      runtimeMode: "auto" as const,
      interactionMode: "default" as const,
      cwd: "/w",
      permissionSource: "inherit" as const,
    };
    assert.strictEqual(supervisedRuntimePolicy(inherit), inherit);
  });
});

describe("resolveApprovalChoice", () => {
  const claudeOptions: ReadonlyArray<ProviderApprovalOption> = [
    { decision: "accept", label: "Allow once" },
    {
      decision: "acceptForSession",
      label: "Allow for this session",
      scope: "session",
      nativePayload: [{ type: "addDirectories", directories: ["/tmp"], destination: "session" }],
    },
    {
      decision: "acceptAlways",
      label: "Always allow",
      scope: "persistent",
      persistsTo: "claude-local-settings",
      rulePreview: ["Bash(npm test)"],
    },
    { decision: "decline", label: "Deny", acceptsFeedback: true },
  ];

  it("records the exact option and native payload the user chose", () => {
    const result = resolveApprovalChoice({ optionId: "session:0", options: claudeOptions });
    assert.deepStrictEqual(result, {
      _tag: "chosen",
      choice: {
        optionId: "session:0",
        decision: "acceptForSession",
        scope: "session",
        nativePayload: [{ type: "addDirectories", directories: ["/tmp"], destination: "session" }],
      },
    });
  });

  it("refuses an option the request did not offer", () => {
    assert.equal(
      resolveApprovalChoice({ optionId: "turn:0", options: claudeOptions })._tag,
      "refused",
    );
  });

  it("refuses a stale session answer instead of silently allowing once", () => {
    const onceOnly: ReadonlyArray<ProviderApprovalOption> = [
      { decision: "accept", label: "Allow once" },
      { decision: "decline", label: "Deny" },
    ];
    assert.equal(
      resolveApprovalChoice({ decision: "acceptForSession", options: onceOnly })._tag,
      "refused",
    );
    // A denial the request did not list is refused up front too: a provider that
    // lists its decisions (Codex) cannot take it, so it would end undelivered.
    assert.deepStrictEqual(resolveApprovalChoice({ decision: "cancel", options: onceOnly }), {
      _tag: "refused",
      reason: "This choice is no longer offered. Choose again from the request.",
    });
    // The listed denial still maps for an older client.
    assert.equal(resolveApprovalChoice({ decision: "decline", options: onceOnly })._tag, "chosen");
    // A request recorded before options existed takes any decision, as before option ids.
    assert.deepStrictEqual(resolveApprovalChoice({ decision: "cancel", options: undefined }), {
      _tag: "chosen",
      choice: { decision: "cancel" },
    });
  });

  it("refuses every answer to a request that explicitly offers nothing", () => {
    // Codex may list `availableDecisions: []`: it takes no answer at all, so
    // nothing may be recorded for it, whatever an older client sends.
    const offered = codexApprovalOptionsForClients(
      codexCommandApprovalChoices({ command: "make build", availableDecisions: [] }),
    );
    assert.deepStrictEqual(offered, []);
    for (const decision of ["accept", "acceptForSession", "decline", "cancel"] as const) {
      const result = resolveApprovalChoice({ decision, options: offered });
      assert.equal(result._tag, "refused", decision);
      assert.equal(
        result._tag === "refused" ? result.reason : undefined,
        "The agent offered no choices for this request, so no answer can be sent. It closes when the agent stops waiting.",
      );
    }
    assert.equal(resolveApprovalChoice({ optionId: "deny:0", options: offered })._tag, "refused");
  });

  it("maps an older client's decision to the narrowest offered option", () => {
    const options: ReadonlyArray<ProviderApprovalOption> = [
      { decision: "accept", label: "Allow for this turn", scope: "turn" },
      { decision: "accept", label: "Allow once" },
    ];
    const result = resolveApprovalChoice({ decision: "accept", options });
    assert.equal(result._tag === "chosen" ? result.choice.optionId : undefined, "once:0");
  });

  it("sends a reason only with an option that accepts one", () => {
    assert.equal(
      resolveApprovalChoice({
        optionId: "once:0",
        feedback: "Use the fixture instead.",
        options: claudeOptions,
      })._tag,
      "refused",
    );
    const denied = resolveApprovalChoice({
      optionId: "deny:0",
      feedback: "Use the fixture instead.",
      options: claudeOptions,
    });
    assert.equal(
      denied._tag === "chosen" ? denied.choice.feedback : undefined,
      "Use the fixture instead.",
    );
  });

  it("marks every persistent answer, including a persisted deny", () => {
    assert.isTrue(isPersistentChoice({ decision: "acceptAlways" }));
    assert.isTrue(isPersistentChoice({ decision: "decline", scope: "persistent", effect: "deny" }));
    assert.isFalse(isPersistentChoice({ decision: "acceptForSession", scope: "session" }));
  });
});
