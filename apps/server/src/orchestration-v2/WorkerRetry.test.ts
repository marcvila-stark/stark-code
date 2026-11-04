import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@starkfuture/contracts";
import { resolveWorkerRetry } from "@starkfuture/shared/workerRetry";
import type * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
// No effect worker: runs stay unstarted, so the tests end them by hand.
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "worker-retry" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** A parent with a running turn that delegated `task` to a worker sharing its folder. */
const delegateWorker = (
  name: string,
  task: string,
  // Workers never run Bypass, so Auto is the broadest a worker gets.
  childRuntimeMode: "approval-required" | "auto" = "auto",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentThreadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}`),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:worker-retry"),
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(parentThreadId, "delegate", "start_immediately");
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${name}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: childRuntimeMode,
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const original = parent.subagents.find((candidate) => candidate.prompt === task)!;
    return { parentThreadId, childThreadId: original.childThreadId!, originalTaskId: original.id };
  });

/** Waits for the parent to record `taskId`'s result once its child run ended. */
const awaitTaskResult = (afterSequence: number, taskId: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const settled = yield* eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === taskId &&
          stored.event.payload.result !== null,
      ),
      Stream.take(1),
      Stream.runHead,
    );
    assert.isTrue(settled._tag === "Some");
  });

it.effect("a worker Stop held queued messages for is not run again ahead of them", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { childThreadId } = yield* delegateWorker("held", "Held task");
    yield* send(childThreadId, "queued follow-up", "queue_after_active");
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop:held"),
      threadId: childThreadId,
      runId: child.runs[0]!.id,
      holdQueue: true,
    });

    const stopped = yield* orchestrator.getThreadProjection(childThreadId);
    assert.deepEqual(
      stopped.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      ["interrupted", "queued:held"],
    );
    assert.deepEqual(resolveWorkerRetry(stopped), { type: "unavailable", reason: "queue_held" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a provider failure in a shared folder runs again as a follow-up, not a setup retry",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { childThreadId } = yield* delegateWorker("provider-failure", "Failing task");
      const child = yield* orchestrator.getThreadProjection(childThreadId);
      const run = child.runs[0]!;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("command:provider-failure"),
        events: [
          {
            id: EventId.make("event:provider-failure:error"),
            type: "turn-item.updated",
            threadId: childThreadId,
            runId: run.id,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("turn-item:provider-failure"),
              type: "error",
              threadId: childThreadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Provider failed.",
                code: "provider_failed",
                retryable: null,
              },
            },
          },
          {
            id: EventId.make("event:provider-failure:run"),
            type: "run.updated",
            threadId: childThreadId,
            runId: run.id,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...run, status: "failed", completedAt: now },
          },
        ],
      });

      const failed = yield* orchestrator.getThreadProjection(childThreadId);
      // The worker shares the parent's folder, so it never had a worktree path.
      assert.isNull(failed.thread.worktreePath);
      assert.deepEqual(resolveWorkerRetry(failed), { type: "run_again" });
      // And the server agrees there is no setup to repeat.
      const setupRetry = yield* Effect.exit(
        orchestrator.dispatch({
          type: "prepared-run.retry",
          commandId: CommandId.make("retry:provider-failure"),
          threadId: childThreadId,
          runId: run.id,
        }),
      );
      assert.isTrue(Exit.isFailure(setupRetry));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "Run again is a new task that wakes the parent and keeps the worker's current modes",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { parentThreadId, childThreadId, originalTaskId } = yield* delegateWorker(
        "run-again",
        "Original brief",
      );
      const child = yield* orchestrator.getThreadProjection(childThreadId);
      const afterSequence = yield* eventSink.latestSequence();
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop:run-again"),
        threadId: childThreadId,
        runId: child.runs[0]!.id,
        holdQueue: true,
      });
      yield* awaitTaskResult(afterSequence, originalTaskId);
      assert.deepEqual(resolveWorkerRetry(yield* orchestrator.getThreadProjection(childThreadId)), {
        type: "run_again",
      });

      // The user narrows the worker's permissions after its row was drawn.
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode:run-again"),
        threadId: childThreadId,
        runtimeMode: "approval-required",
      });
      const text = "Run again requested by the user.\n\nOriginal brief";
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("run-again"),
        threadId: childThreadId,
        messageId: MessageId.make("message:run-again"),
        text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });

      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const tasks = parent.subagents.filter((task) => task.childThreadId === childThreadId);
      assert.strictEqual(tasks.length, 2);
      const original = tasks.find((task) => task.id === originalTaskId)!;
      const again = tasks.find((task) => task.id !== originalTaskId)!;
      // The first attempt keeps its own result; the new attempt has none yet.
      assert.strictEqual(original.status, "interrupted");
      assert.isNotNull(original.result);
      assert.deepInclude(again, {
        prompt: text,
        createdBy: "user",
        completionWake: "always",
        result: null,
      });
      const ranAgain = yield* orchestrator.getThreadProjection(childThreadId);
      assert.strictEqual(ranAgain.thread.runtimeMode, "approval-required");
      assert.strictEqual(ranAgain.runs.at(-1)?.delegatedTaskId, again.id);
      // While that attempt is underway, another Run again is refused.
      assert.deepEqual(resolveWorkerRetry(ranAgain), { type: "unavailable", reason: "active" });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("Run again keeps the policy recorded for the worker, never its Bypass parent's", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const { parentThreadId, childThreadId, originalTaskId } = yield* delegateWorker(
      "run-again-policy",
      "Supervised brief",
      "approval-required",
    );
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const afterSequence = yield* eventSink.latestSequence();
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop:run-again-policy"),
      threadId: childThreadId,
      runId: child.runs[0]!.id,
      holdQueue: true,
    });
    yield* awaitTaskResult(afterSequence, originalTaskId);
    // The parent runs Bypass; the worker's own recorded policy still decides.
    assert.strictEqual(
      (yield* orchestrator.getThreadProjection(parentThreadId)).thread.runtimeMode,
      "full-access",
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("run-again-policy"),
      threadId: childThreadId,
      messageId: MessageId.make("message:run-again-policy"),
      text: "Run again requested by the user.\n\nSupervised brief",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const ranAgain = yield* orchestrator.getThreadProjection(childThreadId);
    assert.strictEqual(ranAgain.thread.runtimeMode, "approval-required");
    assert.strictEqual(ranAgain.runs.length, 2);
  }).pipe(Effect.provide(layerTest)),
);
