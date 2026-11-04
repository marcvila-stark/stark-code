import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  type ScheduledTaskRun,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { RUN_ERRORS, occurrenceKeys, runCommandId, runMessageId } from "./ScheduledTaskRuns.ts";
import * as ScheduledTaskRunTracker from "./ScheduledTaskRunTracker.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const PROJECT_ID = ProjectId.make("project-runs");
const THREAD_ID = ThreadId.make("thread-1");

const taskInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    id: "scheduled-task:runs",
    title: "Nightly review",
    prompt: "Review the open pull requests.",
    enabled: false,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: PROJECT_ID,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

/** An orchestration run as `run.created` and `run.updated` carry it. */
const agentRun = (
  input: Pick<OrchestrationV2Run, "id" | "status" | "userMessageId"> & Partial<OrchestrationV2Run>,
): OrchestrationV2Run => ({
  threadId: THREAD_ID,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  providerThreadId: null,
  rootNodeId: null,
  activeAttemptId: null,
  requestedAt: DateTime.makeUnsafe("2026-10-29T10:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...input,
});

interface Harness {
  readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
  readonly launches: Queue.Queue<ThreadLaunchService.ThreadLaunchInput>;
}

/**
 * A service whose launches are pushed to `launches`. `launch` replaces the
 * default launch, which answers with THREAD_ID.
 */
const withService = <A, E, R>(
  body: (harness: Harness) => Effect.Effect<A, E, R>,
  options: {
    readonly launch?: (
      input: ThreadLaunchService.ThreadLaunchInput,
    ) => Effect.Effect<
      unknown,
      | ThreadLaunchService.ThreadLaunchError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
    readonly threads?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  } = {},
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<ThreadLaunchService.ThreadLaunchInput>();
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Queue.offer(launches, input).pipe(
            Effect.andThen(options.launch?.(input) ?? Effect.void),
            Effect.as({ threadId: THREAD_ID, resumed: false } as never),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)(options.threads ?? {}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body({ service, launches });
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provideMerge(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const listRuns = (service: Harness["service"], task: ScheduledTask) =>
  service.listRuns({ id: task.id }).pipe(Effect.map((result) => result.runs));

const onlyRun = (service: Harness["service"], task: ScheduledTask) =>
  listRuns(service, task).pipe(
    Effect.map((runs) => {
      assert.equal(runs.length, 1);
      return runs[0]!;
    }),
  );

/** Waits until the task list shows a latest run matching `predicate`. */
const awaitLatestRun = (
  service: Harness["service"],
  predicate: (run: ScheduledTaskRun) => boolean,
) =>
  service.subscribeList().pipe(
    Stream.map((list) => list.tasks[0]?.latestRun),
    Stream.filter((run): run is ScheduledTaskRun => run !== undefined && predicate(run)),
    Stream.runHead,
  );

/** The run row a server leaves behind when it stops at a given point. */
const seedRun = (
  sql: SqlClient.SqlClient,
  task: ScheduledTask,
  row: {
    readonly id: string;
    readonly createdAt: string;
    readonly dispatchKind?: "launch" | "send";
    readonly dispatchState: string;
    readonly threadId?: string | null;
    readonly agentRunId?: string | null;
    readonly agentStatus?: string | null;
    readonly agentSequence?: number;
    readonly agentEndedAt?: string | null;
    readonly webhookDeliveryId?: string | null;
  },
) => {
  const occurrenceKey = occurrenceKeys.manual(task, row.id);
  return sql`INSERT INTO scheduled_task_runs ${sql.insert({
    run_id: row.id,
    task_id: task.id,
    task_created_at: task.createdAt,
    project_id: task.projectId,
    trigger_kind: row.webhookDeliveryId ? "webhook" : "manual",
    occurrence_key: occurrenceKey,
    dispatch_kind: row.dispatchKind ?? "launch",
    command_id: runCommandId(occurrenceKey),
    message_id: runMessageId(occurrenceKey),
    webhook_delivery_id: row.webhookDeliveryId ?? null,
    thread_id: row.threadId ?? null,
    dispatch_state: row.dispatchState,
    agent_run_id: row.agentRunId ?? null,
    agent_status: row.agentStatus ?? null,
    agent_sequence: row.agentSequence ?? 0,
    agent_ended_at: row.agentEndedAt ?? null,
    created_at: row.createdAt,
    started_at: row.dispatchState === "waiting" ? null : row.createdAt,
  })}`.pipe(
    Effect.as({
      commandId: runCommandId(occurrenceKey),
      messageId: runMessageId(occurrenceKey),
    }),
  );
};

const acceptedReceipt = (
  receipts: CommandReceiptStore.CommandReceiptStoreV2["Service"],
  input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly status?: "accepted" | "rejected";
  },
) =>
  receipts.insertIfAbsent({
    commandId: input.commandId,
    threadId: input.threadId,
    commandType: input.commandType,
    acceptedAt: DateTime.makeUnsafe("2026-10-29T10:00:00.000Z"),
    resultSequence: 1,
    status: input.status ?? "accepted",
    error: input.status === "rejected" ? "Refused for a reason with PRIVATE-DETAIL." : null,
  });

it.effect("steps over a scheduled slot that already has a run instead of choosing it again", () =>
  Effect.gen(function* () {
    const slot = "2026-10-29T09:00:00.000Z";
    yield* TestClock.setTime(Date.parse(slot) + 1_000);
    yield* withService(({ service, launches }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { task } = yield* service.upsert(yield* taskInput({ enabled: true }));
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${slot} WHERE task_id = ${task.id}`;
        // A run for this slot exists already, as after a restart mid-run.
        const occurrenceKey = occurrenceKeys.scheduled(task, slot);
        yield* sql`INSERT INTO scheduled_task_runs ${sql.insert({
          run_id: "scheduled-run:earlier",
          task_id: task.id,
          task_created_at: task.createdAt,
          project_id: task.projectId,
          trigger_kind: "scheduled",
          occurrence_key: occurrenceKey,
          dispatch_kind: "launch",
          command_id: runCommandId(occurrenceKey),
          message_id: runMessageId(occurrenceKey),
          dispatch_state: "dispatched",
          thread_id: THREAD_ID,
          created_at: slot,
          started_at: slot,
        })}`;

        const moved = Effect.forkChild(
          service.subscribeList().pipe(
            Stream.filter((list) => list.tasks[0]?.nextRunAt !== slot),
            Stream.runHead,
          ),
        );
        const fiber = yield* moved;
        yield* TestClock.adjust("6 seconds");
        const listed = yield* Fiber.join(fiber);
        assert.isTrue(listed._tag === "Some");
        const next = listed._tag === "Some" ? listed.value.tasks[0]?.nextRunAt : null;
        assert.isNotNull(next);
        assert.isTrue(Date.parse(next!) > Date.parse(slot));
        assert.equal(yield* Queue.size(launches), 0);
        const run = yield* onlyRun(service, task);
        assert.equal(run.id, "scheduled-run:earlier");
      }),
    );
  }),
);

it.effect("moves a scheduled slot past itself in the same write that reserves its run", () =>
  Effect.gen(function* () {
    const slot = "2026-10-29T09:00:00.000Z";
    yield* TestClock.setTime(Date.parse(slot) + 1_000);
    const dispatching = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { task } = yield* service.upsert(yield* taskInput({ enabled: true }));
          yield* sql`UPDATE scheduled_tasks SET next_run_at = ${slot} WHERE task_id = ${task.id}`;
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(dispatching);

          // The launch is still in flight, yet the slot is already behind the task.
          const [row] = yield* sql<{
            next_run_at: string | null;
          }>`SELECT next_run_at FROM scheduled_tasks WHERE task_id = ${task.id}`;
          assert.isTrue(Date.parse(row!.next_run_at!) > Date.parse(slot));
          const reserved = yield* onlyRun(service, task);
          assert.equal(reserved.state, "starting");
          assert.equal(reserved.trigger, "scheduled");
          assert.isNull(reserved.threadId);
          const launched = yield* Queue.take(launches);
          assert.equal(launched.commandId, runCommandId(occurrenceKeys.scheduled(task, slot)));

          yield* Deferred.succeed(release, undefined);
          const dispatched = yield* awaitLatestRun(service, (run) => run.threadId !== null);
          assert.equal(dispatched._tag, "Some");
          const run = yield* onlyRun(service, task);
          assert.equal(run.threadId, THREAD_ID);
          // Dispatch alone is not the agent's outcome.
          assert.equal(run.state, "starting");
        }),
      {
        launch: () =>
          Deferred.succeed(dispatching, undefined).pipe(Effect.andThen(Deferred.await(release))),
      },
    );
  }),
);

it.effect("returns the run a Run now click started when the same click id comes again", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* taskInput());
      const click = CommandId.make("click-1");
      const first = yield* service.runNow({ id: task.id, commandId: click });
      const again = yield* service.runNow({ id: task.id, commandId: click });
      assert.isDefined(first.run);
      assert.equal(again.run?.id, first.run?.id);
      assert.equal(yield* Queue.size(launches), 1);

      const next = yield* service.runNow({ id: task.id, commandId: CommandId.make("click-2") });
      assert.notEqual(next.run?.id, first.run?.id);
      assert.equal(yield* Queue.size(launches), 2);
      const runs = yield* listRuns(service, task);
      assert.deepEqual(
        runs.map((run) => run.trigger),
        ["manual", "manual"],
      );
      // The task list carries the newest run for badges and the thread panel.
      const listed = yield* service.list();
      assert.equal(listed.tasks[0]?.latestRun?.id, next.run?.id);
    }),
  ),
);

it.effect("follows the agent run by event sequence, including moves back to earlier states", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* taskInput());
      const { run } = yield* service.runNow({ id: task.id, commandId: CommandId.make("seq") });
      const messageId = runMessageId(occurrenceKeys.manual(task, "seq"));
      const id = RunId.make("run-a");
      const observe = (sequence: number, overrides: Partial<OrchestrationV2Run>) =>
        service.observeRun({
          run: agentRun({ id, userMessageId: messageId, status: "starting", ...overrides }),
          sequence,
        });
      const state = onlyRun(service, task).pipe(Effect.map((current) => current.state));

      yield* observe(10, { status: "starting" });
      assert.equal(yield* state, "starting");
      // Sent to a busy bound thread: the run waits its turn.
      yield* observe(11, { status: "queued" });
      assert.equal(yield* state, "queued");
      yield* observe(12, { status: "running" });
      // An older observation arriving late changes nothing.
      yield* observe(11, { status: "queued" });
      assert.equal(yield* state, "running");
      yield* observe(13, {
        status: "failed",
        completedAt: DateTime.makeUnsafe("2026-10-29T10:05:00.000Z"),
      });
      const failed = yield* onlyRun(service, task);
      assert.equal(failed.state, "failed");
      assert.equal(failed.endedAt, "2026-10-29T10:05:00.000Z");
      // A workspace retry prepares the same run again.
      yield* observe(14, { status: "preparing" });
      const retried = yield* onlyRun(service, task);
      assert.equal(retried.state, "starting");
      assert.isNull(retried.endedAt);
      yield* observe(15, {
        status: "completed",
        completedAt: DateTime.makeUnsafe("2026-10-29T10:09:00.000Z"),
      });
      const done = yield* onlyRun(service, task);
      assert.equal(done.id, run?.id);
      assert.equal(done.state, "succeeded");
      assert.equal(done.endedAt, "2026-10-29T10:09:00.000Z");
    }),
  ),
);

it.effect("moves to a restart continuation and ignores the run it replaced", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* taskInput());
      yield* service.runNow({ id: task.id, commandId: CommandId.make("cont") });
      const messageId = runMessageId(occurrenceKeys.manual(task, "cont"));
      const source = RunId.make("run-source");
      const continuation = RunId.make("run-continuation");
      const state = onlyRun(service, task).pipe(Effect.map((current) => current.state));

      yield* service.observeRun({
        run: agentRun({ id: source, userMessageId: messageId, status: "cancelled" }),
        sequence: 20,
      });
      assert.equal(yield* state, "cancelled");
      yield* service.observeRun({
        run: agentRun({
          id: continuation,
          userMessageId: MessageId.make("restart-continuation-message"),
          status: "running",
          restartContinuationOfRunId: source,
        }),
        sequence: 21,
      });
      assert.equal(yield* state, "running");
      // The replaced run can still be updated, for example by a checkpoint.
      yield* service.observeRun({
        run: agentRun({ id: source, userMessageId: messageId, status: "cancelled" }),
        sequence: 22,
      });
      assert.equal(yield* state, "running");
      yield* service.observeRun({
        run: agentRun({
          id: continuation,
          userMessageId: MessageId.make("restart-continuation-message"),
          status: "completed",
          restartContinuationOfRunId: source,
        }),
        sequence: 23,
      });
      assert.equal(yield* state, "succeeded");
    }),
  ),
);

it.effect("shows a fixed reason for a failed dispatch and keeps the cause out of the run", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* taskInput());
        yield* service.runNow({ id: task.id, commandId: CommandId.make("boom") });
        const failed = yield* onlyRun(service, task);
        assert.equal(failed.state, "failed");
        assert.equal(failed.error, RUN_ERRORS.notStarted);
        assert.isNotNull(failed.endedAt);
        // The launch had created its thread before failing, so the run links it.
        assert.equal(failed.threadId, "thread-partial");
        const wire = JSON.stringify(yield* service.listRuns({ id: task.id }));
        assert.notInclude(wire, "PRIVATE-DETAIL");
      }),
    {
      launch: (input) =>
        Effect.fail(
          new ThreadLaunchService.ThreadLaunchError({
            operation: "dispatch-message",
            commandId: input.commandId,
            projectId: input.projectId,
            threadId: ThreadId.make("thread-partial"),
            cause: "token PRIVATE-DETAIL rejected",
          }),
        ),
    },
  ),
);

it.effect("names a disabled provider as the reason a run did not start", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* taskInput());
        yield* service.runNow({ id: task.id });
        const failed = yield* onlyRun(service, task);
        assert.equal(failed.error, RUN_ERRORS.providerDisabled);
      }),
    {
      launch: () =>
        Effect.fail(
          new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
            projectId: PROJECT_ID,
            instanceId: ProviderInstanceId.make("codex"),
          }),
        ),
    },
  ),
);

/**
 * Runs a task bound to THREAD_ID once while the thread is `shell`, and
 * reports whether the prompt went out and what the run shows.
 */
const runBound = (shell: OrchestrationV2ThreadShell, task: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const sends = yield* Ref.make(0);
    return yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const { task: saved } = yield* service.upsert(
            yield* taskInput({ threadId: THREAD_ID, runtimeMode: "approval-required", ...task }),
          );
          yield* service.runNow({ id: saved.id });
          const run = yield* onlyRun(service, saved);
          const listed = (yield* service.list()).tasks[0]!;
          return {
            sent: yield* Ref.get(sends),
            error: run.error,
            lastRunStatus: listed.lastRunStatus,
          };
        }),
      {
        threads: {
          getThreadShell: () => Effect.succeed(shell),
          sendToThread: () => Ref.update(sends, (count) => count + 1).pipe(Effect.as({} as never)),
        },
      },
    );
  });

const claudeTask = { modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } };

it.effect("runs a bound task while its thread stays within the task's limit", () =>
  Effect.gen(function* () {
    const within = yield* runBound(
      liveThreadShell(THREAD_ID, { runtimeMode: "approval-required", instance: "claudeAgent" }),
      claudeTask,
    );
    assert.deepEqual(within, { sent: 1, error: null, lastRunStatus: "succeeded" });
    // Codex chats store the Supervised mode they run, which is within the task's limit.
    const codex = yield* runBound(liveThreadShell(THREAD_ID, { runtimeMode: "approval-required" }));
    assert.equal(codex.sent, 1);
  }),
);

it.effect("refuses a bound run visibly when its thread now asks for more than the task", () =>
  Effect.gen(function* () {
    const broader = yield* runBound(
      liveThreadShell(THREAD_ID, { runtimeMode: "auto", instance: "claudeAgent" }),
      claudeTask,
    );
    // The thread is never widened or changed for the run, and the prompt never goes out.
    assert.deepEqual(broader, {
      sent: 0,
      error:
        "Not run: the thread now allows auto/default, more than this task's approval-required/default. Narrow the thread or edit the task.",
      lastRunStatus: "failed",
    });
    const moved = yield* runBound(
      liveThreadShell(THREAD_ID, { runtimeMode: "approval-required", instance: "claudeAgent" }),
    );
    assert.equal(moved.sent, 0);
    assert.include(moved.error ?? "", "different provider");
    const inheriting = yield* runBound(
      Object.assign(liveThreadShell(THREAD_ID, { runtimeMode: "approval-required" }), {
        permissionSource: "inherit",
      }),
    );
    assert.equal(inheriting.sent, 0);
    assert.include(inheriting.error ?? "", "own permission settings");
  }),
);

it.effect("lists an accepted webhook delivery as a waiting run until its turn comes", () =>
  Effect.gen(function* () {
    const firstDispatching = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let launchCount = 0;
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* taskInput({ schedule: { type: "webhook" }, enabled: true }),
          );
          const request = (body: string): ScheduledTaskService.WebhookTriggerRequest => ({
            hookId: task.id,
            token: task.webhook!.path.split("/").at(-1)!,
            method: "POST",
            path: `/api/hooks/${task.id}`,
            query: "",
            headers: {},
            body: new TextEncoder().encode(body),
            bodyText: body,
          });
          const first = yield* service.triggerWebhook(request("first"));
          yield* Deferred.await(firstDispatching);
          const second = yield* service.triggerWebhook(request("second"));
          assert.equal(second._tag, "accepted");

          const runs = yield* listRuns(service, task);
          assert.deepEqual(
            runs.map((run) => [run.state, run.trigger, run.webhookDeliveryId]),
            [
              ["waiting", "webhook", second._tag === "accepted" ? second.deliveryId : null],
              ["starting", "webhook", first._tag === "accepted" ? first.deliveryId : null],
            ],
          );
          assert.isNull(runs[0]?.startedAt);

          // Paused while it waits: the delivery is skipped, and its run says why.
          yield* service.setEnabled({ id: task.id, enabled: false });
          yield* Deferred.succeed(release, undefined);
          yield* Queue.take(launches);
          const skipped = yield* awaitLatestRun(service, (run) => run.state === "skipped");
          assert.equal(skipped._tag, "Some");
          const settled = yield* listRuns(service, task);
          assert.equal(settled[0]?.error, "The task was paused before this delivery ran.");
          assert.equal(settled[1]?.threadId, THREAD_ID);
          assert.equal(launchCount, 1);
        }),
      {
        launch: () =>
          Effect.sync(() => {
            launchCount += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(firstDispatching, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
      },
    );
  }),
);

it.effect("settles runs a stopped server left open from the receipts it finds", () =>
  Effect.gen(function* () {
    const launchedThread = ThreadId.make("thread-launched");
    const boundThread = ThreadId.make("thread-bound");
    const records = new Map<string, { runs: OrchestrationV2Run[]; messages: unknown[] }>();
    const dispatching = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const { task } = yield* service.upsert(yield* taskInput());
          const at = (minute: number) => `2026-10-29T10:${String(minute).padStart(2, "0")}:00.000Z`;

          // Stopped after reserving: nothing reached the orchestrator.
          yield* seedRun(sql, task, {
            id: "a-reserved",
            createdAt: at(1),
            dispatchState: "dispatching",
          });
          // Stopped after the launch created its thread, before the prompt.
          const created = yield* seedRun(sql, task, {
            id: "b-thread",
            createdAt: at(2),
            dispatchState: "dispatching",
          });
          yield* acceptedReceipt(receipts, {
            commandId: created.commandId,
            threadId: launchedThread,
            commandType: "thread.create",
          });
          // Stopped after the prompt was committed.
          const committed = yield* seedRun(sql, task, {
            id: "c-message",
            createdAt: at(3),
            dispatchState: "dispatching",
          });
          yield* acceptedReceipt(receipts, {
            commandId: committed.commandId,
            threadId: ThreadId.make("thread-committed"),
            commandType: "thread.create",
          });
          yield* acceptedReceipt(receipts, {
            commandId: CommandId.make(`${committed.commandId}:initial-message`),
            threadId: ThreadId.make("thread-committed"),
            commandType: "message.dispatch",
          });
          records.set("thread-committed", {
            runs: [
              agentRun({
                id: RunId.make("run-committed"),
                userMessageId: committed.messageId,
                status: "running",
                threadId: ThreadId.make("thread-committed"),
              }),
            ],
            messages: [{ id: committed.messageId, runId: RunId.make("run-committed") }],
          });
          // Dispatch was recorded, but no run had been seen yet; it finished since.
          const unobserved = yield* seedRun(sql, task, {
            id: "d-unobserved",
            createdAt: at(4),
            dispatchState: "dispatched",
            threadId: launchedThread,
          });
          yield* acceptedReceipt(receipts, {
            commandId: unobserved.commandId,
            threadId: launchedThread,
            commandType: "thread.create",
          });
          yield* acceptedReceipt(receipts, {
            commandId: CommandId.make(`${unobserved.commandId}:initial-message`),
            threadId: launchedThread,
            commandType: "message.dispatch",
          });
          records.set(launchedThread, {
            runs: [
              agentRun({
                id: RunId.make("run-unobserved"),
                userMessageId: unobserved.messageId,
                status: "completed",
                threadId: launchedThread,
              }),
            ],
            messages: [{ id: unobserved.messageId, runId: RunId.make("run-unobserved") }],
          });
          // The orchestrator refused the launch.
          const refused = yield* seedRun(sql, task, {
            id: "e-refused",
            createdAt: at(5),
            dispatchState: "dispatching",
          });
          yield* acceptedReceipt(receipts, {
            commandId: refused.commandId,
            threadId: ThreadId.make("thread-refused"),
            commandType: "thread.create",
            status: "rejected",
          });
          // A send to a bound thread that never went out.
          yield* seedRun(sql, task, {
            id: "f-send",
            createdAt: at(6),
            dispatchKind: "send",
            dispatchState: "dispatching",
            threadId: boundThread,
          });
          // A webhook delivery still waiting for its turn.
          yield* sql`INSERT INTO scheduled_task_webhook_deliveries ${sql.insert({
            delivery_id: "delivery:lost",
            task_id: task.id,
            received_at: at(7),
            method: "POST",
            query: "",
            headers_json: "{}",
            body: "",
            body_bytes: 0,
            body_truncated: 0,
            outcome: "accepted",
            signature_verified: 0,
            missing_fields_json: "[]",
            rendered_prompt: "prompt",
            error: null,
          })}`;
          yield* seedRun(sql, task, {
            id: "g-waiting",
            createdAt: at(7),
            dispatchState: "waiting",
            webhookDeliveryId: "delivery:lost",
          });

          // A run this process is dispatching right now is not left behind.
          const inFlight = yield* service
            .runNow({ id: task.id, commandId: CommandId.make("in-flight") })
            .pipe(Effect.forkChild);
          yield* Deferred.await(dispatching);

          yield* service.reconcileRuns(
            ScheduledTaskRunTracker.makeRunInspector({ threads, receipts }),
          );

          const runs = new Map(
            (yield* listRuns(service, task)).map((run) => [run.id as string, run]),
          );
          const summary = (id: string) => {
            const run = runs.get(id);
            return [run?.state, run?.threadId, run?.error];
          };
          assert.deepEqual(summary("a-reserved"), [
            "interrupted",
            null,
            RUN_ERRORS.restartBeforeStart,
          ]);
          assert.deepEqual(summary("b-thread"), [
            "interrupted",
            launchedThread,
            RUN_ERRORS.restartBeforePrompt,
          ]);
          assert.deepEqual(summary("c-message"), ["running", "thread-committed", null]);
          assert.deepEqual(summary("d-unobserved"), ["succeeded", launchedThread, null]);
          assert.deepEqual(summary("e-refused"), ["failed", null, RUN_ERRORS.notStarted]);
          assert.deepEqual(summary("f-send"), [
            "interrupted",
            boundThread,
            RUN_ERRORS.restartBeforeStart,
          ]);
          assert.deepEqual(summary("g-waiting"), [
            "interrupted",
            null,
            RUN_ERRORS.restartBeforeDelivery,
          ]);
          const { deliveries } = yield* service.listWebhookDeliveries({ id: task.id });
          assert.equal(deliveries[0]?.outcome, "dispatch_failed");
          assert.equal(deliveries[0]?.error, RUN_ERRORS.restartBeforeDelivery);
          // Its launch has no receipt yet, so only the hold keeps it open.
          const held = [...runs.values()].filter((run) => run.id.startsWith("scheduled-run:"));
          assert.deepEqual(
            held.map((run) => run.state),
            ["starting"],
          );

          // The committed run is linked, so its later events reach it.
          yield* service.observeRun({
            run: agentRun({
              id: RunId.make("run-committed"),
              userMessageId: committed.messageId,
              status: "completed",
              threadId: ThreadId.make("thread-committed"),
            }),
            sequence: 99,
          });
          const linked = (yield* listRuns(service, task)).find((run) => run.id === "c-message");
          assert.equal(linked?.state, "succeeded");

          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(inFlight);
        }).pipe(Effect.provide(CommandReceiptStore.layer)),
      {
        launch: () =>
          Deferred.succeed(dispatching, undefined).pipe(Effect.andThen(Deferred.await(release))),
        threads: {
          getThreadEventSequence: () => Effect.succeed(50),
          getProjectThreadRecords: (input) => {
            const found = records.get(input.threadId);
            return found === undefined
              ? Effect.fail(
                  new ThreadManagementService.ThreadManagementThreadNotFoundError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                  }),
                )
              : Effect.succeed(found as never);
          },
        },
      },
    );
  }),
);

it.effect("follows run events from before its snapshot, so neither can lose an update", () =>
  Effect.gen(function* () {
    const afterSequences: Array<number | undefined> = [];
    const updates = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const snapshotRun = yield* Ref.make<OrchestrationV2Run | null>(null);
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { task } = yield* service.upsert(yield* taskInput({ threadId: THREAD_ID }));
          // The prompt went out to the bound thread, then the server stopped.
          const sent = yield* seedRun(sql, task, {
            id: "sent",
            createdAt: "2026-10-29T10:00:00.000Z",
            dispatchKind: "send",
            dispatchState: "dispatched",
            threadId: THREAD_ID,
          });
          const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
          yield* acceptedReceipt(receipts, {
            commandId: sent.commandId,
            threadId: THREAD_ID,
            commandType: "message.dispatch",
          });
          const runId = RunId.make("run-sent");
          yield* Ref.set(
            snapshotRun,
            agentRun({ id: runId, userMessageId: sent.messageId, status: "running" }),
          );
          const update = (sequence: number, status: OrchestrationV2Run["status"]) =>
            Queue.offer(updates, {
              sequence,
              commandId: null,
              event: {
                id: EventId.make(`event-${sequence}`),
                threadId: THREAD_ID,
                occurredAt: DateTime.makeUnsafe("2026-10-29T10:01:00.000Z"),
                type: "run.updated",
                payload: agentRun({ id: runId, userMessageId: sent.messageId, status }),
              },
            });
          // Landed between the high-water mark and the snapshot: older than the
          // snapshot, so it must not undo it; then the run completes.
          yield* update(44, "starting");
          yield* update(46, "completed");

          const done = service.subscribeList().pipe(
            Stream.map((list) => list.tasks[0]?.latestRun?.state),
            Stream.filter((state) => state === "succeeded"),
            Stream.runHead,
          );
          yield* Layer.build(
            ScheduledTaskRunTracker.layer.pipe(
              Layer.provide(
                Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
                  latestAgentSequence: () => Effect.succeed(40),
                }),
              ),
            ),
          );
          assert.equal((yield* done)._tag, "Some");
          assert.deepEqual(afterSequences.toSorted(), [40, 40]);
        }).pipe(Effect.scoped, Effect.provide(CommandReceiptStore.layer)),
      {
        threads: {
          streamStoredEventsFrom: (input) => {
            afterSequences.push(input?.afterSequence);
            return input?.eventType === "run.updated" ? Stream.fromQueue(updates) : Stream.never;
          },
          getThreadEventSequence: () => Effect.succeed(45),
          getProjectThreadRecords: () =>
            Ref.get(snapshotRun).pipe(
              Effect.map((run) => ({ runs: run === null ? [] : [run], messages: [] }) as never),
            ),
        },
      },
    );
  }),
);

it.effect(
  "moves a run a restart cut on to a continuation that finished while nothing watched",
  () =>
    // Set before the scheduler starts, so its tick loop never replays the years in between.
    TestClock.setTime(Date.parse("2026-10-29T12:00:00.000Z")).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const afterSequences: Array<number | undefined> = [];
          const records = new Map<string, { runs: OrchestrationV2Run[]; messages: unknown[] }>();
          yield* withService(
            ({ service }) =>
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const { task } = yield* service.upsert(yield* taskInput());
                const cutAt = DateTime.makeUnsafe("2026-10-29T10:30:00.000Z");
                // Each row recorded its agent run's cancellation at sequence 50,
                // then the server stopped before the tracker saw anything later.
                const seedCancelled = (id: string, minute: number, threadId: ThreadId) =>
                  seedRun(sql, task, {
                    id,
                    createdAt: `2026-10-29T10:0${minute}:00.000Z`,
                    dispatchState: "dispatched",
                    threadId,
                    agentRunId: `run-${id}`,
                    agentStatus: "cancelled",
                    agentSequence: 50,
                    agentEndedAt: DateTime.formatIso(cutAt),
                  });
                const cancelledRun = (id: string, messageId: MessageId) =>
                  agentRun({
                    id: RunId.make(`run-${id}`),
                    userMessageId: messageId,
                    status: "cancelled",
                    completedAt: cutAt,
                  });
                // Stopped by its user: nothing continues it.
                const stopped = yield* seedCancelled("stopped", 1, ThreadId.make("thread-stopped"));
                records.set("thread-stopped", {
                  runs: [cancelledRun("stopped", stopped.messageId)],
                  messages: [],
                });
                // Its thread was deleted since.
                yield* seedCancelled("deleted", 2, ThreadId.make("thread-deleted"));
                // Cut by a restart; recovery's continuation was committed and
                // finished before this tracker started.
                const cut = yield* seedCancelled("cut", 3, THREAD_ID);
                records.set(THREAD_ID, {
                  runs: [
                    cancelledRun("cut", cut.messageId),
                    agentRun({
                      id: RunId.make("run-continuation"),
                      userMessageId: MessageId.make("message:restart-continuation:run-cut"),
                      ordinal: 2,
                      status: "completed",
                      restartContinuationOfRunId: RunId.make("run-cut"),
                      completedAt: DateTime.makeUnsafe("2026-10-29T10:45:00.000Z"),
                    }),
                  ],
                  messages: [],
                });

                const done = awaitLatestRun(service, (run) => run.state === "succeeded");
                yield* Layer.build(
                  ScheduledTaskRunTracker.layer.pipe(
                    Layer.provide(
                      Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
                        latestAgentSequence: () => Effect.succeed(60),
                      }),
                    ),
                  ),
                );
                assert.equal((yield* done)._tag, "Some");
                // The continuation's events are below the mark, so no follower replays them.
                assert.deepEqual(afterSequences, [60, 60]);
                const runs = new Map(
                  (yield* listRuns(service, task)).map((run) => [run.id as string, run]),
                );
                const summary = (id: string) => {
                  const run = runs.get(id);
                  return [run?.state, run?.endedAt, run?.error];
                };
                assert.deepEqual(summary("cut"), ["succeeded", "2026-10-29T10:45:00.000Z", null]);
                assert.deepEqual(summary("stopped"), [
                  "cancelled",
                  DateTime.formatIso(cutAt),
                  null,
                ]);
                assert.deepEqual(summary("deleted"), [
                  "cancelled",
                  DateTime.formatIso(cutAt),
                  null,
                ]);
              }).pipe(Effect.scoped, Effect.provide(CommandReceiptStore.layer)),
            {
              threads: {
                streamStoredEventsFrom: (input) => {
                  afterSequences.push(input?.afterSequence);
                  return Stream.never;
                },
                getThreadEventSequence: () => Effect.succeed(58),
                getProjectThreadRecords: (input) => {
                  const found = records.get(input.threadId);
                  return found === undefined
                    ? Effect.fail(
                        new ThreadManagementService.ThreadManagementThreadNotFoundError({
                          projectId: input.projectId,
                          threadId: input.threadId,
                        }),
                      )
                    : Effect.succeed(found as never);
                },
              },
            },
          );
        }),
      ),
    ),
);

it.effect("keeps finished runs for the dedupe window even past the history limit", () =>
  // Set before the scheduler starts, so its tick loop never replays the years in between.
  TestClock.setTime(Date.parse("2026-10-29T12:00:00.000Z")).pipe(
    Effect.andThen(
      withService(({ service }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const { task } = yield* service.upsert(yield* taskInput());
          for (let index = 0; index < 100; index++) {
            yield* seedRun(sql, task, {
              id: `recent-${index}`,
              createdAt: `2026-10-29T11:${String(Math.floor(index / 2)).padStart(2, "0")}:00.000Z`,
              dispatchState: "failed",
            });
          }
          for (let index = 0; index < 10; index++) {
            yield* seedRun(sql, task, {
              id: `old-${index}`,
              createdAt: `2026-10-27T10:0${index}:00.000Z`,
              dispatchState: "skipped",
            });
          }
          yield* seedRun(sql, task, {
            id: "old-open",
            createdAt: "2026-10-27T09:00:00.000Z",
            dispatchState: "dispatched",
            threadId: THREAD_ID,
          });

          yield* service.runNow({ id: task.id });
          const ids = (yield* sql<{
            run_id: string;
          }>`SELECT run_id FROM scheduled_task_runs WHERE task_id = ${task.id}`).map(
            (row) => row.run_id,
          );
          // The 100 newest, one more recent run still inside the window, and the
          // run that has not finished; the old finished runs are gone.
          assert.equal(ids.length, 102);
          assert.isTrue(ids.includes("old-open"));
          assert.isFalse(ids.some((id) => id.startsWith("old-") && id !== "old-open"));
          assert.equal((yield* listRuns(service, task)).length, 100);
        }),
      ),
    ),
  ),
);

it.effect("deletes a task's runs with the task", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { task } = yield* service.upsert(yield* taskInput());
      yield* service.runNow({ id: task.id });
      yield* service.delete({ id: task.id });
      const [count] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM scheduled_task_runs`;
      assert.equal(count?.count, 0);
    }),
  ),
);
