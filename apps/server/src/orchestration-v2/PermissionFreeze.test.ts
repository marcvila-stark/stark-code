/**
 * The startup permission freeze when storage misbehaves (PLAN-002 §2): a chat
 * it cannot freeze keeps startup from reaching recovery, a transient failure
 * is retried by the next run instead of being replayed as a rejection, and a
 * chat whose saved state cannot be decoded is quarantined, not left to block
 * every startup.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@starkfuture/contracts";
import type { ProviderInstance } from "@starkfuture/provider-core/server/driver";
import * as McpProviderSessions from "@starkfuture/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as PermissionFreeze from "./PermissionFreeze.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const claudeId = ProviderInstanceId.make("claudeAgent");
const projectId = ProjectId.make("project:permission-freeze");
const claudeSelection = {
  instanceId: claudeId,
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

const claudeInstance = {
  instanceId: claudeId,
  driverKind: ProviderDriverKind.make("claudeAgent"),
  continuationIdentity: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    continuationKey: "claudeAgent:permission-freeze",
  },
  displayName: "Claude test",
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed({
      supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto"],
    } as unknown as ServerProvider),
  } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: claudeId,
    driver: ProviderDriverKind.make("claudeAgent"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by permission freeze tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerPlatform = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "stark-permission-freeze-",
});

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
  RuntimePolicy.layerFromProjectStore.pipe(Layer.provide(ProjectStore.layer)),
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatform),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provideMerge(
    ServerSettings.layerTest({
      providerInstances: {
        [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), config: {} },
      },
    }),
  ),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === claudeId ? claudeInstance : undefined),
      listInstances: Effect.succeed([claudeInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provide(layerPlatform),
);

/** A Claude chat saved before permission sources, at a mode it never ran. */
const writeLegacyThread = (threadId: ThreadId, runtimeMode: RuntimeMode) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Legacy chat",
      providerInstanceId: claudeId,
      modelSelection: claudeSelection,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace/permission-freeze",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`legacy:${threadId}`),
          type: "thread.created",
          threadId,
          providerInstanceId: claudeId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
  });

const threadOf = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections.getThread(threadId),
  );

/**
 * A freeze whose own reads of `threadId` call `onRead` with the read's number
 * first, so a test can change storage between the freeze's read and the
 * orchestrator's.
 */
const freezeWithReadHook = (
  threadId: ThreadId,
  onRead: (read: number) => Effect.Effect<void, never, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const sql = yield* SqlClient.SqlClient;
    const hooked = Layer.effect(
      ProjectionStore.ProjectionStoreV2,
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        return ProjectionStore.ProjectionStoreV2.of({
          ...projections,
          getThread: (id) =>
            id !== threadId
              ? projections.getThread(id)
              : Ref.updateAndGet(reads, (count) => count + 1).pipe(
                  Effect.flatMap((read) =>
                    read === 1
                      ? // The freeze reads first, then the hook breaks storage.
                        projections
                          .getThread(id)
                          .pipe(
                            Effect.tap(() =>
                              onRead(read).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
                            ),
                          )
                      : onRead(read).pipe(
                          Effect.provideService(SqlClient.SqlClient, sql),
                          Effect.andThen(projections.getThread(id)),
                        ),
                  ),
                ),
        });
      }),
    );
    return yield* Effect.gen(function* () {
      return yield* PermissionFreeze.PermissionFreeze;
      // Fresh: the shared test layer already built the freeze over the plain store.
    }).pipe(Effect.provide(Layer.fresh(PermissionFreeze.layer).pipe(Layer.provide(hooked))));
  });

it.layer(layerTest)("permission freeze failures", (it) => {
  it.effect("blocks startup on a chat it could not freeze and retries it on the next run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:freeze-transient");
      yield* writeLegacyThread(threadId, "full-access");
      // After the freeze's first read the thread table goes away, so the
      // orchestrator's own read fails and records a rejected command; the
      // freeze's next read brings it back.
      const freeze = yield* freezeWithReadHook(threadId, (read) =>
        read === 1
          ? sql`ALTER TABLE orchestration_v2_projection_threads RENAME TO projection_threads_offline`.pipe(
              Effect.orDie,
            )
          : read === 2
            ? sql`ALTER TABLE projection_threads_offline RENAME TO orchestration_v2_projection_threads`.pipe(
                Effect.orDie,
              )
            : Effect.void,
      );

      const failed = yield* freeze.run().pipe(Effect.flip);
      assert.equal(failed._tag, "PermissionFreezeError");
      assert.equal(failed.stage, "migrate-threads");
      assert.deepStrictEqual(failed.threadIds, [threadId]);
      assert.include(failed.message, "recovery waits until they are frozen");
      assert.equal((yield* threadOf(threadId)).runtimeMode, "full-access");
      const rejected = yield* sql<{ readonly status: string }>`
        SELECT status FROM orchestration_command_receipts
        WHERE command_id LIKE ${`permission-freeze:perm-v1:${threadId}:%`}
      `;
      assert.deepStrictEqual(rejected, [{ status: "rejected" }]);

      // The next startup is not handed the earlier rejection.
      assert.deepStrictEqual(yield* freeze.run(), {
        migratedThreadCount: 1,
        migratedScheduledTaskCount: 0,
        failedThreadCount: 0,
      });
      const frozen = yield* threadOf(threadId);
      assert.equal(frozen.runtimeMode, "approval-required");
      assert.deepStrictEqual(
        frozen.permissionMigrations?.map((entry) => entry.migrationId),
        ["perm-v1"],
      );
      // A successful migration stays done: a third run dispatches nothing.
      assert.equal((yield* freeze.run()).migratedThreadCount, 0);
    }),
  );

  it.effect(
    "quarantines a chat whose saved state cannot be read, then freezes it once it can",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread:freeze-unreadable");
        yield* writeLegacyThread(threadId, "full-access");
        const [saved] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
        yield* sql`
        UPDATE orchestration_v2_projection_threads SET payload_json = '{"unreadable":true}'
        WHERE thread_id = ${threadId}
      `;
        const freeze = yield* PermissionFreeze.PermissionFreeze;
        // Startup goes on: nothing can run the chat while it cannot be read.
        assert.equal((yield* freeze.run()).failedThreadCount, 1);
        const audit = yield* sql<{
          readonly subject_kind: string;
          readonly from_runtime_mode: string;
          readonly reason: string;
        }>`
        SELECT subject_kind, from_runtime_mode, reason FROM permission_migration_audit
        WHERE subject_id = ${threadId}
      `;
        assert.deepStrictEqual(audit, [
          {
            subject_kind: "thread",
            from_runtime_mode: "full-access",
            reason: PermissionFreeze.PERMISSION_FREEZE_QUARANTINE_REASON,
          },
        ]);

        yield* sql`
        UPDATE orchestration_v2_projection_threads SET payload_json = ${saved!.payload_json}
        WHERE thread_id = ${threadId}
      `;
        assert.equal((yield* freeze.run()).migratedThreadCount, 1);
        assert.equal((yield* threadOf(threadId)).runtimeMode, "approval-required");
      }),
  );
});
