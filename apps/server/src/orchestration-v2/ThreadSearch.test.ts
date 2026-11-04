import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationSearchThreadHistoryResult,
  type OrchestrationThreadHistoryCursor,
  type OrchestrationV2DomainEvent,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

const layerTest = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

// Small enough that a test conversation outgrows one request.
const layerSmallBudget = Layer.mergeAll(
  ThreadSearch.layerWithOptions({ historyMessageBudget: 40, historyMessageBatch: 15 }),
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: {
    readonly archivedAt?: DateTime.Utc;
    readonly deletedAt?: DateTime.Utc;
    readonly updatedAt?: DateTime.Utc;
    readonly title?: string;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly historyOrigin?: "v1_import";
    readonly subagentOf?: ThreadId;
  } = {},
): OrchestrationV2DomainEvent => {
  const instanceId = overrides.providerInstanceId ?? providerInstanceId;
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created",
    threadId,
    providerInstanceId: instanceId,
    occurredAt: at(0),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: overrides.title ?? threadId,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      ...(overrides.historyOrigin === undefined ? {} : { historyOrigin: overrides.historyOrigin }),
      lineage:
        overrides.subagentOf === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
          : {
              parentThreadId: overrides.subagentOf,
              relationshipToParent: "subagent",
              rootThreadId: overrides.subagentOf,
            },
      forkedFrom: null,
      createdAt: at(0),
      updatedAt: overrides.updatedAt ?? at(0),
      archivedAt: overrides.archivedAt ?? null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: overrides.deletedAt ?? null,
    },
  };
};

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: { readonly minute?: number; readonly streaming?: boolean } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

