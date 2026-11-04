/**
 * Stark's own authority over a chat (its MCP tools and workers), kept apart
 * from what the provider executes with. A preset only orders presets of one
 * provider instance, which share native settings; it never shows that one
 * provider's rules contain another's, so cross-instance work is never derived
 * from a rank. See docs/internals/permissions-boundaries.md.
 */
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ChildPolicy,
  type OrchestrationV2RunPermissionCeiling,
  type PermissionSource,
  permissionSourceOf,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@starkfuture/contracts";
import { BRAND } from "@starkfuture/shared/branding";
import * as Result from "effect/Result";

import { effectiveRuntimeMode } from "./PermissionPolicy.ts";

/** What Stark knows about the provider instance a thread runs on. */
export interface ProviderFacts {
  readonly driver: string;
  /** Presets the instance offers; absent or empty when it offers every preset. */
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
}

/**
 * The driver of the provider a thread runs on, read from its own provider
 * sessions and threads: the session an MCP credential belongs to first, then
 * any record on the thread's current instance. Undefined when it never ran.
 */
export function providerFactsFromRecords(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId?: string | undefined;
  readonly providerSessions?: ReadonlyArray<{
    readonly id: string;
    readonly driver: string;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
  readonly providerThreads?: ReadonlyArray<{
    readonly driver: string;
    readonly providerInstanceId: ProviderInstanceId;
  }>;
}): ProviderFacts | undefined {
  const sessions = input.providerSessions ?? [];
  const record =
    (input.providerSessionId === undefined
      ? undefined
      : sessions.find((session) => session.id === input.providerSessionId)) ??
    sessions.find((session) => session.providerInstanceId === input.providerInstanceId) ??
    (input.providerThreads ?? []).find(
      (thread) => thread.providerInstanceId === input.providerInstanceId,
    );
  return record === undefined ? undefined : { driver: record.driver };
}

interface StoredModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly permissionSource?: PermissionSource | undefined;
}

const PRESET_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const INTERACTION_RANK: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

/** True when `preset` asks for no more than `limit` on the same provider instance. */
export const presetWithin = (preset: RuntimeMode, limit: RuntimeMode) =>
  PRESET_RANK[preset] <= PRESET_RANK[limit];

const interactionWithin = (mode: ProviderInteractionMode, limit: ProviderInteractionMode) =>
  INTERACTION_RANK[mode] <= INTERACTION_RANK[limit];

/** The narrowest preset an instance offers: Claude Manual, Codex Supervised. */
function floorPreset(supported: ReadonlyArray<RuntimeMode> | undefined): RuntimeMode {
  return (supported ?? []).reduce<RuntimeMode>(
    (floor, mode) => (PRESET_RANK[mode] < PRESET_RANK[floor] ? mode : floor),
    "approval-required",
  );
}

/**
 * The preset the provider actually runs a thread at, or "unknown" when the
 * thread follows the provider's own settings. Mirrors RuntimePolicy, where an
 * unoffered preset runs Supervised, and the brand clamp in
 * ProviderSessionManager, where every non-Claude session runs Supervised.
 */
export function effectivePreset(
  thread: Pick<StoredModes, "runtimeMode" | "permissionSource">,
  provider: ProviderFacts,
): RuntimeMode | "unknown" {
  return permissionSourceOf(thread) === "inherit"
    ? "unknown"
    : effectiveRuntimeMode(thread.runtimeMode, {
        driver: provider.driver,
        supportedRuntimeModes: provider.supportedRuntimeModes,
      });
}

/**
 * The most a thread may hand to work it starts or changes: its effective
 * preset. Inherited settings Stark cannot read, and a provider it cannot
 * identify under the brand clamp, count as Supervised.
 */
export function grantingPreset(
  thread: Pick<StoredModes, "runtimeMode" | "permissionSource">,
  provider: ProviderFacts | undefined,
): RuntimeMode {
  if (provider === undefined) {
    return permissionSourceOf(thread) === "inherit" || BRAND.requireApprovalsByDefault
      ? "approval-required"
      : thread.runtimeMode;
  }
  const effective = effectivePreset(thread, provider);
  return effective === "unknown" ? "approval-required" : effective;
}

