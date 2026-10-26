import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import { normalizeProjectPathForComparison } from "@starkfuture/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as LocalAgentHistoryStore from "./LocalAgentHistoryStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const isThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);
const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const historyStore = yield* LocalAgentHistoryStore.LocalAgentHistoryStore;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const gate = yield* Semaphore.make(1);
  const ignoredSources = new Map<string, AgentSessionImportSource>();
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const allLocal = input.scope === "all-local";
    const nativeOwners = allLocal ? yield* historyStore.owners : [];
    const ownerByNative = new Map(
      nativeOwners.map((owner) => [`${owner.driver}\0${owner.nativeId}`, owner.threadId]),
    );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        (!allLocal &&
          (payload.value.cwd === undefined ||
            normalizeProjectPathForComparison(payload.value.cwd) !==
              normalizeProjectPathForComparison(project.workspaceRoot)))
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    if (allLocal) completedSources.push(...ignoredSources.values());
    const outcomes = allLocal
      ? scanner.allThreads(completedSources)
      : scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    let truncated = false;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Truncated") {
          truncated = true;
          return;
        }
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          if (allLocal) unchangedCount += 1;
          else importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const owner = ownerByNative.get(`${source.provider}\0${source.providerSessionId}`);
        if (allLocal && owner !== undefined && owner !== threadId) {
          // The native transcript may belong to an app chat, native terminal,
          // archived chat, or another configured alias of the same CLI home.
          unchangedCount += 1;
          if (ignoredSources.size >= 10_000) {
            const oldest = ignoredSources.keys().next().value;
            if (oldest !== undefined) ignoredSources.delete(oldest);
          }
          ignoredSources.set(`${source.providerInstanceId}\0${source.filePath}`, source);
          return;
        }
        let updated = false;
        const imported = yield* threadCommands
          .withLock(
            threadId,
            Effect.gen(function* () {
              const thread = outcome.thread;
              // A provider may have registered this session during discovery.
              // Re-read ownership before copying it into a new app thread.
              const currentOwner = allLocal
                ? (yield* historyStore.owners).find(
                    (candidate) =>
                      candidate.driver === source.provider &&
                      candidate.nativeId === source.providerSessionId,
                  )?.threadId
                : undefined;
              if (currentOwner !== undefined && currentOwner !== threadId) {
                unchangedCount += 1;
                ownerByNative.set(`${source.provider}\0${source.providerSessionId}`, currentOwner);
                return false;
              }
              const activeNativeDirectories =
                allLocal && currentOwner === undefined
                  ? yield* historyStore.activeNativeDirectories
                  : [];
              if (
                allLocal &&
                currentOwner === undefined &&
                thread.cwd !== undefined &&
                activeNativeDirectories.some(
                  (cwd) =>
                    normalizeProjectPathForComparison(cwd) ===
                    normalizeProjectPathForComparison(thread.cwd!),
                )
              ) {
                // A first native-shell turn has no captured reply/session owner yet.
                // Defer this folder until its shell is closed rather than create a duplicate.
                skippedCount += 1;
                return false;
              }
              truncated ||= thread.historyTruncated === true;
              if (
                thread.source === "claudeAgent" &&
                !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
              ) {
                return yield* new AgentSessionUnresumableSessionError({
                  source: thread.source,
                  providerSessionId: thread.providerSessionId,
                });
              }
              const existing = yield* orchestrator
                .getThreadRecords(threadId, allLocal ? ["messages", "runs"] : [])
                .pipe(
                  Effect.map(Option.some),
                  Effect.catch((error) =>
                    isThreadNotFound(error.cause)
                      ? Effect.succeed(Option.none())
                      : Effect.fail(error),
                  ),
                );
              if (Option.isSome(existing)) {
                if (existing.value.thread.projectId !== input.projectId) {
                  return yield* new AgentSessionThreadProjectConflictError({
                    threadId,
                    expectedProjectId: input.projectId,
                    actualProjectId: existing.value.thread.projectId,
                  });
                }
                if (existing.value.thread.historyOrigin !== "v1_import") {
                  return yield* new AgentSessionThreadModifiedError({ threadId });
                }
                if (allLocal) {
                  const state = existing.value;
                  // A Stark turn owns its provider output. Never replay the source
                  // file over app-created messages, even while that turn is idle.
                  if (
                    state.thread.deletedAt !== null ||
                    state.thread.archivedAt !== null ||
                    (state.runs?.length ?? 0) > 0
                  ) {
                    yield* runtimes.recordImportedTranscript({ threadId, source });
                    unchangedCount += 1;
                    return false;
                  }
                  const messages = [...(state.messages ?? [])].sort((left, right) =>
                    left.id.localeCompare(right.id),
                  );
                  const prefixMatches =
                    messages.length <= thread.messages.length &&
                    messages.every((message, index) => {
                      const next = thread.messages[index];
                      return (
                        message.id === `${threadId}:${String(index).padStart(6, "0")}` &&
                        message.runId === null &&
                        next?.role === message.role &&
                        next.text === message.text
                      );
                    });
                  if (!prefixMatches) {
                    // Compaction/rewrite is not an append. Leave both histories intact.
                    skippedCount += 1;
                    return false;
                  }
                  const additions = thread.messages.slice(messages.length);
                  const metadataChanged =
                    state.thread.localSession?.historyTruncated !==
                      (thread.historyTruncated ?? false) ||
                    state.thread.localSession?.cwd !== thread.cwd;
                  if (additions.length > 0 || metadataChanged) {
                    const events = additions.flatMap((message, index) =>
                      messageEvents({ threadId, index: index + messages.length, message }),
                    );
                    for (let start = 0; start < events.length; start += 200) {
                      yield* eventSink.write({ events: events.slice(start, start + 200) });
                    }
                    const updatedAt = dateTime(thread.updatedAt);
                    const settledAt = state.thread.settledAt;
                    // Imported chats start settled at the source-file timestamp.
                    // A later manual settle has its own timestamp and must survive sync.
                    const refreshImportedSettlement =
                      additions.length > 0 &&
                      state.thread.settledOverride === "settled" &&
                      settledAt !== null &&
                      state.thread.unsettledAt == null &&
                      state.thread.pinnedAt == null &&
                      state.thread.snoozedUntil == null &&
                      DateTime.toEpochMillis(updatedAt) > DateTime.toEpochMillis(settledAt) &&
                      completedSources.some(
                        (completed) =>
                          completed.providerInstanceId === source.providerInstanceId &&
                          completed.providerSessionId === source.providerSessionId &&
                          completed.filePath === source.filePath &&
                          completed.mtimeMs === DateTime.toEpochMillis(settledAt),
                      );
                    yield* eventSink.write({
                      events: [
                        {
                          id: EventId.make(
                            `${IMPORT_EVENT_PREFIX}:sync:${threadId}:${source.size}:${source.mtimeMs}`,
                          ),
                          type: "thread.metadata-updated",
                          threadId,
                          occurredAt: updatedAt,
                          payload: {
                            ...state.thread,
                            updatedAt,
                            ...(refreshImportedSettlement ? { settledAt: updatedAt } : {}),
                            localSession: {
                              providerSessionId: thread.providerSessionId,
                              cwd:
                                thread.cwd ??
                                state.thread.localSession?.cwd ??
                                project.workspaceRoot,
                              historyTruncated: thread.historyTruncated ?? false,
                            },
                          },
                        },
                      ],
                    });
                    updated = true;
                  } else unchangedCount += 1;
                  yield* runtimes.recordImportedTranscript({ threadId, source });
                  return updated;
                }
                yield* runtimes.recordImportedTranscript({ threadId, source });
                return true;
              }

              const driver = ProviderDriverKind.make(thread.source);
              const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
              const providerThreadId = idAllocator.derive.providerThread({
                driver,
                nativeThreadId: thread.providerSessionId,
                ...(allLocal ? { providerInstanceId: thread.providerInstanceId } : {}),
              });
              const createdAt = dateTime(thread.createdAt);
              const updatedAt = dateTime(thread.updatedAt);
              const appThread: OrchestrationV2AppThread = {
                createdBy: "system",
                creationSource: "server",
                id: threadId,
                projectId: input.projectId,
                title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
                providerInstanceId: thread.providerInstanceId,
                modelSelection: { instanceId: thread.providerInstanceId, model },
                runtimeMode: DEFAULT_RUNTIME_MODE,
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                branch: null,
                worktreePath: null,
                linkedPullRequest: null,
                branchPullRequest: null,
                activeProviderThreadId: providerThreadId,
                historyOrigin: "v1_import",
                ...(allLocal && thread.cwd
                  ? {
                      localSession: {
                        providerSessionId: thread.providerSessionId,
                        cwd: thread.cwd,
                        historyTruncated: thread.historyTruncated ?? false,
                      },
                    }
                  : {}),
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                forkedFrom: null,
                createdAt,
                updatedAt,
                archivedAt: null,
                settledOverride: "settled",
                settledAt: updatedAt,
                unsettledAt: null,
                snoozedUntil: null,
                snoozedAt: null,
                pinnedAt: null,
                pinOrderKey: null,
                activeOrderKey: null,
                lastVisitedAt: null,
                deletedAt: null,
              };
              const providerThread: OrchestrationV2ProviderThread = {
                id: providerThreadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: thread.providerSessionId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt,
                updatedAt,
              };

              yield* runtimes.upsert(
                {
                  threadId,
                  providerName: driver,
                  providerInstanceId: thread.providerInstanceId,
                  adapterKey: driver,
                  runtimeMode: DEFAULT_RUNTIME_MODE,
                  status: "stopped",
                  lastSeenAt: thread.updatedAt,
                  resumeCursor:
                    thread.source === "codex"
                      ? { threadId: thread.providerSessionId }
                      : { threadId, resume: thread.providerSessionId },
                  runtimePayload: {
                    cwd: allLocal ? (thread.cwd ?? project.workspaceRoot) : project.workspaceRoot,
                  },
                },
                { onConflict: "ignore" },
              );
              const creationEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [
                {
                  id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                  type: "thread.created",
                  threadId,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: createdAt,
                  payload: appThread,
                },
                ...thread.messages.flatMap((message, index) =>
                  messageEvents({ threadId, index, message }),
                ),
                {
                  id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                  type: "provider-thread.updated",
                  threadId,
                  driver,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: updatedAt,
                  payload: providerThread,
                },
              ];
              if (allLocal) {
                // Commit the owner with thread creation, before chunking long history.
                yield* eventSink.write({
                  events: [creationEvents[0]!, creationEvents[creationEvents.length - 1]!],
                });
                const messages = creationEvents.slice(1, -1);
                for (let start = 0; start < messages.length; start += 200) {
                  yield* eventSink.write({ events: messages.slice(start, start + 200) });
                }
                ownerByNative.set(`${thread.source}\0${thread.providerSessionId}`, threadId);
                truncated ||= thread.historyTruncated === true;
              } else yield* eventSink.write({ events: creationEvents });
              yield* runtimes.recordImportedTranscript({ threadId, source });
              return true;
            }),
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                skippedCount += 1;
              }).pipe(
                Effect.andThen(
                  Effect.logWarning("Could not import an agent session", {
                    provider: outcome.thread.source,
                    sessionId: outcome.thread.providerSessionId,
                    error: cause instanceof Error ? cause.name : "ImportError",
                  }),
                ),
                Effect.as(false),
              ),
            ),
          );
        if (imported) {
          importedThreadIds.add(threadId);
          if (updated) updatedCount += 1;
          else importedCount += 1;
        }
      }),
    );

    const result: AgentSessionImportResult = {
      importedCount,
      skippedCount,
      ...(allLocal ? { updatedCount, unchangedCount, truncated } : {}),
    };
    return result;
  }, gate.withPermits(1));

  return { importRecentAgentThreads };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("stark-code/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