it.layer(layerTest)("ThreadSearch", (it) => {
  it.effect("returns one finished user or assistant match per active thread", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search");
      const deletedProject = ProjectId.make("project:search-deleted");
      yield* createProject(project);
      yield* createProject(deletedProject);
      yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
        projects.apply({
          sequence: 0,
          eventId: EventId.make("deleted:project"),
          aggregateKind: "project",
          aggregateId: deletedProject,
          occurredAt: DateTime.formatIso(at(2)),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: deletedProject, deletedAt: DateTime.formatIso(at(2)) },
        }),
      );

      const both = ThreadId.make("thread:both");
      const assistantOnly = ThreadId.make("thread:assistant");
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        thread(both, project),
        message(both, "both-assistant", "assistant", "needle from the answer", { minute: 3 }),
        message(both, "both-user-old", "user", "older needle question", { minute: 1 }),
        message(both, "both-user-new", "user", "newer needle question", { minute: 2 }),
        thread(assistantOnly, project),
        message(assistantOnly, "assistant-only", "assistant", "needle in an answer"),
        message(assistantOnly, "assistant-streaming", "user", "needle still typing", {
          streaming: true,
        }),
        message(assistantOnly, "assistant-system", "system", "needle system prompt"),
        thread(ThreadId.make("thread:archived"), project, { archivedAt: at(1) }),
        message(ThreadId.make("thread:archived"), "archived", "user", "needle archived"),
        thread(ThreadId.make("thread:deleted"), project, { deletedAt: at(1) }),
        message(ThreadId.make("thread:deleted"), "deleted", "user", "needle deleted"),
        thread(ThreadId.make("thread:orphaned"), deletedProject),
        message(ThreadId.make("thread:orphaned"), "orphaned", "user", "needle orphaned"),
      ];
      yield* Effect.forEach(events, projections.apply, { discard: true });

      const result = yield* search.search({ query: "NEEDLE", limit: 20 });
      assert.deepEqual(
        result.matches.map((match) => [match.threadId, match.source, match.snippet]),
        [
          [both, "user", "newer needle question"],
          [assistantOnly, "assistant", "needle in an answer"],
        ],
      );
      assert.lengthOf((yield* search.search({ query: "needle", limit: 1 })).matches, 1);
      // LIKE wildcards in the query match literally.
      assert.deepEqual((yield* search.search({ query: "ne%le" })).matches, []);
    }),
  );

  it.effect("reports an unreadable match as a decode failure", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-corrupt");
      const threadId = ThreadId.make("thread:corrupt");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "corrupt", "user", "20260927")],
        projections.apply,
        { discard: true },
      );
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.text', 20260927)
        WHERE message_id = 'corrupt'
      `;

      const error = yield* Effect.flip(search.search({ query: "0260927" }));
      assert.equal(error.operation, "decode");
    }),
  );

  it.effect("lists history newest first, archived threads included, with first prompts", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:history-list");
      yield* createProject(project);
      const stark = ThreadId.make("thread:history-stark");
      const archived = ThreadId.make("thread:history-archived");
      const imported = ThreadId.make("import:claudeAgent:6f1c2f0e-3b7a-4c55-9d7e-1a2b3c4d5e6f");
      const migrated = ThreadId.make("thread:history-v1");
      const longPrompt = `Plan   the\nrelease ${"x".repeat(400)}`;
      // Messages first: each message event moves its thread's updated time.
      yield* Effect.forEach(
        [
          message(stark, "stark-assistant", "assistant", "Done", { minute: 3 }),
          message(stark, "stark-user-late", "user", "Second question", { minute: 4 }),
          message(stark, "stark-user-first", "user", longPrompt, { minute: 2 }),
          thread(stark, project, { updatedAt: at(40) }),
          message(archived, "archived-user", "user", "Archived work"),
          thread(archived, project, { updatedAt: at(30), archivedAt: at(31) }),
          thread(imported, project, {
            updatedAt: at(20),
            historyOrigin: "v1_import",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          }),
          thread(migrated, project, { updatedAt: at(10), historyOrigin: "v1_import" }),
          thread(ThreadId.make("thread:history-deleted"), project, {
            updatedAt: at(50),
            deletedAt: at(50),
          }),
          thread(ThreadId.make("thread:history-child"), project, {
            updatedAt: at(50),
            subagentOf: stark,
          }),
        ],
        projections.apply,
        { discard: true },
      );

      const result = yield* search.searchHistory({ projectIds: [project] });
      assert.deepEqual(
        result.entries.map((entry) => [entry.threadId, entry.origin, entry.archivedAt !== null]),
        [
          [stark, "stark", false],
          [archived, "stark", true],
          [imported, "agent-session", false],
          [migrated, "v1", false],
        ],
      );
      assert.isNull(result.nextCursor);
      const first = result.entries[0]!;
      assert.lengthOf(first.firstPrompt ?? "", 240);
      assert.isTrue(first.firstPrompt?.startsWith("Plan the release xx"));
      assert.isNull(first.match);
      assert.equal(result.entries[1]?.firstPrompt, "Archived work");
      assert.isNull(result.entries[2]?.firstPrompt);
    }),
  );

  it.effect("filters history by status, origin, provider, folder and date", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:history-filters");
      const otherProject = ProjectId.make("project:history-filters-other");
      yield* createProject(project);
      yield* createProject(otherProject);
      const claude = ProviderInstanceId.make("claudeAgent");
      const active = ThreadId.make("thread:filters-active");
      const archived = ThreadId.make("thread:filters-archived");
      const imported = ThreadId.make("import:claudeAgent:filters-session");
      const elsewhere = ThreadId.make("thread:filters-elsewhere");
      yield* Effect.forEach(
        [
          thread(active, project, { updatedAt: at(40) }),
          thread(archived, project, { updatedAt: at(30), archivedAt: at(30) }),
          thread(imported, project, {
            updatedAt: at(5),
            historyOrigin: "v1_import",
            providerInstanceId: claude,
          }),
          thread(elsewhere, otherProject, { updatedAt: at(45) }),
        ],
        projections.apply,
        { discard: true },
      );
      const ids = (input: Parameters<typeof search.searchHistory>[0]) =>
        search
          .searchHistory({ projectIds: [project, otherProject], ...input })
          .pipe(Effect.map((result) => result.entries.map((entry) => entry.threadId)));

      assert.deepEqual(yield* ids({ archived: "exclude" }), [elsewhere, active, imported]);
      assert.deepEqual(yield* ids({ archived: "only" }), [archived]);
      assert.deepEqual(yield* ids({ origins: ["agent-session"] }), [imported]);
      assert.deepEqual(yield* ids({ origins: ["stark", "v1"] }), [elsewhere, active, archived]);
      assert.deepEqual(yield* ids({ providerInstanceIds: [claude] }), [imported]);
      assert.deepEqual(yield* ids({ projectIds: [otherProject] }), [elsewhere]);
      assert.deepEqual(yield* ids({ updatedAfter: DateTime.formatIso(at(30)) }), [
        elsewhere,
        active,
        archived,
      ]);
    }),
  );

  it.effect("matches titles before messages and searches archived threads", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:history-query");
      yield* createProject(project);
      const titled = ThreadId.make("thread:query-title");
      const archived = ThreadId.make("thread:query-archived");
      const unrelated = ThreadId.make("thread:query-unrelated");
      yield* Effect.forEach(
        [
          message(titled, "titled-user", "user", "Something else entirely"),
          thread(titled, project, { updatedAt: at(20), title: "Fix the Comet build" }),
          message(archived, "archived-assistant", "assistant", "The comet answer"),
          message(archived, "archived-user", "user", "Where is the comet?", { minute: 2 }),
          thread(archived, project, { updatedAt: at(10), archivedAt: at(11) }),
          message(unrelated, "unrelated-user", "user", "Nothing to see"),
          thread(unrelated, project, { updatedAt: at(30) }),
        ],
        projections.apply,
        { discard: true },
      );

      const result = yield* search.searchHistory({ query: "COMET", projectIds: [project] });
      assert.deepEqual(
        result.entries.map((entry) => [entry.threadId, entry.match?.source, entry.match?.snippet]),
        [
          [titled, "title", "Fix the Comet build"],
          [archived, "user", "Where is the comet?"],
        ],
      );
      assert.isNull(result.nextCursor);
      assert.deepEqual(
        (yield* search.searchHistory({ query: "co%et", projectIds: [project] })).entries,
        [],
      );
    }),
  );

  it.effect("pages threads updated at the same instant without skipping any", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:history-ties");
      yield* createProject(project);
      const threadIds = Array.from({ length: 5 }, (_, index) =>
        ThreadId.make(`thread:tie-${index}`),
      );
      yield* Effect.forEach(
        threadIds.map((threadId) => thread(threadId, project, { updatedAt: at(7) })),
        projections.apply,
        { discard: true },
      );

      const seen: Array<ThreadId> = [];
      let cursor: OrchestrationThreadHistoryCursor | null = null;
      for (let page = 0; page < 5; page += 1) {
        const result: OrchestrationSearchThreadHistoryResult = yield* search.searchHistory({
          projectIds: [project],
          limit: 2,
          ...(cursor === null ? {} : { after: cursor }),
        });
        seen.push(...result.entries.map((entry) => entry.threadId));
        cursor = result.nextCursor;
        if (cursor === null) break;
      }
      assert.deepEqual(seen, threadIds.toReversed());
    }),
  );

  it.effect("returns a cursor instead of reading every thread for a rare query", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:history-budget");
      yield* createProject(project);
      const match = ThreadId.make("thread:budget-match");
      yield* projections.apply(thread(match, project, { updatedAt: at(1), title: "rare needle" }));
      // Newer threads that do not match fill more than one request's scan.
      yield* Effect.forEach(
        Array.from({ length: 1_020 }, (_, index) =>
          thread(ThreadId.make(`thread:budget-${String(index).padStart(4, "0")}`), project, {
            updatedAt: at(2),
          }),
        ),
        projections.apply,
        { discard: true },
      );

      const first = yield* search.searchHistory({ query: "rare needle", projectIds: [project] });
      assert.deepEqual(first.entries, []);
      assert.isNotNull(first.nextCursor);
      const second = yield* search.searchHistory({
        query: "rare needle",
        projectIds: [project],
        after: first.nextCursor!,
      });
      assert.deepEqual(
        second.entries.map((entry) => entry.threadId),
        [match],
      );
      assert.isNull(second.nextCursor);
    }),
  );

  it.effect("answers an ordinary history in one request", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:history-ordinary");
      yield* createProject(project);
      // 120 threads of six messages span three statements of threads.
      const threadIds = Array.from({ length: 120 }, (_, index) =>
        ThreadId.make(`thread:ordinary-${String(index).padStart(3, "0")}`),
      );
      yield* Effect.forEach(
        threadIds.flatMap((threadId, index) => [
          ...Array.from({ length: 6 }, (_, position) =>
            message(
              threadId,
              `${threadId}-${position}`,
              position % 2 === 0 ? "user" : "assistant",
              index % 3 === 0 && position === 4 ? "the ordinary needle" : `message ${position}`,
              { minute: position + 1 },
            ),
          ),
          thread(threadId, project, { updatedAt: at(10 + index) }),
        ]),
        projections.apply,
        { discard: true },
      );

      const result = yield* search.searchHistory({
        query: "ordinary needle",
        projectIds: [project],
        limit: 50,
      });
      assert.deepEqual(
        result.entries.map((entry) => entry.threadId),
        threadIds.filter((_, index) => index % 3 === 0).toReversed(),
      );
      assert.isNull(result.nextCursor);
    }),
  );
});

it.layer(layerSmallBudget)("ThreadSearch with a small message budget", (it) => {
  it.effect("reads a conversation longer than the message budget across requests", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:history-long");
      yield* createProject(project);
      const newest = ThreadId.make("thread:long-newest");
      const long = ThreadId.make("thread:long");
      const oldest = ThreadId.make("thread:long-oldest");
      const longId = (index: number) => `long-${String(index).padStart(3, "0")}`;
      yield* Effect.forEach(
        [
          message(newest, "newest-user", "user", "Find the needle"),
          message(newest, "newest-assistant", "assistant", "Looking", { minute: 2 }),
          message(newest, "newest-system", "system", "System prompt", { minute: 3 }),
          thread(newest, project, { updatedAt: at(500) }),
          // 100 messages; only long-040, the 60th newest, matches.
          ...Array.from({ length: 100 }, (_, index) =>
            message(
              long,
              longId(index),
              index % 2 === 0 ? "user" : "assistant",
              index === 40 ? "a needle deep in the conversation" : `step ${index}`,
              { minute: index + 1 },
            ),
          ),
          thread(long, project, { updatedAt: at(400) }),
          message(oldest, "oldest-user", "user", "Another needle"),
          thread(oldest, project, { updatedAt: at(300) }),
        ],
        projections.apply,
        { discard: true },
      );
      const page = (after?: OrchestrationThreadHistoryCursor) =>
        search.searchHistory({
          query: "needle",
          projectIds: [project],
          ...(after === undefined ? {} : { after }),
        });

      const first = yield* page();
      assert.deepEqual(
        first.entries.map((entry) => entry.threadId),
        [newest],
      );
      // The newest thread's three messages and 37 of the long one's spend the
      // budget of 40, so the scan stops inside the long thread at long-063.
      assert.deepEqual(first.nextCursor, {
        updatedAt: DateTime.formatIso(at(400)),
        threadId: long,
        beforeMessage: {
          createdAt: DateTime.formatIso(at(64)),
          messageId: MessageId.make(longId(63)),
        },
      });

      const second = yield* page(first.nextCursor!);
      assert.deepEqual(
        second.entries.map((entry) => [entry.threadId, entry.match?.source, entry.match?.snippet]),
        [
          [long, "user", "a needle deep in the conversation"],
          [oldest, "user", "Another needle"],
        ],
      );
      assert.isNull(second.nextCursor);
    }),
  );

  it.effect("reads threads that together outgrow one statement without losing order", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:history-split");
      yield* createProject(project);
      // Six threads of six messages: within the budget, beyond one statement.
      const threadIds = Array.from({ length: 6 }, (_, index) =>
        ThreadId.make(`thread:split-${index}`),
      );
      const matching = new Set([0, 3, 5]);
      yield* Effect.forEach(
        threadIds.flatMap((threadId, index) => [
          ...Array.from({ length: 6 }, (_, position) =>
            message(
              threadId,
              `${threadId}-${position}`,
              "user",
              matching.has(index) && position === 2 ? "split needle" : `message ${position}`,
              { minute: position + 1 },
            ),
          ),
          thread(threadId, project, { updatedAt: at(100 - index) }),
        ]),
        projections.apply,
        { discard: true },
      );

      const result = yield* search.searchHistory({ query: "needle", projectIds: [project] });
      assert.deepEqual(
        result.entries.map((entry) => entry.threadId),
        [threadIds[0], threadIds[3], threadIds[5]],
      );
      assert.isNull(result.nextCursor);
    }),
  );
});
