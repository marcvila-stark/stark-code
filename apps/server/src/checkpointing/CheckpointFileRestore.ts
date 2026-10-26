import {
  CheckpointFileRestoreError,
  CheckpointRef,
  type CheckpointFileRestoreInput,
  type CheckpointFileRestoreResult,
  type CheckpointRestorePreview,
  type ThreadId,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CheckpointStore } from "./CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import { CheckpointServiceV2 } from "../orchestration-v2/CheckpointService.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ServerConfig } from "../config.ts";
import { ThreadCommandExecutor } from "../orchestration-v2/ThreadCommandExecutor.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "@starkfuture/provider-core/server/IdAllocator";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import {
  makeNativeFileCheckpointRestore,
  sameNativeFileState,
} from "./NativeFileCheckpointRestore.ts";

const Journal = Schema.Struct({
  threadId: Schema.String,
  cwd: Schema.String,
  sourceRef: Schema.optional(CheckpointRef),
  expectedRef: Schema.optional(CheckpointRef),
  paths: Schema.Array(Schema.String),
  native: Schema.optional(Schema.Boolean),
});
const encodeJournal = Schema.encodeEffect(Schema.fromJsonString(Journal));
const decodeJournal = Schema.decodeUnknownEffect(Schema.fromJsonString(Journal));
const isRestoreError = Schema.is(CheckpointFileRestoreError);
const empty = (reason: string): CheckpointRestorePreview => ({
  restorable: [],
  conflicts: [],
  untracked: [],
  insertions: 0,
  deletions: 0,
  reason,
});

export class CheckpointFileRestore extends Context.Service<
  CheckpointFileRestore,
  {
    readonly preview: (
      input: CheckpointFileRestoreInput,
    ) => Effect.Effect<CheckpointRestorePreview, CheckpointFileRestoreError>;
    readonly restore: (
      input: CheckpointFileRestoreInput,
    ) => Effect.Effect<CheckpointFileRestoreResult, CheckpointFileRestoreError>;
    readonly undo: (input: {
      readonly threadId: ThreadId;
      readonly undoId: string;
    }) => Effect.Effect<CheckpointFileRestoreResult, CheckpointFileRestoreError>;
  }
>()("stark-code/checkpointing/CheckpointFileRestore") {}

