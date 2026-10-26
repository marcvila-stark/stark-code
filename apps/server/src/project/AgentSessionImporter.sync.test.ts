import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type AgentSessionImportSource,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as Scanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Store from "./LocalAgentHistoryStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";

const projectId = ProjectId.make("main-folder");
const providerInstanceId = ProviderInstanceId.make("codex");
const nativeId = "native-session";
const threadId = ThreadId.make(`import:codex:${nativeId}`);
const at = "2026-01-01T10:00:00.000Z";
const message = (text: string): Scanner.AgentSessionThreadMessage => ({
  role: "assistant",
  text,
  createdAt: at,
});
function fixture() {
  const state = {
    messages: [message("First")],
    sourceSize: 100,
    updatedAt: at,
    truncated: false,
    thread: undefined as OrchestrationV2AppThread | undefined,
    persisted: new Map<string, OrchestrationV2ConversationMessage>(),
    recorded: [] as AgentSessionImportSource[],
    owners: [] as Store.LocalSessionOwner[],
    onOwnerRead: undefined as (() => void) | undefined,
    events: [] as OrchestrationV2DomainEvent[],
    readFailure: false,
    activeDirectories: [] as string[],
    appRuns: false,
    failAfterEvents: Infinity,
  };
  const source = (): AgentSessionImportSource => ({
    provider: "codex",
    providerInstanceId,
    providerSessionId: nativeId,
    filePath: "/home/codex/sessions/source.jsonl",
    size: state.sourceSize,
    mtimeMs: Date.parse(state.updatedAt),
    device: 1,
    inode: 2,
    birthtimeMs: 1,
  });
  const scanner = Scanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () => Stream.die("unused"),
    allThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: source(),
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId: nativeId,
          title: "CLI history",
          model: null,
          cwd: "/original/worktree",
          historyTruncated: state.truncated,
          createdAt: at,
          updatedAt: state.updatedAt,
          messages: state.messages,
        },
      }),
  });
  const layer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Scanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/main" } as never)),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            state.readFailure
              ? Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({
                    threadId,
                    cause: "database unavailable",
                  }),
                )
              : state.thread
                ? Effect.succeed({
                    thread: state.thread,
                    messages: [...state.persisted.values()],
                    runs: state.appRuns ? [{}] : [],
                  } as never)
                : Effect.fail(
                    new Orchestrator.OrchestratorProjectionError({
                      threadId,
                      cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
                    }),
                  ),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.gen(function* () {
              if (state.events.length >= state.failAfterEvents)
                return yield* new EventSink.EventSinkWriteError({
                  eventCount: input.events.length,
                });
              for (const event of input.events) {
                state.events.push(event);
                if (event.type === "thread.created" || event.type === "thread.metadata-updated")
                  state.thread = event.payload;
                if (event.type === "message.updated")
                  state.persisted.set(event.payload.id, event.payload);
              }
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () =>
            Effect.succeed(
              state.recorded.length === 0
                ? []
                : ([
                    {
                      runtimePayload: {
                        cwd: "/original/worktree",
                        importedTranscripts: state.recorded,
                      },
                    },
                  ] as never),
            ),
          upsert: () => Effect.void,
          recordImportedTranscript: ({ source }) =>
            Effect.sync(() => {
              state.recorded.push(source);
            }),
        }),
        Layer.succeed(Store.LocalAgentHistoryStore, {
          owners: Effect.sync(() => {
            state.onOwnerRead?.();
            return state.owners;
          }),
          activeNativeDirectories: Effect.sync(() => state.activeDirectories),
        }),
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
      ),
    ),
  );
  return { state, layer };
}

it.effect("imports all-history with original cwd and appends CLI replies exactly once", () => {
  const { state, layer } = fixture();
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const first = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(first.importedCount).toBe(1);
    expect(state.thread?.localSession?.cwd).toBe("/original/worktree");
    expect(state.thread?.worktreePath).toBeNull();
    expect(state.thread?.projectId).toBe(projectId);
    state.messages.push(message("Later CLI reply"));
    state.sourceSize++;
    const updated = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(updated.updatedCount).toBe(1);
    expect([...state.persisted.values()].map((value) => value.text)).toEqual([
      "First",
      "Later CLI reply",
    ]);
    const again = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(again.unchangedCount).toBe(1);
    expect(state.persisted.size).toBe(2);
    expect(state.events.filter((e) => e.type === "thread.created")).toHaveLength(1);
  }).pipe(Effect.provide(layer));
});

