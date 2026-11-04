import type { OrchestrationV2HistoricalMessage } from "@starkfuture/contracts";
import {
  ChatAttachment,
  CheckpointId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderSession,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  PermissionSource,
  ProviderApprovalDecision,
  ProviderApprovalOptionId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderInstanceId,
  PositiveInt,
  ProviderUserInputAnswers,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeMode,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ServerProviderSessionCatalog,
  McpServerStatusEntry,
  McpServerSignInStart,
  McpServersReloadResult,
  ProviderContextBreakdown,
  PreviewBrowserStatus,
  ThreadId,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type {
  ProviderSelectionTransitionInput,
  ProviderSelectionTransitionPlan,
} from "./selectionTransition.ts";

export const ProviderAdapterV2RuntimePolicy = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /**
   * `inherit`: send no permission settings, so the provider applies its own
   * configuration. Set only for a driver that reports `nativePermissionInherit`;
   * missing means `override`, and `runtimeMode` is sent as today.
   */
  permissionSource: Schema.optional(PermissionSource),
  cwd: Schema.NullOr(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type ProviderAdapterV2RuntimePolicy = typeof ProviderAdapterV2RuntimePolicy.Type;

export const ProviderAdapterV2TurnMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  createdBy: OrchestrationV2ConversationMessage.fields.createdBy,
  creationSource: OrchestrationV2ConversationMessage.fields.creationSource,
  scheduledTaskId: OrchestrationV2ConversationMessage.fields.scheduledTaskId,
  senderThreadId: OrchestrationV2ConversationMessage.fields.senderThreadId,
  userShell: OrchestrationV2ConversationMessage.fields.userShell,
});
export type ProviderAdapterV2TurnMessage = typeof ProviderAdapterV2TurnMessage.Type;

export const ProviderAdapterV2SessionStatus = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type ProviderAdapterV2SessionStatus = typeof ProviderAdapterV2SessionStatus.Type;

export const ProviderAdapterV2Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("app_thread.created"),
    driver: ProviderDriverKind,
    appThread: OrchestrationV2AppThread,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_session.updated"),
    driver: ProviderDriverKind,
    providerSession: OrchestrationV2ProviderSession,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_thread.updated"),
    driver: ProviderDriverKind,
    providerThread: OrchestrationV2ProviderThread,
    /**
     * Set when the provider rewound its own conversation outside Stark, for
     * example a Pi extension moving the session-tree leaf back. Lists every
     * native turn id still on the active branch; the ingestor rolls back
     * earlier runs whose turns fell off it.
     */
    retainedNativeTurnIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("provider_turn.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    providerTurn: OrchestrationV2ProviderTurn,
  }),
  Schema.Struct({
    type: Schema.Literal("node.updated"),
    driver: ProviderDriverKind,
    node: OrchestrationV2ExecutionNode,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent.updated"),
    driver: ProviderDriverKind,
    subagent: OrchestrationV2Subagent,
  }),
  Schema.Struct({
    type: Schema.Literal("message.updated"),
    driver: ProviderDriverKind,
    message: OrchestrationV2ConversationMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("turn_item.updated"),
    driver: ProviderDriverKind,
    turnItem: OrchestrationV2TurnItem,
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_request.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    runtimeRequest: OrchestrationV2RuntimeRequest,
    /**
     * The provider closed the request itself (Codex `serverRequest/resolved`).
     * The adapter stopped waiting without answering; the orchestrator expires
     * an unanswered request or marks an answered one `not_needed`.
     */
    closedByProvider: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("plan.updated"),
    driver: ProviderDriverKind,
    plan: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    status: Schema.Literals(["completed", "interrupted", "cancelled"]),
    failure: Schema.Null,
    threadDisposition: Schema.Literals(["reusable", "broken"]),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    failureItemOrdinal: PositiveInt,
    status: Schema.Literal("failed"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
    retryStartedAt: Schema.optional(Schema.DateTimeUtc),
    threadDisposition: Schema.Literals(["reusable", "broken"]),
  }),
]);
export type ProviderAdapterV2Event = typeof ProviderAdapterV2Event.Type;