export const layer = Layer.effect(
  CheckpointFileRestore,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const store = yield* CheckpointStore;
    const checkpoints = yield* CheckpointServiceV2;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const threadCommands = yield* ThreadCommandExecutor;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const sessions = yield* ProviderSessionManagerV2;
    const nativeFiles = yield* makeNativeFileCheckpointRestore();
    const journalRoot = path.join(config.stateDir, "checkpoint-restores");
    const journalPath = (id: string) => path.join(journalRoot, `${id}.json`);
    const fail = (message: string) => new CheckpointFileRestoreError({ message });
    const assertIdle = Effect.fn("CheckpointFileRestore.assertIdle")(function* (
      threadId: ThreadId,
    ) {
      const records = yield* projections.getThreadRecords(threadId, [
        "runs",
        "nodes",
        "providerThreads",
      ]);
      if (
        records.runs.some((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        ) ||
        records.nodes.some((node) => ["running", "waiting"].includes(node.status))
      )
        return yield* fail(
          "Interrupt the current turn and background tasks before restoring files.",
        );
      for (const thread of records.providerThreads) {
        if (thread.pendingBackgroundTasks?.length)
          return yield* fail("Stop this thread's background tasks before restoring files.");
        if (!thread.providerSessionId) continue;
        const session = yield* sessions.peek(thread.providerSessionId);
        if (Option.isNone(session)) continue;
        const pending = session.value.hasPendingBackgroundWorkForThread
          ? yield* session.value.hasPendingBackgroundWorkForThread(thread)
          : session.value.hasPendingBackgroundWork
            ? yield* session.value.hasPendingBackgroundWork
            : false;
        if (pending)
          return yield* fail("Stop this thread's background tasks before restoring files.");
      }
    });
    const record = Effect.fn("CheckpointFileRestore.record")(function* (
      threadId: ThreadId,
      result: CheckpointFileRestoreResult,
    ) {
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: {
              ...thread,
              lastFileRestore: {
                restored: result.restorable.length,
                kept: result.conflicts.length + result.untracked.length,
                ...(result.undoId ? { undoId: result.undoId } : {}),
                createdAt: now,
              },
            },
          },
        ],
      });
    });
    const plan = Effect.fn("CheckpointFileRestore.plan")(function* (
      input: CheckpointFileRestoreInput,
    ) {
      yield* assertIdle(input.threadId);
      const records = yield* projections.getThreadRecords(input.threadId, [
        "checkpoints",
        "checkpointScopes",
        "runs",
        "providerTurns",
        "providerThreads",
        "attempts",
      ]);
      const target =
        input.checkpointId !== undefined
          ? records.checkpoints.find(
              (checkpoint) =>
                checkpoint.id === input.checkpointId &&
                (input.scopeId === undefined || checkpoint.scopeId === input.scopeId),
            )
          : records.checkpoints.findLast(
              (checkpoint) =>
                (input.scopeId === undefined || checkpoint.scopeId === input.scopeId) &&
                (input.turnCount === 0
                  ? checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null
                  : checkpoint.appRunOrdinal === input.turnCount),
            );
      const scope = records.checkpointScopes.find((candidate) => candidate.id === target?.scopeId);
      if (!target || !scope)
        return {
          available: false as const,
          preview: empty("File undo needs an available checkpoint."),
        };
      if (target.status === "missing") {
        const providerThread =
          records.providerThreads.find((candidate) => candidate.id === scope.providerThreadId) ??
          records.providerThreads.find(
            (candidate) => candidate.id === records.thread.activeProviderThreadId,
          );
        if (providerThread?.driver !== "claudeAgent" || !providerThread.providerSessionId)
          return {
            available: false as const,
            preview: empty("File undo needs a Git project for this provider."),
          };
        const runtime = Option.getOrNull(yield* sessions.peek(providerThread.providerSessionId));
        if (!runtime?.rewindFiles)
          return {
            available: false as const,
            preview: empty(
              "Start a live Claude session before restoring its native file checkpoints.",
            ),
          };
        const retained = target.appRunOrdinal ?? 0;
        const turns = records.providerTurns
          .filter(
            (turn) =>
              turn.providerThreadId === providerThread.id && turn.nativeMetadata?.userMessageId,
          )
          .toSorted((a, b) => a.ordinal - b.ordinal);
        const turn = turns.find((candidate) => {
          const attempt = records.attempts.find((item) => item.id === candidate.runAttemptId);
          const run = records.runs.find((item) => item.id === attempt?.runId);
          return run !== undefined && run.ordinal > retained;
        });
        const userMessageId = turn?.nativeMetadata?.userMessageId;
        if (!userMessageId)
          return {
            available: false as const,
            preview: empty("This older Claude history has no native user-message checkpoint key."),
          };
        const later = records.checkpoints
          .filter(
            (checkpoint) =>
              checkpoint.scopeId === scope.id &&
              checkpoint.ordinalWithinScope > target.ordinalWithinScope,
          )
          .toSorted((a, b) => a.ordinalWithinScope - b.ordinalWithinScope);
        const expected = new Map<string, NonNullable<typeof target.nativeFileStates>[number]>();
        const tracked = new Set<string>();
        for (const checkpoint of later) {
          for (const file of checkpoint.agentWrittenPaths ?? []) {
            const relative = path
              .relative(scope.cwd, path.resolve(scope.cwd, file))
              .split(path.sep)
              .join("/");
            tracked.add(relative);
            expected.delete(relative);
          }
          for (const state of checkpoint.nativeFileStates ?? []) {
            tracked.add(state.path);
            expected.set(state.path, state);
          }
        }
        const rewindFiles = runtime.rewindFiles;
        return {
          available: true as const,
          native: true as const,
          scope,
          target,
          expected,
          tracked,
          run: (dryRun: boolean) => rewindFiles({ providerThread, userMessageId, dryRun }),
        };
      }
      if (target.status !== "ready")
        return {
          available: false as const,
          preview: empty("File undo needs an available Git checkpoint."),
        };
      const later = records.checkpoints.filter(
        (checkpoint) =>
          checkpoint.scopeId === scope.id &&
          checkpoint.status === "ready" &&
          checkpoint.ordinalWithinScope > target.ordinalWithinScope,
      );
      const expected =
        later.toSorted((a, b) => b.ordinalWithinScope - a.ordinalWithinScope)[0] ?? target;
      const paths = [...new Set(later.flatMap((checkpoint) => checkpoint.agentWrittenPaths ?? []))];
      // A later whole-workspace snapshot may contain the owner's changes to a file this
      // thread last edited earlier. Only that path's last own writer supplies its precondition.
      const expectedRefs: Record<string, CheckpointRef> = {};
      for (const checkpoint of later.toSorted(
        (a, b) => a.ordinalWithinScope - b.ordinalWithinScope,
      )) {
        for (const file of checkpoint.agentWrittenPaths ?? [])
          expectedRefs[
            path.relative(scope.cwd, path.resolve(scope.cwd, file)).split(path.sep).join("/")
          ] = checkpoint.ref;
      }
      const normalized = new Set(
        paths.map((file) =>
          path.relative(scope.cwd, path.resolve(scope.cwd, file)).split(path.sep).join("/"),
        ),
      );
      const untracked = [
        ...new Set(later.flatMap((checkpoint) => checkpoint.files.map((file) => file.path))),
      ].filter((file) => !normalized.has(file));
      return {
        available: true as const,
        native: false as const,
        scope,
        target,
        expected,
        expectedRefs,
        paths,
        untracked,
      };
    });
    const summarize = Effect.fn("CheckpointFileRestore.summarize")(function* (
      candidate: Extract<
        Effect.Success<ReturnType<typeof plan>>,
        { available: true; native: false }
      >,
      dryRun: boolean,
    ) {
      const result = yield* store.restorePaths({
        cwd: candidate.scope.cwd,
        sourceRef: candidate.target.ref,
        expectedRef: candidate.expected.ref,
        expectedRefs: candidate.expectedRefs,
        paths: candidate.paths,
        dryRun,
      });
      const diff = yield* store.diffCheckpoints({
        cwd: candidate.scope.cwd,
        fromCheckpointRef: candidate.target.ref,
        toCheckpointRef: candidate.expected.ref,
        ignoreWhitespace: false,
        format: "numstat",
        filePaths: result.restored,
      });
      const files = parseTurnDiffFilesFromNumstat(diff);
      return {
        restorable: result.restored,
        conflicts: result.conflicts,
        untracked: candidate.untracked,
        insertions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        ...(result.restored.length
          ? {}
          : { reason: "No unchanged agent-edited files can be restored." }),
      } satisfies CheckpointRestorePreview;
    });
    const nativePreview = Effect.fn("CheckpointFileRestore.nativePreview")(function* (
      candidate: Extract<
        Effect.Success<ReturnType<typeof plan>>,
        { available: true; native: true }
      >,
    ) {
      const dry = yield* candidate.run(true);
      if (!dry.canRewind)
        return {
          preview: empty("Claude's native file checkpoint is no longer available."),
          files: [],
        };
      const inspection = yield* nativeFiles.inspect(candidate.scope.cwd, dry.filesChanged);
      const conflicts = [...inspection.conflicts];
      for (const file of inspection.files) {
        const expected = candidate.expected.get(file.state.path);
        if (!candidate.tracked.has(file.state.path) || !expected)
          conflicts.push({
            path: file.state.path,
            reason: "not tracked by this thread's edit tools",
          });
        else if (!sameNativeFileState(file.state, expected))
          conflicts.push({ path: file.state.path, reason: "changed since" });
      }
      const preview: CheckpointRestorePreview = {
        restorable: conflicts.length ? [] : inspection.files.map((file) => file.state.path),
        conflicts,
        untracked: [],
        insertions: dry.insertions,
        deletions: dry.deletions,
        ...(conflicts.length
          ? {
              reason:
                "Native Claude rewind cannot skip individual unsafe files; all files were kept.",
            }
          : inspection.files.length
            ? {}
            : { reason: "No native file changes can be restored." }),
      };
      return { preview, files: inspection.files };
    });
    const preview = Effect.fn("CheckpointFileRestore.preview")(function* (
      input: CheckpointFileRestoreInput,
    ) {
      const candidate = yield* plan(input);
      if (!candidate.available) return candidate.preview;
      return yield* checkpoints.withWorkspaceLock(
        candidate.scope.cwd,
        Effect.gen(function* () {
          if (candidate.native) return (yield* nativePreview(candidate)).preview;
          return yield* summarize(candidate, true);
        }),
      );
    });
    const restore = Effect.fn("CheckpointFileRestore.restore")(function* (
      input: CheckpointFileRestoreInput,
    ) {
      const candidate = yield* plan(input);
      if (!candidate.available) return candidate.preview;
      return yield* checkpoints.withWorkspaceLock(
        candidate.scope.cwd,
        Effect.gen(function* () {
          if (candidate.native) {
            const { preview, files } = yield* nativePreview(candidate);
            if (preview.restorable.length === 0) return preview;
            const undoId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
            const directory = path.join(journalRoot, undoId);
            yield* nativeFiles.snapshot(directory, files);
            yield* fs.makeDirectory(journalRoot, { recursive: true, mode: 0o700 });
            yield* fs.writeFileString(
              journalPath(undoId),
              yield* encodeJournal({
                threadId: input.threadId,
                cwd: candidate.scope.cwd,
                paths: preview.restorable,
                native: true,
              }),
              { mode: 0o600 },
            );
            // A second dry run and fingerprint check detects provider/cache or editor
            // changes during backup creation. Never rewind an expanded path set.
            const latest = yield* nativePreview(candidate);
            const latestPaths = latest.preview.restorable.toSorted();
            const plannedPaths = preview.restorable.toSorted();
            if (
              latestPaths.length !== plannedPaths.length ||
              latestPaths.some((file, index) => file !== plannedPaths[index])
            )
              return {
                ...latest.preview,
                restorable: [],
                reason: "The native checkpoint changed during preparation; preview it again.",
              };
            const real = yield* Effect.result(candidate.run(false));
            const after = yield* nativeFiles.inspect(candidate.scope.cwd, preview.restorable);
            yield* nativeFiles.complete(
              directory,
              after.files.map((file) => file.state),
            );
            const skippedLinks = real._tag === "Success" ? (real.success.skippedLinks ?? 0) : 0;
            const complete = {
              ...preview,
              conflicts: [
                ...preview.conflicts,
                ...after.conflicts,
                ...(skippedLinks
                  ? [
                      {
                        path: "(native linked paths)",
                        reason: `Claude skipped ${skippedLinks} linked paths.`,
                      },
                    ]
                  : []),
              ],
              ...(real._tag === "Failure" || !real.success.canRewind
                ? {
                    reason:
                      "Claude could not finish the native rewind. Undo restore can recover captured files.",
                  }
                : {}),
              undoId,
            };
            yield* record(input.threadId, complete);
            yield* Effect.logInfo("checkpoint native-file restore", {
              threadId: input.threadId,
              files: complete.restorable.length,
              conflicts: complete.conflicts.length,
            });
            if (real._tag === "Failure" || !real.success.canRewind)
              return yield* fail(
                "Claude could not finish the native file rewind. Use Undo restore before retrying.",
              );
            return complete;
          }
          const preview = yield* summarize(candidate, true);
          if (preview.restorable.length === 0) return preview;
          const undoId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const sourceRef = CheckpointRef.make(`refs/stark-code/restores/${undoId}/before`);
          const expectedRef = CheckpointRef.make(`refs/stark-code/restores/${undoId}/after`);
          yield* store.captureCheckpoint({ cwd: candidate.scope.cwd, checkpointRef: sourceRef });
          // Record recovery metadata before the first write. A crash still leaves the pre-restore ref.
          yield* fs.makeDirectory(journalRoot, { recursive: true, mode: 0o700 });
          const journal = {
            threadId: input.threadId,
            cwd: candidate.scope.cwd,
            sourceRef,
            expectedRef,
            paths: preview.restorable,
          };
          const encoded = yield* encodeJournal(journal);
          yield* fs.writeFileString(journalPath(undoId), encoded, { mode: 0o600 });
          const result = yield* summarize(candidate, false);
          yield* store.captureCheckpoint({ cwd: candidate.scope.cwd, checkpointRef: expectedRef });
          yield* Effect.logInfo("checkpoint agent-file restore", {
            threadId: input.threadId,
            files: result.restorable.length,
            conflicts: result.conflicts.length,
          });
          const complete = { ...result, undoId };
          yield* record(input.threadId, complete);
          return complete;
        }),
      );
    });
    const undo = Effect.fn("CheckpointFileRestore.undo")(function* (input: {
      readonly threadId: ThreadId;
      readonly undoId: string;
    }) {
      if (!/^[a-f0-9-]{36}$/.test(input.undoId)) return yield* fail("Invalid restore ID.");
      yield* assertIdle(input.threadId);
      const raw = yield* fs.readFileString(journalPath(input.undoId));
      const journal = yield* decodeJournal(raw);
      if (journal.threadId !== input.threadId)
        return yield* fail("This restore belongs to another thread.");
      return yield* checkpoints.withWorkspaceLock(
        journal.cwd,
        Effect.gen(function* () {
          const result = journal.native
            ? yield* nativeFiles.undo(path.join(journalRoot, input.undoId), journal.cwd)
            : journal.sourceRef && journal.expectedRef
              ? yield* store.restorePaths({
                  ...journal,
                  sourceRef: journal.sourceRef,
                  expectedRef: journal.expectedRef,
                })
              : yield* fail("The restore journal is incomplete.");
          const complete = {
            restorable: result.restored,
            conflicts: result.conflicts,
            untracked: [],
            insertions: 0,
            deletions: 0,
          };
          yield* record(input.threadId, complete);
          return complete;
        }),
      );
    });
    const mapError = (cause: unknown) =>
      isRestoreError(cause)
        ? cause
        : new CheckpointFileRestoreError({
            message: "Could not restore the checkpoint's files.",
            cause,
          });
    return CheckpointFileRestore.of({
      preview: (input) => preview(input).pipe(Effect.mapError(mapError)),
      restore: (input) =>
        threadCommands.withLock(input.threadId, restore(input)).pipe(Effect.mapError(mapError)),
      undo: (input) =>
        threadCommands.withLock(input.threadId, undo(input)).pipe(Effect.mapError(mapError)),
    });
  }),
);
