/**
 * Shared setup for the permission regression suites (PLAN-002 D4): the real
 * orchestrator, projections, event store and startup freeze over in-memory
 * SQLite, with a Claude and a Codex instance whose snapshots the tests change.
 *
 * Nothing here starts a provider: the adapters refuse to open sessions, so runs
 * stay unstarted and approvals are seeded as the ingestor would write them.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type PermissionSource,
  ProjectId,
  type ProviderApprovalOption,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInteractionMode,
  ProviderSessionId,
  type RuntimeMode,
  RuntimeRequestId,
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
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as RuntimeLayer from "../runtimeLayer.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";

export const claudeId = ProviderInstanceId.make("claudeAgent");
export const codexId = ProviderInstanceId.make("codex");
/** An instance this build does not know, as left behind by a removed provider. */
const goneId = ProviderInstanceId.make("removed-provider");
export const projectId = ProjectId.make("project:permission-regression");
export const workspace = "/workspace/permission-regression";
export const claudeSelection = {
  instanceId: claudeId,
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
export const codexSelection = { instanceId: codexId, model: "gpt-5.5" } satisfies ModelSelection;
export const goneSelection = { instanceId: goneId, model: "old-model" } satisfies ModelSelection;

/** What the instances' live snapshots report; tests set it before they act. */
export interface SnapshotState {
  readonly claudeBypassAllowed: boolean;
  readonly claudeInherits: boolean;
  readonly codexInherits: boolean;
}
const DEFAULT_SNAPSHOT_STATE: SnapshotState = {
  claudeBypassAllowed: false,
  claudeInherits: false,
  codexInherits: false,
};
const snapshotState = Ref.makeUnsafe<SnapshotState>(DEFAULT_SNAPSHOT_STATE);

const adapterFor = (instanceId: ProviderInstanceId, driver: ProviderDriverKind) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("permission regression tests never open a provider session"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const instanceFor = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  snapshot: Effect.Effect<ServerProvider>,
) =>
  ({
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: `${driver}:permission-d4` },
    displayName: `${driver} test`,
    enabled: true,
    snapshot: { getSnapshot: snapshot } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: adapterFor(instanceId, driver),
    textGeneration: {} as ProviderInstance["textGeneration"],
  }) satisfies ProviderInstance;

const claudeInstance = instanceFor(
  claudeId,
  ProviderDriverKind.make("claudeAgent"),
  Ref.get(snapshotState).pipe(
    Effect.map(
      (state) =>
        ({
          supportedRuntimeModes: [
            "approval-required",
            "auto-accept-edits",
            "auto",
            ...(state.claudeBypassAllowed ? (["full-access"] as const) : []),
          ],
          ...(state.claudeInherits ? { nativePermissionInherit: true } : {}),
        }) as unknown as ServerProvider,
    ),
  ),
);
const codexInstance = instanceFor(
  codexId,
  ProviderDriverKind.make("codex"),
  Ref.get(snapshotState).pipe(
    Effect.map(
      (state) =>
        ({
          supportedRuntimeModes: ["approval-required"],
          ...(state.codexInherits ? { nativePermissionInherit: true } : {}),
        }) as unknown as ServerProvider,
    ),
  ),
);
const instances = [claudeInstance, codexInstance];

const layerRegistry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(instances),
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
  prefix: "stark-permission-d4-",
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

/**
 * The orchestrator runtime with the startup freeze, projection maintenance and
 * the runtime policy that reads the instances' snapshots. Settings start with
 * Bypass not allowed for Claude.
 */
export const layerPermissionRuntime = Layer.mergeAll(
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
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(layerPlatform),
);

/**
 * Sets what the snapshots report and whether Claude's settings allow Bypass,
 * as the account toggle would. Every test calls this first, since the suites
 * share one runtime.
 */
export const setSnapshots = (state: Partial<SnapshotState>) =>
  Effect.gen(function* () {
    const next = { ...DEFAULT_SNAPSHOT_STATE, ...state };
    yield* Ref.set(snapshotState, next);
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { allowBypassPermissions: next.claudeBypassAllowed },
        },
      },
    });
  });

export const LEGACY_CREATED_AT = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");

/** A thread as servers before permission sources stored it: no source field at all. */
export const legacyThread = (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly title?: string;
  readonly lineage?: OrchestrationV2AppThread["lineage"];
  readonly forkedFrom?: OrchestrationV2AppThread["forkedFrom"];
  readonly createdBy?: OrchestrationV2AppThread["createdBy"];
  readonly creationSource?: OrchestrationV2AppThread["creationSource"];
  readonly archivedAt?: DateTime.Utc | null;
  readonly permissionSource?: PermissionSource;
}): OrchestrationV2AppThread => ({
  createdBy: input.createdBy ?? "user",
  creationSource: input.creationSource ?? "web",
  id: input.threadId,
  projectId,
  title: input.title ?? "Saved chat",
  providerInstanceId: input.modelSelection.instanceId,
  modelSelection: input.modelSelection,
  runtimeMode: input.runtimeMode,
  interactionMode: input.interactionMode ?? "default",
  ...(input.permissionSource === undefined ? {} : { permissionSource: input.permissionSource }),
  branch: null,
  worktreePath: workspace,
  activeProviderThreadId: null,
  lineage: input.lineage ?? {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: input.threadId,
  },
  forkedFrom: input.forkedFrom ?? null,
  createdAt: LEGACY_CREATED_AT,
  updatedAt: LEGACY_CREATED_AT,
  archivedAt: input.archivedAt ?? null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** Writes `thread.created` events exactly as an older server did. */
export const writeLegacyThreads = (threads: ReadonlyArray<OrchestrationV2AppThread>) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      events: threads.map((thread) => ({
        id: EventId.make(`legacy-created:${thread.id}`),
        type: "thread.created" as const,
        threadId: thread.id,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: LEGACY_CREATED_AT,
        payload: thread,
      })),
    });
  });