export class ProviderAdapterCapabilitiesError extends Schema.TaggedError<ProviderAdapterCapabilitiesError>()(
  "ProviderAdapterCapabilitiesError",
  {
    driver: ProviderDriverKind,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read ${this.driver} provider capabilities.`;
  }
}

export class ProviderAdapterOpenSessionError extends Schema.TaggedError<ProviderAdapterOpenSessionError>()(
  "ProviderAdapterOpenSessionError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open ${this.driver} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterCloseSessionError extends Schema.TaggedError<ProviderAdapterCloseSessionError>()(
  "ProviderAdapterCloseSessionError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close ${this.driver} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterResumeThreadError extends Schema.TaggedError<ProviderAdapterResumeThreadError>()(
  "ProviderAdapterResumeThreadError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resume ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterEnsureThreadError extends Schema.TaggedError<ProviderAdapterEnsureThreadError>()(
  "ProviderAdapterEnsureThreadError",
  {
    driver: ProviderDriverKind,
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ensure ${this.driver} provider thread for app thread ${this.threadId}.`;
  }
}

export class ProviderAdapterReadThreadSnapshotError extends Schema.TaggedError<ProviderAdapterReadThreadSnapshotError>()(
  "ProviderAdapterReadThreadSnapshotError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read ${this.driver} provider thread snapshot ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterRollbackThreadError extends Schema.TaggedError<ProviderAdapterRollbackThreadError>()(
  "ProviderAdapterRollbackThreadError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    checkpointId: Schema.optional(CheckpointId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to roll back ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterForkThreadError extends Schema.TaggedError<ProviderAdapterForkThreadError>()(
  "ProviderAdapterForkThreadError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to fork ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterTurnStartError extends Schema.TaggedError<ProviderAdapterTurnStartError>()(
  "ProviderAdapterTurnStartError",
  {
    driver: ProviderDriverKind,
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to start run ${this.runId} on ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterSteerRunUnsupportedError extends Schema.TaggedError<ProviderAdapterSteerRunUnsupportedError>()(
  "ProviderAdapterSteerRunUnsupportedError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
  },
) {
  override get message(): string {
    return `${this.driver} provider thread ${this.providerThreadId} does not support active-run steering.`;
  }
}

export class ProviderAdapterSteerRunError extends Schema.TaggedError<ProviderAdapterSteerRunError>()(
  "ProviderAdapterSteerRunError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to steer active run ${this.providerTurnId} on ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterInterruptError extends Schema.TaggedError<ProviderAdapterInterruptError>()(
  "ProviderAdapterInterruptError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to interrupt ${this.driver} provider turn ${this.providerTurnId}.`;
  }
}

export class ProviderAdapterRuntimeRequestResponseError extends Schema.TaggedError<ProviderAdapterRuntimeRequestResponseError>()(
  "ProviderAdapterRuntimeRequestResponseError",
  {
    driver: ProviderDriverKind,
    requestId: RuntimeRequestId,
    /**
     * The adapter proved nothing was waiting for this answer, so the provider
     * never received it and nothing ran. Absent means delivery is uncertain.
     */
    nothingWaiting: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to respond to ${this.driver} runtime request ${this.requestId}.`;
  }
}

export class ProviderAdapterEventStreamError extends Schema.TaggedError<ProviderAdapterEventStreamError>()(
  "ProviderAdapterEventStreamError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed while streaming ${this.driver} provider session ${this.providerSessionId} events.`;
  }
}

export class ProviderAdapterProtocolError extends Schema.TaggedError<ProviderAdapterProtocolError>()(
  "ProviderAdapterProtocolError",
  {
    driver: ProviderDriverKind,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    payload: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `${this.driver} provider protocol error: ${this.detail}.`;
  }
}

export const ProviderAdapterV2Error = Schema.Union([
  ProviderAdapterCapabilitiesError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterCloseSessionError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterEnsureThreadError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterTurnStartError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterSteerRunError,
  ProviderAdapterInterruptError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterEventStreamError,
  ProviderAdapterProtocolError,
]);
export type ProviderAdapterV2Error = typeof ProviderAdapterV2Error.Type;

export interface ProviderAdapterV2OpenSessionInput {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly resumeFromSession?: OrchestrationV2ProviderSession;
  /** Native thread to activate while an eager adapter opens its provider process. */
  readonly initialNativeThreadId?: string;
  /** Preserves provider item identity across eager activation of a persisted thread. */
  readonly initialProviderItemIdentityVersion?: 2;
}

