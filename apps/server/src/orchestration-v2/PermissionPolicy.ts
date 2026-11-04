/**
 * Pure permission policy shared by the orchestrator, runtime policy, the
 * session manager and the startup freeze. Nothing here reads state.
 *
 * Two questions are kept apart:
 * - what a provider executes with (`effectiveRuntimeMode`, the session
 *   manager's clamp, and later the provider's own reported settings);
 * - what Stark lets a chat do with its own tools and workers, which lives in
 *   `PermissionContainment.ts` and never compares presets across providers.
 */
import {
  approvalOptionClass,
  type OrchestrationV2PermissionMigration,
  type OrchestrationV2PermissionMigrationReason,
  type PermissionSource,
  type ProviderApprovalChoice,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderApprovalOptionClass,
  type ProviderApprovalOptionId,
  type ProviderInteractionMode,
  type ProviderPermissionSettings,
  type RuntimeMode,
  permissionSourceOf,
  withApprovalOptionIds,
} from "@starkfuture/contracts";
import { BRAND } from "@starkfuture/shared/branding";
import type * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";

/** The startup freeze's migration id. A thread is migrated under one id at most once. */
export const PERMISSION_FREEZE_MIGRATION_ID = "perm-v1";

const CLAUDE_DRIVER = "claudeAgent";

/** What the orchestrator knows about an instance's permission handling. */
export interface PermissionCapabilities {
  /** Undefined when the instance is not configured in this build. */
  readonly driver: string | undefined;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly nativePermissionInherit: boolean;
}

/** Stark clamps every non-Claude session to Supervised under this brand. */
export function clampsToSupervised(driver: string | undefined): boolean {
  return BRAND.requireApprovalsByDefault && driver !== undefined && driver !== CLAUDE_DRIVER;
}

/**
 * The mode a provider offers for a stored mode. A mode it does not offer (a
 * thread set before it stopped offering it, or a stale client) runs in
 * Supervised rather than having Stark imitate it.
 */
export function offeredRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

/**
 * The preset a stored mode actually runs with on an instance: what
 * `RuntimePolicy` offers, then the session manager's clamp. Stored modes are
 * aligned to this on every write so a later account or provider change can
 * never activate a broader mode the chat never ran with.
 */
export function effectiveRuntimeMode(
  runtimeMode: RuntimeMode,
  capabilities: Pick<PermissionCapabilities, "driver" | "supportedRuntimeModes">,
): RuntimeMode {
  return clampsToSupervised(capabilities.driver)
    ? "approval-required"
    : offeredRuntimeMode(runtimeMode, capabilities.supportedRuntimeModes);
}

/** The source a chat may store on an instance: `inherit` only where the driver supports it. */
export function allowedPermissionSource(
  requested: PermissionSource | undefined,
  capabilities: Pick<PermissionCapabilities, "nativePermissionInherit">,
): PermissionSource | undefined {
  if (requested === "inherit" && !capabilities.nativePermissionInherit) return "override";
  return requested;
}

/**
 * What a chat stores when it moves to another provider instance (O3): the
 * preset the target actually runs, an explicit preset for a chat that
 * inherited the old provider's settings (until the user chooses to inherit the
 * new one's), and no change still waiting on the old provider's run. Every
 * path that moves a chat applies it: explicit switches, a message or steer that
 * selects another instance, and a queued run starting on one. Otherwise a mode
 * the target clamps would be stored as is and come back, unclamped, on a later
 * switch to a provider that offers it.
 */
export function switchedPermissionFields(
  thread: {
    readonly runtimeMode: RuntimeMode;
    readonly permissionSource?: PermissionSource | undefined;
    readonly permissionChangePending?: unknown;
  },
  capabilities: Pick<PermissionCapabilities, "driver" | "supportedRuntimeModes">,
): {
  readonly runtimeMode: RuntimeMode;
  readonly permissionSource?: "override";
  readonly permissionChangePending?: null;
} {
  return {
    runtimeMode: effectiveRuntimeMode(thread.runtimeMode, capabilities),
    ...(thread.permissionSource === undefined ? {} : { permissionSource: "override" as const }),
    ...(thread.permissionChangePending == null ? {} : { permissionChangePending: null }),
  };
}

/**
 * The session manager's brand clamp for non-Claude providers: every session
 * runs Supervised, keeping only already-narrow explicit overrides. A policy
 * that inherits the provider's own settings is passed through; RuntimePolicy
 * produces one only for a driver that reports `nativePermissionInherit`.
 */
export function supervisedRuntimePolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): ProviderAdapter.ProviderAdapterV2RuntimePolicy;
export function supervisedRuntimePolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined,
): ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined;
export function supervisedRuntimePolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined,
): ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined {
  if (!BRAND.requireApprovalsByDefault || policy === undefined) return policy;
  if (policy.permissionSource === "inherit") return policy;
  const { approvalPolicy, sandboxPolicy, ...rest } = policy;
  const readOnlySandbox =
    sandboxPolicy === "read-only" ||
    (typeof sandboxPolicy === "object" &&
      sandboxPolicy !== null &&
      "type" in sandboxPolicy &&
      sandboxPolicy.type === "readOnly");
  return {
    ...rest,
    runtimeMode: "approval-required",
    ...(approvalPolicy === "untrusted" ? { approvalPolicy } : {}),
    ...(readOnlySandbox ? { sandboxPolicy } : {}),
  };
}