/** A new chat created the way a client creates one. */
export const createThread = (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly permissionSource?: PermissionSource;
}) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`create:${input.threadId}`),
      threadId: input.threadId,
      projectId,
      title: "Permission chat",
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode ?? "default",
      ...(input.permissionSource === undefined ? {} : { permissionSource: input.permissionSource }),
      branch: null,
      worktreePath: workspace,
    }),
  );

/** A user message; with no effect worker running, its run stays unstarted. */
export const sendMessage = (input: {
  readonly threadId: ThreadId;
  readonly key: string;
  readonly dispatchMode: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["dispatchMode"];
  readonly permissionCeiling?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["permissionCeiling"];
  readonly createdBy?: "user" | "system";
}) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`message:${input.threadId}:${input.key}`),
      threadId: input.threadId,
      messageId: MessageId.make(`message:${input.threadId}:${input.key}`),
      text: `Message ${input.key}`,
      attachments: [],
      dispatchMode: input.dispatchMode,
      ...(input.permissionCeiling === undefined
        ? {}
        : { permissionCeiling: input.permissionCeiling }),
      createdBy: input.createdBy ?? "user",
      creationSource: "web",
    }),
  );

export const threadOf = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections.getThread(threadId),
  );

export const projectionOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  );

/** The refusal text an orchestrator error carries. */
export const causeOf = (error: unknown): string =>
  String(typeof error === "object" && error !== null && "cause" in error ? error.cause : error);

export const storedEventTypes = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly event_type: string }>`
      SELECT event_type FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${threadId}
      ORDER BY sequence
    `;
    return rows.map((row) => row.event_type);
  });

export const totalEventCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events WHERE application_event_version = 2
  `;
  return rows[0]?.count ?? 0;
});

/** Effects the orchestrator queued for a thread, by request type. */
export const queuedEffectTypes = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId}
      ORDER BY rowid
    `;
    return rows.map((row) => row.effect_type);
  });

/** Respond effects queued for a thread, as the effect worker would hand them to the adapter. */
export const queuedResponds = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_type = 'runtime-request.respond'
      ORDER BY rowid
    `;
    return rows.map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
  });

/**
 * A chat with one command approval pending on a live provider session, as the
 * ingestor writes it. `options` are what the adapter offered.
 */
export const seedPendingApproval = (input: {
  readonly name: string;
  readonly options: ReadonlyArray<ProviderApprovalOption>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly requestKind?: "command" | "file-change" | "permission";
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const selection = input.modelSelection ?? claudeSelection;
    const driver = ProviderDriverKind.make(
      selection.instanceId === codexId ? "codex" : "claudeAgent",
    );
    const threadId = ThreadId.make(`thread:${input.name}`);
    const requestId = RuntimeRequestId.make(`request:${input.name}`);
    const nodeId = NodeId.make(`node:${input.name}`);
    const providerSessionId = ProviderSessionId.make(`session:${input.name}`);
    const requestKind = input.requestKind ?? "command";
    yield* createThread({
      threadId,
      modelSelection: selection,
      runtimeMode: input.runtimeMode ?? "approval-required",
    });
    yield* eventSink.write({
      commandId: CommandId.make(`${input.name}:seed`),
      events: [
        {
          id: EventId.make(`${input.name}:session`),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: {
            id: providerSessionId,
            driver,
            providerInstanceId: selection.instanceId,
            status: "ready",
            cwd: workspace,
            model: selection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        },
        {
          id: EventId.make(`${input.name}:node`),
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
          id: EventId.make(`${input.name}:request`),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: requestKind,
            status: "pending",
            responseCapability: { type: "live", providerSessionId },
            createdAt: now,
            resolvedAt: null,
          },
        },
        {
          id: EventId.make(`${input.name}:item`),
          type: "turn-item.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${input.name}`),
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
            requestKind,
            options: [...input.options],
          },
        },
      ],
    });
    const projection = orchestrator.getThreadProjection(threadId);
    return {
      threadId,
      requestId,
      nodeId,
      providerSessionId,
      requestOf: projection.pipe(
        Effect.map((current) =>
          current.runtimeRequests.find((request) => request.id === requestId)!,
        ),
      ),
      itemOf: projection.pipe(
        Effect.map((current) =>
          current.turnItems.find((item) => item.id === TurnItemId.make(`item:${input.name}`))!,
        ),
      ),
      nodeOf: projection.pipe(
        Effect.map((current) => current.nodes.find((node) => node.id === nodeId)!),
      ),
    };
  });
