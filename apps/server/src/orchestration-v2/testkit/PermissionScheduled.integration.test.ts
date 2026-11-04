/**
 * Scheduled runs on a bound thread (PLAN-002 §3.4 `boundRunAllowed`, O9 as
 * adjusted): the task's policy is captured on the run when it is queued, and
 * the run starts only while the shared thread stays within it. The thread is
 * never widened or changed for the run.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2Run,
  type OrchestrationV2RunPermissionCeiling,
  ThreadId,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import {
  causeOf,
  claudeId,
  claudeSelection,
  codexSelection,
  createThread,
  layerPermissionRuntime,
  projectionOf,
  queuedEffectTypes,
  sendMessage,
  setSnapshots,
} from "./PermissionTestkit.ts";

const ceiling = (
  runtimeMode: OrchestrationV2RunPermissionCeiling["runtimeMode"],
): OrchestrationV2RunPermissionCeiling => ({
  providerInstanceId: claudeId,
  runtimeMode,
  interactionMode: "default",
});

/**
 * Ends the active run as the run finalizer would once its provider turn
 * settled (no provider runs here), then lets the queue move on.
 */
const endRunAndResume = (threadId: ThreadId, run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make(`end:${run.id}`),
      events: [
        {
          id: EventId.make(`end:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`resume:${run.id}`),
      threadId,
    });
  });

const turnStarts = (threadId: ThreadId) =>
  queuedEffectTypes(threadId).pipe(
    Effect.map((types) => types.filter((type) => type === "provider-turn.start").length),
  );

/**
 * A thread with an active run and a scheduled message queued behind it with
 * `taskCeiling`; `change` then edits the thread while the message waits.
 */
const queueBehindActiveRun = (input: {
  readonly name: string;
  readonly threadMode: "approval-required" | "auto-accept-edits" | "auto";
  readonly taskCeiling: OrchestrationV2RunPermissionCeiling;
}) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(`thread:scheduled:${input.name}`);
    yield* createThread({
      threadId,
      modelSelection: claudeSelection,
      runtimeMode: input.threadMode,
    });
    yield* sendMessage({ threadId, key: "user", dispatchMode: { type: "start_immediately" } });
    yield* sendMessage({
      threadId,
      key: "scheduled",
      dispatchMode: { type: "queue_after_active" },
      permissionCeiling: input.taskCeiling,
      createdBy: "system",
    });
    const projection = yield* projectionOf(threadId);
    const [active, queued] = projection.runs;
    assert.equal(queued?.status, "queued");
    return { threadId, active: active!, queued: queued! };
  });

it.layer(layerPermissionRuntime)("a bound scheduled run carries its task's policy", (it) => {
  it.effect("records the ceiling on a run that starts at once and on one that waits", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const { active, queued } = yield* queueBehindActiveRun({
        name: "records",
        threadMode: "auto",
        taskCeiling: ceiling("auto"),
      });
      // The user's own message has no ceiling; the scheduled one keeps its task's.
      assert.isUndefined(active.permissionCeiling);
      assert.deepEqual(queued.permissionCeiling, ceiling("auto"));

      const immediate = ThreadId.make("thread:scheduled:records-immediate");
      yield* createThread({
        threadId: immediate,
        modelSelection: claudeSelection,
        runtimeMode: "auto",
      });
      yield* sendMessage({
        threadId: immediate,
        key: "scheduled",
        dispatchMode: { type: "start_immediately" },
        permissionCeiling: ceiling("auto"),
        createdBy: "system",
      });
      const started = (yield* projectionOf(immediate)).runs.at(-1)!;
      assert.deepEqual(started.permissionCeiling, ceiling("auto"));
      assert.equal(yield* turnStarts(immediate), 1);
    }),
  );

  it.effect("starts a queued bound run within its ceiling when the run ahead ends", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const { threadId, active, queued } = yield* queueBehindActiveRun({
        name: "within",
        threadMode: "auto-accept-edits",
        taskCeiling: ceiling("auto"),
      });
      yield* endRunAndResume(threadId, active);
      const after = (yield* projectionOf(threadId)).runs.find((run) => run.id === queued.id);
      assert.include(["starting", "running"], after?.status);
      assert.equal(yield* turnStarts(threadId), 2);
    }),
  );
});

describe("bound scheduled runs are refused", () => {
  it.layer(layerPermissionRuntime)("refusals", (it) => {
    it.effect("refuses to start a bound run at once on a thread broader than its task", () =>
      Effect.gen(function* () {
        yield* setSnapshots({});
        const threadId = ThreadId.make("thread:scheduled:immediate-broader");
        yield* createThread({ threadId, modelSelection: claudeSelection, runtimeMode: "auto" });
        const refused = yield* sendMessage({
          threadId,
          key: "scheduled",
          dispatchMode: { type: "start_immediately" },
          permissionCeiling: ceiling("approval-required"),
          createdBy: "system",
        }).pipe(Effect.flip);
        assert.include(causeOf(refused), "broader than the scheduled task allows");
        assert.lengthOf((yield* projectionOf(threadId)).runs, 0);
        assert.equal(yield* turnStarts(threadId), 0);
        // The thread itself is untouched.
        assert.equal((yield* projectionOf(threadId)).thread.runtimeMode, "auto");
      }),
    );

    it.effect("does not start a queued bound run after the thread widened while it waited", () =>
      Effect.gen(function* () {
        yield* setSnapshots({});
        const { threadId, active, queued } = yield* queueBehindActiveRun({
          name: "widened-while-queued",
          threadMode: "approval-required",
          taskCeiling: ceiling("approval-required"),
        });
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("scheduled:widen-while-queued"),
          threadId,
          runtimeMode: "auto",
        });
        yield* endRunAndResume(threadId, active);
        const projection = yield* projectionOf(threadId);
        const after = projection.runs.find((run) => run.id === queued.id)!;
        // Held or cancelled with its reason, never started under broader settings.
        assert.notInclude(["starting", "running"], after.status);
        assert.isTrue(after.queueHeld === true || after.status === "cancelled", after.status);
        assert.equal(yield* turnStarts(threadId), 1);
        assert.equal(projection.thread.runtimeMode, "auto");
      }),
    );

    it.effect("refuses a bound run on a thread that inherits or moved to another provider", () =>
      Effect.gen(function* () {
        yield* setSnapshots({ claudeInherits: true });
        const inheriting = ThreadId.make("thread:scheduled:inherit");
        yield* createThread({
          threadId: inheriting,
          modelSelection: claudeSelection,
          runtimeMode: "approval-required",
          permissionSource: "inherit",
        });
        const fromInherit = yield* sendMessage({
          threadId: inheriting,
          key: "scheduled",
          dispatchMode: { type: "start_immediately" },
          permissionCeiling: ceiling("auto"),
          createdBy: "system",
        }).pipe(Effect.flip);
        assert.isDefined(fromInherit);
        assert.lengthOf((yield* projectionOf(inheriting)).runs, 0);

        const moved = ThreadId.make("thread:scheduled:moved");
        yield* createThread({
          threadId: moved,
          modelSelection: codexSelection,
          runtimeMode: "approval-required",
        });
        const fromMoved = yield* sendMessage({
          threadId: moved,
          key: "scheduled",
          dispatchMode: { type: "start_immediately" },
          permissionCeiling: ceiling("auto"),
          createdBy: "system",
        }).pipe(Effect.flip);
        assert.isDefined(fromMoved);
        assert.lengthOf((yield* projectionOf(moved)).runs, 0);
      }),
    );
  });
});