/** The narrowest preset on every provider: Claude Manual, Codex Supervised. */
export function isNarrowestPreset(source: PermissionSource, runtimeMode: RuntimeMode): boolean {
  return source === "override" && runtimeMode === "approval-required";
}

// Orders presets of one provider only, to tell a narrowing from a widening on
// the same chat. Never use it to compare presets across providers.
const SAME_PROVIDER_PRESET_ORDER: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/**
 * Whether moving a chat from one requested policy to another on the same
 * provider narrows it. Leaving `inherit` counts as narrowing because the
 * provider's own settings may be broader than any preset; entering `inherit`
 * never does.
 */
export function narrowsPermissions(
  from: { readonly permissionSource: PermissionSource; readonly runtimeMode: RuntimeMode },
  to: { readonly permissionSource: PermissionSource; readonly runtimeMode: RuntimeMode },
): boolean {
  if (to.permissionSource === "inherit") return false;
  if (from.permissionSource === "inherit") return true;
  return SAME_PROVIDER_PRESET_ORDER[to.runtimeMode] < SAME_PROVIDER_PRESET_ORDER[from.runtimeMode];
}

/**
 * The startup freeze's decision for one saved chat: narrow its stored mode to
 * the mode it already ran with, or nothing. Only `override` chats are frozen;
 * a chat that already carries this migration id is left alone.
 */
export function permissionFreezeFor(input: {
  readonly thread: {
    readonly runtimeMode: RuntimeMode;
    readonly permissionSource?: PermissionSource | undefined;
    readonly permissionMigrations?: ReadonlyArray<OrchestrationV2PermissionMigration> | undefined;
  };
  readonly capabilities: Pick<PermissionCapabilities, "driver" | "supportedRuntimeModes">;
  readonly migrationId?: string;
}):
  | {
      readonly from: RuntimeMode;
      readonly to: RuntimeMode;
      readonly reason: OrchestrationV2PermissionMigrationReason;
    }
  | undefined {
  const migrationId = input.migrationId ?? PERMISSION_FREEZE_MIGRATION_ID;
  if (permissionSourceOf(input.thread) !== "override") return undefined;
  if (input.thread.permissionMigrations?.some((entry) => entry.migrationId === migrationId)) {
    return undefined;
  }
  const from = input.thread.runtimeMode;
  // An instance missing from this build cannot run the chat, so only the mode
  // a later instance could silently activate (full access) is narrowed.
  if (input.capabilities.driver === undefined) {
    return from === "full-access"
      ? { from, to: "approval-required", reason: "mode-not-offered" }
      : undefined;
  }
  const to = effectiveRuntimeMode(from, input.capabilities);
  if (to === from) return undefined;
  const reason: OrchestrationV2PermissionMigrationReason = clampsToSupervised(
    input.capabilities.driver,
  )
    ? "provider-clamped"
    : input.capabilities.driver === CLAUDE_DRIVER && from === "full-access"
      ? "claude-bypass-not-allowed"
      : "mode-not-offered";
  return { from, to, reason };
}

/**
 * What the next launch or turn requests, in the provider's words. For an
 * inheriting chat Stark sends nothing, so only the source is known here; the
 * provider's own values come from its active or configured settings.
 */