/**
 * What a thread may run at, for checks that it stays within someone else's
 * limit. Inherited settings count as the broadest preset; without provider
 * facts the stored preset stands, since the clamp only ever narrows it.
 */
export function targetPreset(
  thread: Pick<StoredModes, "runtimeMode" | "permissionSource">,
  provider?: ProviderFacts | undefined,
): RuntimeMode {
  if (permissionSourceOf(thread) === "inherit") return "full-access";
  if (provider === undefined) return thread.runtimeMode;
  const effective = effectivePreset(thread, provider);
  return effective === "unknown" ? "full-access" : effective;
}

/**
 * `environment` may change projects and environment settings through Stark's
 * MCP tools; `standard` may not. Only an override thread whose provider really
 * runs Bypass, outside Plan, holds it.
 */
export type StarkAuthority = "standard" | "environment";

export interface StarkLimits extends StoredModes {
  readonly authority: StarkAuthority;
}

const authorityOf = (
  preset: RuntimeMode,
  interactionMode: ProviderInteractionMode,
): StarkAuthority =>
  preset === "full-access" && interactionMode === "default" ? "environment" : "standard";

/**
 * A chat's authority from its stored policy. The startup freeze and every
 * permission write store the preset the provider runs, so for an override the
 * stored preset is the effective one; an inheriting chat is `standard`. Use
 * `threadLimits` where the provider is known.
 */
export function starkAuthority(
  thread: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode" | "permissionSource">,
): StarkAuthority {
  return permissionSourceOf(thread) === "inherit"
    ? "standard"
    : authorityOf(thread.runtimeMode, thread.interactionMode);
}

/** A calling thread's limits, from what its provider runs rather than what was stored. */
export function threadLimits(
  thread: StoredModes,
  provider: ProviderFacts | undefined,
): StarkLimits {
  const runtimeMode = grantingPreset(thread, provider);
  return {
    runtimeMode,
    interactionMode: thread.interactionMode,
    authority: authorityOf(runtimeMode, thread.interactionMode),
  };
}

/** An outside client's limits: the ceiling the user approved it with. */
export const clientLimits = (ceiling: RuntimeMode): StarkLimits => ({
  runtimeMode: ceiling,
  interactionMode: "default",
  authority: authorityOf(ceiling, "default"),
});

/** Which of a target's modes would exceed `limits`, if either. */
export function exceededLimit(
  limits: StoredModes,
  target: StoredModes,
  provider?: ProviderFacts | undefined,
): "runtime" | "interaction" | undefined {
  return !presetWithin(targetPreset(target, provider), limits.runtimeMode)
    ? "runtime"
    : !interactionWithin(target.interactionMode, limits.interactionMode)
      ? "interaction"
      : undefined;
}

/** Shown on a child that runs on another provider or instance than its parent. */
const CROSS_PROVIDER_CHILD_LABEL = "Not limited by the parent's rules";

/**
 * The explicit policy a Stark worker starts with, recorded with the delegation
 * (OrchestrationV2ChildPolicy). `same-instance` children share the parent's
 * native settings and ask for no more than its preset. `cross-provider-floor`
 * children run at the target's narrowest preset under that provider's own
 * settings, shown as not limited by the parent's rules.
 */
export interface ChildPolicy extends OrchestrationV2ChildPolicy {
  readonly label?: typeof CROSS_PROVIDER_CHILD_LABEL;
}

export interface ChildPolicyRefusal {
  /**
   * `bypass`: children never run Bypass (O5). `above_parent`: broader than the
   * parent's preset. `unsupported`: the target does not offer that preset.
   * `unprovable`: Stark cannot show the child stays within the parent's rules.
   */
  readonly reason: "bypass" | "above_parent" | "unsupported" | "unprovable";
  readonly message: string;
}

