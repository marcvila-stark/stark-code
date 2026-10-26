import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ThreadId,
  ProviderThreadId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  ProviderTurnId,
  type OrchestrationV2ThreadProjection,
} from "@starkfuture/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@starkfuture/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { CheckpointStore, make as makeStore } from "./CheckpointStore.ts";
import { CheckpointFileRestore, layer } from "./CheckpointFileRestore.ts";
import { CheckpointServiceV2 } from "../orchestration-v2/CheckpointService.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import { captureNativeFileStates } from "./NativeFileCheckpointRestore.ts";

const runtime = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "stark-file-restore-service-" }),
  VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
).pipe(Layer.provideMerge(NodeServices.layer));

const nativeFixture = Effect.fn(function* (
  mode: "normal" | "owner-change" | "dry-mismatch" | "old-history" = "normal",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "stark-native-service-" });
  const file = (name: string) => path.join(cwd, name);
  yield* fs.writeFileString(file("a.txt"), "agent");
  yield* fs.writeFileString(file("new.txt"), "agent created");
  const states = yield* captureNativeFileStates(cwd, ["a.txt", "new.txt"]);
  if (mode === "owner-change") yield* fs.writeFileString(file("a.txt"), "owner changed it");
  const threadId = ThreadId.make(`native-${mode}`);
  const scopeId = CheckpointScopeId.make(`native-scope-${mode}`);
  const providerThreadId = ProviderThreadId.make(`native-provider-${mode}`);
  const providerSessionId = ProviderSessionId.make(`native-session-${mode}`);
  const runId = RunId.make(`native-run-${mode}`);
  const attemptId = RunAttemptId.make(`native-attempt-${mode}`);
  let projection = {
    thread: { id: threadId, activeProviderThreadId: providerThreadId, worktreePath: null },
    nodes: [],
    providerThreads: [{ id: providerThreadId, driver: "claudeAgent", providerSessionId }],
    checkpointScopes: [{ id: scopeId, cwd, providerThreadId }],
    checkpoints: [
      {
        id: CheckpointId.make("native-before"),
        scopeId,
        status: "missing",
        ordinalWithinScope: 0,
        appRunOrdinal: null,
        files: [],
      },
      {
        id: CheckpointId.make("native-after"),
        scopeId,
        status: "missing",
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        files: [],
        agentWrittenPaths: ["a.txt", "new.txt"],
        ...(mode === "old-history" ? {} : { nativeFileStates: states }),
      },
    ],
    runs: [{ id: runId, ordinal: 1, status: "completed" }],
    attempts: [{ id: attemptId, runId }],
    providerTurns: [
      {
        id: ProviderTurnId.make("native-turn"),
        providerThreadId,
        runAttemptId: attemptId,
        ordinal: 1,
        nativeMetadata: { userMessageId: "app-supplied-user-uuid" },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const calls: string[] = [];
  let dryRuns = 0;
  const nativeRuntime = {
    rewindFiles: (input: { userMessageId: string; dryRun: boolean }) =>
      Effect.gen(function* () {
        assert.equal(input.userMessageId, "app-supplied-user-uuid");
        calls.push(input.dryRun ? "dry" : "real");
        if (input.dryRun) dryRuns++;
        if (!input.dryRun) {
          yield* fs.writeFileString(file("a.txt"), "before");
          yield* fs.remove(file("new.txt"));
        }
        return {
          canRewind: true,
          filesChanged: mode === "dry-mismatch" && dryRuns > 1 ? ["a.txt"] : ["a.txt", "new.txt"],
          insertions: 2,
          deletions: 1,
          ...(input.dryRun ? {} : { skippedLinks: 0 }),
        };
      }),
    hasPendingBackgroundWork: Effect.succeed(false),
  } as unknown as ProviderAdapterV2SessionRuntime;
  const dependencies = Layer.mergeAll(
    Layer.mock(CheckpointStore)({}),
    Layer.mock(ProjectionStoreV2)({ getThreadRecords: () => Effect.succeed(projection) }),
    Layer.mock(CheckpointServiceV2)({ withWorkspaceLock: (_cwd, effect) => effect }),
    Layer.mock(ProviderSessionManagerV2)({
      peek: () => Effect.succeed(Option.some(nativeRuntime)),
    }),
    Layer.mock(EventSinkV2)({
      write: (input) =>
        Effect.sync(() => {
          for (const event of input.events)
            if (event.type === "thread.metadata-updated")
              projection = Object.assign({}, projection, { thread: event.payload });
          return [];
        }),
    }),
  );
  const open = () =>
    CheckpointFileRestore.pipe(Effect.provide(layer.pipe(Layer.provide(dependencies))));
  return { fs, file, calls, threadId, open, getProjection: () => projection };
});

it.effect(
  "native non-Git rewind snapshots exact files, keeps the chat and supports fresh-service undo",
  () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const service = yield* f.open();
      const result = yield* service.restore({ threadId: f.threadId, turnCount: 0 });
      assert.deepEqual(f.calls, ["dry", "dry", "real"]);
      assert.isString(result.undoId);
      assert.equal(yield* f.fs.readFileString(f.file("a.txt")), "before");
      assert.isFalse(yield* f.fs.exists(f.file("new.txt")));
      assert.equal(f.getProjection().runs[0]?.status, "completed");
      yield* f.fs.writeFileString(f.file("a.txt"), "owner after restore");
      const undo = yield* (yield* f.open()).undo({ threadId: f.threadId, undoId: result.undoId! });
      assert.deepEqual(undo.restorable, ["new.txt"]);
      assert.equal(yield* f.fs.readFileString(f.file("a.txt")), "owner after restore");
      assert.equal(yield* f.fs.readFileString(f.file("new.txt")), "agent created");
    }).pipe(Effect.scoped, Effect.provide(runtime)),
);

