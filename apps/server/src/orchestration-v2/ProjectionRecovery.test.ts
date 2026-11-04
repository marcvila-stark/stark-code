import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";

const layerTest = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerRecoveryTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:recovery:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:recovery"),
    title: name,
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
    ...overrides,
  };
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const ordinal = overrides.ordinal ?? 1;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* projections.apply({
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
      ...overrides,
    },
  });
  return runId;
});

it.effect.each(["startup", "shutdown"] as const)(
  "%s cancels queued buffered wakes and holds durable messages",
  (trigger) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const now = yield* DateTime.now;
      const bufferedThreads = [] as ThreadId[];
      const durableThreads = [] as ThreadId[];
      for (const kind of ["buffered", "user", "notification", "delegated"] as const) {
        const threadId = yield* createThread(`wake:${trigger}:${kind}`);
        const buffered = kind === "buffered";
        (buffered ? bufferedThreads : durableThreads).push(threadId);
        const messageId = MessageId.make(`message:${threadId}`);
        const runId = yield* createRun(threadId, "queued", {
          userMessageId: messageId,
          startedAt: null,
          queuePosition: 1,
        });
        yield* createRun(threadId, "completed", { ordinal: 2 });
        yield* projections.apply({
          id: EventId.make(`message:${threadId}`),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: "Queued work",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: kind === "user" ? "user" : "agent",
            creationSource: buffered ? "provider" : "server",
            ...(kind === "user" || kind === "delegated"
              ? {}
              : {
                  notification: {
                    source: { kind: "background_task" as const },
                    outcome: "updated" as const,
                    summary: "Background activity updated",
                  },
                }),
            ...(kind === "delegated"
              ? { delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [] } }
              : {}),
          },
        });
      }
      assert.deepEqual(
        new Set(yield* projections.getRecoveryThreadIds("runtime")),
        new Set([...bufferedThreads, ...durableThreads]),
      );
      const summary = yield* recovery.reconcile(trigger);
      assert.equal(summary.terminalizedRuns, 1);
      for (const threadId of bufferedThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "cancelled");
        assert.isNotNull(projection.runs[0]?.completedAt);
        assert.isNull(projection.runs[0]?.queuePosition);
        assert.equal(projection.runs[1]?.status, "completed");
      }
      for (const threadId of durableThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "queued");
        assert.isTrue(projection.runs[0]?.queueHeld);
      }
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("stops a session its thread detached, which kept its live status", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("detached-session");
    const providerSessionId = ProviderSessionId.make("session:recovery:detached");
    yield* projections.apply({
      id: EventId.make("event:recovery:detached-session:attached"),
      type: "provider-session.attached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    // The server died before the release that should follow the detach.
    yield* projections.apply({
      id: EventId.make("event:recovery:detached-session:detached"),
      type: "provider-session.detached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: { providerSessionId, detachedAt: now, reason: "Thread settled." },
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), [threadId]);

    const summary = yield* recovery.reconcile("startup");

    assert.equal(summary.stoppedSessions, 1);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = ${providerSessionId}
    `;
    assert.deepEqual(rows, [{ status: "stopped" }]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("selects unfinished recovery work without reading settled thread histories", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (let index = 0; index < 600; index += 1) {
      yield* createRun(yield* createThread(`settled-${index}`), "completed");
    }
    const queued = yield* createThread("queued");
    const archived = yield* createThread("archived", { archivedAt: now });
    const deleted = yield* createThread("deleted", { deletedAt: now });
    const blocked = yield* createThread("blocked");
    yield* createRun(queued, "completed");
    for (const threadId of [queued, archived, deleted, blocked]) {
      yield* createRun(threadId, "queued", threadId === queued ? { ordinal: 2 } : {});
    }
    yield* createRun(blocked, "waiting", { ordinal: 2 });
    const background = yield* createThread("background");
    yield* createRun(background, "completed");
    yield* projections.apply({
      id: EventId.make("event:recovery:background"),
      type: "turn-item.updated",
      threadId: background,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:recovery:background"),
        threadId: background,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "dynamic_tool",
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        toolName: "background",
        input: null,
        output: null,
      },
    });
    const outboxOnly = yield* createThread("outbox-only");
    yield* outbox.enqueue([
      {
        id: "effect:recovery:outbox-only",
        commandId: CommandId.make("command:recovery:outbox-only"),
        threadId: outboxOnly,
        request: { type: "provider-turn.start", runId: RunId.make("run:outbox-only") },
      },
    ]);
    const requestOnly = yield* createThread("request-only");
    yield* projections.apply({
      id: EventId.make("event:recovery:request-only"),
      type: "runtime-request.updated",
      threadId: requestOnly,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:recovery:pending"),
        nodeId: NodeId.make("node:recovery:request"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Process stopped" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const delivery = yield* createThread("delivery", { archivedAt: now });
    yield* createRun(delivery, "completed", {
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: { generation: 1, messageId: MessageId.make("message:delivery"), taskIds: [] },
      },
    });

    // This historical payload cannot be decoded. Candidate discovery must not
    // materialize it while deciding which threads have work to reconcile.
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${ThreadId.make("thread:recovery:settled-599")}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${queued} AND ordinal = 1
    `;
    assert.deepEqual(yield* projections.getRecoveryThreadIds("queued-runs"), [queued]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([queued, archived, blocked, background, outboxOnly, requestOnly]),
    );
    assert.deepEqual(yield* projections.getRecoveryThreadIds("delegated-completions"), [delivery]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const recoveryState = yield* projections.getRuntimeRecoveryProjection(queued);
    assert.deepEqual(
      recoveryState.runs.map((run) => run.id),
      [RunId.make(`run:${queued}:2`)],
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), [
      queued,
      ThreadId.make("thread:recovery:settled-599"),
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recovers terminal subagent results until their cross-thread transfer exists", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const parent = yield* createThread("subagent-parent");
    const children: Array<ThreadId> = [];
    for (const name of ["terminal", "archived", "deleted", "running", "held", "queued"]) {
      const child = yield* createThread(`subagent-${name}`, {
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
        forkedFrom: { type: "node", nodeId: NodeId.make(`node:${name}`) },
        archivedAt: name === "archived" ? now : null,
        deletedAt: name === "deleted" ? now : null,
      });
      yield* createRun(child, name === "running" ? "running" : "completed");
      // A wake queued behind the result: held by Stop or a restart, or still deliverable.
      if (name === "held" || name === "queued") {
        yield* createRun(child, "queued", {
          ordinal: 2,
          startedAt: null,
          ...(name === "held" ? { queueHeld: true } : {}),
        });
      }
      children.push(child);
    }
    const terminalChildren = new Set([children[0]!, children[1]!, children[4]!]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      terminalChildren,
    );

    const completed = children[0]!;
    const transferId = ContextTransferId.make("transfer:recovery:subagent-result");
    yield* projections.apply({
      id: EventId.make("event:recovery:subagent-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: transferId,
        type: "subagent_result",
        sourceThreadId: completed,
        targetThreadId: parent,
        sourcePoint: { threadId: completed },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
    const archivedChild = children[1];
    assert.isDefined(archivedChild);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      new Set([archivedChild, children[4]!]),
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_context_transfers SET payload_json = '{}'
      WHERE context_transfer_id = ${transferId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([parent, completed]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "SQLite", layer: layerTest },
  { name: "memory", layer: ProjectionStore.layerMemory },
])("recovers only recorded follow-up results with $name projections", ({ layer }) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const parent = yield* createThread("followup-parent");
    const child = yield* createThread("followup-child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      forkedFrom: { type: "node", nodeId: NodeId.make("node:original") },
    });
    const originalRunId = yield* createRun(child, "completed");
    yield* projections.apply({
      id: EventId.make("event:original-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: ContextTransferId.make("transfer:original-result"),
        type: "subagent_result",
        sourceThreadId: child,
        targetThreadId: parent,
        sourcePoint: { threadId: child, runId: originalRunId },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
    // Historical untracked work does not acquire a notification on restart.
    yield* createRun(child, "completed", { ordinal: 2 });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const taskId = NodeId.make("node:followup");
    yield* createRun(child, "completed", { ordinal: 3, delegatedTaskId: taskId });
    yield* createRun(child, "running", { ordinal: 4 });
    const task = {
      id: taskId,
      threadId: parent,
      runId: null,
      parentNodeId: NodeId.make("node:parent"),
      origin: "app_owned" as const,
      createdBy: "agent" as const,
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: child,
      nativeTaskRef: null,
      prompt: "Check the follow-up.",
      title: null,
      model: null,
      status: "running" as const,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* projections.apply({
      id: EventId.make("event:followup-task"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: task,
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), [child]);
    yield* projections.apply({
      id: EventId.make("event:followup-settled"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: { ...task, status: "completed", result: "Follow-up result.", completedAt: now },
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("includes shared sessions and provider-owned background rosters in recovery", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const first = yield* createThread("shared-first");
    const second = yield* createThread("shared-second", { archivedAt: now });
    const providerSessionId = ProviderSessionId.make("session:recovery:shared");
    for (const threadId of [first, second]) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:session`),
        type: "provider-session.attached",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
    }
    const roster = yield* createThread("roster");
    yield* projections.apply({
      id: EventId.make("event:recovery:roster"),
      type: "provider-thread.updated",
      threadId: roster,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("provider-thread:recovery:roster"),
        appThreadId: roster,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "background", description: "Still running", kind: "command" },
        ],
      },
    });
    const prepared = yield* createThread("prepared-continuation");
    const preparedSessionId = ProviderSessionId.make("session:recovery:prepared");
    const preparedProviderThreadId = ProviderThreadId.make("provider-thread:recovery:prepared");
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-session"),
      type: "provider-session.attached",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedSessionId,
        driver,
        providerInstanceId,
        status: "stopped",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-thread"),
      type: "provider-thread.updated",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedProviderThreadId,
        appThreadId: prepared,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: preparedSessionId,
        nativeThreadRef: { driver, nativeId: "native:prepared", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [],
      },
    });
    const preparedRunId = yield* createRun(prepared, "starting", {
      providerThreadId: preparedProviderThreadId,
      restartContinuationOfRunId: RunId.make("run:recovery:source"),
    });
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([first, second, roster, prepared]),
    );
    const preparedState = yield* projections.getRuntimeRecoveryProjection(prepared);
    assert.deepEqual(
      preparedState.providerSessions.map((session) => session.id),
      [preparedSessionId],
    );
    assert.equal(restartContinuationRun(preparedState, yield* DateTime.now)?.id, preparedRunId);
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_provider_sessions SET payload_json = '{}'
      WHERE provider_session_id = ${providerSessionId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([first, second]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads the run that owns a background roster, not a queued or resumed one", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const withRoster = Effect.fn(function* (threadId: ThreadId) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:roster`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make(`provider-thread:${threadId}`),
          appThreadId: threadId,
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          pendingBackgroundTasks: [
            { taskId: "background", description: "Still running", kind: "command" },
          ],
        },
      });
    });
    const runIds = (threadId: ThreadId) =>
      projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.map((state) => state.runs.map((run) => run.id)));
    // Settled with background work left, then a queued follow-up.
    const settled = yield* createThread("roster-before-queue");
    const settledRun = yield* createRun(settled, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${settled}`),
    });
    const queuedRun = yield* createRun(settled, "queued", { ordinal: 2, completedAt: null });
    yield* withRoster(settled);
    assert.deepEqual(yield* runIds(settled), [settledRun, queuedRun]);
    // A resumed queued run (ordinal 1) ended after a continuation (ordinal 2).
    const resumed = yield* createThread("roster-after-resume");
    const resumedRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z"),
    });
    const continuationRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      ordinal: 2,
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    });
    yield* withRoster(resumed);
    assert.deepEqual(yield* runIds(resumed), [resumedRun, continuationRun]);
    // Without a roster, settled history is not read.
    const quiet = yield* createThread("no-roster-before-queue");
    yield* createRun(quiet, "completed");
    const quietQueued = yield* createRun(quiet, "queued", { ordinal: 2, completedAt: null });
    assert.deepEqual(yield* runIds(quiet), [quietQueued]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("marks fork descendants unreadable when their source is missing or corrupt", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const source = yield* createThread("source");
    const sourceRun = yield* createRun(source, "completed");
    const fork = yield* createThread("fork", {
      forkedFrom: { type: "run", threadId: source, runId: sourceRun },
    });
    const descendant = yield* createThread("descendant", {
      forkedFrom: { type: "run", threadId: fork, runId: RunId.make("run:fork") },
    });
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{}'
      WHERE run_id = ${sourceRun}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([source, fork, descendant]),
    );
    yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${source}`;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([fork, descendant]),
    );
  }).pipe(Effect.provide(layerTest)),
);

const seedRequest = Effect.fn(function* (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly name: string;
  readonly kind: OrchestrationV2RuntimeRequest["kind"];
  readonly answered?: OrchestrationV2RuntimeRequest["decision"];
  readonly delivery?: "pending" | "delivered";
}) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const nodeId = NodeId.make(`node:${input.name}`);
  const requestId = RuntimeRequestId.make(`request:${input.name}`);
  const question = input.kind === "user_input";
  const runScope = input.runId === null ? {} : { runId: input.runId };
  yield* projections.apply({
    id: EventId.make(`event:${input.name}:node`),
    type: "node.updated",
    threadId: input.threadId,
    ...runScope,
    nodeId,
    occurredAt: now,
    payload: {
      id: nodeId,
      threadId: input.threadId,
      runId: input.runId,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: question ? "user_input_request" : "approval_request",
      status: input.answered === undefined ? "waiting" : "completed",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: input.answered === undefined ? null : now,
    },
  });
  yield* projections.apply({
    id: EventId.make(`event:${input.name}:request`),
    type: "runtime-request.updated",
    threadId: input.threadId,
    nodeId,
    occurredAt: now,
    payload: {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: input.kind,
      status: input.answered === undefined ? "pending" : "resolved",
      responseCapability: {
        type: "live",
        providerSessionId: ProviderSessionId.make("session:recovery:lost"),
      },
      createdAt: now,
      resolvedAt: input.answered === undefined ? null : now,
      ...(input.answered === undefined ? {} : { decision: input.answered }),
      ...(input.delivery === undefined
        ? {}
        : { delivery: { state: input.delivery, attempts: 0, updatedAt: now } }),
    },
  });
  const itemBase = {
    id: TurnItemId.make(`item:${input.name}`),
    threadId: input.threadId,
    runId: input.runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 10,
    status: input.answered === undefined ? ("waiting" as const) : ("completed" as const),
    title: null,
    startedAt: now,
    completedAt: input.answered === undefined ? null : now,
    updatedAt: now,
    requestId,
  };
  yield* projections.apply({
    id: EventId.make(`event:${input.name}:item`),
    type: "turn-item.updated",
    threadId: input.threadId,
    ...runScope,
    nodeId,
    occurredAt: now,
    payload: question
      ? {
          ...itemBase,
          type: "user_input_request",
          questions: [{ id: "q", header: "Q", question: "Which branch?", options: [] }],
        }
      : { ...itemBase, type: "approval_request", requestKind: "command" },
  });
  return { requestId, itemId: itemBase.id };
});

const requestState = Effect.fn(function* (threadId: ThreadId, requestId: RuntimeRequestId) {
  const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
    threadId,
  );
  const request = projection.runtimeRequests.find((candidate) => candidate.id === requestId);
  const item = projection.turnItems.find(
    (candidate) =>
      (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
      candidate.requestId === requestId,
  );
  return { projection, request, item };
});

// Invariant (crash path): after a crash, startup recovery leaves no run working
// and no request answerable. A cut turn says Interrupted, an approval it waited
// on is a lost decision the user can ask again for, held queues stay held, and
// recovering twice changes nothing.
it.effect("startup recovery turns a decision cut by a crash into a lost one, once", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const threadId = yield* createThread("lost:crash");
    const runId = yield* createRun(threadId, "running");
    const queuedRunId = yield* createRun(threadId, "queued", {
      ordinal: 2,
      startedAt: null,
      queuePosition: 1,
    });
    const approval = yield* seedRequest({
      threadId,
      runId,
      name: "crash-approval",
      kind: "command",
    });
    const tool = yield* seedRequest({
      threadId,
      runId,
      name: "crash-tool",
      kind: "dynamic_tool_call",
    });

    const first = yield* recovery.reconcile("startup");
    assert.equal(first.terminalizedRuns, 1);

    const { projection, request, item } = yield* requestState(threadId, approval.requestId);
    assert.isFalse(
      projection.runs.some((run) => ["preparing", "starting", "running"].includes(run.status)),
    );
    const cut = projection.runs.find((run) => run.id === runId);
    assert.equal(cut?.status, "cancelled");
    assert.deepEqual(
      projection.turnItems
        .filter((candidate) => candidate.type === "run_interrupt_result")
        .map((candidate) => candidate.title),
      ["Interrupted by restart"],
    );
    assert.isFalse(
      projection.runtimeRequests.some(
        (candidate) =>
          candidate.status === "pending" && candidate.responseCapability.type === "live",
      ),
    );
    assert.equal(request?.status, "expired");
    assert.equal(request?.lost?.cause, "server_restart");
    assert.equal(item?.status, "cancelled");
    assert.equal(item?.title, "Approval lost: Stark Code restarted");
    const toolRequest = projection.runtimeRequests.find(
      (candidate) => candidate.id === tool.requestId,
    );
    assert.equal(toolRequest?.status, "expired");
    assert.isUndefined(toolRequest?.lost);
    const queued = projection.runs.find((run) => run.id === queuedRunId);
    assert.equal(queued?.status, "queued");
    assert.isTrue(queued?.queueHeld);
    assert.equal(
      (yield* projections.getThreadShell(threadId))?.lostRuntimeRequest?.id,
      approval.requestId,
    );

    const second = yield* recovery.reconcile("startup");
    assert.equal(second.terminalizedRuns, 0);
    assert.equal(second.closedRequests, 0);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

// Invariant (graceful path): a shutdown marks the decision lost to the
// shutdown, and the startup after it neither re-marks it nor cuts the turn again.
it.effect("a graceful restart marks a cut question lost to the shutdown exactly once", () =>
  Effect.gen(function* () {
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const threadId = yield* createThread("lost:graceful");
    const runId = yield* createRun(threadId, "running");
    const question = yield* seedRequest({
      threadId,
      runId,
      name: "graceful-question",
      kind: "user_input",
    });

    yield* recovery.reconcile("shutdown");
    yield* recovery.reconcile("startup");

    const { projection, request, item } = yield* requestState(threadId, question.requestId);
    assert.equal(request?.status, "cancelled");
    assert.equal(request?.lost?.cause, "server_shutdown");
    assert.equal(item?.title, "Question lost: Stark Code shut down");
    assert.deepEqual(
      projection.turnItems
        .filter((candidate) => candidate.type === "run_interrupt_result")
        .map((candidate) => candidate.title),
      ["Interrupted by shutdown"],
    );
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("titles a lost request whose item no cut run owns", () =>
  Effect.gen(function* () {
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const threadId = yield* createThread("lost:runless");
    const approval = yield* seedRequest({
      threadId,
      runId: null,
      name: "runless-approval",
      kind: "permission",
    });

    yield* recovery.reconcile("startup");

    const { request, item } = yield* requestState(threadId, approval.requestId);
    assert.equal(request?.lost?.cause, "server_restart");
    assert.equal(item?.status, "cancelled");
    assert.equal(item?.title, "Approval lost: Stark Code restarted");
  }).pipe(Effect.provide(layerRecoveryTest)),
);

// An answer committed before the crash whose provider delivery never settled is
// kept, marked uncertain, and never rerun: the turn waits on the user.
it.effect("keeps an answer whose delivery the crash interrupted as an uncertain lost one", () =>
  Effect.gen(function* () {
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = yield* createThread("lost:undelivered");
    const runId = yield* createRun(threadId, "running");
    const answered = yield* seedRequest({
      threadId,
      runId,
      name: "undelivered-approval",
      kind: "command",
      answered: "accept",
    });
    const delivered = yield* seedRequest({
      threadId,
      runId,
      name: "delivered-approval",
      kind: "command",
      answered: "decline",
    });
    yield* outbox.enqueue([
      {
        id: "effect:undelivered-answer",
        commandId: CommandId.make("command:undelivered-answer"),
        threadId,
        request: {
          type: "runtime-request.respond",
          providerSessionId: ProviderSessionId.make("session:recovery:lost"),
          requestId: answered.requestId,
          decision: "accept",
        },
      },
      {
        id: "effect:delivered-answer",
        commandId: CommandId.make("command:delivered-answer"),
        threadId,
        request: {
          type: "runtime-request.respond",
          providerSessionId: ProviderSessionId.make("session:recovery:lost"),
          requestId: delivered.requestId,
          decision: "decline",
        },
      },
    ]);
    yield* sql`
      UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'
      WHERE effect_id = 'effect:delivered-answer'
    `;

    const summary = yield* recovery.reconcile("startup");
    assert.equal(summary.closedRequests, 1);

    const { projection, request, item } = yield* requestState(threadId, answered.requestId);
    assert.equal(request?.status, "expired");
    assert.equal(request?.decision, "accept");
    assert.deepEqual(request?.lost?.cause, "server_restart");
    assert.isTrue(request?.lost?.deliveryUncertain);
    assert.equal(item?.status, "completed");
    assert.equal(item?.title, "Answer may not have reached the agent: Stark Code restarted");
    const settled = projection.runtimeRequests.find(
      (candidate) => candidate.id === delivered.requestId,
    );
    assert.equal(settled?.status, "resolved");
    assert.isUndefined(settled?.lost);
    assert.deepEqual(
      yield* outbox.listUnsettled({ threadId, effectTypes: ["runtime-request.respond"] }),
      [],
    );
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("turns an answer whose delivery report never landed into an uncertain one, once", () =>
  Effect.gen(function* () {
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = yield* createThread("lost:orphaned-delivery");
    const runId = yield* createRun(threadId, "running");
    // The respond effect failed for good, but its report never reached the request.
    const orphaned = yield* seedRequest({
      threadId,
      runId,
      name: "orphaned-delivery",
      kind: "command",
      answered: "accept",
      delivery: "pending",
    });
    const delivered = yield* seedRequest({
      threadId,
      runId,
      name: "reported-delivery",
      kind: "command",
      answered: "accept",
      delivery: "delivered",
    });
    yield* outbox.enqueue([
      {
        id: "effect:orphaned-delivery",
        commandId: CommandId.make("command:orphaned-delivery"),
        threadId,
        request: {
          type: "runtime-request.respond",
          providerSessionId: ProviderSessionId.make("session:recovery:lost"),
          requestId: orphaned.requestId,
          decision: "accept",
        },
      },
    ]);
    yield* sql`
      UPDATE orchestration_v2_effect_outbox SET status = 'failed'
      WHERE effect_id = 'effect:orphaned-delivery'
    `;

    yield* recovery.reconcile("startup");
    const { request, item } = yield* requestState(threadId, orphaned.requestId);
    assert.equal(request?.delivery?.state, "uncertain");
    assert.isTrue(request?.lost?.deliveryUncertain);
    assert.equal(request?.decision, "accept");
    assert.equal(item?.title, "Answer may not have reached the agent: Stark Code restarted");
    const kept = yield* requestState(threadId, delivered.requestId);
    assert.equal(kept.request?.delivery?.state, "delivered");
    assert.isUndefined(kept.request?.lost);

    // A second restart changes nothing.
    const before = request;
    yield* recovery.reconcile("startup");
    assert.deepEqual((yield* requestState(threadId, orphaned.requestId)).request, before);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

// No run needs cutting here, yet the restart still cancels the undelivered
// answer: a question from a settled root's background work, or one no run owns.
it.effect.each(["a completed root turn", "no run"] as const)(
  "keeps an undelivered answer on %s as an uncertain lost one",
  (owner) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const name = owner === "no run" ? "runless" : "completed";
      const threadId = yield* createThread(`lost:undelivered-${name}`);
      const runId = owner === "no run" ? null : yield* createRun(threadId, "completed");
      const answered = yield* seedRequest({
        threadId,
        runId,
        name: `undelivered-${name}-approval`,
        kind: "permission",
        answered: "accept",
      });
      yield* outbox.enqueue([
        {
          id: `effect:undelivered-${name}-answer`,
          commandId: CommandId.make(`command:undelivered-${name}-answer`),
          threadId,
          request: {
            type: "runtime-request.respond",
            providerSessionId: ProviderSessionId.make("session:recovery:lost"),
            requestId: answered.requestId,
            decision: "accept",
          },
        },
      ]);

      const summary = yield* recovery.reconcile("startup");
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.closedRequests, 1);

      const { projection, request, item } = yield* requestState(threadId, answered.requestId);
      assert.equal(request?.status, "expired");
      assert.equal(request?.decision, "accept");
      assert.equal(request?.lost?.cause, "server_restart");
      assert.isTrue(request?.lost?.deliveryUncertain);
      assert.equal(item?.status, "completed");
      assert.equal(item?.title, "Answer may not have reached the agent: Stark Code restarted");
      if (runId !== null) {
        assert.equal(projection.runs.find((run) => run.id === runId)?.status, "completed");
      }
      assert.isTrue(
        (yield* projections.getThreadShell(threadId))?.lostRuntimeRequest?.deliveryUncertain,
      );
      assert.deepEqual(
        yield* outbox.listUnsettled({ threadId, effectTypes: ["runtime-request.respond"] }),
        [],
      );
    }).pipe(Effect.provide(layerRecoveryTest)),
);
