// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as MaintenanceGate from "./MaintenanceGate.ts";
import * as MaintenanceGatedOrchestrator from "./MaintenanceGatedOrchestrator.ts";

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "stark-maintenance-" }).pipe(
  Layer.provide(NodeServices.layer),
);

const layerGate = MaintenanceGate.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(layerConfig),
);

const insertRun = (threadId: string, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${status}, '2026-10-30T00:00:00.000Z', '{}')
    `;
  });

const finishRun = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE thread_id = ${threadId}`;
  });

const insertProviderThread = (id: string, status: string, payload: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES (${id}, 'thread-provider', 'claude', ${status}, '2026-10-30T00:00:00.000Z', ${JSON.stringify(payload)})
    `;
  });

const insertRequest = (id: string, kind: string, capability: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES (${id}, 'thread-request', 'node-1', ${kind}, 'pending', '2026-10-30T00:00:00.000Z',
        ${JSON.stringify({ responseCapability: { type: capability } })})
    `;
  });

const SOURCES = ["command", "scheduler", "manual-run", "webhook", "storage-cleanup"] as const;

const admitted = (gate: MaintenanceGate.MaintenanceGateService) =>
  Effect.forEach(SOURCES, (source) => gate.admits(source));

describe("MaintenanceGate", () => {
  it.effect("refuses every source while admitted work drains, then reports ready", () =>
    Effect.gen(function* () {
      const gate = yield* MaintenanceGate.MaintenanceGate;
      yield* insertRun("thread-busy", "running");

      const closing = yield* gate.prepare({ requestId: "update-1", mode: "drain" });
      assert.strictEqual(closing.state, "closing");
      assert.isFalse(closing.ready);
      assert.deepStrictEqual(
        closing.blockers.map((blocker) => [blocker.kind, blocker.threadId]),
        [["run", "thread-busy"]],
      );
      assert.deepStrictEqual(yield* admitted(gate), [false, false, false, false, false]);
      assert.isTrue(Option.isNone(yield* gate.guard("manual-run", Effect.succeed("ran"))));
      // Draining work keeps claiming effects so it can finish.
      assert.isFalse(yield* gate.claimsPaused);

      yield* finishRun("thread-busy");
      const ready = yield* gate.renew("update-1");
      assert.strictEqual(ready.state, "closed");
      assert.isTrue(ready.ready);
      assert.isTrue(yield* gate.claimsPaused);

      const released = yield* gate.release("update-1");
      assert.strictEqual(released.state, "open");
      assert.deepStrictEqual(yield* admitted(gate), [true, true, true, true, true]);
      assert.isFalse(yield* gate.claimsPaused);
    }).pipe(Effect.provide(layerGate)),
  );

  it.effect("a probe refuses nothing while it shows the blockers", () =>
    Effect.gen(function* () {
      const gate = yield* MaintenanceGate.MaintenanceGate;
      yield* insertRun("thread-busy", "waiting");
      const status = yield* gate.prepare({ requestId: "update-1", mode: "probe" });
      assert.strictEqual(status.state, "open");
      assert.lengthOf(status.blockers, 1);
      assert.deepStrictEqual(yield* admitted(gate), [true, true, true, true, true]);
    }).pipe(Effect.provide(layerGate)),
  );

  it.effect("background tasks and person-facing requests block; idle work does not", () =>
    Effect.gen(function* () {
      const gate = yield* MaintenanceGate.MaintenanceGate;
      yield* insertProviderThread("idle-session", "idle", { pendingBackgroundTasks: [] });
      yield* insertRequest("tool-call", "dynamic_tool_call", "live");
      yield* insertRequest("message-question", "user_input", "message");
      const idle = yield* gate.prepare({ requestId: "update-1", mode: "probe" });
      assert.isTrue(idle.ready);
      yield* gate.release("update-1");

      yield* insertProviderThread("background", "idle", {
        pendingBackgroundTasks: [{ id: "task-1" }],
      });
      yield* insertRequest("approval", "command_approval", "live");
      const busy = yield* gate.prepare({ requestId: "update-2", mode: "probe" });
      assert.isFalse(busy.ready);
      assert.deepStrictEqual(
        busy.blockers.map((blocker) => [blocker.kind, blocker.id]).toSorted(),
        [
          ["pending-request", "approval"],
          ["provider-work", "background"],
        ],
      );
    }).pipe(Effect.provide(layerGate)),
  );

  it.effect("waits for work admitted just before it closed", () =>
    Effect.gen(function* () {
      const gate = yield* MaintenanceGate.MaintenanceGate;
      const recording = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const fiber = yield* gate
        .guard(
          "manual-run",
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(recording))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);

      const blocked = yield* gate.prepare({ requestId: "update-1", mode: "drain" });
      assert.deepStrictEqual(
        blocked.blockers.map((blocker) => blocker.kind),
        ["admission"],
      );
      yield* Deferred.succeed(recording, undefined);
      yield* Fiber.join(fiber);
      assert.isTrue((yield* gate.renew("update-1")).ready);
    }).pipe(Effect.provide(layerGate)),
  );

  it.effect("reopens when the lease is not renewed, and a late renewal does not close it", () =>
    Effect.gen(function* () {
      const gate = yield* MaintenanceGate.MaintenanceGate;
      assert.isTrue((yield* gate.prepare({ requestId: "update-1", mode: "probe" })).ready);
      yield* TestClock.adjust("20 seconds");
      assert.strictEqual((yield* gate.renew("update-1")).state, "closed");
      yield* TestClock.adjust("20 seconds");
      // Renewed 20 s ago: still closed.
      assert.isTrue(yield* gate.claimsPaused);
      yield* TestClock.adjust("11 seconds");
      assert.strictEqual((yield* gate.status).state, "open");
      assert.deepStrictEqual(yield* admitted(gate), [true, true, true, true, true]);
      const late = yield* gate.renew("update-1");
      assert.strictEqual(late.state, "open");
      assert.isFalse(late.ready);
    }).pipe(Effect.provide(layerGate)),
  );

  it.effect("another request cannot take over a closed gate", () =>
    Effect.gen(function* () {
      const gate = yield* MaintenanceGate.MaintenanceGate;
      yield* gate.prepare({ requestId: "update-1", mode: "probe" });
      const other = yield* gate.prepare({ requestId: "update-2", mode: "probe" });
      assert.strictEqual(other.requestId, "update-1");
      yield* gate.release("update-2");
      assert.isTrue(yield* gate.claimsPaused);
    }).pipe(Effect.provide(layerGate)),
  );

  it.effect("each backend has its own gate", () =>
    Effect.gen(function* () {
      const first = Context.get(
        yield* Layer.build(Layer.fresh(layerGate)),
        MaintenanceGate.MaintenanceGate,
      );
      const second = Context.get(
        yield* Layer.build(Layer.fresh(layerGate)),
        MaintenanceGate.MaintenanceGate,
      );
      yield* first.prepare({ requestId: "update-1", mode: "probe" });
      assert.isTrue(yield* first.claimsPaused);
      assert.isFalse(yield* second.claimsPaused);
    }).pipe(Effect.scoped),
  );

  it.effect("a recovery hold stops automatic work until resumed, not the user's own", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const holdPath = NodePath.join(NodePath.dirname(config.dbPath), "recovery-hold.json");
      NodeFS.writeFileSync(
        holdPath,
        JSON.stringify({
          version: 1,
          backupId: "backup-1",
          backupAppVersion: "0.0.46-alpha.1",
          displacedPath: "/displaced",
          heldSince: "2026-10-30T00:00:00.000Z",
        }),
      );
      const gate = yield* MaintenanceGate.MaintenanceGate.pipe(
        Effect.provide(MaintenanceGate.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      );
      assert.deepStrictEqual(yield* admitted(gate), [true, false, true, false, false]);
      assert.isTrue(yield* gate.restartContinuationsHeld);
      assert.strictEqual((yield* gate.status).recoveryHold?.backupId, "backup-1");

      const resumed = yield* gate.resumeRecovery;
      assert.isNull(resumed.recoveryHold);
      assert.isFalse(NodeFS.existsSync(holdPath));
      assert.deepStrictEqual(yield* admitted(gate), [true, true, true, true, true]);
      assert.isFalse(yield* gate.restartContinuationsHeld);
    }).pipe(Effect.provide(layerConfig)),
  );
});