it.effect("does not steal an app-owned native binding or reimport a native terminal chat", () => {
  const { state, layer } = fixture();
  state.owners.push({
    driver: "codex",
    nativeId,
    threadId: ThreadId.make("existing-native-shell"),
  });
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const result = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(result.unchangedCount).toBe(1);
    expect(state.events).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("does not duplicate an SDK session registered during transcript discovery", () => {
  const { state, layer } = fixture();
  let reads = 0;
  state.onOwnerRead = () => {
    if (++reads === 2)
      state.owners.push({ driver: "codex", nativeId, threadId: ThreadId.make("live-sdk-chat") });
  };
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const result = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(result.unchangedCount).toBe(1);
    expect(result.importedCount).toBe(0);
    expect(state.events).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("stops following after a Stark turn and never overwrites a rewritten source", () => {
  const { state, layer } = fixture();
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    state.messages = [message("Rewritten")];
    state.sourceSize++;
    const rewritten = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(rewritten.skippedCount).toBe(1);
    expect(state.recorded).toHaveLength(1);
    expect([...state.persisted.values()][0]?.text).toBe("First");
    state.appRuns = true;
    state.messages = [message("First"), message("Adapter already owns this")];
    const owned = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(owned.unchangedCount).toBe(1);
    expect(state.persisted.size).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("recovers partial chunk writes and clears incomplete-history metadata", () => {
  const { state, layer } = fixture();
  state.messages = Array.from({ length: 220 }, (_, index) => message(`Message ${index}`));
  state.failAfterEvents = 202;
  state.truncated = true;
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const interrupted = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(interrupted.skippedCount).toBe(1);
    expect(state.recorded).toHaveLength(0);
    expect(state.persisted.size).toBe(100);
    state.failAfterEvents = Infinity;
    const retry = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(retry.updatedCount).toBe(1);
    expect(retry.truncated).toBe(true);
    expect(state.persisted.size).toBe(220);
    state.truncated = false;
    state.sourceSize++;
    yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(state.thread?.localSession?.historyTruncated).toBe(false);
  }).pipe(Effect.provide(layer));
});

it.effect("defers an unknown first native-shell turn until that folder is idle", () => {
  const { state, layer } = fixture();
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    state.activeDirectories.push("/original/worktree");
    const waiting = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(waiting.skippedCount).toBe(1);
    expect(state.events).toEqual([]);
    expect(state.recorded).toEqual([]);
    state.activeDirectories.length = 0;
    const ready = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(ready.importedCount).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("a database read failure cannot recreate an existing chat", () => {
  const { state, layer } = fixture();
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    state.readFailure = true;
    const result = yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(result.skippedCount).toBe(1);
    expect(state.events).toEqual([]);
    expect(state.recorded).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("refreshes automatic import settlement when a later CLI reply is appended", () => {
  const { state, layer } = fixture();
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(DateTime.formatIso(state.thread!.settledAt!)).toBe(at);
    state.updatedAt = "2026-10-22T12:00:00.000Z";
    state.messages.push({ ...message("New CLI reply"), createdAt: state.updatedAt });
    state.sourceSize++;
    yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
    expect(DateTime.formatIso(state.thread!.settledAt!)).toBe(state.updatedAt);
    expect(state.thread?.settledOverride).toBe("settled");
  }).pipe(Effect.provide(layer));
});

it.effect.each(["active", "manual-settled", "pinned", "snoozed", "app-owned"] as const)(
  "preserves %s status while discovering a later CLI reply",
  (status) => {
    const { state, layer } = fixture();
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
      const chosenAt = DateTime.makeUnsafe("2026-02-01T12:00:00.000Z");
      const original = state.thread!;
      state.thread = {
        ...original,
        ...(status === "active"
          ? { settledOverride: "active" as const, settledAt: null, unsettledAt: chosenAt }
          : {}),
        ...(status === "manual-settled" ? { settledAt: chosenAt, updatedAt: chosenAt } : {}),
        ...(status === "pinned" ? { pinnedAt: chosenAt } : {}),
        ...(status === "snoozed" ? { snoozedUntil: chosenAt, snoozedAt: chosenAt } : {}),
      };
      const previous = state.thread;
      state.appRuns = status === "app-owned";
      state.updatedAt = "2026-10-22T12:00:00.000Z";
      state.messages.push({ ...message("New CLI reply"), createdAt: state.updatedAt });
      state.sourceSize++;
      yield* importer.importRecentAgentThreads({ projectId, scope: "all-local" });
      expect(state.thread?.settledAt).toEqual(previous.settledAt);
      expect(state.thread?.settledOverride).toBe(previous.settledOverride);
      expect(state.thread?.unsettledAt).toEqual(previous.unsettledAt);
      expect(state.thread?.pinnedAt).toEqual(previous.pinnedAt);
      expect(state.thread?.snoozedUntil).toEqual(previous.snoozedUntil);
      if (status === "app-owned") expect(state.persisted.size).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);
