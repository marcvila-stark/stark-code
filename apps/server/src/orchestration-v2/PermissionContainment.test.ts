import { assert, describe, it } from "@effect/vitest";
import { permissionSourceOf, ProviderInstanceId, type RuntimeMode } from "@starkfuture/contracts";
import * as Result from "effect/Result";

import * as PermissionContainment from "./PermissionContainment.ts";

const claude = { driver: "claudeAgent" } as const;
const codex = { driver: "codex" } as const;
const claudeInstance = ProviderInstanceId.make("claudeAgent");
const codexInstance = ProviderInstanceId.make("codex");
const inheriting = (runtimeMode: RuntimeMode) => ({
  runtimeMode,
  permissionSource: "inherit" as const,
});

describe("effective presets", () => {
  it("runs Claude at its stored preset unless the account stopped offering it", () => {
    assert.equal(
      PermissionContainment.effectivePreset({ runtimeMode: "full-access" }, claude),
      "full-access",
    );
    assert.equal(
      PermissionContainment.effectivePreset(
        { runtimeMode: "full-access" },
        { ...claude, supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto"] },
      ),
      "approval-required",
    );
  });

  it("runs every other provider Supervised under the brand, whatever was stored", () => {
    assert.equal(
      PermissionContainment.effectivePreset({ runtimeMode: "full-access" }, codex),
      "approval-required",
    );
    assert.equal(
      PermissionContainment.effectivePreset({ runtimeMode: "auto" }, { driver: "opencode" }),
      "approval-required",
    );
  });

  it("knows nothing about a thread that follows its provider's own settings", () => {
    assert.equal(PermissionContainment.effectivePreset(inheriting("auto"), claude), "unknown");
    // Granting it counts as Supervised; as a target it counts as the broadest.
    assert.equal(
      PermissionContainment.grantingPreset(inheriting("auto"), claude),
      "approval-required",
    );
    assert.equal(
      PermissionContainment.targetPreset(inheriting("approval-required")),
      "full-access",
    );
  });

  it("grants Supervised for a provider it cannot identify, and keeps a target's stored preset", () => {
    assert.equal(
      PermissionContainment.grantingPreset({ runtimeMode: "full-access" }, undefined),
      "approval-required",
    );
    assert.equal(PermissionContainment.targetPreset({ runtimeMode: "auto" }), "auto");
  });

  it("reads a legacy thread without a source as an override, with stored authority", () => {
    assert.equal(permissionSourceOf({}), "override");
    assert.equal(
      PermissionContainment.starkAuthority({
        ...inheriting("full-access"),
        interactionMode: "default",
      }),
      "standard",
    );
    assert.equal(
      PermissionContainment.starkAuthority({
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
      "environment",
    );
  });
});

describe("Stark authority", () => {
  it("holds environment authority only where the provider really runs Bypass outside Plan", () => {
    const limits = (
      thread: { runtimeMode: RuntimeMode },
      provider: PermissionContainment.ProviderFacts = claude,
    ) =>
      PermissionContainment.threadLimits({ ...thread, interactionMode: "default" }, provider)
        .authority;
    assert.equal(limits({ runtimeMode: "full-access" }), "environment");
    assert.equal(limits({ runtimeMode: "full-access" }, codex), "standard");
    assert.equal(limits(inheriting("full-access")), "standard");
    assert.equal(
      PermissionContainment.threadLimits(
        { runtimeMode: "full-access", interactionMode: "plan" },
        claude,
      ).authority,
      "standard",
    );
    assert.equal(PermissionContainment.clientLimits("full-access").authority, "environment");
    assert.equal(PermissionContainment.clientLimits("auto").authority, "standard");
  });

  it("reads the driver from the session a credential belongs to before any other record", () => {
    assert.deepEqual(
      PermissionContainment.providerFactsFromRecords({
        providerInstanceId: codexInstance,
        providerSessionId: "session:claude",
        providerSessions: [
          { id: "session:codex", driver: "codex", providerInstanceId: codexInstance },
          { id: "session:claude", driver: "claudeAgent", providerInstanceId: claudeInstance },
        ],
      }),
      { driver: "claudeAgent" },
    );
    assert.isUndefined(
      PermissionContainment.providerFactsFromRecords({ providerInstanceId: codexInstance }),
    );
  });
});

describe("child policy", () => {
  const child = (input: {
    readonly parent: ProviderInstanceId;
    readonly effective: RuntimeMode | "unknown";
    readonly target: ProviderInstanceId;
    readonly requested?: RuntimeMode | "inherit";
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  }) =>
    PermissionContainment.decideChildPolicy({
      parent: { providerInstanceId: input.parent, effective: input.effective },
      target: {
        providerInstanceId: input.target,
        supportedRuntimeModes: input.supportedRuntimeModes,
      },
      requested: input.requested,
    });

  it("labels a child on another provider that starts at the target's narrowest mode", () => {
    const result = child({
      parent: claudeInstance,
      effective: "auto-accept-edits",
      target: codexInstance,
      requested: "approval-required",
    });
    assert.isTrue(Result.isSuccess(result));
    assert.deepEqual(Result.getOrThrow(result), {
      source: "override",
      preset: "approval-required",
      providerInstanceId: codexInstance,
      containment: "cross-provider-floor",
      label: "Not limited by the parent's rules",
    });
  });

  it("refuses to translate a parent's mode to another provider", () => {
    for (const requested of [undefined, "inherit", "auto-accept-edits"] as const) {
      const result = child({
        parent: claudeInstance,
        effective: "auto-accept-edits",
        target: codexInstance,
        ...(requested === undefined ? {} : { requested }),
      });
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.reason, "unprovable");
    }
  });

  it("treats two instances of one driver as separate providers", () => {
    const result = child({
      parent: claudeInstance,
      effective: "auto",
      target: ProviderInstanceId.make("claude-work"),
      requested: "auto",
    });
    assert.isTrue(Result.isFailure(result));
  });

  it("inherits on the same instance, never Bypass and never above the parent", () => {
    const sameInstance = (effective: RuntimeMode, requested?: RuntimeMode | "inherit") =>
      Result.match(
        child({
          parent: claudeInstance,
          effective,
          target: claudeInstance,
          ...(requested === undefined ? {} : { requested }),
        }),
        {
          onSuccess: (policy) => `${policy.containment}:${policy.preset}`,
          onFailure: (refusal) => `refused:${refusal.reason}`,
        },
      );
    assert.equal(sameInstance("auto"), "same-instance:auto");
    assert.equal(sameInstance("full-access"), "same-instance:approval-required");
    assert.equal(sameInstance("full-access", "auto"), "same-instance:auto");
    assert.equal(sameInstance("full-access", "full-access"), "refused:bypass");
    assert.equal(sameInstance("auto-accept-edits", "auto"), "refused:above_parent");
  });

  it("starts a child of a parent that inherits at the floor", () => {
    const runtimeMode = (requested?: RuntimeMode) =>
      Result.match(
        child({
          parent: claudeInstance,
          effective: "unknown",
          target: claudeInstance,
          ...(requested === undefined ? {} : { requested }),
        }),
        {
          onSuccess: (policy) => policy.preset,
          onFailure: (refusal) => `refused:${refusal.reason}`,
        },
      );
    assert.equal(runtimeMode(), "approval-required");
    assert.equal(runtimeMode("auto"), "refused:unprovable");
  });

  it("steps an inherited mode down to one the target offers", () => {
    const result = child({
      parent: claudeInstance,
      effective: "auto",
      target: claudeInstance,
      supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
    });
    assert.equal(Result.getOrThrow(result).preset, "auto-accept-edits");
  });
});

describe("bound scheduled runs", () => {
  const task = {
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    providerInstanceId: claudeInstance,
  } as const;
  const thread = (runtimeMode: RuntimeMode, providerInstanceId = claudeInstance) => ({
    runtimeMode,
    interactionMode: "default" as const,
    providerInstanceId,
  });

  it("runs only when the thread asks for no more than the task allows", () => {
    assert.isUndefined(
      PermissionContainment.boundRunRefusal({ task, thread: thread("approval-required") }),
    );
    assert.isUndefined(
      PermissionContainment.boundRunRefusal({ task, thread: thread("auto-accept-edits") }),
    );
    assert.equal(
      PermissionContainment.boundRunRefusal({ task, thread: thread("auto") }),
      "above_task_limit",
    );
  });

  it("refuses a thread that moved to another provider or follows its own settings", () => {
    assert.equal(
      PermissionContainment.boundRunRefusal({
        task,
        thread: thread("approval-required", codexInstance),
      }),
      "provider_changed",
    );
    assert.equal(
      PermissionContainment.boundRunRefusal({
        task,
        thread: { ...thread("approval-required"), permissionSource: "inherit" as const },
      }),
      "inherit",
    );
  });

  it("compares the mode a clamped provider really runs", () => {
    const codexTask = {
      ...task,
      runtimeMode: "approval-required",
      providerInstanceId: codexInstance,
    } as const;
    assert.isUndefined(
      PermissionContainment.boundRunRefusal({
        task: codexTask,
        thread: thread("full-access", codexInstance),
        provider: codex,
      }),
    );
    assert.equal(
      PermissionContainment.boundRunRefusal({
        task: codexTask,
        thread: thread("full-access", codexInstance),
      }),
      "above_task_limit",
    );
  });
});