const commandId = (id: string) => CommandId.make(id);

const userMessage = (threadId: string, extra: Partial<Record<string, unknown>> = {}) =>
  ({
    type: "message.dispatch",
    commandId: commandId(`message-${threadId}`),
    threadId: ThreadId.make(threadId),
    messageId: MessageId.make(`message-${threadId}`),
    text: "Hello",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
    ...extra,
  }) as OrchestrationV2ServerCommand;

describe("MaintenanceGatedOrchestrator", () => {
  const layerDecorated = (dispatched: Ref.Ref<ReadonlyArray<string>>) =>
    MaintenanceGatedOrchestrator.layer.pipe(
      Layer.provide(
        Layer.succeed(
          Orchestrator.OrchestratorV2,
          // Only dispatch is exercised; the decorator passes everything else through.
          Orchestrator.OrchestratorV2.of({
            dispatch: (command: OrchestrationV2ServerCommand) =>
              Ref.update(dispatched, (all) => [...all, command.type]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] }),
              ),
          } as unknown as Orchestrator.OrchestratorV2Shape),
        ),
      ),
    );

  it.effect("refuses new root work while closing and lets everything else through", () =>
    Effect.gen(function* () {
      const gate = yield* MaintenanceGate.MaintenanceGate;
      const dispatched = yield* Ref.make<ReadonlyArray<string>>([]);
      const orchestrator = yield* Orchestrator.OrchestratorV2.pipe(
        Effect.provide(layerDecorated(dispatched)),
        Effect.provideService(MaintenanceGate.MaintenanceGate, gate),
      );
      yield* insertRun("thread-active", "running");
      yield* gate.prepare({ requestId: "update-1", mode: "drain" });

      const refused = yield* Effect.flip(orchestrator.dispatch(userMessage("thread-idle")));
      assert.strictEqual(refused._tag, "OrchestratorCommandRejectedError");

      // Child work of a thread still working, a continuation, control and state commands pass.
      yield* orchestrator.dispatch(userMessage("thread-active"));
      yield* orchestrator.dispatch(
        userMessage("thread-idle", { restartContinuationOfRunId: RunId.make("run-1") }),
      );
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: commandId("interrupt"),
        threadId: ThreadId.make("thread-idle"),
        runId: RunId.make("run-1"),
      });
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: commandId("pin"),
        threadId: ThreadId.make("thread-idle"),
      });
      assert.deepStrictEqual(yield* Ref.get(dispatched), [
        "message.dispatch",
        "message.dispatch",
        "run.interrupt",
        "thread.pin",
      ]);

      yield* gate.release("update-1");
      yield* orchestrator.dispatch(userMessage("thread-idle"));
      assert.lengthOf(yield* Ref.get(dispatched), 5);
    }).pipe(Effect.provide(layerGate)),
  );

  it("classifies every command", () => {
    assert.strictEqual(
      MaintenanceGatedOrchestrator.classifyMaintenanceCommand(userMessage("thread")),
      "work",
    );
    assert.strictEqual(
      MaintenanceGatedOrchestrator.classifyMaintenanceCommand({
        type: "thread.stop",
        commandId: commandId("stop"),
        threadId: ThreadId.make("thread"),
      }),
      "control",
    );
  });
});
