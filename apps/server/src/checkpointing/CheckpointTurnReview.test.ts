// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@starkfuture/contracts";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointCaptureService from "../orchestration-v2/CheckpointCaptureService.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

// These tests run the real capture path (Git snapshots, projection rows, the capture service)
// and read the result back through the same diff query the Changes panel calls.

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerVcsDriver = VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess));
const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  CheckpointStore.layer.pipe(
    Layer.provideMerge(layerVcsDriver),
    Layer.provideMerge(layerVcsProcess),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "stark-checkpoint-turn-review-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" } as const;

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({
      operation: "CheckpointTurnReview.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

/** A repository with `files` committed, plus a projected thread with one root checkpoint scope. */
const makeThread = Effect.fn("makeThread")(function* (
  name: string,
  files: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: `turn-review-${name}-` });
  yield* git(cwd, ["init"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  for (const [path, contents] of Object.entries(files)) {
    yield* fileSystem.makeDirectory(NodePath.dirname(NodePath.join(cwd, path)), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(NodePath.join(cwd, path), contents);
  }
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial"]);

  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:turn-review:${name}`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:turn-review:${name}`);
  const scopeId = CheckpointScopeId.make(`scope:turn-review:${name}`);
  const firstNodeId = NodeId.make(`node:turn-review:${name}:1`);
  const firstRunId = RunId.make(`run:turn-review:${name}:1`);
  yield* projections.apply({
    id: EventId.make(`event:${name}:thread`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:turn-review:${name}`),
      title: "Turn review",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projections.apply({
    id: EventId.make(`event:${name}:provider-thread`),
    type: "provider-thread.updated",
    threadId,
    nodeId: firstNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: firstNodeId,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  const scope: OrchestrationV2CheckpointScope = {
    id: scopeId,
    threadId,
    runId: firstRunId,
    nodeId: firstNodeId,
    parentScopeId: null,
    providerThreadId,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd,
    createdAt: now,
  };
  yield* projections.apply({
    id: EventId.make(`event:${name}:scope`),
    type: "checkpoint-scope.created",
    threadId,
    runId: firstRunId,
    nodeId: firstNodeId,
    occurredAt: now,
    payload: scope,
  });
  return { name, cwd, threadId, providerThreadId, scope };
});

type TestThread = Effect.Success<ReturnType<typeof makeThread>>;

/** Projects run `ordinal` with its root node in `status`, as the orchestrator would. */
const putRun = Effect.fn("putRun")(function* (
  thread: TestThread,
  ordinal: number,
  status: OrchestrationV2Run["status"],
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const runId = RunId.make(`run:turn-review:${thread.name}:${ordinal}`);
  const nodeId = NodeId.make(`node:turn-review:${thread.name}:${ordinal}`);
  const run: OrchestrationV2Run = {
    id: runId,
    threadId: thread.threadId,
    ordinal,
    providerInstanceId,
    modelSelection,
    providerThreadId: thread.providerThreadId,
    userMessageId: MessageId.make(`message:turn-review:${thread.name}:${ordinal}`),
    rootNodeId: nodeId,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: status === "running" || status === "waiting" ? null : now,
    checkpointId: null,
    contextHandoffId: null,
  };
  const node: OrchestrationV2ExecutionNode = {
    id: nodeId,
    threadId: thread.threadId,
    runId,
    parentNodeId: null,
    rootNodeId: nodeId,
    kind: "root_turn",
    status: status === "cancelled" ? "cancelled" : status === "waiting" ? "waiting" : "running",
    countsForRun: true,
    providerThreadId: thread.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: thread.scope.id,
    startedAt: now,
    completedAt: null,
  };
  yield* projections.apply({
    id: EventId.make(`event:${thread.name}:run:${ordinal}:${status}`),
    type: "run.updated",
    threadId: thread.threadId,
    runId,
    nodeId,
    providerInstanceId,
    occurredAt: now,
    payload: run,
  });
  yield* projections.apply({
    id: EventId.make(`event:${thread.name}:node:${ordinal}:${status}`),
    type: "node.updated",
    threadId: thread.threadId,
    runId,
    nodeId,
    providerInstanceId,
    occurredAt: now,
    payload: node,
  });
  return { runId, nodeId };
});

/** A run starts: the root scope saves the folder as it was before the turn. */
const startRun = Effect.fn("startRun")(function* (thread: TestThread, ordinal: number) {
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const run = yield* putRun(thread, ordinal, "running");
  yield* checkpoints.captureBaseline({
    scope: thread.scope,
    ordinalWithinScope: Math.max(0, ordinal - 1),
  });
  return run;
});

/** Records one completed tool item for a run. */
const putItem = Effect.fn("putItem")(function* (
  thread: TestThread,
  run: { readonly runId: RunId; readonly nodeId: NodeId },
  key: string,
  item:
    | {
        readonly type: "file_change";
        readonly fileName: string;
        readonly agentWrittenPaths: ReadonlyArray<string>;
      }
    | { readonly type: "command_execution"; readonly input: string },
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const payload = {
    id: TurnItemId.make(`item:turn-review:${thread.name}:${key}`),
    threadId: thread.threadId,
    runId: run.runId,
    nodeId: run.nodeId,
    providerThreadId: thread.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    ...item,
  } satisfies OrchestrationV2TurnItem;
  yield* projections.apply({
    id: EventId.make(`event:${thread.name}:item:${key}`),
    type: "turn-item.updated",
    threadId: thread.threadId,
    runId: run.runId,
    nodeId: run.nodeId,
    driver,
    occurredAt: now,
    payload,
  });
});

/** The provider turn ended: capture the checkpoint through the real capture service. */
const finishRun = Effect.fn("finishRun")(function* (
  thread: TestThread,
  ordinal: number,
  status: "waiting" | "interrupted" = "waiting",
) {
  const capture = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { runId } = yield* putRun(thread, ordinal, status);
  yield* capture.execute({ threadId: thread.threadId, runId, scopeId: thread.scope.id });
  const projection = yield* projections.getThreadProjection(thread.threadId);
  const checkpoint = projection.checkpoints.find((candidate) => candidate.runId === runId);
  assert.isDefined(checkpoint);
  return checkpoint as OrchestrationV2Checkpoint;
});

/** Capture and diff services over the shared projection and a Git-backed checkpoint store. */
const servicesLayer = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const checkpointServiceLayer = CheckpointService.layer.pipe(
    Layer.provide(Layer.mergeAll(IdAllocator.layer, NodeCrypto.layer)),
  );
  return Layer.mergeAll(
    CheckpointCaptureService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          checkpointServiceLayer,
          IdAllocator.layer,
          Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
          // Commit applies the capture's events to the projection, as the event sink does.
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) =>
              Effect.forEach(input.events, (event) => projections.apply(event), {
                discard: true,
              }).pipe(
                Effect.orDie,
                Effect.as({
                  commandId: input.commandId,
                  committed: true,
                  sequence: 1,
                  events: input.events,
                  effects: [],
                } as never),
              ),
          }),
        ),
      ),
    ),
    checkpointServiceLayer,
    CheckpointDiffQuery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCheckpointContext: (threadId) =>
              projections
                .getCheckpointContext(threadId)
                .pipe(Effect.mapError(() => new OrchestratorProjectionError({ threadId }))),
          }),
        ),
      ),
    ),
  );
});

const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* effect.pipe(Effect.provide(yield* servicesLayer));
  });

const write = (thread: TestThread, path: string, contents: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.writeFileString(NodePath.join(thread.cwd, path), contents),
  );

const turnDiff = (thread: TestThread, toTurnCount: number) =>
  Effect.flatMap(CheckpointDiffQuery.CheckpointDiffQuery, (query) =>
    query.getTurnDiff({
      threadId: thread.threadId,
      fromTurnCount: toTurnCount - 1,
      toTurnCount,
    }),
  );

const filesByPath = (checkpoint: OrchestrationV2Checkpoint) =>
  Object.fromEntries(
    checkpoint.files.map((file) => [
      file.path,
      { origin: file.origin, additions: file.additions, deletions: file.deletions },
    ]),
  );

it.layer(layerTest)("turn review after capture", (it) => {
  describe("turn diff", () => {
    it.effect("loads the turn after an attempt that a restart cancelled", () =>
      withServices(
        Effect.gen(function* () {
          const thread = yield* makeThread("restart", { "plan.txt": "Lunch starts at 12:00.\n" });
          // Turn 1 stops at an approval; the app restarts and cancels it before any capture.
          yield* startRun(thread, 1);
          yield* putRun(thread, 1, "cancelled");

          // Turn 2 retries and makes the approved edit.
          const second = yield* startRun(thread, 2);
          yield* write(thread, "plan.txt", "Lunch starts at 12:30.\n");
          yield* putItem(thread, second, "edit", {
            type: "file_change",
            fileName: NodePath.join(thread.cwd, "plan.txt"),
            agentWrittenPaths: [NodePath.join(thread.cwd, "plan.txt")],
          });
          const checkpoint = yield* finishRun(thread, 2);

          assert.deepEqual(filesByPath(checkpoint), {
            "plan.txt": { origin: "agent", additions: 1, deletions: 1 },
          });
          const result = yield* turnDiff(thread, 2);
          assert.include(result.diff, "-Lunch starts at 12:00.");
          assert.include(result.diff, "+Lunch starts at 12:30.");
        }),
      ),
    );

    it.effect("loads turns on both sides of a stopped turn", () =>
      withServices(
        Effect.gen(function* () {
          const thread = yield* makeThread("stopped", { "notes.md": "one\n" });
          yield* startRun(thread, 1);
          yield* write(thread, "notes.md", "one\ntwo\n");
          yield* finishRun(thread, 1, "interrupted");

          yield* startRun(thread, 2);
          yield* write(thread, "notes.md", "one\ntwo\nthree\n");
          yield* finishRun(thread, 2);

          const stopped = yield* Effect.flatMap(CheckpointDiffQuery.CheckpointDiffQuery, (query) =>
            query.getFullThreadDiff({ threadId: thread.threadId, toTurnCount: 1 }),
          );
          assert.include(stopped.diff, "+two");
          const next = yield* turnDiff(thread, 2);
          assert.include(next.diff, "+three");
          assert.notInclude(next.diff, "+two");
        }),
      ),
    );
  });

  describe("file origins", () => {
    it.effect("marks edits made between turns as outside a turn that used no tools", () =>
      withServices(
        Effect.gen(function* () {
          const thread = yield* makeThread("no-tools", {
            "src/pricing.ts": "export const tiers = [];\n",
            "docs/notes.md": "# Notes\n",
          });
          const first = yield* startRun(thread, 1);
          yield* write(thread, "src/pricing.ts", "export const tiers = ['team'];\n");
          yield* putItem(thread, first, "edit", {
            type: "file_change",
            fileName: "src/pricing.ts",
            agentWrittenPaths: ["src/pricing.ts"],
          });
          const firstCheckpoint = yield* finishRun(thread, 1);
          assert.deepEqual(filesByPath(firstCheckpoint), {
            "src/pricing.ts": { origin: "agent", additions: 1, deletions: 1 },
          });

          // The user edits a file while no turn runs, then asks a question that needs no tools.
          yield* write(thread, "docs/notes.md", "# Notes\nPricing ideas.\n");
          yield* startRun(thread, 2);
          const secondCheckpoint = yield* finishRun(thread, 2);

          assert.deepEqual(filesByPath(secondCheckpoint), {
            "docs/notes.md": { origin: "outside", additions: 1, deletions: 0 },
          });
        }),
      ),
    );

    it.effect("keeps the agent's edits apart from files that appeared while it ran commands", () =>
      withServices(
        Effect.gen(function* () {
          const thread = yield* makeThread("mixed", { "plan.txt": "Lunch starts at 12:00.\n" });
          const run = yield* startRun(thread, 1);
          yield* putItem(thread, run, "read", { type: "command_execution", input: "cat plan.txt" });
          yield* write(thread, "plan.txt", "Lunch starts at 12:30.\n");
          yield* putItem(thread, run, "edit", {
            type: "file_change",
            fileName: NodePath.join(thread.cwd, "plan.txt"),
            agentWrittenPaths: [NodePath.join(thread.cwd, "plan.txt")],
          });
          // Someone adds a file to the folder while the turn runs.
          yield* write(thread, "investigator.txt", "added by hand\n");
          const checkpoint = yield* finishRun(thread, 1);

          assert.deepEqual(filesByPath(checkpoint), {
            "plan.txt": { origin: "agent", additions: 1, deletions: 1 },
            "investigator.txt": { origin: "unknown", additions: 1, deletions: 0 },
          });
        }),
      ),
    );
  });
});
