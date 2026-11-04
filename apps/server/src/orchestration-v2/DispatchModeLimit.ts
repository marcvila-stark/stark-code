import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@starkfuture/contracts";
import * as Context from "effect/Context";
import type * as Ref from "effect/Ref";

import { exceededLimit } from "./PermissionContainment.ts";

export interface DispatchModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** A thread the orchestrator refused to touch because it ran above the limit. */
export interface DispatchModeRefusal extends DispatchModes {
  readonly threadId: ThreadId;
  readonly mode: "runtime" | "interaction";
}

/**
 * The broadest modes a command may touch, for commands an MCP caller sends.
 * A caller checks its target's modes before dispatching, but the target's
 * user can raise them meanwhile; the orchestrator re-checks this limit inside
 * the thread's command lock, where nothing else can change them. Unset for
 * the user's own commands, which have no limit.
 *
 * The orchestrator also records its refusal in `refused`, so the sender can
 * report it however the code in between wrapped the dispatch error.
 */
export interface DispatchModeLimitValue extends DispatchModes {
  readonly refused?: Ref.Ref<DispatchModeRefusal | undefined>;
  /**
   * The sender's own thread, always within its limit. The limit is the preset
   * the sender's provider really runs, which can sit below the thread's stored
   * one (the brand runs Codex Supervised), and that must not lock a caller out
   * of its own thread.
   */
  readonly self?: ThreadId | undefined;
}

export const DispatchModeLimit = Context.Reference<DispatchModeLimitValue | undefined>(
  "stark-code/orchestration-v2/DispatchModeLimit",
  { defaultValue: () => undefined },
);

/**
 * Which of `modes` is broader than `limit`, if either. A thread that follows
 * its provider's own settings counts as the broadest preset (see
 * PermissionContainment), so a limited sender never reaches one. The
 * sender's own thread never exceeds its limit.
 */
export const exceededDispatchModeLimit = (
  limit: DispatchModes & Pick<DispatchModeLimitValue, "self">,
  // The orchestrator hands over the thread itself, so `id` names it when no
  // `threadId` is passed.
  modes: DispatchModes & { readonly id?: ThreadId },
  threadId: ThreadId | undefined = modes.id,
): "runtime" | "interaction" | undefined =>
  limit.self !== undefined && threadId === limit.self ? undefined : exceededLimit(limit, modes);