/**
 * Decides the policy a delegated or created child starts with. A child on the parent's
 * own instance asks for no more than the parent's effective preset, and never
 * Bypass. A child elsewhere gets only the target's narrowest preset, and only
 * when the agent names it, since no rank shows one provider's rules contain
 * another's. Anything Stark cannot establish is refused rather than translated.
 */
export function decideChildPolicy(input: {
  readonly parent: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly effective: RuntimeMode | "unknown";
  };
  readonly target: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
  };
  readonly requested: RuntimeMode | "inherit" | undefined;
}): Result.Result<ChildPolicy, ChildPolicyRefusal> {
  const { parent, target, requested } = input;
  const floor = floorPreset(target.supportedRuntimeModes);
  if (requested === "full-access") {
    return Result.fail({
      reason: "bypass",
      message:
        "Child agents cannot use Bypass permissions. Select Manual, Accept edits, Auto or Plan.",
    });
  }
  if (parent.providerInstanceId !== target.providerInstanceId) {
    return requested === floor
      ? Result.succeed({
          source: "override",
          preset: floor,
          providerInstanceId: target.providerInstanceId,
          containment: "cross-provider-floor",
          label: CROSS_PROVIDER_CHILD_LABEL,
        })
      : Result.fail({
          reason: "unprovable",
          message: `Provider ${target.providerInstanceId} does not share this thread's provider settings, so Stark cannot show a child there stays within this thread's permissions. Pass runtimeMode "${floor}" to start it at that provider's narrowest mode; its own settings apply, not this thread's.`,
        });
  }
  const sameInstance = (preset: RuntimeMode) =>
    Result.succeed<ChildPolicy>({
      source: "override",
      preset,
      providerInstanceId: target.providerInstanceId,
      containment: "same-instance",
    });
  const inherited = requested === undefined || requested === "inherit";
  if (parent.effective === "unknown") {
    return inherited || requested === floor
      ? sameInstance(floor)
      : Result.fail({
          reason: "unprovable",
          message: `This thread follows ${target.providerInstanceId}'s own permission settings, which Stark cannot read, so a child it starts runs at "${floor}".`,
        });
  }
  // Children never run Bypass (O5): under a Bypass parent they default to
  // Supervised and may ask for Auto at most.
  const ceiling = parent.effective === "full-access" ? "auto" : parent.effective;
  const preset = inherited
    ? parent.effective === "full-access"
      ? "approval-required"
      : parent.effective
    : requested;
  if (!presetWithin(preset, ceiling)) {
    return Result.fail({
      reason: "above_parent",
      message: `Child runtime mode ${preset} is broader than parent mode ${parent.effective}.`,
    });
  }
  const supported = target.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(preset)) {
    return sameInstance(preset);
  }
  if (!inherited) {
    return Result.fail({
      reason: "unsupported",
      message: `Provider ${target.providerInstanceId} does not offer runtime mode ${preset}, so it would run as approval-required. Use one of: ${supported.join(", ")}.`,
    });
  }
  return sameInstance(
    supported
      .filter((mode) => presetWithin(mode, preset))
      .toSorted((left, right) => PRESET_RANK[right] - PRESET_RANK[left])[0] ?? floor,
  );
}

export type BoundRunRefusalReason = "inherit" | "provider_changed" | "above_task_limit";

/** Why a bound scheduled run did not start, as the run's visible reason. */
export function boundRunRefusalMessage(input: {
  readonly reason: BoundRunRefusalReason;
  readonly task: StoredModes;
  readonly thread: StoredModes;
}): string {
  switch (input.reason) {
    case "inherit":
      return "Not run: the thread follows its provider's own permission settings, which Stark cannot compare with this task's limit. Pick a mode for the thread or edit the task.";
    case "provider_changed":
      return "Not run: the thread now uses a different provider than this task was saved for. Switch the thread back or edit the task.";
    case "above_task_limit":
      return `Not run: the thread now allows ${input.thread.runtimeMode}/${input.thread.interactionMode}, more than this task's ${input.task.runtimeMode}/${input.task.interactionMode}. Narrow the thread or edit the task.`;
  }
}

