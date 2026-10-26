import * as Schema from "effect/Schema";
import { CheckpointId, CheckpointScopeId, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const CheckpointFileRestoreInput = Schema.Struct({
  threadId: ThreadId,
  turnCount: Schema.optional(NonNegativeInt),
  checkpointId: Schema.optional(CheckpointId),
  scopeId: Schema.optional(CheckpointScopeId),
});
export type CheckpointFileRestoreInput = typeof CheckpointFileRestoreInput.Type;
export const CheckpointRestorePreview = Schema.Struct({
  restorable: Schema.Array(Schema.String),
  conflicts: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  untracked: Schema.Array(Schema.String),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  reason: Schema.optional(Schema.String),
});
export type CheckpointRestorePreview = typeof CheckpointRestorePreview.Type;
export const CheckpointFileRestoreResult = Schema.Struct({
  ...CheckpointRestorePreview.fields,
  undoId: Schema.optional(Schema.String),
});
export type CheckpointFileRestoreResult = typeof CheckpointFileRestoreResult.Type;
export const CheckpointUndoRestoreInput = Schema.Struct({
  threadId: ThreadId,
  undoId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
});
export class CheckpointFileRestoreError extends Schema.TaggedError<CheckpointFileRestoreError>()(
  "CheckpointFileRestoreError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
