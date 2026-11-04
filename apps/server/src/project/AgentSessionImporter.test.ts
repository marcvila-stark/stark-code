import { assert, expect, it } from "@effect/vitest";
import {
  agentSessionImportThreadId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type AgentSessionImportSource,
  type OrchestrationV2DomainEvent,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";
import * as LocalAgentHistoryStore from "./LocalAgentHistoryStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);
assert.equal(threadId, agentSessionImportThreadId({ providerInstanceId, providerSessionId }));
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

interface Session {
  readonly source: AgentSessionImportSource;
  readonly thread: AgentSessionScanner.AgentSessionThread;
}

const session = (
  provider: AgentSessionImportSource["provider"],
  instanceId: ProviderInstanceId,
  sessionId: string,
  messages: AgentSessionScanner.AgentSessionThread["messages"] = [
    { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
    { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
  ],
): Session => ({
  source: {
    provider,
    providerInstanceId: instanceId,
    providerSessionId: sessionId,
    filePath: `/tmp/${sessionId}.jsonl`,
    size: 100,
    mtimeMs: 2,
    device: 3,
    inode: 4,
    birthtimeMs: 1,
  },
  thread: {
    source: provider,
    providerInstanceId: instanceId,
    providerSessionId: sessionId,
    title: "Imported thread",
    model: provider === "codex" ? "gpt-5.4" : null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:01:00.000Z",
    messages,
  },
});

/** A provider thread Stark ran for one of its own threads. */
const starkProviderThread = (input: {
  readonly appThreadId: ThreadId;
  readonly driver: AgentSessionImportSource["provider"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeId: string;
}): OrchestrationV2DomainEvent => {
  const driver = ProviderDriverKind.make(input.driver);
  const at = DateTime.makeUnsafe("2026-09-01T09:00:00.000Z");
  const id = ProviderThreadId.make(`provider-thread:${input.appThreadId}`);
  return {
    id: EventId.make(`provider-thread:${input.appThreadId}`),
    type: "provider-thread.updated",
    threadId: input.appThreadId,
    driver,
    providerInstanceId: input.providerInstanceId,
    occurredAt: at,
    payload: {
      id,
      driver,
      providerInstanceId: input.providerInstanceId,
      providerSessionId: null,
      appThreadId: input.appThreadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: input.nativeId, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: at,
      updatedAt: at,
    },
  };
};

/**
 * The importer over a real projection database. The scanner offers `sessions`
 * and, like the real one, asks whether Stark ran each before offering it.
 */
const makeLayerTest = (input: {
  readonly sessions: ReadonlyArray<Session>;
  readonly writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>>;
  readonly upserts?: Array<unknown>;
  readonly recorded?: Array<unknown>;
}) => {
  const importedThreadIds = new Set<ThreadId>();
  return AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AgentSessionScanner.AgentSessionScanner,
          AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            allThreads: () => Stream.die("unused"),
            recentThreads: (_workspaceRoot, _completedSources, ranInStark = () => false) =>
              Stream.fromIterable(
                input.sessions.map(
                  ({ source, thread }): AgentSessionScanner.AgentSessionRecentThread =>
                    ranInStark(source)
                      ? { _tag: "RanInStark" }
                      : { _tag: "Importable", source, thread },
                ),
              ),
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (id) =>
            importedThreadIds.has(id)
              ? Effect.succeed({ thread: { id, projectId, historyOrigin: "v1_import" } } as never)
              : Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({
                    threadId: id,
                    cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                  }),
                ),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (write) =>
            Effect.sync(() => {
              input.writes.push(write.events);
              for (const event of write.events) {
                if (event.type === "thread.created") importedThreadIds.add(event.threadId);
              }
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (upsert) => Effect.sync(() => void input.upserts?.push(upsert)),
          recordImportedTranscript: (record) =>
            Effect.sync(() => void input.recorded?.push(record)),
        }),
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        Layer.succeed(LocalAgentHistoryStore.LocalAgentHistoryStore, {
          owners: Effect.succeed([]),
          activeNativeDirectories: Effect.succeed([]),
        }),
      ),
    ),
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
};

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
      alreadyImportedCount: 0,
      alreadyRunByStarkCount: 0,
    });
    // The imported thread's own provider thread holds the same native session,
    // and does not make the session one Stark ran.
    yield* Effect.forEach(writes[0] ?? [], projections.apply, { discard: true });
    // importedCount keeps its old meaning, so the second run reports the
    // session again; alreadyImportedCount shows nothing new was added.
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
      alreadyImportedCount: 1,
      alreadyRunByStarkCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(
    Effect.provide(
      makeLayerTest({
        sessions: [session("codex", providerInstanceId, providerSessionId)],
        writes,
        upserts,
        recorded,
      }),
    ),
  );
});

