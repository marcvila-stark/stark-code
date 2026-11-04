import { runRanAfter } from "@starkfuture/shared/orchestrationV2ThreadError";
import {
  isPersonFacingRuntimeRequest,
  lostRuntimeRequestLabel,
} from "@starkfuture/shared/orchestrationV2LostRequests";
import { resolveProjectSettings } from "@starkfuture/shared/projectSettings";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type ProviderThreadId,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  isOrchestrationV2WorkActive,
  ThreadId,
} from "@starkfuture/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";
import { isBufferedProviderNotification } from "./NotificationMailbox.ts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@starkfuture/provider-core/server/subagentProjection";
import {
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  mergeRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";

export class ProviderRuntimeRecoveryError extends Schema.TaggedError<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals(["read-projections", "reconcile", "drain-outbox"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}

export interface ProviderRuntimeRecoverySummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly prepareForShutdown: Effect.Effect<void, ProviderRuntimeRecoveryError>;
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
  }
>()("stark-code/orchestration-v2/ProviderRuntimeRecoveryService") {}

function nonterminalRuns(projection: ProjectionStore.ProjectionRuntimeRecoveryState) {
  return projection.runs.filter((run) => {
    const status: string = run.status;
    return (
      status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting"
    );
  });
}

function isBackgroundCapableTurnItemType(type: string): boolean {
  return type === "command_execution" || type === "dynamic_tool" || type === "subagent";
}

function isNonterminalTurnItemStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isNonterminalNodeStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

/**
 * A delegate_task child. Its own thread is reconciled and continued on its own
 * and reports back through the app, so it is not provider background work.
 */
function isAppOwnedDelegation(task: {
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
}): boolean {
  return task.origin === "app_owned" && task.childThreadId !== null;
}

function isAppOwnedDelegationItem(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
): boolean {
  return item.type === "subagent" && isAppOwnedDelegation(item);
}

function providerThreadHasPendingBackgroundTasks(
  providerThread: OrchestrationV2ThreadProjection["providerThreads"][number],
): boolean {
  return (providerThread.pendingBackgroundTasks?.length ?? 0) > 0;
}

/**
 * Resolve providerInstanceId for a stale background-capable turn item whose
 * run is missing/null (or not found). Prefer an existing run, then a subagent
 * item's own instance id, then the item's provider thread, then a last-resort
 * first provider thread, then the thread's selected provider.
 */
function resolveStaleBackgroundItemProviderInstanceId(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): OrchestrationV2ThreadProjection["thread"]["providerInstanceId"] {
  if (item.runId !== null) {
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    if (run !== undefined) {
      return run.providerInstanceId;
    }
  }
  if (item.type === "subagent") {
    return item.providerInstanceId;
  }
  if (item.providerThreadId !== null && item.providerThreadId !== undefined) {
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === item.providerThreadId,
    );
    if (providerThread !== undefined) {
      return providerThread.providerInstanceId;
    }
  }
  return projection.providerThreads[0]?.providerInstanceId ?? projection.thread.providerInstanceId;
}

/** An open item closed by recovery. A secret card also closes its form, so it takes no answer. */
const cancelledItem = (
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  now: DateTime.Utc,
): OrchestrationV2ThreadProjection["turnItems"][number] =>
  item.type === "notification" && item.toolNonExecutionKind === "workspace_wait"
    ? {
        ...item,
        status: "cancelled",
        outcome: "cancelled",
        summary: "Chat stopped before it could start.",
        completedAt: now,
        updatedAt: now,
      }
    : item.type === "secret_request" && item.secretStatus === "pending"
      ? {
          ...item,
          status: "cancelled",
          secretStatus: "cancelled",
          completedAt: now,
          updatedAt: now,
        }
      : { ...item, status: "cancelled", completedAt: now, updatedAt: now };

/**
 * A provider thread's latest started run: the last turn that provider saw.
 * Restart recovery records the thread's cancelled background work on it, and
 * the next run on the same provider thread delivers it with its input.
 */
