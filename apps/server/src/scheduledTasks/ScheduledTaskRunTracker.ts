import { CommandId, type OrchestrationV2StoredEvent } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

/**
 * Reads what the orchestrator recorded for a scheduled run's prompt. A
 * launch is two commands: the thread create, whose accepted receipt names the
 * thread it made, and the initial message under `${commandId}:initial-message`.
 * Each is checked on its own, so an empty thread is never taken for
 * dispatched work. Once the prompt landed, the run is read from the thread
 * after its event sequence, so the observation can only be older than what
 * the run tracker applies next, never newer.
 */
export const makeRunInspector =
  (deps: {
    readonly threads: ThreadManagementService.ThreadManagementService["Service"];
    readonly receipts: CommandReceiptStore.CommandReceiptStoreV2["Service"];
  }): ScheduledTaskService.ScheduledTaskRunInspector =>
  (target) =>
    Effect.gen(function* () {
      let threadId = target.threadId;
      if (target.agentRunId === null || threadId === null) {
        const receipt = yield* deps.receipts.getByCommandId(target.commandId);
        if (Option.isNone(receipt)) return { _tag: "NotDispatched" } as const;
        if (receipt.value.status === "rejected") {
          return { _tag: "Rejected", threadId } as const;
        }
        if (target.dispatchKind === "launch") {
          threadId = receipt.value.threadId;
          const message = yield* deps.receipts.getByCommandId(
            CommandId.make(`${target.commandId}:initial-message`),
          );
          if (Option.isNone(message)) return { _tag: "ThreadOnly", threadId } as const;
          if (message.value.status === "rejected") return { _tag: "Rejected", threadId } as const;
        }
      }
      if (threadId === null) return { _tag: "Missing", threadId } as const;
      const sequence = yield* deps.threads.getThreadEventSequence(threadId);
      const records = yield* deps.threads
        .getProjectThreadRecords({ projectId: target.projectId, threadId }, ["runs", "messages"], {
          messageIds: [target.messageId],
        })
        .pipe(
          Effect.asSome,
          Effect.catchTags({ ThreadManagementThreadNotFoundError: () => Effect.succeedNone }),
        );
      if (Option.isNone(records)) return { _tag: "Missing", threadId } as const;
      const { runs, messages } = records.value;
      const messageRunId = messages.find((message) => message.id === target.messageId)?.runId;
      const followed =
        runs.find((run) => run.id === target.agentRunId) ??
        runs.find((run) => run.id === messageRunId) ??
        runs.find((run) => run.userMessageId === target.messageId);
      if (followed === undefined) return { _tag: "Missing", threadId } as const;
      return {
        _tag: "Observed",
        run: ThreadManagementService.latestRestartContinuation(runs, followed),
        sequence,
      } as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read what became of a scheduled run", { cause }).pipe(
          Effect.as({ _tag: "Unknown" } as const),
        ),
      ),
    );

/**
 * Keeps scheduled runs in step with the agent runs they started. It reads the
 * event high-water mark first, then follows `run.created` and `run.updated`
 * from that mark, then reconciles runs a stopped server left open. Because
 * the followers replay everything after the mark, an event that lands while
 * the reconcile reads its snapshot still arrives, and per-row event sequences
 * make the older of the two lose.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const highWater = yield* events.latestAgentSequence().pipe(Effect.orElseSucceed(() => 0));

    const observe = (stored: OrchestrationV2StoredEvent) =>
      stored.event.type === "run.created" || stored.event.type === "run.updated"
        ? scheduledTasks
            .observeRun({ run: stored.event.payload, sequence: stored.sequence })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not record a scheduled run's state", { cause }),
              ),
            )
        : Effect.void;

    // One follower per event type keeps transcript traffic out of its
    // buffer. A follower that falls behind fails; it resumes after the last
    // event it handled.
    const follow = (eventType: "run.created" | "run.updated") =>
      Effect.gen(function* () {
        const cursor = yield* Ref.make(highWater);
        return yield* Stream.unwrap(
          Ref.get(cursor).pipe(
            Effect.map((afterSequence) =>
              threads.streamStoredEventsFrom({ afterSequence, eventType }),
            ),
          ),
        ).pipe(
          Stream.runForEach((stored) =>
            observe(stored).pipe(Effect.andThen(Ref.set(cursor, stored.sequence))),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Scheduled run tracker lost its event stream", {
              eventType,
              cause,
            }),
          ),
          Effect.andThen(Effect.sleep("1 second")),
          Effect.forever,
        );
      });

    yield* forkParked(follow("run.created"));
    yield* forkParked(follow("run.updated"));
    yield* forkParked(
      scheduledTasks
        .reconcileRuns(makeRunInspector({ threads, receipts }))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not reconcile scheduled task runs", { cause }),
          ),
        ),
    );
  }),
);