it.effect.each(["owner-change", "old-history", "dry-mismatch"] as const)(
  "native rewind refuses unsafe %s without invoking a real SDK rewind",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* nativeFixture(mode);
      const result = yield* (yield* f.open()).restore({ threadId: f.threadId, turnCount: 0 });
      assert.deepEqual(result.restorable, []);
      assert.isFalse(f.calls.includes("real"));
      assert.equal(yield* f.fs.readFileString(f.file("new.txt")), "agent created");
    }).pipe(Effect.scoped, Effect.provide(runtime)),
);

it.effect(
  "previews narrow paths, persists an undo journal, restores code without chat changes and recovers undo in a fresh service",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "stark-file-restore-repo-" });
      const git = (args: ReadonlyArray<string>) =>
        driver.execute({ operation: "file-restore-test", cwd, args });
      const file = (name: string) => path.join(cwd, name);
      yield* git(["init"]);
      yield* git(["config", "user.name", "Test"]);
      yield* git(["config", "user.email", "test@test.com"]);
      yield* fs.writeFileString(file("a.txt"), "before\n");
      yield* fs.writeFileString(file("b.txt"), "owner before\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "before"]);
      const before = CheckpointRef.make(
        "refs/stark-code/orchestration-v2/checkpoints/test/ordinal/0",
      );
      const after = CheckpointRef.make(
        "refs/stark-code/orchestration-v2/checkpoints/test/ordinal/1",
      );
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: before });
      yield* fs.writeFileString(file("a.txt"), "agent\n");
      yield* fs.writeFileString(file("new.txt"), "agent created\n");
      yield* fs.writeFileString(file("b.txt"), "owner after\n");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: after });
      yield* fs.writeFileString(file("untracked.txt"), "keep\n");
      const threadId = ThreadId.make("shared-restore");
      const scopeId = CheckpointScopeId.make("root");
      const now = yield* DateTime.now;
      let projection = {
        thread: { id: threadId, worktreePath: null },
        runs: [],
        nodes: [],
        providerThreads: [],
        checkpointScopes: [{ id: scopeId, cwd }],
        checkpoints: [
          {
            id: CheckpointId.make("before"),
            scopeId,
            ref: before,
            status: "ready",
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            files: [],
            nodeId: NodeId.make("root"),
          },
          {
            id: CheckpointId.make("after"),
            scopeId,
            ref: after,
            status: "ready",
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            agentWrittenPaths: [file("a.txt"), file("new.txt")],
            files: [{ path: "a.txt" }, { path: "new.txt" }, { path: "b.txt" }],
            capturedAt: now,
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const repository = yield* driver.detectRepository(cwd);
      assert.isNotNull(repository);
      const handle = { kind: repository!.kind, repository: repository!, driver };
      const store = yield* makeStore.pipe(
        Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, {
          get: () => Effect.succeed(driver),
          detect: () => Effect.succeed(handle),
          resolve: () => Effect.succeed(handle),
        }),
      );
      const dependencies = Layer.mergeAll(
        Layer.mock(ProviderSessionManagerV2)({}),
        Layer.succeed(CheckpointStore, store),
        Layer.mock(ProjectionStoreV2)({ getThreadRecords: () => Effect.succeed(projection) }),
        Layer.mock(CheckpointServiceV2)({ withWorkspaceLock: (_cwd, effect) => effect }),
        Layer.mock(EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              for (const event of input.events)
                if (event.type === "thread.metadata-updated")
                  projection = Object.assign({}, projection, { thread: event.payload });
              return [];
            }),
        }),
      );
      const open = () =>
        CheckpointFileRestore.pipe(Effect.provide(layer.pipe(Layer.provide(dependencies))));
      const service = yield* open();
      const preview = yield* service.preview({ threadId, turnCount: 0 });
      assert.deepEqual(preview.restorable, ["a.txt", "new.txt"]);
      assert.deepEqual(preview.untracked, ["b.txt"]);
      const result = yield* service.restore({ threadId, turnCount: 0 });
      assert.isString(result.undoId);
      assert.equal(projection.thread.lastFileRestore?.restored, 2);
      assert.equal(yield* fs.readFileString(file("a.txt")), "before\n");
      assert.isFalse(yield* fs.exists(file("new.txt")));
      assert.equal(yield* fs.readFileString(file("b.txt")), "owner after\n");
      assert.equal(yield* fs.readFileString(file("untracked.txt")), "keep\n");
      assert.deepEqual(projection.runs, []);
      const fresh = yield* open();
      const undone = yield* fresh.undo({ threadId, undoId: result.undoId! });
      assert.deepEqual(undone.restorable, ["a.txt", "new.txt"]);
      assert.equal(yield* fs.readFileString(file("a.txt")), "agent\n");
      assert.equal(yield* fs.readFileString(file("new.txt")), "agent created\n");
      assert.equal(projection.thread.lastFileRestore?.undoId, undefined);
      // A later turn snapshots an owner edit to A while the agent writes only B.
      yield* fs.writeFileString(file("a.txt"), "owner after the first turn\n");
      yield* fs.writeFileString(file("b.txt"), "second agent turn\n");
      const third = CheckpointRef.make(
        "refs/stark-code/orchestration-v2/checkpoints/test/ordinal/2",
      );
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: third });
      projection = {
        ...projection,
        checkpoints: [
          ...projection.checkpoints,
          {
            ...projection.checkpoints[1]!,
            id: CheckpointId.make("third"),
            ref: third,
            ordinalWithinScope: 2,
            appRunOrdinal: 2,
            agentWrittenPaths: ["b.txt"],
            files: [{ path: "b.txt", kind: "modified", additions: 1, deletions: 1 }],
          },
        ],
      };
      const safe = yield* fresh.restore({ threadId, turnCount: 0 });
      assert.deepEqual(safe.conflicts, [{ path: "a.txt", reason: "changed since" }]);
      assert.equal(yield* fs.readFileString(file("a.txt")), "owner after the first turn\n");
      assert.equal(yield* fs.readFileString(file("b.txt")), "owner before\n");
    }).pipe(Effect.scoped, Effect.provide(runtime)),
);