function latestStartedRun(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  providerThreadId: ProviderThreadId,
) {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | undefined>(
    (latest, run) =>
      run.providerThreadId === providerThreadId &&
      run.status !== "queued" &&
      run.status !== "rolled_back" &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  // Answers the user gave whose delivery to the provider never settled. The
  // reconcile commit cancels their outbox rows, so they are read first. They
  // are read whatever state the runs are in: a question from a settled root's
  // background work, or one no run owns, loses its answer to the same cancel.
  const undeliveredAnswers = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const effects = yield* outbox.listUnsettled({
        threadId,
        effectTypes: ["runtime-request.respond"],
      });
      const answers = [];
      for (const effect of effects) {
        if (effect.request.type !== "runtime-request.respond") continue;
        const context = yield* projections.getRuntimeResponseContext(
          threadId,
          effect.request.requestId,
        );
        const request = context.request;
        if (
          request?.status !== "resolved" ||
          request.lost !== undefined ||
          request.responseCapability.type !== "live" ||
          !isPersonFacingRuntimeRequest(request)
        )
          continue;
        answers.push({ request, item: context.item });
      }
      return answers;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderRuntimeRecoveryError({ operation: "read-projections", threadId, cause }),
      ),
    );
  const reconcileProjection = Effect.fn("ProviderRuntimeRecoveryService.reconcileProjection")(
    function* (
      projection: ProjectionStore.ProjectionRuntimeRecoveryState,
      trigger: "startup" | "shutdown",
      continueAfterRestart: boolean,
    ) {
      const now = yield* DateTime.now;
      const runs = [] as Array<OrchestrationV2ThreadProjection["runs"][number]>;
      for (const run of nonterminalRuns(projection)) {
        if (run.status === "waiting") {
          const checkpointEffects = yield* outbox
            .listByCommandId(CommandId.make(`command:effect:checkpoint.capture:${run.id}`))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({
                    operation: "reconcile",
                    threadId: projection.thread.id,
                    cause,
                  }),
              ),
            );
          const hasReplayableCheckpoint = checkpointEffects.some(
            (effect) =>
              effect.request.type === "checkpoint.capture" &&
              effect.request.runId === run.id &&
              (effect.status === "pending" || effect.status === "running"),
          );
          if (hasReplayableCheckpoint) continue;
        }
        runs.push(run);
      }
      const messageRequestNodeIds = new Set(
        projection.runtimeRequests
          .filter(
            (request) =>
              request.status === "pending" && request.responseCapability.type === "message",
          )
          .map((request) => request.nodeId),
      );
      const requests = projection.runtimeRequests.filter(
        (request) => request.status === "pending" && request.responseCapability.type !== "message",
      );
      // A request that waited on the user stays open as a lost decision until
      // they ask again or dismiss it; its timeline row says why it closed.
      const lost = {
        cause: trigger === "startup" ? ("server_restart" as const) : ("server_shutdown" as const),
        lostAt: now,
      };
      const lostTitles = new Map(
        requests
          .filter(isPersonFacingRuntimeRequest)
          .map((request) => [
            request.id,
            lostRuntimeRequestLabel({ kind: request.kind, cause: lost.cause }),
          ]),
      );
      const withLostTitle = (item: OrchestrationV2ThreadProjection["turnItems"][number]) =>
        (item.type === "approval_request" || item.type === "user_input_request") &&
        lostTitles.has(item.requestId)
          ? { ...item, title: lostTitles.get(item.requestId)! }
          : item;
      const unsettledAnswers = yield* undeliveredAnswers(projection.thread.id);
      // An answer still pending delivery whose respond effect already settled
      // lost its report (the process died between them, or recording failed).
      // It may or may not have reached the provider either.
      const orphanedAnswers = yield* Effect.forEach(
        projection.runtimeRequests.filter(
          (request) =>
            request.status === "resolved" &&
            request.delivery?.state === "pending" &&
            request.lost === undefined &&
            request.responseCapability.type === "live" &&
            isPersonFacingRuntimeRequest(request) &&
            !unsettledAnswers.some((answer) => answer.request.id === request.id),
        ),
        (request) =>
          projections.getRuntimeResponseContext(projection.thread.id, request.id).pipe(
            Effect.map((context) => ({ request, item: context.item })),
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "read-projections",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          ),
      );
      const undelivered = [...unsettledAnswers, ...orphanedAnswers];
      const uncertainRequests = undelivered.map(({ request }) => ({
        ...request,
        status: trigger === "startup" ? ("expired" as const) : ("cancelled" as const),
        responseCapability: {
          type: "not_resumable" as const,
          reason: `The server ${trigger === "startup" ? "restarted" : "shut down"} before this answer was confirmed delivered.`,
        },
        lost: { ...lost, deliveryUncertain: true },
        ...(request.delivery === undefined
          ? {}
          : {
              delivery: {
                state: "uncertain" as const,
                attempts: request.delivery.attempts,
                updatedAt: now,
                reason: "Stark stopped before it could confirm the answer reached the agent.",
              },
            }),
      }));
      // Delegated task rows, items and nodes stay open: the child settles them.
      const delegatedTaskNodeIds = new Set<string>([
        ...(projection.subagents ?? []).filter(isAppOwnedDelegation).map((subagent) => subagent.id),
        ...(projection.turnItems ?? []).flatMap((item) =>
          item.type === "subagent" && isAppOwnedDelegation(item) ? [item.subagentId] : [],
        ),
      ]);
      const detail = `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:${projection.thread.id}:${DateTime.formatIso(now)}`,
      );
      const allocateEventId = () =>
        ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "reconcile",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      // Background work that outlived its settled turn. The provider transcript
      // cannot record its death, so the next provider turn is told instead.
      // Shutdown records it too: a graceful restart cancels it there first.
      // Keyed by the provider thread that lost the work: only its turns are told.
      const cancelledBackgroundWork = new Map<
        ProviderThreadId,
        Array<OrchestrationV2RestartCancelledBackgroundWork>
      >();
      const cancelledBackgroundNativeIds = new Set<string>();
      const recordCancelledBackgroundWork = (
        providerThreadId: ProviderThreadId | null | undefined,
        work: OrchestrationV2RestartCancelledBackgroundWork,
      ) => {
        if (providerThreadId == null) return;
        const existing = cancelledBackgroundWork.get(providerThreadId);
        if (existing === undefined) cancelledBackgroundWork.set(providerThreadId, [work]);
        else existing.push(work);
      };
      const recordCancelledBackgroundItem = (
        item: OrchestrationV2ThreadProjection["turnItems"][number],
      ) => {
        if (!isBackgroundCapableTurnItemType(item.type)) return;
        const work = cancelledTurnItemWork(item);
        if (work === undefined) return;
        recordCancelledBackgroundWork(
          item.providerThreadId ??
            projection.runs.find((run) => run.id === item.runId)?.providerThreadId,
          work,
        );
        if (item.nativeItemRef?.nativeId != null) {
          cancelledBackgroundNativeIds.add(item.nativeItemRef.nativeId);
        }
      };
      const queuedRuns = projection.runs.filter((run) => run.status === "queued");
      const queuedMessages =
        queuedRuns.length === 0
          ? []
          : (yield* projections
              .getThreadRecords(projection.thread.id, ["messages"], {
                messageIds: queuedRuns.map((run) => run.userMessageId),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderRuntimeRecoveryError({
                      operation: "read-projections",
                      threadId: projection.thread.id,
                      cause,
                    }),
                ),
              )).messages;
      const bufferedMessageIds = new Set(
        queuedMessages.filter(isBufferedProviderNotification).map((message) => message.id),
      );
      // Buffered wakes lost their output with the process. Durable queued messages
      // keep their execution identities and order until the user resumes them.
      for (const run of queuedRuns) {
        if (bufferedMessageIds.has(run.userMessageId)) {
          runs.push(run);
          continue;
        }
        if (run.queueHeld === true) continue;
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, queueHeld: true },
        });
      }
      for (const request of requests) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: trigger === "startup" ? "expired" : "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason: `The server ${trigger === "startup" ? "restarted" : "shut down"} before this runtime request was resolved.`,
            },
            resolvedAt: now,
            ...(lostTitles.has(request.id) ? { lost } : {}),
          },
        });
      }
      // The answer stays on the request; the item keeps its answered status.
      for (const [index, { item }] of undelivered.entries()) {
        const request = uncertainRequests[index]!;
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: request,
        });
        if (item === undefined) continue;
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
          occurredAt: now,
          payload: {
            ...item,
            title: lostRuntimeRequestLabel({
              kind: request.kind,
              cause: lost.cause,
              deliveryUncertain: true,
            }),
            updatedAt: now,
          },
        });
      }
      for (const run of runs) {
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
        });
        for (const attempt of projection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "cancelled", completedAt: now },
          });
        }
        for (const node of projection.nodes.filter(
          (candidate) =>
            candidate.runId === run.id &&
            !messageRequestNodeIds.has(candidate.id) &&
            !delegatedTaskNodeIds.has(candidate.id) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: "cancelled", completedAt: now },
          });
        }
        for (const providerTurn of projection.providerTurns.filter(
          (candidate) =>
            candidate.runAttemptId !== null &&
            projection.attempts.some(
              (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
            ) &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: providerTurn.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...providerTurn, status: "cancelled", completedAt: now },
          });
        }
        // A turn cut while it worked says so, so its partial reply never reads
        // as a finished answer. A waiting run's turn had already ended.
        if (run.status === "preparing" || run.status === "starting" || run.status === "running") {
          const rootNodeId =
            projection.attempts.find((attempt) => attempt.id === run.activeAttemptId)?.rootNodeId ??
            null;
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(rootNodeId === null ? {} : { nodeId: rootNodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              id: ids.derive.runSignalTurnItem({ runId: run.id, signal: "restart-interrupt" }),
              threadId: projection.thread.id,
              runId: run.id,
              nodeId: rootNodeId,
              providerThreadId: run.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: run.ordinal * 100 + 98,
              status: "interrupted",
              title: trigger === "startup" ? "Interrupted by restart" : "Interrupted by shutdown",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "run_interrupt_result",
              message:
                trigger === "startup"
                  ? "The server restarted before this turn finished."
                  : "The server stopped before this turn finished.",
            },
          });
        }
        for (const message of projection.messages.filter(
          (candidate) => candidate.runId === run.id && candidate.streaming,
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "message.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...message, streaming: false, updatedAt: now },
          });
        }
        for (const item of projection.turnItems.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.nodeId === null || !messageRequestNodeIds.has(candidate.nodeId)) &&
            !isAppOwnedDelegationItem(candidate) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          // A waiting run's provider turn already settled; its open items are
          // background work. A running run's items die with its turn.
          if (run.status === "waiting") recordCancelledBackgroundItem(item);
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: withLostTitle(cancelledItem(item, now)),
          });
        }
      }
      // A blocking delegate_task wait dies with the turn that made it, and its
      // continuation never got the tool result. Let the child's result wake
      // the parent like an async task, so it reaches the continued turn.
      const cutRunIds = new Set(runs.map((run) => run.id));
      for (const task of projection.subagents ?? []) {
        if (
          task.origin !== "app_owned" ||
          task.runId === null ||
          !cutRunIds.has(task.runId) ||
          task.completionWake !== "settled_only" ||
          !isOrchestrationV2WorkActive(task.status)
        )
          continue;
        events.push({
          id: yield* allocateEventId(),
          type: "subagent.updated",
          threadId: projection.thread.id,
          runId: task.runId,
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
          payload: { ...task, completionWake: "always", updatedAt: now },
        });
      }
      // Process loss also orphans background-capable turn items on already-
      // settled runs (e.g. post-settle Waiting work). Skip items already
      // cancelled above for recovered nonterminal runs to avoid duplicate
      // cancellation events.
      const recoveredNonterminalRunIds = new Set(runs.map((run) => run.id));
      const cancelledStaleNodeIds = new Set<string>();
      for (const item of projection.turnItems ?? []) {
        if (item.runId !== null && recoveredNonterminalRunIds.has(item.runId)) {
          continue;
        }
        if (!isBackgroundCapableTurnItemType(item.type)) {
          continue;
        }
        if (!isNonterminalTurnItemStatus(item.status) || isAppOwnedDelegationItem(item)) {
          continue;
        }
        const providerInstanceId = resolveStaleBackgroundItemProviderInstanceId(item, projection);
        recordCancelledBackgroundItem(item);
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
          providerInstanceId,
          occurredAt: now,
          payload: cancelledItem(item, now),
        });
        if (item.nodeId !== null && item.nodeId !== undefined) {
          const staleItemNode = projection.nodes.find(
            (candidate) =>
              candidate.id === item.nodeId && isNonterminalNodeStatus(candidate.status),
          );
          if (staleItemNode !== undefined && !cancelledStaleNodeIds.has(staleItemNode.id)) {
            cancelledStaleNodeIds.add(staleItemNode.id);
            events.push({
              id: yield* allocateEventId(),
              type: "node.updated",
              threadId: projection.thread.id,
              ...(item.runId === null ? {} : { runId: item.runId }),
              nodeId: staleItemNode.id,
              providerInstanceId,
              occurredAt: now,
              payload: { ...staleItemNode, status: "cancelled", completedAt: now },
            });
          }
        }
      }
      // A lost request's item closes with its loss title even when no cut run owns it.
      const closedItemIds = new Set(
        events.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload.id] : [])),
      );
      for (const item of projection.turnItems ?? []) {
        const titled = withLostTitle(item);
        if (titled === item || closedItemIds.has(item.id)) continue;
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
          occurredAt: now,
          payload: withLostTitle(cancelledItem(item, now)),
        });
      }
      // No provider process outlives the server, so a native subagent still open
      // here never reports its end, whatever state its run and item are in.
      for (const subagent of projection.subagents ?? []) {
        events.push(
          ...(yield* endOrphanedNativeSubagent({
            projection,
            subagentId: subagent.id,
            status: "cancelled",
            now,
            emitted: events,
            allocateEventId,
          })),
        );
      }
      // A provider-native subagent thread has no runs; left running, the child
      // would show as working forever.
      events.push(
        ...(yield* endRunlessRootTurns({
          threadId: projection.thread.id,
          providerInstanceId: projection.thread.providerInstanceId,
          projection,
          status: "cancelled",
          now,
          emitted: events,
          allocateEventId,
        })),
      );
      // All provider processes are gone on startup/shutdown: clear any
      // persisted Waiting roster (including idle threads from settled roots)
      // and idle active threads without resurrecting active status.
      for (const providerThread of projection.providerThreads ?? []) {
        const needsIdle = providerThread.status === "active";
        const needsRosterClear = providerThreadHasPendingBackgroundTasks(providerThread);
        if (!needsIdle && !needsRosterClear) {
          continue;
        }
        if (providerThread.ownerNodeId === null) {
          for (const task of providerThread.pendingBackgroundTasks ?? []) {
            if (cancelledBackgroundNativeIds.has(task.taskId)) continue;
            cancelledBackgroundNativeIds.add(task.taskId);
            recordCancelledBackgroundWork(providerThread.id, cancelledRosterTaskWork(task));
          }
        }
        events.push({
          id: yield* allocateEventId(),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...providerThread,
            status: needsIdle ? "idle" : providerThread.status,
            pendingBackgroundTasks: [],
            updatedAt: now,
          },
        });
      }
      for (const session of projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
        });
      }
      for (const [providerThreadId, work] of cancelledBackgroundWork) {
        const noteRun = latestStartedRun(projection, providerThreadId);
        if (noteRun === undefined) continue;
        // Its own event: a run snapshot read before this commit could regress
        // a lifecycle change (e.g. a checkpoint completing the run) made since.
        events.push({
          id: yield* allocateEventId(),
          type: "run.background-work-cancelled",
          threadId: projection.thread.id,
          runId: noteRun.id,
          providerInstanceId: noteRun.providerInstanceId,
          occurredAt: now,
          payload: {
            runId: noteRun.id,
            restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(
              noteRun.restartCancelledBackgroundWork ?? [],
              work,
            ),
          },
        });
      }
      // An answer whose delivery is uncertain blocks continuing the turn like an
      // unanswered request does: the step it decided is never rerun automatically.
      const continuationRun =
        continueAfterRestart && trigger === "startup"
          ? restartContinuationRun(
              {
                ...projection,
                runtimeRequests: [...projection.runtimeRequests, ...uncertainRequests],
              },
              now,
            )
          : undefined;
      const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = continuationRun
        ? [
            {
              id: `effect:restart-continuation:${continuationRun.id}`,
              commandId,
              threadId: projection.thread.id,
              request: { type: "provider-runtime.continue", sourceRunId: continuationRun.id },
            },
          ]
        : [];
      const stoppedSessions = projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      ).length;
      let retiredEffects: number;
      if (events.length === 0) {
        const retiredEffectIds = yield* outbox
          .cancelUnsettled({
            threadId: projection.thread.id,
            effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
            reason: detail,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause: { detail, cause },
                }),
            ),
          );
        yield* outbox.signalCancellations(retiredEffectIds);
        retiredEffects = retiredEffectIds.length;
      } else {
        const result = yield* eventSink
          .commitCommand({
            commandId,
            threadId: projection.thread.id,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events,
            effects,
            cancelUnsettledEffects: {
              effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
              reason: detail,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        retiredEffects = result.cancelledEffectCount;
      }
      return {
        terminalizedRuns: runs.length,
        stoppedSessions,
        closedRequests: requests.length + uncertainRequests.length,
        retiredEffects,
      };
    },
  );

  const reconcile = (trigger: "startup" | "shutdown") =>
    Effect.gen(function* () {
      const continueAfterRestart = yield* settings.getSettings.pipe(
        Effect.orElseSucceed(() => null),
      );
      const threadIds = yield* projections
        .getRecoveryThreadIds("runtime")
        .pipe(
          Effect.mapError(
            (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
          ),
        );
      let terminalizedRuns = 0;
      let stoppedSessions = 0;
      let closedRequests = 0;
      let retiredEffects = 0;
      for (const threadId of threadIds) {
        const projection = yield* projections.getRuntimeRecoveryProjection(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "read-projections",
                threadId,
                cause,
              }),
          ),
        );
        const enabled =
          continueAfterRestart !== null &&
          resolveProjectSettings(continueAfterRestart, projection.thread.projectId).settings
            .continueThreadsAfterServerUpdate;
        const result = yield* reconcileProjection(projection, trigger, enabled);
        terminalizedRuns += result.terminalizedRuns;
        stoppedSessions += result.stoppedSessions;
        closedRequests += result.closedRequests;
        retiredEffects += result.retiredEffects;
      }
      const outboxReconciliation = yield* outbox.reconcileAfterProcessLoss.pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
        ),
      );
      return {
        terminalizedRuns,
        stoppedSessions,
        closedRequests,
        retiredEffects: retiredEffects + outboxReconciliation.cancelled,
        requeuedEffects: outboxReconciliation.requeued,
      } satisfies ProviderRuntimeReconciliationSummary;
    });

  // Snapshot intent only while providers are live. A provider may finish while
  // this commits; reconciliation reads fresh state after shutdown, and delivery
  // rejects any source run that actually completed.
  const prepareForShutdown = Effect.gen(function* () {
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threadIds = yield* projections.getRecoveryThreadIds("runtime");
    for (const threadId of threadIds) {
      yield* Effect.gen(function* () {
        const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
        if (
          !resolveProjectSettings(enabled, projection.thread.projectId).settings
            .continueThreadsAfterServerUpdate
        )
          return;
        const run = restartContinuationRun(projection, yield* DateTime.now);
        if (!run) return;
        const commandId = CommandId.make(`command:restart-prepare:${run.id}`);
        yield* eventSink.writeWithEffects({
          commandId,
          events: [],
          effects: [
            {
              id: `effect:restart-continuation:${run.id}`,
              commandId,
              threadId,
              request: { type: "provider-runtime.continue", sourceRunId: run.id },
            },
          ],
        });
      }).pipe(
        // One failing thread must not cost the threads after it their continuation.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Failed to prepare a restart continuation", { threadId, cause }),
        ),
      );
    }
  }).pipe(
    Effect.mapError((cause) => new ProviderRuntimeRecoveryError({ operation: "reconcile", cause })),
  );

  const recover = Effect.gen(function* () {
    return (yield* reconcile("startup")) satisfies ProviderRuntimeRecoverySummary;
  });

  return ProviderRuntimeRecoveryService.of({ reconcile, prepareForShutdown, recover });
});

export const layer = Layer.effect(ProviderRuntimeRecoveryService, make);
