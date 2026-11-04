// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as MaintenanceGate from "./MaintenanceGate.ts";

/**
 * The gate against the real outbox and effect worker: draining is the only
 * clock, so every step is a drained worker or a persisted row, never a sleep.
 */
const makeHarness = (input: { readonly blockOn?: Deferred.Deferred<void> } = {}) =>
  Effect.gen(function* () {
    const executed = yield* Ref.make<ReadonlyArray<string>>([]);
    const started = yield* Deferred.make<void>();
    const executor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: (effect) =>
          Effect.gen(function* () {
            yield* Ref.update(executed, (all) => [...all, effect.id]);
            if (input.blockOn !== undefined && effect.id === "effect:slow") {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(input.blockOn);
            }
          }),
      }),
    );
    const config = ServerConfig.layerTest(process.cwd(), { prefix: "stark-gate-it-" }).pipe(
      Layer.provide(NodeServices.layer),
    );
    const services = yield* Layer.build(
      // The worker reads the gate it is built with, as in the server's runtime.
      EffectWorker.layer.pipe(
        Layer.provideMerge(MaintenanceGate.layer),
        Layer.provideMerge(executor),
        Layer.provideMerge(EffectOutbox.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(config),
      ),
    );
    return {
      executed,
      started,
      services,
      gate: Context.get(services, MaintenanceGate.MaintenanceGate),
      worker: Context.get(services, EffectWorker.OrchestrationEffectWorkerV2),
      outbox: Context.get(services, EffectOutbox.EffectOutboxV2),
    };
  });

const pending = (id: string, request: EffectOutbox.PendingOrchestrationEffectV2["request"]) => ({
  id,
  commandId: CommandId.make(`command:${id}`),
  // One thread per effect, so the per-thread lane never orders them.
  threadId: ThreadId.make(`thread:${id}`),
  request,
});

const attempts = (outbox: EffectOutbox.EffectOutboxV2["Service"], id: string) =>
  outbox
    .get(id)
    .pipe(Effect.map(Option.match({ onNone: () => -1, onSome: (e) => e.attemptCount })));