export interface ProviderAdapterV2EnsureThreadInput {
  readonly threadId: ThreadId;
  /** The app thread's title, for providers that name their native sessions. */
  readonly title?: string;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly providerSessionId?: ProviderSessionId;
  readonly existingProviderThread?: OrchestrationV2ProviderThread;
}

export interface ProviderAdapterV2TurnInput {
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runOrdinal: number;
  /** Whether the current native session has an accepted turn; omitted when unknown. */
  readonly nativeThreadHasTurns?: boolean;
  readonly providerTurnOrdinal: number;
  readonly restartContinuationOfRunId?: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly message: ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  /**
   * What the thread's MCP Apps want the agent to know (`ui/update-model-context`),
   * latest per app, keyed stably per app. Adapters that host apps deliver it as
   * application context; others never receive any.
   */
  readonly appContext?: ReadonlyArray<{ readonly key: string; readonly text: string }>;
  /**
   * Whether Stark's preview browser can serve `html_preview` right now. Adapters
   * with a per-turn context channel tell the agent when it changes, so it picks
   * a diagram or page tool knowing what will work.
   */
  readonly previewBrowser?: PreviewBrowserStatus;
}

export interface ProviderAdapterV2SteerInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly message: ProviderAdapterV2TurnMessage;
}

export interface ProviderAdapterV2InterruptInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  /** When true, the next `startTurn` may respawn the provider runtime (Grok Stop recovery). */
  readonly requestRuntimeRestart?: boolean;
}

/**
 * A chat's requested permissions changed outside a turn, for one provider
 * thread. `now` stops running work first (Stop and apply now); `after-run`
 * lets it finish but starts no continuation under the earlier settings.
 */
export interface ProviderAdapterV2RuntimePolicyChange {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly timing: "now" | "after-run";
}

/**
 * When a permission change takes effect: `unchanged` (the provider already
 * runs it), `next-turn` (idle; the next turn sends it), `stopped` (running work
 * was stopped so it applies now), `after-run` (requested and active differ
 * until the current run stops).
 */
export type ProviderAdapterV2RuntimePolicyApplication =
  | "unchanged"
  | "next-turn"
  | "stopped"
  | "after-run";

export interface ProviderAdapterV2RuntimeRequestResponseInput {
  readonly requestId: RuntimeRequestId;
  /**
   * The offered option the user chose. An adapter that issued option ids sends
   * exactly that option's native response; `decision` stays for adapters that
   * do not issue ids yet.
   */
  readonly optionId?: ProviderApprovalOptionId;
  /** A reason for the agent, set only for an option that accepts one. */
  readonly feedback?: string;
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: ProviderUserInputAnswers;
  readonly response?: unknown;
}

export interface ProviderAdapterV2ThreadSnapshot {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly providerPayload?: unknown;
}

export interface ProviderAdapterV2ReadThreadSnapshotInput {
  readonly providerThread: OrchestrationV2ProviderThread;
}

export type ProviderAdapterV2RollbackTarget =
  | {
      readonly type: "thread_start";
      readonly checkpointId: CheckpointId;
      readonly appRunOrdinal: 0;
    }
  | {
      readonly type: "provider_turn";
      readonly checkpointId: CheckpointId;
      readonly appRunOrdinal: number;
      readonly providerTurn: OrchestrationV2ProviderTurn;
    };

export interface ProviderAdapterV2RollbackThreadInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly target: ProviderAdapterV2RollbackTarget;
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}

export interface ProviderAdapterV2ForkThreadInput {
  readonly sourceProviderThread: OrchestrationV2ProviderThread;
  readonly sourceProviderTurns?: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly providerTurnId?: ProviderTurnId;
  readonly targetThreadId: ThreadId;
  readonly ownerNodeId?: NodeId;
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
}

export interface ProviderAdapterV2EventSubscription {
  readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  readonly close: Effect.Effect<void>;
}

export interface ProviderAdapterV2HistoricalContext {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly context: string;
}

/** An MCP tool as the provider's MCP client lists it. */
export interface ProviderAdapterV2McpTool {
  readonly name: string;
  readonly _meta?: unknown;
  readonly annotations?: unknown;
}