/**
 * Why a scheduled task bound to a thread may not run there now, if it may
 * not. The run uses the thread's own settings, so it runs only when the
 * thread is an override on the task's provider instance and asks for no more
 * than the task allows. It is refused otherwise; the shared thread is never
 * widened or changed for it.
 */
export function boundRunRefusal(input: {
  readonly task: StoredModes & { readonly providerInstanceId: ProviderInstanceId };
  readonly thread: StoredModes & { readonly providerInstanceId: ProviderInstanceId };
  readonly provider?: ProviderFacts | undefined;
}): BoundRunRefusalReason | undefined {
  const { task, thread } = input;
  if (permissionSourceOf(thread) === "inherit") return "inherit";
  if (thread.providerInstanceId !== task.providerInstanceId) return "provider_changed";
  return exceededLimit(task, thread, input.provider) === undefined ? undefined : "above_task_limit";
}

/**
 * The policy a worker starts with when the orchestrator creates it, whoever
 * sent the delegation: Stark's MCP tools or a client dispatching the command
 * directly. A policy the sender supplied is never trusted; this decides it
 * again from the parent's run and the target, under the parent thread's lock.
 *
 * The requested preset is first taken as what the target really runs (a
 * clamped Codex runs Supervised whatever it is asked for, and an unoffered
 * preset runs Supervised), so the worker stores the preset it runs (D0's
 * stored = effective rule) and a request whose effective preset is the
 * target's floor counts as naming the floor. Bypass is refused before that,
 * since asking for it is refused whatever it would run as (O5).
 */
export function decideWorkerPolicy(input: {
  readonly parent: Pick<StoredModes, "runtimeMode" | "permissionSource"> & {
    readonly interactionMode: ProviderInteractionMode;
  };
  /** The instance the parent's run uses, and what Stark knows about it. */
  readonly parentProviderInstanceId: ProviderInstanceId;
  readonly parentProvider: ProviderFacts | undefined;
  readonly target: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly driver: string | undefined;
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
  };
  readonly requested: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): Result.Result<ChildPolicy, ChildPolicyRefusal> {
  if (!interactionWithin(input.interactionMode, input.parent.interactionMode)) {
    return Result.fail({
      reason: "above_parent",
      message: `Child interaction mode ${input.interactionMode} is broader than parent mode ${input.parent.interactionMode}.`,
    });
  }
  const requested =
    input.requested === "full-access"
      ? input.requested
      : effectiveRuntimeMode(input.requested, {
          driver: input.target.driver,
          supportedRuntimeModes: input.target.supportedRuntimeModes,
        });
  return decideChildPolicy({
    parent: {
      providerInstanceId: input.parentProviderInstanceId,
      effective:
        input.parentProvider === undefined
          ? grantingPreset(input.parent, undefined)
          : effectivePreset(input.parent, input.parentProvider),
    },
    target: {
      providerInstanceId: input.target.providerInstanceId,
      supportedRuntimeModes: input.target.supportedRuntimeModes,
    },
    requested,
  });
}

/** A chosen policy as a delegation records it on the worker's task. */
export const recordedChildPolicy = ({
  label: _label,
  ...policy
}: ChildPolicy): OrchestrationV2ChildPolicy => policy;

/**
 * Whether a bound scheduled run may start on its thread now: the thread is an
 * override on the instance the ceiling was captured for, and asks for no more
 * than it. The orchestrator calls this when the run is created and again when
 * it leaves the queue.
 */
export function boundRunAllowed(
  ceiling: OrchestrationV2RunPermissionCeiling,
  thread: Pick<
    OrchestrationV2AppThread,
    "providerInstanceId" | "runtimeMode" | "interactionMode" | "permissionSource"
  >,
): boolean {
  return boundRunRefusal({ task: ceiling, thread }) === undefined;
}
