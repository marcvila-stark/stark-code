import { NonNegativeInt, ThreadId, type VcsError } from "@starkfuture/contracts";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export const CheckpointDiffOperation = Schema.Literals([
  "CheckpointDiffQuery.getTurnDiff",
  "CheckpointDiffQuery.getFullThreadDiff",
]);
export type CheckpointDiffOperation = typeof CheckpointDiffOperation.Type;

/** The computed result does not satisfy the checkpoint RPC contract. */
export class CheckpointDiffResultInvalidError extends Schema.TaggedError<CheckpointDiffResultInvalidError>()(
  "CheckpointDiffResultInvalidError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const result =
      this.operation === "CheckpointDiffQuery.getTurnDiff" ? "turn diff" : "full thread diff";
    return `Checkpoint invariant violation in ${this.operation}: Computed ${result} result does not satisfy contract schema.`;
  }
}

/** Projection state no longer contains the requested checkpoint thread. */
export class CheckpointThreadNotFoundError extends Schema.TaggedError<CheckpointThreadNotFoundError>()(
  "CheckpointThreadNotFoundError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: Thread '${this.threadId}' not found.`;
  }
}

/** The checkpoint thread has no workspace path from which to compute a diff. */
export class CheckpointWorkspacePathMissingError extends Schema.TaggedError<CheckpointWorkspacePathMissingError>()(
  "CheckpointWorkspacePathMissingError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const diff =
      this.operation === "CheckpointDiffQuery.getTurnDiff" ? "turn diff" : "full thread diff";
    return `Checkpoint invariant violation in ${this.operation}: Workspace path missing for thread '${this.threadId}' when computing ${diff}.`;
  }
}

/** The requested turn lies beyond the latest available checkpoint. */
export class CheckpointTurnRangeUnavailableError extends Schema.TaggedError<CheckpointTurnRangeUnavailableError>()(
  "CheckpointTurnRangeUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    requestedTurnCount: NonNegativeInt,
    availableTurnCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.requestedTurnCount}: Turn diff range exceeds current turn count: requested ${this.requestedTurnCount}, current ${this.availableTurnCount}.`;
  }
}

/** Expected checkpoint metadata does not contain the requested Git ref. */
export class CheckpointRefUnavailableError extends Schema.TaggedError<CheckpointRefUnavailableError>()(
  "CheckpointRefUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    turnCount: NonNegativeInt,
    checkpoint: Schema.Literals(["from", "to"]),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: Checkpoint ref is unavailable for turn ${this.turnCount}.`;
  }
}

export type CheckpointStoreError = VcsError;

export type CheckpointServiceError =
  | CheckpointStoreError
  | ProjectionRepositoryError
  | CheckpointDiffResultInvalidError
  | CheckpointThreadNotFoundError
  | CheckpointWorkspacePathMissingError
  | CheckpointTurnRangeUnavailableError
  | CheckpointRefUnavailableError;

/**
 * The reason a diff request failed, in words a user can act on. The RPC sends this as its
 * message, so clients show it instead of a generic failure.
 */
export function describeCheckpointDiffFailure(cause: CheckpointServiceError): string {
  switch (cause._tag) {
    case "CheckpointTurnRangeUnavailableError":
      return `Turn ${cause.requestedTurnCount} has no saved checkpoint yet. A checkpoint is saved when a turn finishes.`;
    case "CheckpointRefUnavailableError":
      return cause.checkpoint === "to"
        ? `Turn ${cause.turnCount} has no saved checkpoint, so its changes can't be shown. Uncommitted shows the folder's current changes.`
        : `The checkpoint before this turn wasn't saved, so its changes can't be shown. Uncommitted shows the folder's current changes.`;
    case "CheckpointThreadNotFoundError":
      return "This chat isn't on the server any more, so its changes can't be shown.";
    case "CheckpointWorkspacePathMissingError":
      return "The folder this chat ran in is unknown, so its changes can't be shown.";
    case "CheckpointDiffResultInvalidError":
      return "The server produced a diff it couldn't send. Try again.";
    case "PersistenceSqlError":
    case "PersistenceDecodeError":
      return "The server couldn't read this chat's checkpoints. Try again.";
    default:
      return `Git couldn't compare this turn's checkpoints: ${cause.message}`;
  }
}