describe("maintenance gate with the effect worker", () => {
  it.effect(
    "a closed gate claims nothing, spends no attempt, and runs each effect once after",
    () =>
      Effect.gen(function* () {
        const { gate, worker, outbox, executed } = yield* makeHarness();
        yield* outbox.enqueue([
          pending("effect:a", { type: "provider-turn.start", runId: RunId.make("run-a") }),
          pending("effect:b", { type: "provider-turn.start", runId: RunId.make("run-b") }),
        ]);
        assert.isTrue((yield* gate.prepare({ requestId: "update-1", mode: "probe" })).ready);

        assert.strictEqual(yield* worker.drain(), 0);
        assert.strictEqual(yield* attempts(outbox, "effect:a"), 0);
        assert.strictEqual(yield* attempts(outbox, "effect:b"), 0);
        // The idle loop waits instead of spinning on the rows it may not claim.
        assert.isTrue(Option.isNone(yield* worker.nextClaimableAt));

        // The install was abandoned: the gate reopens and the work runs once.
        yield* gate.release("update-1");
        assert.strictEqual(yield* worker.drain(), 2);
        assert.deepStrictEqual([...(yield* Ref.get(executed))].toSorted(), [
          "effect:a",
          "effect:b",
        ]);
        assert.strictEqual(yield* attempts(outbox, "effect:a"), 1);
        assert.strictEqual(yield* worker.drain(), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("an effect already running blocks until it settles; nothing is interrupted", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const { gate, worker, outbox, executed, started } = yield* makeHarness({ blockOn: release });
      yield* outbox.enqueue([
        pending("effect:slow", { type: "provider-turn.start", runId: RunId.make("run-slow") }),
      ]);
      const running = yield* worker.runOnce.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* outbox.enqueue([
        pending("effect:next", { type: "provider-turn.start", runId: RunId.make("run-next") }),
      ]);

      const closing = yield* gate.prepare({ requestId: "update-1", mode: "drain" });
      assert.strictEqual(closing.state, "closing");
      assert.deepStrictEqual(
        closing.blockers.map((blocker) => [blocker.kind, blocker.id]),
        [["effect", "effect:slow"]],
      );

      yield* Deferred.succeed(release, undefined);
      assert.isTrue(yield* Fiber.join(running));
      const ready = yield* gate.renew("update-1");
      assert.isTrue(ready.ready);
      // Closed now: the queued effect waits, with its attempt count intact.
      assert.strictEqual(yield* worker.drain(), 0);
      assert.strictEqual(yield* attempts(outbox, "effect:next"), 0);
      assert.deepStrictEqual(yield* Ref.get(executed), ["effect:slow"]);
    }).pipe(Effect.scoped),
  );
});

describe("recovery hold", () => {
  const writeHold = (config: ServerConfig.ServerConfig["Service"]) =>
    NodeFS.writeFileSync(
      NodePath.join(NodePath.dirname(config.dbPath), "recovery-hold.json"),
      JSON.stringify({
        version: 1,
        backupId: "backup-1",
        backupAppVersion: "0.0.46-alpha.1",
        displacedPath: "/displaced",
        heldSince: "2026-10-30T00:00:00.000Z",
      }),
    );

  it.effect("repeated recovery boots dispatch nothing until Resume, then each item once", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      writeHold(config);
      // The restored database: a restart continuation and an overdue schedule.
      const database = Layer.fresh(
        SqlitePersistence.layerFromPath(config.dbPath).pipe(Layer.provide(NodeServices.layer)),
      );
      const executed = yield* Ref.make<ReadonlyArray<string>>([]);
      const dueRuns = yield* Ref.make(0);
      const boot = Effect.gen(function* () {
        const services = yield* Layer.build(
          Layer.mergeAll(EffectWorker.layer, Scheduler.layer).pipe(
            Layer.provideMerge(MaintenanceGate.layer),
            Layer.provideMerge(
              Layer.succeed(
                EffectWorker.OrchestrationEffectExecutorV2,
                EffectWorker.OrchestrationEffectExecutorV2.of({
                  execute: (effect) => Ref.update(executed, (all) => [...all, effect.id]),
                }),
              ),
            ),
            Layer.provideMerge(EffectOutbox.layer),
            Layer.provideMerge(Layer.fresh(database)),
          ),
        );
        const scheduler = Context.get(services, Scheduler.Scheduler);
        yield* scheduler.register(
          "overdue-schedule",
          Ref.update(dueRuns, (count) => count + 1),
        );
        return {
          gate: Context.get(services, MaintenanceGate.MaintenanceGate),
          worker: Context.get(services, EffectWorker.OrchestrationEffectWorkerV2),
          outbox: Context.get(services, EffectOutbox.EffectOutboxV2),
        };
      });

      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const { worker, outbox } = yield* boot;
          yield* outbox.enqueue([
            pending("effect:continue", {
              type: "provider-runtime.continue",
              sourceRunId: RunId.make("run-cut"),
            }),
          ]);
          assert.strictEqual(yield* worker.drain(), 0);
          yield* TestClock.adjust("1 minute");
          return yield* attempts(outbox, "effect:continue");
        }),
      );
      assert.strictEqual(first, 0);

      // A second boot under the same hold: still nothing.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { worker, gate } = yield* boot;
          assert.isTrue((yield* gate.status).recoveryHold !== null);
          assert.strictEqual(yield* worker.drain(), 0);
          yield* TestClock.adjust("1 minute");
        }),
      );
      assert.deepStrictEqual(yield* Ref.get(executed), []);
      assert.strictEqual(yield* Ref.get(dueRuns), 0);

      // Resume: each held item runs exactly once.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { worker, gate } = yield* boot;
          yield* gate.resumeRecovery;
          assert.strictEqual(yield* worker.drain(), 1);
          assert.strictEqual(yield* worker.drain(), 0);
          yield* TestClock.adjust("5 seconds");
        }),
      );
      assert.deepStrictEqual(yield* Ref.get(executed), ["effect:continue"]);
      // The schedule source reloads due work from durable state whenever it runs.
      assert.isAbove(yield* Ref.get(dueRuns), 0);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "stark-hold-it-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
