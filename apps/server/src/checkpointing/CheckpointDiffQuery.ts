/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type CheckpointScopeId,
  type ThreadId,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointServiceError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "./Diffs.ts";

// Windows limits a command line to 32,767 characters. Leave room for the rest of git's arguments.
const MAX_PATHSPEC_CHARS = 24_000;

/** Splits files into pathspec lists that each fit on one git command line. Renames keep both paths together. */
function batchFilePaths(files: ReadonlyArray<TurnDiffFileSummary>) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    // Each pathspec also carries a `:(top,literal)` prefix and a separator.
    const size = paths.reduce((total, path) => total + path.length + 16, 0);
    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...paths);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    /**
     * Read the patch diff for a single turn checkpoint transition.
     *
     * Verifies checkpoint availability in both projection state and filesystem.
     */
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    /**
     * Read the full patch diff across a thread range of checkpoints.
     *
     * Uses turn-diff semantics with `fromTurnCount = 0`.
     */
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("stark-code/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const crypto = yield* Crypto.Crypto;

  const refForScopeOrdinal = (scopeId: CheckpointScopeId, ordinalWithinScope: number) =>
    checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    );

  /**
   * Finds the checkpoint a turn diff starts from. It is the same snapshot that the turn's
   * file summary was measured from at capture: the root scope's ref one ordinal earlier.
   * That snapshot can be a stopped turn's checkpoint, or a baseline saved when the turn
   * started because the earlier attempt never finished (for example, a server restart).
   */
  const resolveFromCheckpointRef = Effect.fn("resolveFromCheckpointRef")(function* (input: {
    readonly fromTurnCount: number;
    readonly projection: ProjectionCheckpointContext;
    readonly readyCheckpoints: ProjectionCheckpointContext["checkpoints"];
    readonly turnCheckpoints: ProjectionCheckpointContext["checkpoints"];
    readonly toScope: ProjectionCheckpointContext["checkpointScopes"][number];
  }) {
    if (input.fromTurnCount === 0) {
      // The root scope is shared by every run in this thread. Its runId
      // tracks the latest owner, while ordinal zero stays the baseline.
      const firstScope = input.projection.checkpointScopes.find(
        (scope) => scope.kind === "root_run",
      );
      return firstScope === undefined ? undefined : yield* refForScopeOrdinal(firstScope.id, 0);
    }
    const projected =
      input.readyCheckpoints.find(
        (checkpoint) =>
          checkpoint.scopeId === input.toScope.id &&
          checkpoint.ordinalWithinScope === input.fromTurnCount,
      ) ??
      input.turnCheckpoints.find((checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount);
    if (projected !== undefined) return projected.ref;
    // Capture diffs against this ref whenever Git has it, even when no checkpoint row exists.
    const ref = yield* refForScopeOrdinal(input.toScope.id, input.fromTurnCount);
    const exists = yield* checkpointStore
      .hasCheckpointRef({ cwd: input.toScope.cwd, checkpointRef: ref })
      .pipe(Effect.orElseSucceed(() => false));
    return exists ? ref : undefined;
  });

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
        Effect.mapError(
          () =>
            new CheckpointThreadNotFoundError({
              operation,
              threadId: input.threadId,
            }),
        ),
        Effect.withSpan("checkpoint.turnDiff.lookupContext"),
      );
      // A stopped or restart-cancelled turn still saved a usable checkpoint, and the next
      // turn's file summary was measured from it. Only a rollback discards checkpoints.
      const rolledBackRunIds = new Set(
        projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
      );
      const readyCheckpoints = projection.checkpoints.filter(
        (checkpoint) =>
          checkpoint.status === "ready" &&
          (checkpoint.runId === null || !rolledBackRunIds.has(checkpoint.runId)),
      );
      const turnCheckpoints = readyCheckpoints.filter(
        (checkpoint) => checkpoint.appRunOrdinal !== null && checkpoint.runId !== null,
      );
      const maxTurnCount = turnCheckpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const toCheckpoint = turnCheckpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount,
      );
      if (toCheckpoint === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const toScope = projection.checkpointScopes.find(
        (scope) => scope.id === toCheckpoint.scopeId,
      );
      if (toScope === undefined) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      const fromCheckpointRef = yield* resolveFromCheckpointRef({
        fromTurnCount: input.fromTurnCount,
        projection,
        readyCheckpoints,
        turnCheckpoints,
        toScope,
      });
      if (fromCheckpointRef === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const comparison = {
        cwd: toScope.cwd,
        fromCheckpointRef,
        toCheckpointRef: toCheckpoint.ref,
        fallbackFromToHead: false,
        ignoreWhitespace,
      };
      // Leave out files that a pull, merge, or rebase brought in, matching the turn's file summary.
      // Filtering is optional: when it cannot run, the complete diff still loads.
      const authoredPaths = yield* checkpointStore
        .listAuthoredPaths(comparison)
        .pipe(Effect.orElseSucceed(() => null));
      const files =
        authoredPaths === null
          ? []
          : yield* checkpointStore.diffCheckpoints({ ...comparison, format: "numstat" }).pipe(
              Effect.map(parseTurnDiffFilesFromNumstat),
              Effect.orElseSucceed(() => []),
            );
      const retainedFiles = files.filter((file) => !isGitImport(file, authoredPaths));
      // Select retained paths before generating a patch, so imported bulk cannot exhaust its output limit.
      const diff =
        retainedFiles.length === files.length
          ? yield* checkpointStore
              .diffCheckpoints(comparison)
              .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"))
          : (yield* Effect.forEach(
              batchFilePaths(retainedFiles),
              (filePaths) =>
                checkpointStore
                  .diffCheckpoints({ ...comparison, filePaths })
                  .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints")),
              { concurrency: 4 },
            )).join("");

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
