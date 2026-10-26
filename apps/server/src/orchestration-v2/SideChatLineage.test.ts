import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const projectId = ProjectId.make("side-chat-project");
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Side-chat lineage tests never start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "side-chat-lineage" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
const create = (
  id: string,
  extra: Partial<Extract<OrchestrationV2Command, { type: "thread.create" }>> = {},
) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${id}`),
  threadId: ThreadId.make(id),
  projectId,
  title: id,
  modelSelection,
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
  ...extra,
});
const attach = (child: string, parent: string | null, command = `link:${child}:${parent}`) => ({
  type: "thread.metadata.update" as const,
  commandId: CommandId.make(command),
  threadId: ThreadId.make(child),
  sideChatParentThreadId: parent === null ? null : ThreadId.make(parent),
});

it.effect(
  "persists side-chat identity in the creation event, SQL shell and fresh event replay",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* orchestrator.dispatch(create("parent"));
      const child = yield* orchestrator.dispatch(
        create("child", { sideChatParentThreadId: ThreadId.make("parent") }),
      );
      const expected = {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "side_chat" as const,
        rootThreadId: ThreadId.make("parent"),
      };
      assert.equal(child.storedEvents[0]?.event.type, "thread.created");
      assert.deepEqual((yield* projections.getThread(ThreadId.make("child"))).lineage, expected);
      assert.deepEqual(
        (yield* projections.getThreadShell(ThreadId.make("child")))?.lineage,
        expected,
      );
      const replayed = yield* Effect.gen(function* () {
        const fresh = yield* ProjectionStore.ProjectionStoreV2;
        for (const stored of [...parent.storedEvents, ...child.storedEvents])
          yield* fresh.apply(stored.event);
        return yield* fresh.getThread(ThreadId.make("child"));
      }).pipe(Effect.provide(ProjectionStore.layerMemory));
      assert.deepEqual(replayed.lineage, expected);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        parent: string;
      }>`SELECT json_extract(payload_json, '$.lineage.parentThreadId') AS parent FROM orchestration_v2_projection_threads WHERE thread_id = 'child'`;
      assert.equal(rows[0]?.parent, "parent");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "links existing archived chats without changing messages, native references, modes or timestamps; retries are idempotent",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch(create("parent"));
      yield* orchestrator.dispatch(
        create("legacy", {
          importedNativeThread: {
            ref: {
              driver: adapter.driver,
              nativeId: "existing-native-session",
              strength: "strong",
            },
          },
        }),
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("existing-message"),
        threadId: ThreadId.make("legacy"),
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("saved-question"),
        text: "Keep this question",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-legacy"),
        threadId: ThreadId.make("legacy"),
      });
      const before = yield* projections.getThreadProjection(ThreadId.make("legacy"));
      const first = yield* orchestrator.dispatch(attach("legacy", "parent"));
      const retry = yield* orchestrator.dispatch(attach("legacy", "parent"));
      assert.equal(retry.sequence, first.sequence);
      yield* orchestrator.dispatch(attach("legacy", "parent", "new-id-same-parent"));
      const after = yield* projections.getThreadProjection(ThreadId.make("legacy"));
      assert.deepEqual(after.messages, before.messages);
      assert.deepEqual(after.providerThreads, before.providerThreads);
      assert.deepEqual(after.thread, {
        ...before.thread,
        lineage: {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "side_chat",
          rootThreadId: ThreadId.make("parent"),
        },
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "reattaches a legacy subtree and makes it independent without losing its nested relationships",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch(create("parent"));
      yield* orchestrator.dispatch(create("legacy"));
      yield* orchestrator.dispatch(
        create("nested", { sideChatParentThreadId: ThreadId.make("legacy") }),
      );
      yield* orchestrator.dispatch(
        create("deep", { sideChatParentThreadId: ThreadId.make("nested") }),
      );
      const linked = yield* orchestrator.dispatch(attach("legacy", "parent"));
      assert.equal(linked.storedEvents.length, 3);
      assert.deepEqual((yield* projections.getThread(ThreadId.make("deep"))).lineage, {
        parentThreadId: ThreadId.make("nested"),
        relationshipToParent: "side_chat",
        rootThreadId: ThreadId.make("parent"),
      });
      yield* orchestrator.dispatch(attach("legacy", null));
      assert.deepEqual((yield* projections.getThread(ThreadId.make("legacy"))).lineage, {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make("legacy"),
      });
      assert.deepEqual((yield* projections.getThread(ThreadId.make("deep"))).lineage, {
        parentThreadId: ThreadId.make("nested"),
        relationshipToParent: "side_chat",
        rootThreadId: ThreadId.make("legacy"),
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "refuses cross-project, missing, self, cyclic and conflicting parent links without mutating existing chats",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch(create("parent"));
      yield* orchestrator.dispatch(create("other"));
      yield* orchestrator.dispatch(
        create("foreign", { projectId: ProjectId.make("another-project") }),
      );
      yield* orchestrator.dispatch(
        create("child", { sideChatParentThreadId: ThreadId.make("parent") }),
      );
      const before = yield* projections.getThread(ThreadId.make("child"));
      for (const command of [
        attach("child", "other"),
        attach("parent", "child"),
        attach("parent", "parent"),
        attach("other", "foreign"),
        attach("other", "missing"),
      ]) {
        assert.equal((yield* Effect.exit(orchestrator.dispatch(command)))._tag, "Failure");
      }
      assert.deepEqual(yield* projections.getThread(ThreadId.make("child")), before);
      assert.equal(
        (yield* projections.getThread(ThreadId.make("parent"))).lineage.parentThreadId,
        null,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("serializes competing links so two concurrent requests cannot create a cycle", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch(create("one"));
    yield* orchestrator.dispatch(create("two"));
    const results = yield* Effect.all(
      [
        Effect.exit(orchestrator.dispatch(attach("one", "two"))),
        Effect.exit(orchestrator.dispatch(attach("two", "one"))),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(results.filter((result) => result._tag === "Success").length, 1);
    const one = yield* projections.getThread(ThreadId.make("one"));
    const two = yield* projections.getThread(ThreadId.make("two"));
    assert.notEqual(
      one.lineage.parentThreadId !== null && two.lineage.parentThreadId !== null,
      true,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.live(
  "restores migrated side chats, archive state and messages after closing and reopening the database",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "stark-side-chat-restart-" });
        const dbPath = `${directory}/statev2.sqlite`;
        const disk = SqlitePersistence.layerFromPath(dbPath).pipe(
          Layer.provide(NodeServices.layer),
        );
        const writeLayer = ProviderReplayHarness.layerWithRegistry(
          { name: "side-chat-restart" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: disk, runEffectWorker: false },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(create("restart-parent"));
          yield* orchestrator.dispatch(create("restart-legacy"));
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("restart-message"),
            threadId: ThreadId.make("restart-legacy"),
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("restart-question"),
            text: "Saved before restart",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("restart-archive"),
            threadId: ThreadId.make("restart-legacy"),
          });
          yield* orchestrator.dispatch(attach("restart-legacy", "restart-parent"));
        }).pipe(Effect.provide(writeLayer));
        // A new store and SQLite connection read the same file; no client map is involved.
        yield* Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const restored = yield* store.getThreadProjection(ThreadId.make("restart-legacy"));
          assert.equal(restored.thread.lineage.parentThreadId, ThreadId.make("restart-parent"));
          assert.equal(restored.thread.lineage.relationshipToParent, "side_chat");
          assert.isNotNull(restored.thread.archivedAt);
          assert.equal(restored.messages[0]?.text, "Saved before restart");
          const shell = yield* store.getShellSnapshot({ location: "archive" });
          assert.equal(
            shell.archivedThreads[0]?.lineage.parentThreadId,
            ThreadId.make("restart-parent"),
          );
        }).pipe(
          Effect.provide(
            ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerFromPath(dbPath))),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