/** MCP `CallToolResult` / `ReadResourceResult` shapes, passed through unchanged. */
export interface ProviderAdapterV2McpCallToolResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly _meta?: unknown;
}

export interface ProviderAdapterV2McpApps {
  readonly listTools: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly server: string;
  }) => Effect.Effect<ReadonlyArray<ProviderAdapterV2McpTool>, ProviderAdapterV2Error>;
  readonly callTool: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly server: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }) => Effect.Effect<ProviderAdapterV2McpCallToolResult, ProviderAdapterV2Error>;
  readonly readResource: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly server: string;
    readonly uri: string;
  }) => Effect.Effect<{ readonly contents: ReadonlyArray<unknown> }, ProviderAdapterV2Error>;
}

/** A terminal task outcome observed by the provider, not inferred from a stop timeout. */
export type ProviderAdapterV2SubagentOutcome = {
  readonly status: "completed" | "failed" | "cancelled";
  readonly completedAt: NonNullable<OrchestrationV2Subagent["completedAt"]>;
  readonly result: OrchestrationV2Subagent["result"];
};

export interface ProviderAdapterV2McpServers {
  readonly list: () => Effect.Effect<readonly McpServerStatusEntry[], ProviderAdapterV2Error>;
  /** Native status observation bound; defaults to three seconds. */
  readonly statusTimeoutMs?: number;
  /** Whether reconnect(name) preserves other servers' live connections. */
  readonly reconnectScope?: "server" | "all";
  /** Known provider work that makes connection maintenance unsafe, including pending wakes. */
  readonly isBusy?: Effect.Effect<boolean, ProviderAdapterV2Error>;
  readonly reload?: (options: {
    readonly force: boolean;
  }) => Effect.Effect<McpServersReloadResult, ProviderAdapterV2Error>;
  readonly reconnect: (name: string) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly setEnabled: (
    name: string,
    enabled: boolean,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly startSignIn: (
    name: string,
  ) => Effect.Effect<McpServerSignInStart, ProviderAdapterV2Error>;
  readonly submitCallback: (
    name: string,
    url: string,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly signOut: (name: string) => Effect.Effect<void, ProviderAdapterV2Error>;
}

export interface ProviderAdapterV2SessionRuntime {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly providerSessionId: ProviderSessionId;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  /**
   * Manager-owned runtimes expose a synchronous subscription so concurrent
   * provider threads receive independent copies of the process event stream.
   * Adapter runtimes may omit this and expose only their single-consumer event stream.
   */
  readonly subscribeEvents?: Effect.Effect<ProviderAdapterV2EventSubscription>;
  /**
   * Adapters whose native runtime can hold pending work outside an active
   * turn (for example Claude background tasks and their wake turns) report it
   * here so the session manager defers idle release while it is pending.
   */
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  /**
   * Per-provider-thread pending work for root-run ingestion stop gates. When
   * present, RunExecutionService uses only this probe (never the session-wide
   * hasPendingBackgroundWork) so sibling native threads cannot pin an
   * unrelated root subscription open.
   */
  readonly hasPendingBackgroundWorkForThread?: (
    providerThread: OrchestrationV2ProviderThread,
  ) => Effect.Effect<boolean>;
  /**
   * Capacity for the requested model/options, independent of native thread usage.
   * `cwd` is the thread's working directory, for providers whose project config
   * can change a model's limits.
   */
  readonly getModelContextWindow?: (
    modelSelection: ModelSelection,
    cwd?: string | null,
  ) => number | undefined;
  /** Whether an option-only change preserves measured native usage and capacity.
   * Compaction thresholds are still discarded. Unknown transitions invalidate usage.
   */
  readonly canReuseContextUsage?: (previous: ModelSelection, next: ModelSelection) => boolean;
  readonly ensureThread: (
    input: ProviderAdapterV2EnsureThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly resumeThread: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly threadId?: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
    /**
     * The native thread holds history made outside Stark (an imported CLI
     * session) that no Stark turn has resumed yet. An adapter that only opens
     * the native thread at turn start confirms here that the history still
     * exists, and fails otherwise, so the caller starts a fresh native thread
     * with the history as context instead of failing the first turn.
     */
    readonly importedNativeHistory?: boolean;
  }) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  /** False means the native protocol explicitly does not support history injection. */
  readonly injectHistory?: (
    input: ProviderAdapterV2HistoricalContext & {
      readonly providerThread: OrchestrationV2ProviderThread;
    },
  ) => Effect.Effect<boolean, ProviderAdapterV2Error>;
  readonly startTurn: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly runUserShellCommand?: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly compactThread?: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly steerTurn: (
    input: ProviderAdapterV2SteerInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly stopTask?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly taskId: string;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly interruptTurn: (
    input: ProviderAdapterV2InterruptInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  /**
   * Applies a chat's changed permissions to a live provider thread outside a
   * turn. Absent means the adapter applies them with the next turn only. The
   * session runtime does not restart the provider session: a narrowing that
   * must drop provider-held grants needs the caller to detach the session.
   */
  readonly applyRuntimePolicy?: (
    change: ProviderAdapterV2RuntimePolicyChange,
  ) => Effect.Effect<ProviderAdapterV2RuntimePolicyApplication, ProviderAdapterV2Error>;
  /** Stops one native child through its owning runtime; the owner keeps running. */
  readonly stopSubagent?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly nativeTaskId: string;
    /** A delayed Stop must not interrupt a task resumed after this request. */
    readonly requestedAt?: NonNullable<OrchestrationV2Subagent["startedAt"]>;
  }) => Effect.Effect<void | ProviderAdapterV2SubagentOutcome, ProviderAdapterV2Error>;
  /**
   * Lets a runtime shared by several app threads unload one provider thread's
   * native state (and its MCP servers) when that app thread detaches, while
   * the runtime keeps serving the others. A later resume reloads it.
   */
  readonly unloadThread?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly respondToRuntimeRequest: (
    input: ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly readThreadSnapshot: (
    input: ProviderAdapterV2ReadThreadSnapshotInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  /**
   * Providers that accept product feedback for a thread (#7949, Codex → OpenAI)
   * expose it here; absent means the driver has no feedback channel.
   */
  readonly uploadFeedback?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly reason?: string;
  }) => Effect.Effect<{ readonly feedbackId: string }, ProviderAdapterV2Error>;
  /** Reads an already running session; never starts a query or refreshes activity. */
  readonly readSessionCatalog?: () => Effect.Effect<
    ServerProviderSessionCatalog,
    ProviderAdapterV2Error
  >;
  readonly readContextUsage?: (input: {
    readonly detail: "summary" | "full";
  }) => Effect.Effect<ProviderContextBreakdown, ProviderAdapterV2Error>;
  readonly rewindFiles?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly userMessageId: string;
    readonly dryRun: boolean;
  }) => Effect.Effect<
    {
      readonly canRewind: boolean;
      readonly error?: string;
      readonly filesChanged: readonly string[];
      readonly insertions: number;
      readonly deletions: number;
      readonly skippedLinks?: number;
    },
    ProviderAdapterV2Error
  >;
  /**
   * MCP Apps host operations through the provider's own MCP client, for
   * drivers whose protocol exposes them (Codex). Absent means apps from this
   * provider are not interactive and their tool calls stay plain tool rows.
   */
  readonly mcpApps?: ProviderAdapterV2McpApps;
  readonly mcpServers?: ProviderAdapterV2McpServers;
  readonly rollbackThread: (
    input: ProviderAdapterV2RollbackThreadInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  readonly forkThread: (
    input: ProviderAdapterV2ForkThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
}

export class ProviderAdapterV2 extends Context.Service<
  ProviderAdapterV2,
  {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    /** Status-only project query for Settings; never sends a model turn. */
    readonly mcpServersForCwd?: (cwd: string) => ProviderAdapterV2McpServers;
    readonly getCapabilities: () => Effect.Effect<
      OrchestrationV2ProviderCapabilities,
      ProviderAdapterV2Error
    >;
    readonly planSelectionTransition: (
      input: ProviderSelectionTransitionInput,
    ) => Effect.Effect<ProviderSelectionTransitionPlan, ProviderAdapterV2Error>;
    readonly openSession: (
      input: ProviderAdapterV2OpenSessionInput,
    ) => Effect.Effect<ProviderAdapterV2SessionRuntime, ProviderAdapterV2Error, Scope.Scope>;
  }
>()("@starkfuture/provider-core/server/ProviderAdapter/ProviderAdapterV2") {}
