import {
  describeCheckpointFileGroups,
  groupCheckpointFilesByOrigin,
} from "@starkfuture/client-runtime/state/thread-checkpoints";

import type { RunId } from "@starkfuture/contracts";

import type { TurnDiffFileChange } from "../types";

/** The one line under the Changes header that says what the selected view compares. */
export function describeDiffPanelScope(
  input:
    | {
        readonly kind: "turn";
        readonly turnCount: number | null;
        readonly files: ReadonlyArray<TurnDiffFileChange>;
      }
    | { readonly kind: "unstaged" }
    | { readonly kind: "branch"; readonly baseRef: string | null },
) {
  switch (input.kind) {
    case "unstaged":
      return "Every uncommitted change in this folder, including edits made outside this chat.";
    case "branch":
      return input.baseRef
        ? `Changes compared with ${input.baseRef}, including uncommitted edits made outside this chat.`
        : "Changes in this folder that are not on the base branch, including uncommitted edits made outside this chat.";
    case "turn": {
      const turn = input.turnCount === null ? "this turn" : `turn ${input.turnCount}`;
      const scope = `Everything that changed in this folder while ${turn} ran.`;
      // Checkpoints from before origins were recorded can't say who changed what.
      if (input.files.length === 0 || input.files.every((file) => file.origin === undefined)) {
        return scope;
      }
      const groups = describeCheckpointFileGroups(groupCheckpointFilesByOrigin(input.files));
      return `${scope} ${groups.map((group) => group.label).join(" · ")}.`;
    }
  }
}

/** Body text when a selection resolved without a patch to show. */
export function emptyDiffMessage(input: {
  readonly isTurn: boolean;
  readonly hasNoNetChanges: boolean;
}) {
  if (!input.hasNoNetChanges) return "No patch available for this selection.";
  return input.isTurn ? "No changes in this turn." : "No net changes in this selection.";
}

/** A switch to a run whose checkpoint is still being captured, armed while the latest turn shows. */
export interface PendingTurnFollow {
  readonly runId: RunId;
  /** The turn selected when the follow was armed; selecting anything else cancels it. */
  readonly selectedRunId: RunId;
}

/**
 * One step of following the newest turn into its checkpoint. While the latest turn is shown and the
 * next run's checkpoint is captured, the follow is armed; once that checkpoint lands the panel
 * switches to it, unless the user picked another turn or view in the meantime.
 */
export function advanceTurnFollow(input: {
  readonly pending: PendingTurnFollow | null;
  /** The run being captured while the selection shows the latest turn, else null. */
  readonly capturingRunId: RunId | null;
  /** The selected turn, or null when a folder view is selected. */
  readonly selectedRunId: RunId | null;
  readonly checkpointRunIds: ReadonlyArray<RunId>;
}): { readonly pending: PendingTurnFollow | null; readonly select: RunId | null } {
  if (input.capturingRunId !== null && input.selectedRunId !== null) {
    return {
      pending: { runId: input.capturingRunId, selectedRunId: input.selectedRunId },
      select: null,
    };
  }
  const { pending } = input;
  if (pending === null || pending.selectedRunId !== input.selectedRunId) {
    return { pending: null, select: null };
  }
  return input.checkpointRunIds.includes(pending.runId)
    ? { pending: null, select: pending.runId }
    : { pending, select: null };
}
