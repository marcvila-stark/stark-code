/**
 * The startup permission freeze and every chat mutation that stores a mode,
 * against the real orchestrator, projections and event store.
 *
 * Covers the silent-widening cases D0 owns (PLAN-002 §6): legacy records
 * without a source stay `override`; a dormant Claude full-access chat stays
 * frozen after the account allows Bypass, across restarts and rebuilds;
 * provider switches cannot restore broader authority; persistent decisions
 * and widening need settings-write.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isOpenLostRuntimeRequest } from "@starkfuture/shared/orchestrationV2LostRequests";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  type ModelSelection,
  type PermissionSource,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalOption,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
  TurnItemId,
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
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as BypassOptOut from "./BypassOptOut.ts";
import { DispatchSettingsWrite } from "./DispatchSettingsWrite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as PermissionFreeze from "./PermissionFreeze.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:permission-migration");
const claudeSelection = {
  instanceId: claudeId,
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const codexSelection = { instanceId: codexId, model: "gpt-5.5" } satisfies ModelSelection;

// Whether the Claude account currently allows Bypass, as its live snapshot says.
const bypassAllowed = Ref.makeUnsafe(false);
const claudeInherits = Ref.makeUnsafe(false);

const adapterFor = (instanceId: ProviderInstanceId, driver: ProviderDriverKind) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by permission tests"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const instanceFor = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  snapshot: Effect.Effect<ServerProvider>,
) =>
  ({
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: `${driver}:permission-test` },
    displayName: `${driver} test`,
    enabled: true,
    snapshot: { getSnapshot: snapshot } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: adapterFor(instanceId, driver),
    textGeneration: {} as ProviderInstance["textGeneration"],
  }) satisfies ProviderInstance;

const claudeInstance = instanceFor(
  claudeId,
  ProviderDriverKind.make("claudeAgent"),
  Effect.all([Ref.get(bypassAllowed), Ref.get(claudeInherits)]).pipe(
    Effect.map(
      ([allowed, inherits]) =>
        ({
          nativePermissionInherit: inherits,
          supportedRuntimeModes: [
            "approval-required",
            "auto-accept-edits",
            "auto",
            ...(allowed ? (["full-access"] as const) : []),
          ],
        }) as unknown as ServerProvider,
    ),
  ),
);
const codexInstance = instanceFor(
  codexId,
  ProviderDriverKind.make("codex"),
  Effect.succeed({} as ServerProvider),
);
// A Codex instance that can follow Codex's own settings (D2's snapshot).
const codexInheritId = ProviderInstanceId.make("codex_inherit");
const codexInheritInstance = instanceFor(
  codexInheritId,
  ProviderDriverKind.make("codex"),
  Effect.succeed({
    supportedRuntimeModes: ["approval-required"],
    nativePermissionInherit: true,
  } as unknown as ServerProvider),
);
const registeredInstances = [claudeInstance, codexInstance, codexInheritInstance];

const layerRegistry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(registeredInstances.find((i) => i.instanceId === instanceId)),
  listInstances: Effect.succeed(registeredInstances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const layerPlatform = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "stark-permission-migration-",
});
const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerServerConfig),
      Layer.provide(layerPlatform),
    ),
  ),
);

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
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerServerConfig),
  Layer.provideMerge(
    ServerSettings.layerTest({
      providerInstances: {
        [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), config: {} },
      },
    }),
  ),
  Layer.provide(layerRegistry),
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

/** A `thread.created` event as servers before permission sources wrote it. */
const writeLegacyThread = (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Legacy chat",
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace/permission-migration",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
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
          id: EventId.make(`legacy:${input.threadId}`),
          type: "thread.created",
          threadId: input.threadId,
          providerInstanceId: input.modelSelection.instanceId,
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

const causeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "cause" in error ? error.cause : error;

const eventCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events
  `;
  return rows[0]?.count ?? 0;
});

const allowBypass = (allowed: boolean) =>
  Effect.gen(function* () {
    yield* Ref.set(bypassAllowed, allowed);
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { allowBypassPermissions: allowed },
        },
      },
    });
  });

it.layer(layerTest)("permission freeze and mutation paths", (it) => {
  it.effect("freezes saved chats to what they ran, once, and keeps them frozen", () =>
    Effect.gen(function* () {
      const dormantClaude = ThreadId.make("thread:dormant-claude-bypass");
      const claudeAcceptEdits = ThreadId.make("thread:claude-accept-edits");
      const codexAuto = ThreadId.make("thread:codex-auto");
      const codexSupervised = ThreadId.make("thread:codex-supervised");
      yield* writeLegacyThread({
        threadId: dormantClaude,
        modelSelection: claudeSelection,
        runtimeMode: "full-access",
      });
      yield* writeLegacyThread({
        threadId: claudeAcceptEdits,
        modelSelection: claudeSelection,
        runtimeMode: "auto-accept-edits",
      });
      yield* writeLegacyThread({
        threadId: codexAuto,
        modelSelection: codexSelection,
        runtimeMode: "auto",
      });
      yield* writeLegacyThread({
        threadId: codexSupervised,
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
      });

      const freeze = yield* PermissionFreeze.PermissionFreeze;
      const first = yield* freeze.run();
      assert.deepStrictEqual(first, {
        migratedThreadCount: 2,
        migratedScheduledTaskCount: 0,
        failedThreadCount: 0,
      });

      const frozen = yield* threadOf(dormantClaude);
      assert.equal(frozen.runtimeMode, "approval-required");
      assert.deepStrictEqual(
        frozen.permissionMigrations?.map(({ migrationId, from, to, reason }) => ({
          migrationId,
          from,
          to,
          reason,
        })),
        [
          {
            migrationId: "perm-v1",
            from: "full-access",
            to: "approval-required",
            reason: "claude-bypass-not-allowed",
          },
        ],
      );
      assert.equal((yield* threadOf(codexAuto)).runtimeMode, "approval-required");
      assert.equal(
        (yield* threadOf(codexAuto)).permissionMigrations?.[0]?.reason,
        "provider-clamped",
      );
      // Chats that already run what they store are untouched.
      assert.equal((yield* threadOf(claudeAcceptEdits)).runtimeMode, "auto-accept-edits");
      assert.isUndefined((yield* threadOf(claudeAcceptEdits)).permissionMigrations);
      assert.isUndefined((yield* threadOf(codexSupervised)).permissionMigrations);

      // A second startup changes nothing.
      const before = yield* eventCount;
      assert.deepStrictEqual(yield* freeze.run(), {
        migratedThreadCount: 0,
        migratedScheduledTaskCount: 0,
        failedThreadCount: 0,
      });
      assert.equal(yield* eventCount, before);

      // A rebuild replays the freeze from its events.
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* maintenance.rebuild;
      assert.equal((yield* threadOf(dormantClaude)).runtimeMode, "approval-required");

      // Allowing Bypass later never activates the frozen chat's old mode.
      yield* allowBypass(true);
      assert.equal((yield* freeze.run()).migratedThreadCount, 0);
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const resolved = yield* policy.resolve({
        thread: yield* threadOf(dormantClaude),
        modelSelection: claudeSelection,
      });
      assert.equal(resolved.runtimeMode, "approval-required");
      assert.isUndefined(resolved.permissionSource);
      yield* allowBypass(false);
    }),
  );

  it.effect("freezes scheduled tasks with an audit row, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insertTask = (taskId: string, selection: ModelSelection, runtimeMode: RuntimeMode) =>
        sql`
          INSERT INTO scheduled_tasks (
            task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
            workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
            created_by, creation_source, created_at, updated_at, next_run_at, last_run_at,
            last_run_status, last_run_error, run_count
          )
          VALUES (
            ${taskId}, 'Nightly', 'Run the tests', 1, '{"type":"interval","everyMs":3600000}',
            ${projectId}, NULL, '{"type":"root"}', ${JSON.stringify(selection)}, ${runtimeMode},
            'default', 'user', 'web', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
            NULL, NULL, 'never', NULL, 0
          )
        `;
      yield* insertTask("task:codex-full", codexSelection, "full-access");
      yield* insertTask("task:claude-full", claudeSelection, "full-access");
      yield* insertTask("task:claude-edits", claudeSelection, "auto-accept-edits");

      const freeze = yield* PermissionFreeze.PermissionFreeze;
      assert.equal((yield* freeze.run()).migratedScheduledTaskCount, 2);
      const rows = yield* sql<{ readonly task_id: string; readonly runtime_mode: string }>`
        SELECT task_id, runtime_mode FROM scheduled_tasks ORDER BY task_id
      `;
      assert.deepStrictEqual(rows, [
        { task_id: "task:claude-edits", runtime_mode: "auto-accept-edits" },
        { task_id: "task:claude-full", runtime_mode: "approval-required" },
        { task_id: "task:codex-full", runtime_mode: "approval-required" },
      ]);
      const audit = yield* sql<{ readonly subject_id: string; readonly reason: string }>`
        SELECT subject_id, reason FROM permission_migration_audit ORDER BY subject_id
      `;
      assert.deepStrictEqual(audit, [
        { subject_id: "task:claude-full", reason: "claude-bypass-not-allowed" },
        { subject_id: "task:codex-full", reason: "provider-clamped" },
      ]);
      assert.equal((yield* freeze.run()).migratedScheduledTaskCount, 0);
    }),
  );

  it.effect(
    "stores what the target runs on a provider switch, so switching back restores nothing",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:switch-round-trip");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("switch-round-trip:create"),
          threadId,
          projectId,
          title: "Switch",
          modelSelection: claudeSelection,
          runtimeMode: "auto",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        assert.equal((yield* threadOf(threadId)).runtimeMode, "auto");
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("switch-round-trip:to-codex"),
          threadId,
          modelSelection: codexSelection,
        });
        assert.equal((yield* threadOf(threadId)).runtimeMode, "approval-required");
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("switch-round-trip:back"),
          threadId,
          modelSelection: claudeSelection,
        });
        assert.equal((yield* threadOf(threadId)).runtimeMode, "approval-required");
      }),
  );

  it.effect("stores new chats at their effective preset and never stores unsupported inherit", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const create = (threadId: ThreadId, selection: ModelSelection, runtimeMode: RuntimeMode) =>
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "New chat",
          modelSelection: selection,
          runtimeMode,
          interactionMode: "default",
          permissionSource: "inherit",
          branch: null,
          worktreePath: null,
        });
      const claudeChat = ThreadId.make("thread:new-claude-inherit");
      const codexChat = ThreadId.make("thread:new-codex-full");
      yield* create(claudeChat, claudeSelection, "full-access");
      yield* create(codexChat, codexSelection, "full-access");
      // Neither driver reports native inheritance yet, so both store a preset.
      assert.deepInclude(yield* threadOf(claudeChat), {
        permissionSource: "override",
        runtimeMode: "approval-required",
      });
      assert.deepInclude(yield* threadOf(codexChat), {
        permissionSource: "override",
        runtimeMode: "approval-required",
      });
    }),
  );

  it.effect("needs settings-write to widen a chat, but not to pick the narrowest preset", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:remote-widening");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("remote-widening:create"),
        threadId,
        projectId,
        title: "Remote",
        modelSelection: claudeSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const withoutSettingsWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, DispatchSettingsWrite, false);
      const widen = yield* withoutSettingsWrite(
        orchestrator.dispatch({
          type: "thread.permission.set",
          commandId: CommandId.make("remote-widening:widen"),
          threadId,
          permissionSource: "override",
          runtimeMode: "auto",
        }),
      ).pipe(Effect.flip);
      assert.include(String(causeOf(widen)), "needs permission to change settings");
      assert.equal((yield* threadOf(threadId)).runtimeMode, "approval-required");
      // Unsupported inherit is refused rather than stored.
      const inherit = yield* orchestrator
        .dispatch({
          type: "thread.permission.set",
          commandId: CommandId.make("remote-widening:inherit"),
          threadId,
          permissionSource: "inherit",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.flip);
      assert.include(String(causeOf(inherit)), "cannot use its own permission settings");
      // With settings-write the user widens; anyone may narrow back.
      yield* orchestrator.dispatch({
        type: "thread.permission.set",
        commandId: CommandId.make("remote-widening:widen-local"),
        threadId,
        permissionSource: "override",
        runtimeMode: "auto",
      });
      assert.equal((yield* threadOf(threadId)).runtimeMode, "auto");
      const narrowed = yield* withoutSettingsWrite(
        orchestrator.dispatch({
          type: "thread.permission.set",
          commandId: CommandId.make("remote-widening:narrow"),
          threadId,
          permissionSource: "override",
          runtimeMode: "approval-required",
        }),
      );
      assert.deepEqual(
        narrowed.storedEvents.map((stored) => stored.event.type),
        ["thread.permission-updated"],
      );
      assert.deepInclude(yield* threadOf(threadId), {
        permissionSource: "override",
        runtimeMode: "approval-required",
      });
    }),
  );

  /** A chat with one pending command approval on a live provider session. */
  const seedPendingApproval = (name: string, options: ReadonlyArray<ProviderApprovalOption>) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread:${name}`);
      const requestId = RuntimeRequestId.make(`request:${name}`);
      const nodeId = NodeId.make(`node:${name}`);
      const providerSessionId = ProviderSessionId.make(`session:${name}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}:create`),
        threadId,
        projectId,
        title: "Approval",
        modelSelection: claudeSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace/permission-migration",
      });
      yield* eventSink.write({
        commandId: CommandId.make(`${name}:seed`),
        events: [
          {
            id: EventId.make(`${name}:session`),
            type: "provider-session.attached",
            threadId,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver: ProviderDriverKind.make("claudeAgent"),
              providerInstanceId: claudeId,
              status: "ready",
              cwd: "/workspace/permission-migration",
              model: claudeSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make(`${name}:node`),
            type: "node.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make(`${name}:request`),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: { type: "live", providerSessionId },
              createdAt: now,
              resolvedAt: null,
            },
          },
          {
            id: EventId.make(`${name}:item`),
            type: "turn-item.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:${name}`),
              type: "approval_request",
              threadId,
              runId: null,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "waiting",
              title: "npm test",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              requestId,
              requestKind: "command",
              options: [...options],
            },
          },
        ],
      });
      const requestOf = orchestrator
        .getThreadProjection(threadId)
        .pipe(Effect.map((projection) => projection.runtimeRequests[0]!));
      return { orchestrator, threadId, requestId, requestOf };
    });

  it.effect("refuses an answer the request no longer offers and records the exact choice", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, requestId, requestOf } = yield* seedPendingApproval(
        "stale-session-answer",
        [
          { decision: "accept", label: "Allow once" },
          {
            decision: "acceptAlways",
            label: "Always allow",
            scope: "persistent",
            persistsTo: "claude-local-settings",
            nativePayload: [{ type: "addRules", destination: "localSettings" }],
          },
          { decision: "decline", label: "Deny", acceptsFeedback: true },
        ],
      );
      // An older client's session answer used to become allow-once silently.
      const stale = yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("stale-session-answer:stale"),
          threadId,
          requestId,
          decision: "acceptForSession",
        })
        .pipe(Effect.flip);
      assert.include(String(causeOf(stale)), "no longer offered");
      // A remote client without settings-write cannot save a rule.
      const persistent = yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("stale-session-answer:always"),
          threadId,
          requestId,
          optionId: "persistent:0",
        })
        .pipe(Effect.provideService(DispatchSettingsWrite, false), Effect.flip);
      assert.include(String(causeOf(persistent)), "needs permission to change settings");
      assert.equal((yield* requestOf).status, "pending");

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("stale-session-answer:deny"),
        threadId,
        requestId,
        optionId: "deny:0",
        feedback: "Use the fixture instead.",
      });
      const answered = yield* requestOf;
      assert.equal(answered.status, "resolved");
      assert.deepStrictEqual(answered.chosen, {
        optionId: "deny:0",
        decision: "decline",
        feedback: "Use the fixture instead.",
      });
      assert.equal(answered.delivery?.state, "pending");
    }),
  );

  it.effect("moves delivery on without answering twice", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, requestId, requestOf } = yield* seedPendingApproval(
        "delivery-states",
        [{ decision: "accept", label: "Allow once" }],
      );
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("delivery-states:answer"),
        threadId,
        requestId,
        decision: "accept",
      });
      yield* orchestrator.dispatch({
        type: "runtime-request.delivery.update",
        commandId: CommandId.make("delivery-states:uncertain"),
        threadId,
        requestId,
        state: "uncertain",
      });
      const uncertain = yield* requestOf;
      assert.equal(uncertain.delivery?.state, "uncertain");
      assert.deepInclude(uncertain.lost, { cause: "delivery_failed", deliveryUncertain: true });
      // The provider resolved the request itself: no second answer is needed.
      yield* orchestrator.dispatch({
        type: "runtime-request.provider-closed",
        commandId: CommandId.make("delivery-states:closed"),
        threadId,
        requestId,
      });
      assert.equal((yield* requestOf).delivery?.state, "not_needed");
      const again = yield* orchestrator
        .dispatch({
          type: "runtime-request.delivery.update",
          commandId: CommandId.make("delivery-states:late"),
          threadId,
          requestId,
          state: "delivered",
        })
        .pipe(Effect.flip);
      assert.include(String(causeOf(again)), "already not_needed");
    }),
  );

  it.effect.each(["delivered", "provider-closed"] as const)(
    "no longer offers Ask again once an uncertain answer is %s",
    (outcome) =>
      Effect.gen(function* () {
        const { orchestrator, threadId, requestId, requestOf } = yield* seedPendingApproval(
          `delivery-reconciled-${outcome}`,
          [{ decision: "accept", label: "Allow once" }],
        );
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`delivery-reconciled-${outcome}:answer`),
          threadId,
          requestId,
          decision: "accept",
        });
        yield* orchestrator.dispatch({
          type: "runtime-request.delivery.update",
          commandId: CommandId.make(`delivery-reconciled-${outcome}:uncertain`),
          threadId,
          requestId,
          state: "uncertain",
        });
        assert.isTrue(isOpenLostRuntimeRequest(yield* requestOf));
        yield* orchestrator.dispatch(
          outcome === "delivered"
            ? {
                type: "runtime-request.delivery.update",
                commandId: CommandId.make(`delivery-reconciled-${outcome}:delivered`),
                threadId,
                requestId,
                state: "delivered",
              }
            : {
                type: "runtime-request.provider-closed",
                commandId: CommandId.make(`delivery-reconciled-${outcome}:closed`),
                threadId,
                requestId,
              },
        );
        const reconciled = yield* requestOf;
        assert.equal(
          reconciled.delivery?.state,
          outcome === "delivered" ? "delivered" : "not_needed",
        );
        // The loss stays as history but no longer asks the user to act.
        assert.equal(reconciled.lost?.cause, "delivery_failed");
        assert.isFalse(isOpenLostRuntimeRequest(reconciled));
      }),
  );

  it.effect("expires an unanswered request the provider closed", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, requestId, requestOf } = yield* seedPendingApproval(
        "provider-closed-pending",
        [{ decision: "accept", label: "Allow once" }],
      );
      yield* orchestrator.dispatch({
        type: "runtime-request.provider-closed",
        commandId: CommandId.make("provider-closed-pending:closed"),
        threadId,
        requestId,
      });
      const closed = yield* requestOf;
      assert.equal(closed.status, "expired");
      assert.isUndefined(closed.delivery);
    }),
  );

  it.effect("refuses an approval answer that names no choice and keeps the request open", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, requestId, requestOf } = yield* seedPendingApproval(
        "answer-without-choice",
        [
          { decision: "decline", label: "Decline" },
          { decision: "accept", label: "Allow once" },
        ],
      );
      const empty = yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("answer-without-choice:empty"),
          threadId,
          requestId,
        })
        .pipe(Effect.flip);
      assert.include(String(causeOf(empty)), "Choose an answer");
      assert.equal((yield* requestOf).status, "pending");
      // A corrected answer still goes through.
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("answer-without-choice:accept"),
        threadId,
        requestId,
        optionId: "once:0",
      });
      assert.equal((yield* requestOf).status, "resolved");
    }),
  );

  const createChat = (
    name: string,
    selection: ModelSelection,
    runtimeMode: RuntimeMode,
    extra: { readonly commandId?: string; readonly permissionSource?: PermissionSource } = {},
  ) =>
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(extra.commandId ?? `${name}:create`),
        threadId: ThreadId.make(`thread:${name}`),
        projectId,
        title: name,
        modelSelection: selection,
        runtimeMode,
        ...(extra.permissionSource === undefined
          ? {}
          : { permissionSource: extra.permissionSource }),
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace/permission-migration",
      }),
    );

  it.effect("keeps the provider session until the run stops when a narrowing is deferred", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const name = "deferred-narrowing";
      const threadId = ThreadId.make(`thread:${name}`);
      const runId = RunId.make(`run:${name}`);
      yield* createChat(name, claudeSelection, "auto");
      yield* eventSink.write({
        commandId: CommandId.make(`${name}:seed`),
        events: [
          {
            id: EventId.make(`${name}:session`),
            type: "provider-session.attached",
            threadId,
            occurredAt: now,
            payload: {
              id: ProviderSessionId.make(`session:${name}`),
              driver: ProviderDriverKind.make("claudeAgent"),
              providerInstanceId: claudeId,
              status: "running",
              cwd: "/workspace/permission-migration",
              model: claudeSelection.model,
              // Claude cannot switch modes inside a session, so an immediate
              // change would detach it.
              capabilities: ClaudeProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make(`${name}:run`),
            type: "run.created",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: claudeId,
              modelSelection: claudeSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message:${name}`),
              rootNodeId: null,
              activeAttemptId: null,
              status: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      const result = yield* orchestrator.dispatch({
        type: "thread.permission.set",
        commandId: CommandId.make(`${name}:narrow`),
        threadId,
        permissionSource: "override",
        runtimeMode: "approval-required",
        whileRunning: "apply-after-run",
      });
      assert.notInclude(
        result.storedEvents.map((stored) => stored.event.type),
        "provider-session.detached",
      );
      const detaches = yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND effect_type = 'provider-session.detach'
      `;
      assert.deepStrictEqual(detaches, []);
      const thread = yield* threadOf(threadId);
      assert.equal(thread.runtimeMode, "approval-required");
      assert.isNotNull(thread.permissionChangePending ?? null);
    }),
  );

  /** A Claude chat at `runtimeMode` with a live session and a running run. */
  const runningChat = (
    name: string,
    runtimeMode: RuntimeMode,
    permissionSource?: PermissionSource,
  ) =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread:${name}`);
      const runId = RunId.make(`run:${name}`);
      const rootNodeId = NodeId.make(`node:${name}:root`);
      const attemptId = RunAttemptId.make(`attempt:${name}`);
      const providerSessionId = ProviderSessionId.make(`session:${name}`);
      const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
      const claude = ProviderDriverKind.make("claudeAgent");
      yield* createChat(
        name,
        claudeSelection,
        runtimeMode,
        permissionSource === undefined ? {} : { permissionSource },
      );
      yield* eventSink.write({
        commandId: CommandId.make(`${name}:seed`),
        events: [
          {
            id: EventId.make(`${name}:session`),
            type: "provider-session.attached",
            threadId,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver: claude,
              providerInstanceId: claudeId,
              status: "running",
              cwd: "/workspace/permission-migration",
              model: claudeSelection.model,
              capabilities: ClaudeProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make(`${name}:provider-thread`),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: claude,
              providerInstanceId: claudeId,
              providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver: claude, nativeId: `native:${name}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "active",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make(`${name}:root`),
            type: "node.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            occurredAt: now,
            payload: {
              id: rootNodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: true,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make(`${name}:run`),
            type: "run.created",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: claudeId,
              modelSelection: claudeSelection,
              providerThreadId,
              userMessageId: MessageId.make(`message:${name}`),
              rootNodeId,
              activeAttemptId: attemptId,
              status: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make(`${name}:attempt`),
            type: "run-attempt.created",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: attemptId,
              runId,
              attemptOrdinal: 1,
              rootNodeId,
              providerInstanceId: claudeId,
              providerThreadId,
              providerTurnId: null,
              reason: "initial",
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        ],
      });
      // The chat's live provider thread is the one running.
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const thread = yield* projections.getThread(threadId);
      yield* eventSink.write({
        commandId: CommandId.make(`${name}:active-thread`),
        events: [
          {
            id: EventId.make(`${name}:active-thread`),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: { ...thread, activeProviderThreadId: providerThreadId },
          },
        ],
      });
      return { threadId, runId };
    });

  it.effect("keeps a second narrowing during a run pending against what the run uses", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const name = "second-narrowing";
      const { threadId } = yield* runningChat(name, "auto");
      const set = (key: string, runtimeMode: RuntimeMode) =>
        orchestrator.dispatch({
          type: "thread.permission.set",
          commandId: CommandId.make(`${name}:${key}`),
          threadId,
          permissionSource: "override",
          runtimeMode,
          whileRunning: "apply-after-run",
        });
      // Auto runs; Manual waits for the run to stop.
      yield* set("manual", "approval-required");
      // Accept edits is wider than the queued Manual but still narrower than
      // the Auto the session runs, so the restart stays pending.
      const second = yield* set("edits", "auto-accept-edits");
      assert.notInclude(
        second.storedEvents.map((stored) => stored.event.type),
        "provider-session.detached",
      );
      const thread = yield* threadOf(threadId);
      assert.equal(thread.runtimeMode, "auto-accept-edits");
      assert.deepEqual(thread.permissionChangePending?.running, {
        permissionSource: "override",
        runtimeMode: "auto",
      });
      // Picking what the session already runs leaves nothing to apply.
      yield* set("back-to-auto", "auto");
      const restored = yield* threadOf(threadId);
      assert.equal(restored.runtimeMode, "auto");
      assert.isNull(restored.permissionChangePending ?? null);
    }),
  );

  it.effect("stops the run to apply a pending narrowing when asked to apply it now", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const name = "apply-pending-now";
      const { threadId, runId } = yield* runningChat(name, "auto");
      yield* orchestrator.dispatch({
        type: "thread.permission.set",
        commandId: CommandId.make(`${name}:manual`),
        threadId,
        permissionSource: "override",
        runtimeMode: "approval-required",
        whileRunning: "apply-after-run",
      });
      // The client sends the stored values again, now to apply them at once.
      const now = yield* orchestrator.dispatch({
        type: "thread.permission.set",
        commandId: CommandId.make(`${name}:now`),
        threadId,
        permissionSource: "override",
        runtimeMode: "approval-required",
        whileRunning: "stop-and-apply",
      });
      const runUpdates = now.storedEvents.flatMap((stored) =>
        stored.event.type === "run.updated" && stored.event.payload.id === runId
          ? [stored.event.payload.status]
          : [],
      );
      assert.isAbove(runUpdates.length, 0, "the running work is stopped");
      assert.notInclude(runUpdates, "running");
      const thread = yield* threadOf(threadId);
      assert.equal(thread.runtimeMode, "approval-required");
      assert.isNotNull(thread.permissionChangePending ?? null);
    }),
  );

  it.effect("narrows Bypass chats at once when their account stops allowing Bypass", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* allowBypass(true);
      const before = BypassOptOut.bypassAllowedInstanceIds(yield* settings.getSettings);
      assert.isTrue(before.has(claudeId));
      const idle = ThreadId.make("thread:bypass-off-idle");
      yield* createChat("bypass-off-idle", claudeSelection, "full-access");
      const { threadId: running, runId } = yield* runningChat("bypass-off-running", "full-access");
      assert.equal((yield* threadOf(idle)).runtimeMode, "full-access");

      yield* allowBypass(false);
      const revoked = BypassOptOut.bypassRevokedInstanceIds(
        before,
        BypassOptOut.bypassAllowedInstanceIds(yield* settings.getSettings),
      );
      assert.deepEqual(revoked, [claudeId]);
      const narrowed = yield* BypassOptOut.narrowBypassChats(revoked);
      assert.includeMembers(narrowed, [idle, running]);

      // The stored mode shows what runs now, from the moment Bypass went away.
      assert.equal((yield* threadOf(idle)).runtimeMode, "approval-required");
      const runningThread = yield* threadOf(running);
      assert.equal(runningThread.runtimeMode, "approval-required");
      // The running chat's work stops; its session restarts once it has.
      assert.isNotNull(runningThread.permissionChangePending ?? null);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const run = (yield* projections.getThreadRecords(running, ["runs"])).runs.find(
        (candidate) => candidate.id === runId,
      );
      assert.notEqual(run?.status, "running");
      // Turning Bypass back on widens nothing.
      yield* allowBypass(true);
      assert.deepEqual(
        BypassOptOut.bypassRevokedInstanceIds(
          BypassOptOut.bypassAllowedInstanceIds(yield* settings.getSettings),
          BypassOptOut.bypassAllowedInstanceIds(yield* settings.getSettings),
        ),
        [],
      );
      assert.equal((yield* threadOf(idle)).runtimeMode, "approval-required");
      yield* allowBypass(false);
    }),
  );

  it.effect("revokes a live inherited Bypass without changing the chat's permission source", () =>
    Effect.gen(function* () {
      yield* Ref.set(claudeInherits, true);
      yield* allowBypass(true);
      // Its stored fallback says Manual, so searching for full-access alone misses this process.
      const { threadId, runId } = yield* runningChat(
        "inherited-bypass-off",
        "approval-required",
        "inherit",
      );
      const unused = ThreadId.make("thread:inherited-no-session");
      yield* createChat("inherited-no-session", claudeSelection, "approval-required", {
        permissionSource: "inherit",
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const before = yield* projections.getThreadRecords(threadId, ["providerSessions"]);
      const session = before.providerSessions[0]!;
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      yield* eventSink.write({
        commandId: CommandId.make("inherited-bypass-off:reported"),
        events: [
          {
            id: EventId.make("inherited-bypass-off:reported"),
            type: "provider-session.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...session,
              activePermissions: {
                nativeMode: "bypassPermissions",
                reportedBy: "session-init",
                reportedAt: DateTime.formatIso(now),
              },
            },
          },
        ],
      });
      yield* allowBypass(false);
      const affected = yield* BypassOptOut.narrowBypassChats([claudeId]);
      assert.include(affected, threadId);
      assert.notInclude(affected, unused);
      const after = yield* projections.getThreadRecords(threadId, ["runs"]);
      assert.equal(after.thread.permissionSource, "inherit");
      assert.equal(after.thread.runtimeMode, "approval-required");
      assert.equal(after.thread.permissionChangePending?.running?.permissionSource, "inherit");
      assert.notEqual(after.runs.find((run) => run.id === runId)?.status, "running");
    }).pipe(Effect.ensuring(Ref.set(claudeInherits, false))),
  );

  it.effect("stores what the target runs when a message switches the provider", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:message-switch");
      yield* createChat("message-switch", claudeSelection, "auto");
      assert.equal((yield* threadOf(threadId)).runtimeMode, "auto");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("message-switch:to-codex"),
        threadId,
        messageId: MessageId.make("message:message-switch:1"),
        text: "Continue on Codex",
        attachments: [],
        modelSelection: codexSelection,
        dispatchMode: { type: "start_immediately" },
      });
      // Codex runs Supervised, so the chat stores Supervised: switching back
      // to Claude later cannot bring Auto back without a new choice.
      assert.deepInclude(yield* threadOf(threadId), {
        providerInstanceId: codexId,
        runtimeMode: "approval-required",
      });
    }),
  );

  it.effect("never creates a chat over an existing one or above the sender's grant", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:create-over-existing");
      yield* createChat("create-over-existing", claudeSelection, "approval-required");
      // A fresh command for the same thread id cannot replace the chat's permissions.
      const again = yield* createChat("create-over-existing", claudeSelection, "auto", {
        commandId: "create-over-existing:again",
      }).pipe(Effect.flip);
      assert.include(String(causeOf(again)), "already exists");
      assert.equal((yield* threadOf(threadId)).runtimeMode, "approval-required");
      // A retry of the original command still answers from its receipt.
      yield* createChat("create-over-existing", claudeSelection, "approval-required");

      const withoutSettingsWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, DispatchSettingsWrite, false);
      const broad = yield* withoutSettingsWrite(
        createChat("create-broad-remote", claudeSelection, "auto"),
      ).pipe(Effect.flip);
      assert.include(String(causeOf(broad)), "needs permission to change settings");
      assert.equal(
        yield* Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
          projections.getThreadShell(ThreadId.make("thread:create-broad-remote")),
        ),
        null,
      );
      // The narrowest preset, and what Settings gives new chats, need no grant.
      yield* withoutSettingsWrite(
        createChat("create-narrow-remote", claudeSelection, "approval-required"),
      );
      assert.equal(
        (yield* threadOf(ThreadId.make("thread:create-narrow-remote"))).runtimeMode,
        "approval-required",
      );
      // A Codex chat clamps to Supervised, so asking for more widens nothing.
      yield* withoutSettingsWrite(createChat("create-codex-remote", codexSelection, "auto"));
      assert.equal(
        (yield* threadOf(ThreadId.make("thread:create-codex-remote"))).runtimeMode,
        "approval-required",
      );
    }),
  );

  it.effect.each([
    ["apply-after-run", "after-run"],
    ["stop-and-apply", "now"],
  ] as const)(
    "hands a mid-run narrowing of a Codex chat on its own settings to the live thread (%s)",
    ([whileRunning, timing]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const name = `codex-inherit-narrowing-${timing}`;
        const threadId = ThreadId.make(`thread:${name}`);
        const runId = RunId.make(`run:${name}`);
        const rootNodeId = NodeId.make(`node:${name}:root`);
        const attemptId = RunAttemptId.make(`attempt:${name}`);
        const providerSessionId = ProviderSessionId.make(`session:${name}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
        const selection = { instanceId: codexInheritId, model: "gpt-5.5" } satisfies ModelSelection;
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId,
          title: name,
          modelSelection: selection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          permissionSource: "inherit",
          branch: null,
          worktreePath: "/workspace/permission-migration",
        });
        assert.equal((yield* threadOf(threadId)).permissionSource, "inherit");
        yield* eventSink.write({
          commandId: CommandId.make(`${name}:seed`),
          events: [
            {
              id: EventId.make(`${name}:session`),
              type: "provider-session.attached",
              threadId,
              occurredAt: now,
              payload: {
                id: providerSessionId,
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: codexInheritId,
                status: "running",
                cwd: "/workspace/permission-migration",
                model: selection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
            },
            {
              id: EventId.make(`${name}:provider-thread`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: providerThreadId,
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: codexInheritId,
                providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: ProviderDriverKind.make("codex"),
                  nativeId: `native:${name}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "active",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make(`${name}:root`),
              type: "node.updated",
              threadId,
              runId,
              nodeId: rootNodeId,
              occurredAt: now,
              payload: {
                id: rootNodeId,
                threadId,
                runId,
                parentNodeId: null,
                rootNodeId,
                kind: "root_turn",
                status: "running",
                countsForRun: true,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make(`${name}:run`),
              type: "run.created",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId: codexInheritId,
                modelSelection: selection,
                providerThreadId,
                userMessageId: MessageId.make(`message:${name}`),
                rootNodeId,
                activeAttemptId: attemptId,
                status: "running",
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`${name}:attempt`),
              type: "run-attempt.created",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: codexInheritId,
                providerThreadId,
                providerTurnId: null,
                reason: "initial",
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        // Leaving Codex's own settings for Supervised is a narrowing.
        yield* orchestrator.dispatch({
          type: "thread.permission.set",
          commandId: CommandId.make(`${name}:narrow`),
          threadId,
          permissionSource: "override",
          runtimeMode: "approval-required",
          whileRunning,
        });
        const effects = yield* sql<{
          readonly effect_type: string;
          readonly payload_json: string;
        }>`
          SELECT effect_type, payload_json FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${threadId}
            AND effect_type IN ('provider-runtime.apply-policy', 'provider-session.detach')
        `;
        assert.deepStrictEqual(
          effects.map((row) => row.effect_type),
          ["provider-runtime.apply-policy"],
        );
        assert.deepInclude(JSON.parse(effects[0]!.payload_json), {
          type: "provider-runtime.apply-policy",
          providerSessionId,
          providerThreadId,
          timing,
        });
        const thread = yield* threadOf(threadId);
        assert.deepInclude(thread, {
          permissionSource: "override",
          runtimeMode: "approval-required",
        });
        assert.isNotNull(thread.permissionChangePending ?? null);
      }),
  );
});
