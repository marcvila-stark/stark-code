import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Run,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  CommandId,
  ThreadId,
} from "@starkfuture/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../Orchestrator.ts";
import type { ProviderReplayGate } from "@starkfuture/provider-testing/replayGate";

export type OrchestratorV2ScenarioStep =
  | {
      readonly type: "dispatch";
      readonly command: OrchestrationV2Command;
      readonly await?: boolean;
      readonly key?: string;
    }
  | {
      readonly type: "advance_clock";
      readonly duration: Duration.Input;
    }
  | {
      readonly type: "await";
      readonly key: string;
    }
  | {
      readonly type: "await_all";
    }
  | {
      readonly type: "await_thread_idle";
      readonly threadId: ThreadId;
    }
  | {
      /** Waits until the thread's Waiting strip lists no background work. */
      readonly type: "await_no_background_work";
      readonly threadId: ThreadId;
    }
  | {
      readonly type: "await_run_steerable";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
    }
  | {
      readonly type: "await_run_status";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
      readonly status: OrchestrationV2Run["status"];
    }
  | {
      /**
       * Wait for a run held open for background work to finish: each time the
       * adapter arms its finish debounce (a replay gate receipt), advance the
       * test clock by exactly that debounce, until the run reaches `status`.
       */
      readonly type: "finish_held_run";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
      readonly status: OrchestrationV2Run["status"];
    }
  | {
      readonly type: "await_run_turn_item";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
      readonly itemType: OrchestrationV2TurnItem["type"];
    }
  | {
      readonly type: "release_replay_gate_after_waiting";
      readonly label: string;
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
    }
  | {
      readonly type: "release_replay_gate";
      readonly label: string;
    }
  | {
      readonly type: "capture_shell_snapshot";
      readonly key: string;
    }
  | {
      readonly type: "respond_to_next_runtime_request";
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly decision?: ProviderApprovalDecision;
      readonly answers?: ProviderUserInputAnswers;
      /** Captures the shell snapshot under this key while the request is pending. */
      readonly shellSnapshotKeyWhilePending?: string;
    };

export interface OrchestratorV2Scenario {
  readonly name: string;
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  readonly steps?: ReadonlyArray<OrchestratorV2ScenarioStep>;
  readonly projectionThreadIds?: ReadonlyArray<ThreadId>;
}

export interface OrchestratorV2ScenarioResult {
  readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
  readonly domainEvents: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly projections: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
  readonly shellSnapshot: OrchestrationV2ThreadShellSnapshot;
  readonly capturedShellSnapshots: ReadonlyMap<string, OrchestrationV2ThreadShellSnapshot>;
}