export function requestedPermissionSettings(input: {
  readonly driver: string | undefined;
  readonly permissionSource: PermissionSource;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): ProviderPermissionSettings {
  if (input.permissionSource === "inherit") {
    return {
      permissionSource: "inherit",
      preset: input.runtimeMode,
      interactionMode: input.interactionMode,
    };
  }
  const native = nativePresetSettings(input.driver, input.runtimeMode, input.interactionMode);
  return {
    permissionSource: "override",
    preset: input.runtimeMode,
    interactionMode: input.interactionMode,
    ...native,
  };
}

/**
 * Today's preset → native mapping, as the adapters send it (see the wire
 * golden). Claude: Manual `default`, Accept edits `acceptEdits`, Auto `auto`,
 * Bypass `bypassPermissions`, Plan `plan`. Codex and other clamped providers:
 * `untrusted` with the user as reviewer and a read-only sandbox.
 */
function nativePresetSettings(
  driver: string | undefined,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
): Pick<ProviderPermissionSettings, "nativeMode" | "approvalsReviewer" | "sandbox"> {
  if (driver === CLAUDE_DRIVER) {
    return {
      nativeMode:
        interactionMode === "plan"
          ? "plan"
          : runtimeMode === "approval-required"
            ? "default"
            : runtimeMode === "auto-accept-edits"
              ? "acceptEdits"
              : runtimeMode === "auto"
                ? "auto"
                : "bypassPermissions",
    };
  }
  if (driver === "codex") {
    switch (clampsToSupervised(driver) ? "approval-required" : runtimeMode) {
      case "approval-required":
        return { nativeMode: "untrusted", approvalsReviewer: "user", sandbox: "read-only" };
      case "auto-accept-edits":
        return { nativeMode: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" };
      case "auto":
        return {
          nativeMode: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: "workspace-write",
        };
      case "full-access":
        return { nativeMode: "never", approvalsReviewer: "user", sandbox: "danger-full-access" };
    }
  }
  return {};
}

const OPTION_CLASS_BREADTH: Record<ProviderApprovalOptionClass, number> = {
  "deny-stop": 0,
  deny: 1,
  once: 2,
  turn: 3,
  session: 4,
  persistent: 5,
};

/**
 * Matches an answer to the options the request offered. An option id must be
 * one the request offered. An answer from a client that predates option ids
 * names only a decision, and maps to the narrowest offered option with that
 * decision. A decision no option offers is refused before anything is
 * recorded: an allow used to become allow-once silently, which is not what the
 * user chose, and a provider that lists its decisions (Codex) cannot take a
 * denial it did not list, so the answer would end undelivered. Only a request
 * recorded without an option list (an adapter or event from before option
 * ids) takes any decision; an explicitly empty list offers nothing, so every
 * answer is refused and the request stays open until the provider closes it.
 */
export function resolveApprovalChoice(input: {
  readonly optionId?: ProviderApprovalOptionId | undefined;
  readonly decision?: ProviderApprovalDecision | undefined;
  readonly feedback?: string | undefined;
  readonly options: ReadonlyArray<ProviderApprovalOption> | undefined;
}):
  | { readonly _tag: "chosen"; readonly choice: ProviderApprovalChoice }
  | { readonly _tag: "refused"; readonly reason: string } {
  const listed = input.options !== undefined;
  const options = withApprovalOptionIds(input.options ?? []);
  const fromOption = (option: ProviderApprovalOption) => {
    if (input.feedback !== undefined && option.acceptsFeedback !== true) {
      return { _tag: "refused" as const, reason: "This choice does not send a reason." };
    }
    return {
      _tag: "chosen" as const,
      choice: {
        ...(option.optionId === undefined ? {} : { optionId: option.optionId }),
        decision: option.decision,
        ...(option.scope === undefined ? {} : { scope: option.scope }),
        ...(option.effect === undefined ? {} : { effect: option.effect }),
        ...(option.persistsTo === undefined ? {} : { persistsTo: option.persistsTo }),
        ...(option.nativePayload === undefined ? {} : { nativePayload: option.nativePayload }),
        ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      } satisfies ProviderApprovalChoice,
    };
  };
  if (listed && options.length === 0) {
    return {
      _tag: "refused",
      reason:
        "The agent offered no choices for this request, so no answer can be sent. It closes when the agent stops waiting.",
    };
  }
  if (input.optionId !== undefined) {
    const option = options.find((candidate) => candidate.optionId === input.optionId);
    if (option === undefined) {
      return {
        _tag: "refused",
        reason: "This choice is no longer offered. Choose again from the request.",
      };
    }
    if (input.decision !== undefined && input.decision !== option.decision) {
      return { _tag: "refused", reason: "The decision does not match the chosen option." };
    }
    return fromOption(option);
  }
  if (input.decision === undefined) {
    return { _tag: "refused", reason: "Choose an answer for this request." };
  }
  if (!listed) {
    if (input.feedback !== undefined) {
      return { _tag: "refused", reason: "This request does not take a reason." };
    }
    return { _tag: "chosen", choice: { decision: input.decision } };
  }
  const matching = options
    .filter((option) => option.decision === input.decision)
    .toSorted(
      (left, right) =>
        OPTION_CLASS_BREADTH[approvalOptionClass(left)] -
        OPTION_CLASS_BREADTH[approvalOptionClass(right)],
    );
  const narrowest = matching[0];
  if (narrowest !== undefined) return fromOption(narrowest);
  return {
    _tag: "refused",
    reason: "This choice is no longer offered. Choose again from the request.",
  };
}

/** Whether an answer changes the provider's saved configuration. */
export function isPersistentChoice(
  choice: Pick<ProviderApprovalChoice, "decision" | "scope" | "effect">,
): boolean {
  return approvalOptionClass(choice) === "persistent";
}

/**
 * The modes a limited sender's check compares against. A chat that inherits
 * its provider's own settings may run broader than any preset, so as a target
 * it counts as full access.
 */
export function dispatchLimitModes(thread: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly permissionSource?: PermissionSource | undefined;
}): { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode } {
  return {
    runtimeMode: permissionSourceOf(thread) === "inherit" ? "full-access" : thread.runtimeMode,
    interactionMode: thread.interactionMode,
  };
}