it.effect("leaves out Claude and Codex sessions Stark ran for its own threads", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const claudeStarkSession = "6f1c2f0e-3b7a-4c55-9d7e-1a2b3c4d5e6f";
  const claudeCliSession = "0b8e4f6a-1c2d-4e3f-8a9b-7c6d5e4f3a2b";
  const codexStarkSession = "codex-thread-from-stark";

  return Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply(
      starkProviderThread({
        appThreadId: ThreadId.make("thread:update-farewell-greeting"),
        driver: "claudeAgent",
        providerInstanceId: claudeInstanceId,
        nativeId: claudeStarkSession,
      }),
    );
    yield* projections.apply(
      starkProviderThread({
        appThreadId: ThreadId.make("thread:in-another-project"),
        driver: "codex",
        providerInstanceId,
        nativeId: codexStarkSession,
      }),
    );
    // A Codex thread with the Claude session's id is not the Claude session.
    yield* projections.apply(
      starkProviderThread({
        appThreadId: ThreadId.make("thread:codex-same-id"),
        driver: "codex",
        providerInstanceId,
        nativeId: claudeCliSession,
      }),
    );

    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
      alreadyImportedCount: 0,
      alreadyRunByStarkCount: 2,
    });
    expect(
      writes.flatMap((events) =>
        events.flatMap((event) => (event.type === "thread.created" ? [event.threadId] : [])),
      ),
    ).toEqual([
      agentSessionImportThreadId({
        providerInstanceId: claudeInstanceId,
        providerSessionId: claudeCliSession,
      }),
    ]);
  }).pipe(
    Effect.provide(
      makeLayerTest({
        sessions: [
          session("claudeAgent", claudeInstanceId, claudeStarkSession),
          session("codex", providerInstanceId, codexStarkSession),
          session("claudeAgent", claudeInstanceId, claudeCliSession),
        ],
        writes,
      }),
    ),
  );
});

it.effect("names a session after the person's first prompt, not Stark's context", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const sessionId = "6f1c2f0e-3b7a-4c55-9d7e-1a2b3c4d5e6f";
  const record = (timestamp: string, type: "user" | "assistant", text: string) =>
    JSON.stringify({
      type,
      sessionId,
      timestamp,
      message: { role: type, content: [{ type: "text", text }] },
    });
  const thread = AgentSessionScanner.parseAgentSessionTranscript({
    contents: [
      record(
        "2026-09-01T10:00:00.000Z",
        "user",
        "<stark_code_preview_browser>Stark's preview browser is not installed, so `html_preview` cannot screenshot pages.</stark_code_preview_browser>",
      ),
      record("2026-09-01T10:00:30.000Z", "user", "Update the farewell greeting"),
      record("2026-09-01T10:01:00.000Z", "assistant", "Updated"),
    ].join("\n"),
    source: "claudeAgent",
    providerInstanceId: claudeInstanceId,
    fallbackSessionId: sessionId,
    lastActiveAtMs: Date.parse("2026-09-01T10:01:00.000Z"),
  });
  assert.isNotNull(thread);

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect((yield* importer.importRecentAgentThreads({ projectId })).importedCount).toBe(1);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    expect(created?.payload).toMatchObject({ title: "Update the farewell greeting" });
    // History previews the first user message, so it must be the person's.
    expect(
      writes[0]?.flatMap((event) =>
        event.type === "message.updated" ? [[event.payload.role, event.payload.text]] : [],
      ),
    ).toEqual([
      ["user", "Update the farewell greeting"],
      ["assistant", "Updated"],
    ]);
  }).pipe(
    Effect.provide(
      makeLayerTest({
        sessions: [{ ...session("claudeAgent", claudeInstanceId, sessionId), thread }],
        writes,
      }),
    ),
  );
});