export class OrchestratorV2ScenarioStepError extends Schema.TaggedError<OrchestratorV2ScenarioStepError>()(
  "OrchestratorV2ScenarioStepError",
  {
    scenario: Schema.String,
    step: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid orchestrator scenario step ${this.step} in ${this.scenario}.`;
  }
}

function commandThreadIds(command: OrchestrationV2Command): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.delete":
    case "thread.settle":
    case "thread.auto-settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.auto-settle.set":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.active.reorder":
    case "thread.visit":
    case "thread.mark-unread":
    case "thread.metadata.update":
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync":
    case "thread.pull-request.watch":
    case "thread.pull-request.sync":
    case "thread.title.regeneration.complete":
    case "thread.runtime-mode.set":
    case "thread.permission.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider-session.detach":
    case "message.dispatch":
    case "thread.shell-command.dispatch":
    case "notification.delivery.accept":
    case "prepared-run.release":
    case "prepared-run.progress":
    case "prepared-run.fail":
    case "prepared-run.retry":
    case "subagent.stop":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queue.resume":
    case "queued-run.reorder":
    case "queued-run.cancel":
    case "queued-run.edit":
    case "runtime-request.respond":
    case "thread.user-input.dismiss":
    case "checkpoint.rollback":
    case "provider.switch":
      return [command.threadId];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "thread.created.record":
      return [command.parentThreadId];
    case "thread.fork":
    case "thread.merge_back":
      return [command.sourceThreadId, command.targetThreadId];
    case "runtime-request.ask-again":
    case "runtime-request.lost.dismiss":
      return [command.threadId];
  }
}

function scenarioSteps(
  scenario: OrchestratorV2Scenario,
): ReadonlyArray<OrchestratorV2ScenarioStep> {
  return (
    scenario.steps ??
    scenario.commands.map((command) => ({
      type: "dispatch" as const,
      command,
      await: true,
    }))
  );
}

function scenarioCommands(scenario: OrchestratorV2Scenario): ReadonlyArray<OrchestrationV2Command> {
  return scenarioSteps(scenario).flatMap((step) =>
    step.type === "dispatch" ? [step.command] : [],
  );
}

const findPendingRuntimeRequest = (projection: OrchestrationV2ThreadProjection) =>
  projection.runtimeRequests.find(
    (request) =>
      request.status === "pending" &&
      (request.kind === "user_input" ||
        request.kind === "dynamic_tool_call" ||
        request.kind === "auth_refresh" ||
        request.responseCapability.type !== "live" ||
        projection.turnItems.some(
          (item) =>
            item.type === "approval_request" &&
            item.requestId === request.id &&
            item.nodeId === request.nodeId,
        )),
  );

const hasActiveRun = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.some((run) =>
    ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
  );

const SCENARIO_WAIT_ATTEMPTS = 10_000;
// Iterations count event-loop turns, not time: while async work (git
// subprocesses, fixture IO) is in flight the loop is idle and the counter
// burns at full speed on slow runners. A wait is exhausted only once BOTH
// the iteration budget and this wall-clock deadline are spent.
const SCENARIO_WAIT_DEADLINE_MS = 60_000;
const scenarioWaitDeadline = () => performance.now() + SCENARIO_WAIT_DEADLINE_MS;
const scenarioWaitExhausted = (attemptsRemaining: number, deadlineAt: number) =>
  attemptsRemaining <= 0 && performance.now() >= deadlineAt;

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

function collectProjectionThreadIds(scenario: OrchestratorV2Scenario): ReadonlyArray<ThreadId> {
  if (scenario.projectionThreadIds) {
    return scenario.projectionThreadIds;
  }

  const ids = new Set<ThreadId>();
  for (const command of scenarioCommands(scenario)) {
    for (const threadId of commandThreadIds(command)) {
      ids.add(threadId);
    }
  }
  return Array.from(ids);
}

export function runOrchestratorV2Scenario(
  scenario: OrchestratorV2Scenario,
  options: {
    readonly replayGate?: ProviderReplayGate;
    /** Runs after the steps, while the provider session is still open. */
    readonly afterSteps?: Effect.Effect<void>;
  } = {},
): Effect.Effect<
  OrchestratorV2ScenarioResult,
  Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
  Orchestrator.OrchestratorV2
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const storedEventGroups: Array<ReadonlyArray<OrchestrationV2StoredEvent>> = [];
      const observedStoredEvents = yield* Ref.make<Array<OrchestrationV2StoredEvent>>([]);
      yield* orchestrator.streamStoredEvents.pipe(
        Stream.runForEach((event) =>
          Ref.update(observedStoredEvents, (existing) => [...existing, event]),
        ),
        Effect.forkScoped,
      );
      const backgroundDispatches = new Map<
        string,
        Fiber.Fiber<ReadonlyArray<OrchestrationV2StoredEvent>, Orchestrator.OrchestratorV2Error>
      >();
      const capturedShellSnapshots = new Map<string, OrchestrationV2ThreadShellSnapshot>();
      let anonymousBackgroundDispatchIndex = 0;

      const awaitDispatch = (key: string) =>
        Effect.gen(function* () {
          const fiber = backgroundDispatches.get(key);
          if (!fiber) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await:${key}`,
            });
          }
          const events = yield* Fiber.join(fiber);
          backgroundDispatches.delete(key);
          storedEventGroups.push(events);
        });

      const waitForPendingRuntimeRequest = (threadId: ThreadId) =>
        Effect.gen(function* () {
          // Request and card are separate committed events. Answer only once
          // the card's native choices exist, just as the UI does.
          const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const request = findPendingRuntimeRequest(projection);
          if (request !== undefined) return request;
          const result = yield* orchestrator
            .streamStoredEventsFrom({ threadId, afterSequence })
            .pipe(
              Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
              Stream.map(findPendingRuntimeRequest),
              Stream.filter(
                (request): request is OrchestrationV2RuntimeRequest => request !== undefined,
              ),
              Stream.runHead,
            );
          return yield* Option.match(result, {
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new OrchestratorV2ScenarioStepError({
                  scenario: scenario.name,
                  step: `respond_to_next_runtime_request:${threadId}:stream-ended`,
                }),
              ),
          });
        });

      const waitForThreadIdle = (
        threadId: ThreadId,
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          if (!hasActiveRun(projection)) {
            return;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            const activeRuns = projection.runs
              .filter((run) =>
                ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
              )
              .map((run) => `${run.id}:${run.status}`)
              .join(",");
            const pendingRequests = projection.runtimeRequests
              .filter((request) => request.status === "pending")
              .map((request) => `${request.id}:${request.kind}`)
              .join(",");
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_thread_idle:${threadId}:runs=${activeRuns}:requests=${pendingRequests}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForThreadIdle(threadId, attemptsRemaining - 1, deadlineAt);
        });

      const waitForNoBackgroundWork = (
        threadId: ThreadId,
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        Effect.gen(function* () {
          const pending = (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks;
          if ((pending?.length ?? 0) === 0) {
            return;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_no_background_work:${threadId}:pending=${pending?.map((task) => task.taskId).join(",")}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForNoBackgroundWork(threadId, attemptsRemaining - 1, deadlineAt);
        });

      const waitForRunSteerable = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          const providerTurn = projection.providerTurns.find(
            (candidate) =>
              run?.activeAttemptId !== null &&
              candidate.runAttemptId === run?.activeAttemptId &&
              candidate.status === "running",
          );
          if (run?.status === "running" && providerTurn !== undefined) {
            return;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_run_steerable:${runId}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForRunSteerable(threadId, runId, attemptsRemaining - 1, deadlineAt);
        });

      const waitForRunStatus = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        status: OrchestrationV2Run["status"],
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          if (run?.status === status) {
            return;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_run_status:${runId}:${status}:actual=${run?.status ?? "missing"}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForRunStatus(
            threadId,
            runId,
            status,
            attemptsRemaining - 1,
            deadlineAt,
          );
        });

      const waitForRunTurnItem = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        itemType: OrchestrationV2TurnItem["type"],
        attemptsRemaining = SCENARIO_WAIT_ATTEMPTS,
        deadlineAt = scenarioWaitDeadline(),
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const hasTurnItem = projection.turnItems.some(
            (item) => item.runId === runId && item.type === itemType,
          );
          if (hasTurnItem) {
            return;
          }
          if (scenarioWaitExhausted(attemptsRemaining, deadlineAt)) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `await_run_turn_item:${runId}:${itemType}`,
            });
          }
          yield* yieldToRuntime;
          return yield* waitForRunTurnItem(
            threadId,
            runId,
            itemType,
            attemptsRemaining - 1,
            deadlineAt,
          );
        });

      const releaseReplayGateAfterWaiting = (
        label: string,
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
      ) =>
        Effect.gen(function* () {
          const gate = options.replayGate;
          if (gate === undefined || !(yield* Effect.promise(() => gate.waitForReached(label)))) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `release_replay_gate_after_waiting:${label}:missing-gate`,
            });
          }
          // Background Bash holds the root in post-terminal waiting until its
          // roster clears. Await that committed milestone, including replayed
          // events, before releasing the recorded completion.
          yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.runId === runId &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === run?.providerThreadId,
          );
          if (
            providerThread === undefined ||
            (providerThread.pendingBackgroundTasks?.length ?? 0) === 0
          ) {
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `release_replay_gate_after_waiting:${label}:missing-background-task`,
            });
          }
          const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
          gate.release(label);
          yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "provider-thread.updated" &&
                event.payload.id === providerThread.id &&
                event.payload.status === "idle" &&
                (event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        });

      // Finish receipts earlier held runs already consumed.
      let consumedFinishReceipts = 0;
      const finishHeldRun = Effect.fn("scenario.finishHeldRun")(function* (
        step: Extract<OrchestratorV2ScenarioStep, { readonly type: "finish_held_run" }>,
      ) {
        const gate = options.replayGate;
        if (gate === undefined) {
          return yield* new OrchestratorV2ScenarioStepError({
            scenario: scenario.name,
            step: `finish_held_run:${step.runId}:no_replay_gate`,
          });
        }
        while (true) {
          // The run settles only through the latest armed debounce; a rearm
          // (a late frame) supersedes it with a new receipt. Advance past the
          // latest one, then either the run gets there or it rearmed again.
          const armed = yield* Effect.promise(() =>
            gate.waitForFinishArmed(consumedFinishReceipts),
          ).pipe(
            Effect.timeoutOption(Duration.millis(SCENARIO_WAIT_DEADLINE_MS)),
            Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
          );
          if (Option.isNone(armed)) {
            const projection = yield* orchestrator.getThreadProjection(step.threadId);
            const run = projection.runs.find((candidate) => candidate.id === step.runId);
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `finish_held_run:${step.runId}:${step.status}:actual=${run?.status ?? "missing"}:no_finish_armed`,
            });
          }
          consumedFinishReceipts = gate.finishArmedCount();
          yield* TestClock.adjust(armed.value);
          const settled = yield* Effect.raceFirst(
            waitForRunStatus(step.threadId, step.runId, step.status).pipe(Effect.as(true)),
            Effect.promise(() => gate.waitForFinishArmed(consumedFinishReceipts)).pipe(
              Effect.as(false),
            ),
          );
          // A finalized turn arms no further receipts, so the count is final.
          if (settled) {
            consumedFinishReceipts = gate.finishArmedCount();
            return;
          }
        }
      });

      const releaseReplayGate = Effect.fn("scenario.releaseReplayGate")(function* (label: string) {
        const gate = options.replayGate;
        const reached =
          gate === undefined ? false : yield* Effect.promise(() => gate.waitForReached(label));
        if (!reached) {
          return yield* new OrchestratorV2ScenarioStepError({
            scenario: scenario.name,
            step: `release_replay_gate:${label}:not_configured`,
          });
        }
        gate?.release(label);
      });

      for (const step of scenarioSteps(scenario)) {
        switch (step.type) {
          case "dispatch": {
            if (step.await ?? true) {
              const result = yield* orchestrator.dispatch(step.command);
              storedEventGroups.push(result.storedEvents);
              break;
            }

            anonymousBackgroundDispatchIndex += 1;
            const key = step.key ?? `dispatch:${anonymousBackgroundDispatchIndex}`;
            backgroundDispatches.set(
              key,
              yield* orchestrator.dispatch(step.command).pipe(
                Effect.map((result) => result.storedEvents),
                Effect.forkScoped,
              ),
            );
            break;
          }
          case "advance_clock":
            yield* TestClock.adjust(step.duration);
            break;
          case "await":
            yield* awaitDispatch(step.key);
            break;
          case "await_all":
            for (const key of Array.from(backgroundDispatches.keys())) {
              yield* awaitDispatch(key);
            }
            break;
          case "await_thread_idle":
            yield* waitForThreadIdle(step.threadId);
            break;
          case "await_no_background_work":
            yield* waitForNoBackgroundWork(step.threadId);
            break;
          case "await_run_steerable":
            yield* waitForRunSteerable(step.threadId, step.runId);
            break;
          case "await_run_status":
            yield* waitForRunStatus(step.threadId, step.runId, step.status);
            break;
          case "finish_held_run":
            yield* finishHeldRun(step);
            break;
          case "await_run_turn_item":
            yield* waitForRunTurnItem(step.threadId, step.runId, step.itemType);
            break;
          case "release_replay_gate_after_waiting":
            yield* releaseReplayGateAfterWaiting(step.label, step.threadId, step.runId);
            break;
          case "release_replay_gate":
            yield* releaseReplayGate(step.label);
            break;
          case "capture_shell_snapshot":
            capturedShellSnapshots.set(step.key, yield* orchestrator.getShellSnapshot());
            break;
          case "respond_to_next_runtime_request": {
            const request = yield* waitForPendingRuntimeRequest(step.threadId);
            if (step.shellSnapshotKeyWhilePending !== undefined) {
              capturedShellSnapshots.set(
                step.shellSnapshotKeyWhilePending,
                yield* orchestrator.getShellSnapshot(),
              );
            }
            const result = yield* orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: step.commandId,
              threadId: step.threadId,
              requestId: request.id,
              ...(step.decision === undefined ? {} : { decision: step.decision }),
              ...(step.answers === undefined ? {} : { answers: step.answers }),
            });
            storedEventGroups.push(result.storedEvents);
            break;
          }
        }
      }

      for (const key of Array.from(backgroundDispatches.keys())) {
        yield* awaitDispatch(key);
      }
      if (options.afterSteps !== undefined) {
        yield* options.afterSteps;
      }

      const shellSnapshot = yield* orchestrator.getShellSnapshot();
      const projectionThreadIds = new Set(collectProjectionThreadIds(scenario));
      for (const thread of shellSnapshot.threads) {
        projectionThreadIds.add(thread.id);
      }
      const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
      for (const threadId of projectionThreadIds) {
        projections.set(threadId, yield* orchestrator.getThreadProjection(threadId));
      }

      yield* Effect.yieldNow;

      const observedEvents = yield* Ref.get(observedStoredEvents);
      const storedEvents = (
        observedEvents.length > 0 ? observedEvents : storedEventGroups.flat()
      ).toSorted((left, right) => left.sequence - right.sequence);
      return {
        storedEvents,
        domainEvents: storedEvents.map((stored) => stored.event),
        projections,
        shellSnapshot,
        capturedShellSnapshots,
      };
    }),
  ).pipe(
    // A failed step can leave provider frames held at a gate. Release them
    // before the harness shuts the provider down, or teardown waits on them.
    Effect.ensuring(Effect.sync(() => options.replayGate?.releaseAll())),
  );
}
