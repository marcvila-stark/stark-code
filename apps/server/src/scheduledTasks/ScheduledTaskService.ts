import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  RunId,
  ScheduledTask,
  ScheduledTaskError,
  DEFAULT_RUNTIME_MODE,
  ScheduledTaskId,
  ScheduledTaskRunId,
  ThreadId,
  ScheduledTaskWebhookDeliveryId,
  type OrchestrationV2Run,
  type ScheduledTaskListRunsInput,
  type ScheduledTaskListRunsResult,
  type ScheduledTaskRun,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskGetWebhookDeliveryResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskListWebhookDeliveriesResult,
  type ScheduledTaskRotateWebhookTokenInput,
  type ScheduledTaskWebhookDeliveryOutcome,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskUpsertInput,
} from "@starkfuture/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Metric from "effect/Metric";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { DispatchSettingsWrite } from "../orchestration-v2/DispatchSettingsWrite.ts";
import { clampsToSupervised, effectiveRuntimeMode } from "../orchestration-v2/PermissionPolicy.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveProjectSettings } from "@starkfuture/shared/projectSettings";
import * as Metrics from "../observability/Metrics.ts";
import * as PermissionContainment from "../orchestration-v2/PermissionContainment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as MaintenanceGate from "../maintenance/MaintenanceGate.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";
import {
  RUN_ERRORS,
  RUN_HISTORY_LIMIT,
  applyAgentObservation,
  insertRun,
  isFinishedAgentStatus,
  occurrenceKeys,
  pruneRuns,
  runCommandId,
  runMessageId,
  selectLatestRuns,
  selectObservedRuns,
  selectRunByOccurrence,
  selectTaskRuns,
  selectUnsettledRuns,
  selectRun,
  toScheduledTaskRun,
  type NewRun,
  type RunDispatchKind,
  type RunDispatchState,
  type ScheduledTaskRunRow,
} from "./ScheduledTaskRuns.ts";
import {
  redactHeaders,
  redactQuery,
  renderWebhookPrompt,
  type WebhookRequest,
} from "./webhookTemplate.ts";
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";

/** Path prefix of the environment route that receives webhook requests. */
export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";
/** Deliveries kept per task; older ones are pruned on insert. */
const WEBHOOK_DELIVERY_RETENTION = 50;
/** Body text kept in the delivery log. Larger bodies are cut and flagged. */
const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
/** Rendered prompt text kept in the delivery log. */
const WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT = 64 * 1024;
/** Deliveries one task may hold at once, running or waiting their turn. */
const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
/** Accepted deliveries per task per minute, enforced here as well as on the relay because the tunnel hostname is public too. */
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;

/**
 * Where a webhook task's public URL points: `${relayHookBaseUrl}/${taskId}/${token}`.
 * Null when the environment has no managed tunnel on Stark Connect; clients then show the path.
 */
interface WebhookOrigin {
  readonly relayHookBaseUrl: string | null;
}

const ENDPOINT_KEY = /^[0-9a-f]{16}$/;

/**
 * The relay's hook URL prefix for this environment. The relay finds the
 * environment by its managed tunnel's key (the tunnel name's last segment),
 * so the URL never reveals the environment id.
 */
export function relayHookBaseUrl(input: {
  readonly relayUrl: string;
  readonly tunnelName: string | undefined;
}): string | null {
  const endpointKey = input.tunnelName?.split("-").at(-1);
  const relayUrl = input.relayUrl.replace(/\/+$/, "");
  if (relayUrl === "" || endpointKey === undefined || !ENDPOINT_KEY.test(endpointKey)) {
    return null;
  }
  return `${relayUrl}/v1/hooks/${endpointKey}`;
}

export class ScheduledTaskWebhookOrigin extends Context.Reference<Effect.Effect<WebhookOrigin>>(
  "stark-code/scheduledTasks/ScheduledTaskWebhookOrigin",
  {
    defaultValue: () => Effect.succeed({ relayHookBaseUrl: null }),
  },
) {}

/** A queued webhook delivery that no longer applies to its task; `reason` is shown in the delivery log. */
class WebhookDeliverySkipped extends Data.TaggedError("WebhookDeliverySkipped")<{
  readonly reason: string;
}> {}

interface RateWindow {
  readonly accepted: ReadonlyArray<number>;
  /** Whether a rejection was already logged in this window. */
  readonly rejectedLogged: boolean;
}

export interface WebhookTriggerRequest extends WebhookRequest {
  readonly hookId: string;
  readonly token: string;
  readonly body: Uint8Array;
  /** Set by Stark Connect; the same id is never dispatched twice. */
  readonly relayDeliveryId?: string;
  /** When the relay received a held request; defaults to now. */
  readonly receivedAt?: string;
}

/** What the HTTP route should answer. `not_found` covers unknown hooks and wrong tokens alike. */
/**
 * What happened to one webhook request, as recorded in metrics and spans.
 * Sent back to the relay as `x-stark-hook-outcome`; never request contents.
 */
export type WebhookDeliveryOutcome =
  | "accepted"
  | "duplicate"
  | "prompt_too_long"
  | "queue_full"
  | "rate_limited"
  | "disabled"
  | "rejected_signature"
  | "expired"
  | "not_found"
  | "error";

export type WebhookTriggerResult =
  | {
      readonly _tag: "accepted";
      readonly deliveryId: ScheduledTaskWebhookDeliveryId;
      /** A 202 covers more than a started run; this says which. */
      readonly outcome: "accepted" | "duplicate" | "prompt_too_long";
    }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "rejected_signature" }
  | { readonly _tag: "disabled" }
  | {
      readonly _tag: "rate_limited";
      /** Too many requests to this hook, or too many runs already waiting. */
      readonly outcome: "rate_limited" | "queue_full";
    }
  | { readonly _tag: "expired" };

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);
const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const MissingFieldsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeHeadersJson = Schema.decodeUnknownOption(HeadersJson);
const decodeMissingFieldsJson = Schema.decodeUnknownOption(MissingFieldsJson);
const encodeHeadersJson = Schema.encodeSync(HeadersJson);
const encodeMissingFieldsJson = Schema.encodeSync(MissingFieldsJson);

interface ScheduledTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  readonly run_count: number;
  readonly webhook_token: string | null;
  readonly webhook_secret: string | null;
}

interface WebhookDeliveryRow {
  readonly delivery_id: string;
  readonly task_id: string;
  readonly received_at: string;
  readonly method: string;
  readonly query: string;
  readonly headers_json: string;
  readonly body: string;
  readonly body_bytes: number;
  readonly body_truncated: number;
  readonly outcome: string;
  readonly signature_verified: number;
  readonly missing_fields_json: string;
  readonly rendered_prompt: string | null;
  readonly error: string | null;
}

/** What a scheduled run's prompt was sent as, for reading back what became of it. */
export interface ScheduledTaskRunTarget {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  /** The bound thread of a send, or the thread a launch created once that is known. */
  readonly threadId: ThreadId | null;
  readonly dispatchKind: RunDispatchKind;
  /** The agent run the scheduled run follows, once one was observed. */
  readonly agentRunId: RunId | null;
}

/** What the orchestrator recorded for a run's prompt, as read after a restart. */
export type ScheduledTaskRunRecovery =
  /** No command was recorded: the server stopped before the prompt went out. */
  | { readonly _tag: "NotDispatched" }
  | { readonly _tag: "Rejected"; readonly threadId: ThreadId | null }
  /** A launch created its thread, but the prompt was never sent to it. */
  | { readonly _tag: "ThreadOnly"; readonly threadId: ThreadId }
  /** The prompt was accepted but its thread or run can no longer be found. */
  | { readonly _tag: "Missing"; readonly threadId: ThreadId | null }
  /** The agent run, following restart continuations, read at `sequence` or later. */
  | { readonly _tag: "Observed"; readonly run: OrchestrationV2Run; readonly sequence: number }
  /** The records could not be read; the run is left for the next pass. */
  | { readonly _tag: "Unknown" };

export type ScheduledTaskRunInspector = (
  target: ScheduledTaskRunTarget,
) => Effect.Effect<ScheduledTaskRunRecovery>;

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    /** Emits the full task list on subscribe and again after every change (CRUD, run transitions, reschedules). */
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    /** Partial update flipping only the enabled flag; never touches other fields. */
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
    /** Issues a new URL token for a webhook task; the old URL stops working at once. */
    readonly rotateWebhookToken: (
      input: ScheduledTaskRotateWebhookTokenInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly listWebhookDeliveries: (
      input: ScheduledTaskListWebhookDeliveriesInput,
    ) => Effect.Effect<ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskError>;
    readonly getWebhookDelivery: (
      input: ScheduledTaskGetWebhookDeliveryInput,
    ) => Effect.Effect<ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskError>;
    /**
     * Verifies, logs and dispatches one webhook request. Returns as soon as the
     * delivery is logged; the run itself continues in the background so senders
     * with short timeouts get their answer immediately.
     */
    readonly triggerWebhook: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>;
    /** Newest runs of one task, newest first. */
    readonly listRuns: (
      input: ScheduledTaskListRunsInput,
    ) => Effect.Effect<ScheduledTaskListRunsResult, ScheduledTaskError>;
    /**
     * Applies one orchestration run event, stored at `sequence`, to the
     * scheduled runs it belongs to. Fed by ScheduledTaskRunTracker.
     */
    readonly observeRun: (observation: {
      readonly run: OrchestrationV2Run;
      readonly sequence: number;
    }) => Effect.Effect<void, ScheduledTaskError>;
    /**
     * Settles runs a stopped server left open, asking `inspect` what the
     * orchestrator recorded for each. Runs this server is still holding are
     * left alone. ScheduledTaskRunTracker calls it once it follows run events.
     */
    readonly reconcileRuns: (
      inspect: ScheduledTaskRunInspector,
    ) => Effect.Effect<void, ScheduledTaskError>;
  }
>()("stark-code/scheduledTasks/ScheduledTaskService") {}

function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

const isScheduledTaskError = Schema.is(ScheduledTaskError);
const isProviderInstanceDisabled = Schema.is(
  ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
);
const isThreadLaunchError = Schema.is(ThreadLaunchService.ThreadLaunchError);

/**
 * A run on a bound thread uses that thread's own settings, so it starts only
 * while the thread stays within the task's limit. Its reason is the run's
 * visible error; the thread is never widened or changed for the run.
 */
class ScheduledTaskBoundRunRefusedError extends Schema.TaggedError<ScheduledTaskBoundRunRefusedError>()(
  "ScheduledTaskBoundRunRefusedError",
  {
    taskId: ScheduledTaskId,
    threadId: ThreadId,
    reason: Schema.Literals(["inherit", "provider_changed", "above_task_limit"]),
    task: Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
    thread: Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
  },
) {
  override get message(): string {
    return PermissionContainment.boundRunRefusalMessage(this);
  }
}
const isBoundRunRefused = Schema.is(ScheduledTaskBoundRunRefusedError);

/**
 * The fixed reason a run shows for a failed dispatch, which read-scope
 * clients can see, and the thread a failed launch already created. The cause
 * itself can carry request data, so it only reaches the server log.
 */
function dispatchFailure(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  return {
    error: isProviderInstanceDisabled(error)
      ? RUN_ERRORS.providerDisabled
      : isBoundRunRefused(error)
        ? error.message
        : RUN_ERRORS.notStarted,
    threadId: isThreadLaunchError(error) ? (error.threadId ?? null) : null,
  };
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

function nextRunAt(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  from: DateTime.DateTime,
): string | null {
  if (!task.enabled) return null;
  // A stored interval can decode yet overflow the representable DateTime
  // range; an unrepresentable occurrence means the task has no next run.
  try {
    const next = nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next)) ? iso(next) : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

function webhookPath(taskId: string, token: string): string {
  return `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(taskId)}/${token}`;
}

function webhookEndpoint(
  row: Pick<ScheduledTaskRow, "task_id" | "webhook_token" | "webhook_secret">,
  origin: WebhookOrigin | null,
): ScheduledTask["webhook"] {
  if (row.webhook_token === null) return undefined;
  const base = origin?.relayHookBaseUrl ?? null;
  return {
    path: webhookPath(row.task_id, row.webhook_token),
    url: base === null ? null : `${base}/${encodeURIComponent(row.task_id)}/${row.webhook_token}`,
    hasSecret: row.webhook_secret !== null,
  };
}

const decodeRow = (row: ScheduledTaskRow, origin: WebhookOrigin | null = null) =>
  Effect.gen(function* () {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const webhook = schedule.type === "webhook" ? webhookEndpoint(row, origin) : undefined;
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    return yield* decodeTask({
      // The stored id decodes through the task schema so a corrupt value fails
      // as a typed parse error, not a `ScheduledTaskId.make` defect.
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      workspaceStrategy,
      modelSelection,
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastRunError: row.last_run_error,
      runCount: row.run_count,
      ...(webhook === undefined ? {} : { webhook }),
    });
  }).pipe(
    Effect.mapError((cause) => {
      // The typed diagnostic can only carry an id that itself decodes; a
      // corrupt stored id is omitted rather than re-thrown as a defect.
      const taskId = decodeTaskId(row.task_id);
      return taskError("Could not decode schedule task row.", {
        ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
        cause,
      });
    }),
  );

/** Select poll candidates before decoding their schedules or other JSON payloads. */
export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${iso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `;
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is a freeform string at the schema level; a stored value
      // that cannot parse as a DateTime would defect the poll below, so the
      // row is skipped here like any other corrupt row.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});

export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const secretRequests = yield* SecretRequests.SecretRequests;
    const scheduler = yield* Scheduler.Scheduler;
    const maintenance = yield* MaintenanceGate.MaintenanceGate;
    const readWebhookOrigin = yield* ScheduledTaskWebhookOrigin;
    // Optional so narrow test layers keep working; the runtime provides both.
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const runtimePolicy = yield* Effect.serviceOption(RuntimePolicy.RuntimePolicyV2);
    /**
     * The preset a saved task runs: the one it names, else the project's
     * default mode, aligned to what its provider actually runs. Full access is
     * refused for a provider Stark always runs Supervised, rather than stored
     * as a mode it never gets.
     */
    const projectDefaultMode = (input: ScheduledTaskUpsertInput, taskId: ScheduledTaskId) =>
      Option.isSome(serverSettings)
        ? serverSettings.value.getSettings.pipe(
            Effect.mapError((cause) =>
              taskError("Could not read the project's default mode.", { taskId, cause }),
            ),
            Effect.map(
              (settings) =>
                resolveProjectSettings(settings, input.projectId).settings.defaultRuntimeMode,
            ),
          )
        : Effect.succeed(DEFAULT_RUNTIME_MODE);
    const taskCapabilities = (input: ScheduledTaskUpsertInput) =>
      Option.isNone(runtimePolicy)
        ? Effect.succeed(undefined)
        : runtimePolicy.value.permissionCapabilities(input.modelSelection.instanceId);
    const taskRuntimeMode = (input: ScheduledTaskUpsertInput, taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        const requested = input.runtimeMode ?? (yield* projectDefaultMode(input, taskId));
        const capabilities = yield* taskCapabilities(input);
        if (capabilities === undefined) return requested;
        if (requested === "full-access" && clampsToSupervised(capabilities.driver)) {
          return yield* taskError(
            "Full access is not available for this provider. Choose Supervised.",
            { taskId },
          );
        }
        return effectiveRuntimeMode(requested, capabilities);
      });
    /**
     * A sender without the settings-write scope may save a task only at a mode
     * that widens nothing (O12), checked on the mode the task will actually
     * store, whether it was named or resolved from the project default. That
     * is: the narrowest preset; for an existing task, no more than it already
     * allows on the same provider instance; for a new task, no more than the
     * project default every new chat gets (O9) or, for a task bound to a
     * thread, than that thread already runs. RPC authorization only sees a
     * named mode; this check also covers an omitted one.
     */
    const authorizeTaskMode = (input: {
      readonly upsert: ScheduledTaskUpsertInput;
      readonly taskId: ScheduledTaskId;
      readonly existing: ScheduledTask | null;
      readonly runtimeMode: RuntimeMode;
    }) =>
      Effect.gen(function* () {
        if ((yield* DispatchSettingsWrite) !== false) return;
        const { upsert, existing, runtimeMode } = input;
        if (runtimeMode === "approval-required") return;
        const instanceId = upsert.modelSelection.instanceId;
        if (existing !== null) {
          if (
            existing.modelSelection.instanceId === instanceId &&
            PermissionContainment.presetWithin(runtimeMode, existing.runtimeMode)
          )
            return;
        } else {
          const capabilities = yield* taskCapabilities(upsert);
          const projectDefault = yield* projectDefaultMode(upsert, input.taskId);
          const defaultPreset =
            capabilities === undefined
              ? projectDefault
              : effectiveRuntimeMode(projectDefault, capabilities);
          if (PermissionContainment.presetWithin(runtimeMode, defaultPreset)) return;
          const thread =
            upsert.threadId == null
              ? null
              : yield* threadManagement
                  .getThreadShell(upsert.threadId)
                  .pipe(Effect.orElseSucceed(() => null));
          if (
            thread !== null &&
            thread.deletedAt === null &&
            thread.providerInstanceId === instanceId &&
            PermissionContainment.presetWithin(
              runtimeMode,
              PermissionContainment.grantingPreset(
                thread,
                capabilities?.driver === undefined
                  ? undefined
                  : {
                      driver: capabilities.driver,
                      supportedRuntimeModes: capabilities.supportedRuntimeModes,
                    },
              ),
            )
          )
            return;
        }
        return yield* taskError(
          existing === null
            ? "Saving a scheduled task with broader permissions than new chats get needs permission to change settings."
            : "Widening this scheduled task's permissions needs permission to change settings.",
          { taskId: input.taskId },
        );
      });
    // Webhook deliveries for one task dispatch in arrival order rather than
    // being dropped while an earlier delivery is still dispatching.
    const webhookPermits = yield* Ref.make<ReadonlyMap<ScheduledTaskId, Semaphore.Semaphore>>(
      new Map(),
    );
    // Keyed by task id and creation time, so deliveries of a deleted task that
    // finish late release their own count, never a recreated task's.
    const webhookQueued = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const webhookRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(new Map());
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal — an unbounded backlog would just grow memory.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);
    /**
     * Refuses a bound run while its thread asks for more than the task allows
     * (see ScheduledTaskBoundRunRefusedError), so the run's history says why.
     * The run also carries the task's limit as its permission ceiling, and the
     * orchestrator checks it again when the run starts, including after it
     * waited in the queue. A thread that is gone is left to the send.
     */
    const refuseBoundRunAboveTaskLimit = (task: ScheduledTask, threadId: ThreadId) =>
      Effect.gen(function* () {
        const thread = yield* threadManagement.getThreadShell(threadId);
        if (thread === null || thread.deletedAt !== null) return;
        const reason = PermissionContainment.boundRunRefusal({
          task: { ...task, providerInstanceId: task.modelSelection.instanceId },
          thread,
        });
        if (reason === undefined) return;
        const refusal = new ScheduledTaskBoundRunRefusedError({
          taskId: task.id,
          threadId,
          reason,
          task: { runtimeMode: task.runtimeMode, interactionMode: task.interactionMode },
          thread: { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode },
        });
        yield* Effect.logWarning("Refused a scheduled run above its task's limit", {
          taskId: task.id,
          threadId,
          reason,
        });
        return yield* refusal;
      });
    // Webhook runs are detached from the request so the HTTP response does not
    // wait for them, and Run now from the RPC so a client that disconnects
    // cannot stop a dispatch halfway; scoped to the service so shutdown
    // interrupts them.
    const serviceScope = yield* Effect.scope;
    // Runs this process is waiting on or dispatching. A reconcile pass treats
    // every other open run as left behind by a stopped server.
    const heldRuns = yield* Ref.make<ReadonlySet<string>>(new Set());
    const holdRun = (runId: string) => Ref.update(heldRuns, (held) => new Set(held).add(runId));
    const releaseRun = (runId: string) =>
      Ref.update(heldRuns, (held) => {
        const next = new Set(held);
        next.delete(runId);
        return next;
      });
    const newRunId = crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => ScheduledTaskRunId.make(`scheduled-run:${uuid}`)),
      Effect.mapError((cause) => taskError("Could not generate run id.", { cause })),
    );
    const runError = (message: string) => (cause: unknown) => taskError(message, { cause });

    const selectAllRows = () => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        webhook_token,
        webhook_secret
      FROM scheduled_tasks
      ORDER BY updated_at DESC, task_id ASC
    `;

    // Strict decode for the API surface: a corrupt row is a visible error.
    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      const origin = yield* readWebhookOrigin;
      // Keyed by creation time too, so a task recreated under the same id
      // never shows a run of the one it replaced.
      const latestRuns = new Map(
        (yield* selectLatestRuns(sql)).map((run) => [
          `${run.task_id}\u0000${run.task_created_at}`,
          toScheduledTaskRun(run),
        ]),
      );
      return yield* Effect.forEach(
        rows,
        (row) =>
          decodeRow(row, origin).pipe(
            Effect.map((task) => {
              const latestRun = latestRuns.get(`${task.id}\u0000${task.createdAt}`);
              return latestRun === undefined ? task : { ...task, latestRun };
            }),
          ),
        { concurrency: 1 },
      );
    });

    const getRows = (id: ScheduledTaskId) => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        webhook_token,
        webhook_secret
      FROM scheduled_tasks
      WHERE task_id = ${id}
    `;

    /** Load a task, returning `null` when it does not exist; real load/decode failures propagate. */
    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeRow(row, yield* readWebhookOrigin);
    });

    const findWebhookCredentials = (id: ScheduledTaskId) =>
      getRows(id).pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? null
            : { token: rows[0].webhook_token, secret: rows[0].webhook_secret },
        ),
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );

    const newWebhookToken = crypto.randomBytes(32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.mapError((cause) => taskError("Could not generate webhook token.", { cause })),
    );

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // Run-state columns (last_run_*, run_count) are intentionally absent from
    // the conflict clause: they are owned by the run transitions below, and a
    // concurrent settings save must not overwrite an in-flight increment.
    // Check existence in the write itself so an edit cannot undo a deletion
    // that landed after upsert loaded the previous task.
    const saveTask = (
      task: ScheduledTask,
      requireExisting: boolean,
      webhook: {
        readonly token: string | null;
        readonly secret: string | null;
        /** False when the save carried no new secret, so a concurrent change survives. */
        readonly secretChanged: boolean;
      },
    ) =>
      sql<{ task_id: string }>`
        INSERT INTO scheduled_tasks (
          task_id,
          title,
          prompt,
          enabled,
          schedule_json,
          project_id,
          thread_id,
          workspace_strategy_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_by,
          creation_source,
          created_at,
          updated_at,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count,
          webhook_token,
          webhook_secret
        )
        SELECT
          ${task.id},
          ${task.title},
          ${task.prompt},
          ${task.enabled ? 1 : 0},
          ${JSON.stringify(task.schedule)},
          ${task.projectId},
          ${task.threadId},
          ${JSON.stringify(task.workspaceStrategy)},
          ${JSON.stringify(task.modelSelection)},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.createdBy},
          ${task.creationSource},
          ${task.createdAt},
          ${task.updatedAt},
          ${task.nextRunAt},
          ${task.lastRunAt},
          ${task.lastRunStatus},
          ${task.lastRunError},
          ${task.runCount},
          ${webhook.token},
          ${webhook.secret}
        WHERE ${requireExisting ? 0 : 1} = 1
           OR EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${task.id})
        ON CONFLICT (task_id)
        DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          enabled = excluded.enabled,
          schedule_json = excluded.schedule_json,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          workspace_strategy_json = excluded.workspace_strategy_json,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          creation_source = excluded.creation_source,
          updated_at = excluded.updated_at,
          next_run_at = excluded.next_run_at,
          -- Only rotate changes a live token, so a save racing a rotation
          -- cannot bring the old URL back.
          webhook_token = CASE
            WHEN excluded.webhook_token IS NULL THEN NULL
            ELSE COALESCE(scheduled_tasks.webhook_token, excluded.webhook_token)
          END,
          webhook_secret = CASE
            WHEN ${webhook.secretChanged ? 1 : 0} = 1 THEN excluded.webhook_secret
            ELSE scheduled_tasks.webhook_secret
          END
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not save schedule task.", { taskId: task.id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Schedule task not found.", { taskId: task.id }),
        ),
      );

    // A deleted task's runs go with it; threads they started keep running.
    const deleteRow = (id: ScheduledTaskId) =>
      sql
        .withTransaction(
          sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ${id}`.pipe(
            Effect.andThen(sql`DELETE FROM scheduled_task_runs WHERE task_id = ${id}`),
            Effect.andThen(sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete schedule task.", { taskId: id, cause }),
          ),
        );

    // Run-state transitions use targeted UPDATEs (never the full-row upsert) so
    // a completing run cannot resurrect a deleted task or clobber concurrent
    // edits to the task definition.

    /**
     * Reserves a run for its occurrence and marks the task running, in one
     * transaction. A scheduled run moves next_run_at past its slot in the same
     * write whether or not the slot already has a run, so a second tick or a
     * server that stopped mid-run steps over the slot instead of choosing it
     * again forever. A webhook run claims the row its delivery recorded.
     */
    const reserveRun = (input: {
      readonly task: ScheduledTask;
      readonly runId: ScheduledTaskRunId;
      readonly trigger: ScheduledTaskRun["trigger"];
      readonly occurrenceKey: string;
      readonly startedAt: DateTime.DateTime;
      readonly slot: { readonly at: string; readonly next: string | null } | null;
      readonly claimsWaitingRun: boolean;
    }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const startedAtIso = iso(input.startedAt);
            if (input.slot !== null) {
              yield* sql`
                UPDATE scheduled_tasks
                SET next_run_at = ${input.slot.next}, updated_at = ${startedAtIso}
                WHERE task_id = ${input.task.id}
                  AND created_at = ${input.task.createdAt}
                  AND next_run_at = ${input.slot.at}
              `;
            }
            const reserved = input.claimsWaitingRun
              ? yield* sql<{ run_id: string }>`
                  UPDATE scheduled_task_runs
                  SET dispatch_state = 'dispatching', started_at = ${startedAtIso}
                  WHERE run_id = ${input.runId} AND dispatch_state = 'waiting'
                  RETURNING run_id
                `.pipe(Effect.map((rows) => rows.length > 0))
              : yield* insertRun(sql, {
                  runId: input.runId,
                  task: input.task,
                  trigger: input.trigger,
                  occurrenceKey: input.occurrenceKey,
                  webhookDeliveryId: null,
                  dispatchState: "dispatching",
                  createdAt: startedAtIso,
                  startedAt: startedAtIso,
                });
            if (!reserved) {
              const existing = yield* selectRunByOccurrence(sql, input.occurrenceKey);
              return existing === null
                ? ({ _tag: "TaskGone" } as const)
                : ({ _tag: "Existing", run: toScheduledTaskRun(existing) } as const);
            }
            const marked = yield* sql<{ task_id: string }>`
              UPDATE scheduled_tasks
              SET updated_at = ${startedAtIso},
                  last_run_at = ${startedAtIso},
                  last_run_status = 'running',
                  last_run_error = NULL
              WHERE task_id = ${input.task.id}
              RETURNING task_id
            `;
            // A task deleted after the re-read must not be dispatched from the stale snapshot.
            if (marked.length === 0) {
              return yield* taskError("Schedule task not found.", { taskId: input.task.id });
            }
            yield* pruneRuns(sql, input.task.id, DateTime.toUtc(input.startedAt));
            return { _tag: "Reserved" } as const;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isScheduledTaskError(cause)
              ? cause
              : taskError("Could not mark schedule task as running.", {
                  taskId: input.task.id,
                  cause,
                }),
          ),
        );

    /**
     * Records what the launch or send returned. Once an agent run was observed
     * for this run, that observation outranks the dispatch result.
     */
    const recordDispatch = (
      runId: string,
      outcome: {
        readonly threadId: string | null;
        readonly error: string | null;
        readonly at: string;
      },
    ) =>
      sql`
        UPDATE scheduled_task_runs
        SET thread_id = COALESCE(thread_id, ${outcome.threadId}),
            error = CASE WHEN dispatch_state = 'dispatching' THEN ${outcome.error} ELSE error END,
            ended_at = CASE
              WHEN dispatch_state = 'dispatching' AND ${outcome.error} IS NOT NULL THEN ${outcome.at}
              ELSE ended_at
            END,
            dispatch_state = CASE
              WHEN dispatch_state <> 'dispatching' THEN dispatch_state
              WHEN ${outcome.error} IS NULL THEN 'dispatched'
              ELSE 'failed'
            END
        WHERE run_id = ${runId}
      `.pipe(Effect.mapError(runError("Could not record schedule task run.")));

    /** Ends a run whose prompt never reached an agent, if it is still in one of `from`. */
    const settleRun = (input: {
      readonly runId: string;
      readonly from: ReadonlyArray<RunDispatchState>;
      readonly state: "failed" | "skipped" | "interrupted";
      readonly error: string;
      readonly threadId?: string | null;
      /** Drops an observed agent state that can no longer be read. */
      readonly forgetAgent?: boolean;
    }) =>
      Effect.gen(function* () {
        const endedAt = iso(yield* localNow);
        const rows = yield* sql<{ run_id: string }>`
          UPDATE scheduled_task_runs
          SET dispatch_state = ${input.state},
              error = ${input.error},
              ended_at = ${endedAt},
              thread_id = COALESCE(thread_id, ${input.threadId ?? null}),
              agent_status = CASE WHEN ${input.forgetAgent === true ? 1 : 0} = 1 THEN NULL ELSE agent_status END
          WHERE run_id = ${input.runId} AND dispatch_state IN ${sql.in(input.from)}
          RETURNING run_id
        `;
        return rows.length > 0;
      }).pipe(Effect.mapError(runError("Could not record schedule task run.")));

    const loadRun = (runId: string) =>
      selectRun(sql, runId).pipe(
        Effect.map((row) => (row === null ? null : toScheduledTaskRun(row))),
        Effect.mapError(runError("Could not load schedule task run.")),
      );

    const markCompleted = (input: {
      readonly id: ScheduledTaskId;
      readonly completedAtIso: string;
      readonly nextRunAtIso: string | null;
      readonly status: "succeeded" | "failed";
      readonly error: string | null;
      readonly startedAtIso: string;
    }) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${input.completedAtIso},
            next_run_at = ${input.nextRunAtIso},
            last_run_status = ${input.status},
            last_run_error = ${input.error},
            run_count = run_count + 1
        WHERE task_id = ${input.id}
          AND last_run_status = 'running'
          AND last_run_at = ${input.startedAtIso}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    // Best-effort escape hatch: if anything fails between markRunning and
    // markCompleted, write a full terminal record so runDueTasks neither skips
    // the task forever (it filters out 'running' rows) nor re-fires it
    // immediately: the dispatch may already have gone out, so next_run_at must
    // advance and run_count must count the attempt.
    const releaseStuckRun = (task: ScheduledTask, message: string) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        // Compute the next occurrence from the current row so a schedule
        // edited while the run was in flight is honoured; fall back to the
        // run's snapshot only if the re-read itself fails.
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return; // deleted — nothing to release
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${message},
              next_run_at = ${nextRunAt(source, now)},
              updated_at = ${iso(now)},
              run_count = run_count + 1
          WHERE task_id = ${task.id} AND last_run_status = 'running'
        `;
        yield* notifyChanged;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not release stuck schedule task run", {
            taskId: task.id,
            cause,
          }),
        ),
      );

    /** How a run was triggered, plus what each trigger brings with it. */
    interface RunContext {
      readonly trigger: ScheduledTaskRun["trigger"];
      /** A manual run's click id: a repeated request with it returns the run it started. */
      readonly clickId?: string | undefined;
      /** A webhook run: its delivery, the prompt rendered from it, and the run recorded with it. */
      readonly webhook?: {
        readonly deliveryId: string;
        readonly prompt: string;
        readonly runId: ScheduledTaskRunId;
      };
    }

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      context: RunContext,
    ) {
      const { trigger, webhook } = context;
      if (trigger === "manual" && context.clickId !== undefined) {
        const repeated = yield* selectRunByOccurrence(
          sql,
          occurrenceKeys.manual(task, context.clickId),
        ).pipe(Effect.mapError(runError("Could not load schedule task run.")));
        if (repeated !== null) return { task, run: toScheduledTaskRun(repeated) };
      }
      const reserved = yield* Ref.modify(activeRuns, (active) => {
        if (active.has(task.id)) return [false, active] as const;
        const next = new Set(active);
        next.add(task.id);
        return [true, next] as const;
      });
      if (!reserved) {
        if (trigger !== "scheduled") {
          return yield* taskError("Schedule task is already running.", { taskId: task.id });
        }
        return { task, run: null };
      }
      // A webhook run was held when its delivery was accepted, and its
      // delivery releases it.
      const runId = webhook?.runId ?? (yield* newRunId);
      if (webhook === undefined) yield* holdRun(runId);

      return yield* Effect.gen(function* () {
        const startedAt = yield* localNow;
        const startedAtIso = iso(startedAt);

        // The in-memory snapshot may be stale: re-read before touching run
        // state. The task may have been deleted, paused, or postponed since
        // the poll loaded it — none of those may fire.
        const active = yield* findTask(task.id);
        if (active === null) {
          if (webhook !== undefined) {
            return yield* new WebhookDeliverySkipped({
              reason: "The task was deleted before this delivery ran.",
            });
          }
          // A manual run on a just-deleted task must fail loudly, not report
          // a successful run that never dispatched.
          if (trigger !== "scheduled") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return { task, run: null };
        }
        // A next_run_at corrupted between the poll read and this re-read must
        // not defect the poll; an unparseable value is treated as not due.
        const parsedNextRunAt =
          active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
        if (
          trigger === "scheduled" &&
          (!active.enabled ||
            Option.isNone(parsedNextRunAt) ||
            DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
        ) {
          return { task: active, run: null };
        }
        // A queued delivery must not run a task that was paused, deleted and
        // recreated under the same id, or switched to another trigger while
        // it waited for its turn.
        if (webhook !== undefined) {
          const reason =
            active.createdAt !== task.createdAt
              ? "The task was replaced before this delivery ran."
              : active.schedule.type !== "webhook"
                ? "The task's trigger changed before this delivery ran."
                : !active.enabled
                  ? "The task was paused before this delivery ran."
                  : null;
          if (reason !== null) return yield* new WebhookDeliverySkipped({ reason });
        }

        const slot = trigger === "scheduled" ? active.nextRunAt : null;
        const occurrenceKey =
          webhook !== undefined
            ? occurrenceKeys.webhook(active.id, webhook.deliveryId)
            : slot !== null
              ? occurrenceKeys.scheduled(active, slot)
              : occurrenceKeys.manual(active, context.clickId ?? runId);
        const reservation = yield* maintenanceGuardReservation(
          maintenance,
          trigger,
          webhook !== undefined,
          reserveRun({
            task: active,
            runId,
            trigger,
            occurrenceKey,
            startedAt,
            slot: slot === null ? null : { at: slot, next: nextRunAt(active, startedAt) },
            claimsWaitingRun: webhook !== undefined,
          }),
        );
        if (reservation === "maintenance-skipped") return { task: active, run: null };
        if (reservation._tag === "TaskGone") {
          if (webhook !== undefined) {
            return yield* new WebhookDeliverySkipped({
              reason: "The task was deleted before this delivery ran.",
            });
          }
          if (trigger !== "scheduled") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return { task: active, run: null };
        }
        if (reservation._tag === "Existing") {
          if (webhook !== undefined) {
            return yield* new WebhookDeliverySkipped({ reason: RUN_ERRORS.alreadyRan });
          }
          if (slot !== null) {
            yield* Effect.logInfo("Stepping over a scheduled slot that already has a run", {
              taskId: active.id,
              slot,
            });
            yield* notifyChanged;
          }
          return { task: active, run: reservation.run };
        }
        yield* notifyChanged;

        const commandId = runCommandId(occurrenceKey);
        const messageId = runMessageId(occurrenceKey);
        // Dispatch from the fresh row so prompt/model/binding edits made
        // after the poll read are honoured. A webhook prompt was rendered
        // from the row when the request arrived.
        const prompt = webhook?.prompt ?? active.prompt;

        // Effect.exit (not Effect.result) so defects and interruptions in the
        // dispatch are also captured and recorded as a failed run instead of
        // aborting before markCompleted.
        const result =
          active.threadId === null
            ? yield* Effect.exit(
                threadLaunch
                  .launch({
                    commandId,
                    projectId: active.projectId,
                    title: active.title,
                    modelSelection: active.modelSelection,
                    runtimeMode: active.runtimeMode,
                    interactionMode: active.interactionMode,
                    // Scheduled chats run their task's preset, never inherited settings.
                    permissionSource: "override",
                    workspaceStrategy: active.workspaceStrategy,
                    initialMessage: {
                      messageId,
                      scheduledTaskId: active.id,
                      text: prompt,
                      attachments: [],
                    },
                    createdBy: active.createdBy,
                    creationSource: active.creationSource,
                  })
                  .pipe(Effect.map((launched) => launched.threadId)),
              )
            : yield* Effect.exit(
                refuseBoundRunAboveTaskLimit(active, ThreadId.make(active.threadId)).pipe(
                  Effect.andThen(
                    threadManagement.sendToThread({
                      projectId: active.projectId,
                      commandId,
                      threadId: ThreadId.make(active.threadId),
                      messageId,
                      scheduledTaskId: active.id,
                      text: prompt,
                      attachments: [],
                      modelSelection: active.modelSelection,
                      // Scheduled prompts must not interrupt tools in the bound thread.
                      mode: "queue",
                      permissionCeiling: {
                        providerInstanceId: active.modelSelection.instanceId,
                        runtimeMode: active.runtimeMode,
                        interactionMode: active.interactionMode,
                      },
                      createdBy: active.createdBy,
                      creationSource: active.creationSource,
                    }),
                  ),
                  // The bound thread was recorded when the run was reserved.
                  Effect.as(null),
                ),
              );

        const completedAt = yield* localNow;
        const runSucceeded = result._tag === "Success";
        const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
        const lastRunError = runSucceeded ? null : errorMessage(result.cause);
        const failure = result._tag === "Success" ? null : dispatchFailure(result.cause);
        yield* recordDispatch(runId, {
          threadId: result._tag === "Success" ? result.value : (failure?.threadId ?? null),
          error: failure?.error ?? null,
          at: iso(completedAt),
        });
        // Re-read the task so the next run is computed from the schedule as it
        // is *now* (the user may have edited or deleted it while we ran).
        const current = yield* findTask(task.id);
        const scheduleSource = current ?? task;
        const completed: ScheduledTask = {
          ...scheduleSource,
          updatedAt: iso(completedAt),
          lastRunAt: startedAtIso,
          nextRunAt: nextRunAt(scheduleSource, completedAt),
          lastRunStatus,
          lastRunError,
          runCount: scheduleSource.runCount + 1,
        };
        if (current !== null) {
          // startedAtIso in the guard ensures this writes only to the row this
          // run marked as running — a task deleted mid-run and recreated with
          // the same id (idempotent commandId replay) must not be stamped.
          yield* markCompleted({
            id: task.id,
            completedAtIso: completed.updatedAt,
            nextRunAtIso: completed.nextRunAt,
            status: lastRunStatus,
            error: lastRunError,
            startedAtIso,
          });
        }
        yield* notifyChanged;
        return { task: completed, run: yield* loadRun(runId) };
      }).pipe(
        Effect.onError((cause) => releaseStuckRun(task, errorMessage(cause))),
        Effect.ensuring(
          Ref.update(activeRuns, (active) => {
            const next = new Set(active);
            next.delete(task.id);
            return next;
          }).pipe(Effect.andThen(webhook === undefined ? releaseRun(runId) : Effect.void)),
        ),
      );
    });

    // A due fixed-time run that is long past its slot (server was off or
    // asleep) is skipped and re-aimed at its next occurrence, not fired late.
    // The skipped slot is kept as a run, so the history explains the gap.
    const rescheduleMissedRun = Effect.fn("ScheduledTaskService.rescheduleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
    ) {
      const next = nextRunAt(task, now);
      const slot = task.nextRunAt;
      const runId = yield* newRunId;
      yield* Effect.logInfo("Skipping missed schedule task run", {
        taskId: task.id,
        missedRunAt: slot,
        rescheduledTo: next,
      });
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE scheduled_tasks
              SET next_run_at = ${next},
                  updated_at = ${iso(now)}
              WHERE task_id = ${task.id}
            `;
            if (slot === null) return;
            yield* insertRun(sql, {
              runId,
              task,
              trigger: "scheduled",
              occurrenceKey: occurrenceKeys.missed(task, slot),
              webhookDeliveryId: null,
              dispatchState: "skipped",
              error: RUN_ERRORS.missedSlot,
              createdAt: slot,
              startedAt: null,
              endedAt: iso(now),
            });
            yield* pruneRuns(sql, task.id, DateTime.toUtc(now));
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not reschedule missed schedule task run.", {
              taskId: task.id,
              cause,
            }),
          ),
        );
      yield* notifyChanged;
    });

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      const now = yield* localNow;
      const tasks = yield* listDueTasks(now).pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null ? [] : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          Effect.suspend(() =>
            isMissedFixedTimeRun(task.schedule, dueAt, now)
              ? rescheduleMissedRun(task, now)
              : runTask(task, { trigger: "scheduled" }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    // Recover from a crash or hard shutdown mid-run: rows stuck in 'running'
    // would otherwise be skipped by the due-task filter forever. The dispatch
    // may already have gone out before the crash, so next_run_at must advance
    // and run_count must count the attempt — otherwise the first poll after
    // every restart re-fires the interrupted task (same rationale as
    // releaseStuckRun). Schedules are JSON, so this is per-row Effect work
    // rather than a single UPDATE.
    yield* Effect.gen(function* () {
      const rows = yield* selectAllRows();
      const stuck = rows.filter((row) => row.last_run_status === "running");
      if (stuck.length === 0) return;
      const now = yield* localNow;
      yield* Effect.forEach(
        stuck,
        (row) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.result(decodeRow(row));
            if (Result.isSuccess(decoded)) {
              yield* sql`
                UPDATE scheduled_tasks
                SET last_run_status = 'failed',
                    last_run_error = 'Run was interrupted by a server restart.',
                    next_run_at = ${nextRunAt(decoded.success, now)},
                    updated_at = ${iso(now)},
                    run_count = run_count + 1
                WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
              `;
              return;
            }
            // The schedule cannot be decoded, so the next occurrence cannot
            // be computed — still release the row so it is not stuck in
            // 'running' (the lenient poller skips it, so it cannot re-fire).
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = 'Run was interrupted by a server restart.',
                  updated_at = ${iso(now)},
                  run_count = run_count + 1
              WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
            `;
          }),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );

    yield* scheduler.register("scheduled-tasks", runDueTasks());

    const list: ScheduledTaskService["Service"]["list"] = () =>
      listRows().pipe(
        Effect.map((tasks) => ({ tasks })),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: ScheduledTaskService["Service"]["upsert"] = (input) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        const uuid =
          input.commandId === undefined
            ? yield* crypto
                .randomUUIDv4()
                .pipe(
                  Effect.mapError((cause) =>
                    taskError("Could not generate schedule task id.", { cause }),
                  ),
                )
            : null;
        const id =
          input.id ??
          ScheduledTaskId.make(
            input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
          );
        // Look up by the *resolved* id so idempotent creates (commandId replays)
        // keep their run history, and so real load failures propagate instead
        // of silently resetting an existing row.
        const existingTask = yield* findTask(id);
        // Keep the existing next_run_at when the schedule itself is untouched:
        // editing a title or prompt must not postpone (or resurrect) a due
        // run — only schedule/enabled changes restart the clock.
        const schedule: ScheduledTask["schedule"] =
          input.schedule.type === "webhook"
            ? {
                type: "webhook",
                signature:
                  input.schedule.signature == null
                    ? null
                    : {
                        header: input.schedule.signature.header.toLowerCase(),
                        encoding: input.schedule.signature.encoding,
                        prefix: input.schedule.signature.prefix,
                      },
                maxDeliveryAgeMinutes: input.schedule.maxDeliveryAgeMinutes ?? null,
              }
            : input.schedule;
        const webhook =
          input.schedule.type === "webhook"
            ? yield* Effect.gen(function* () {
                const existing = existingTask === null ? null : yield* findWebhookCredentials(id);
                // Saving a webhook task keeps its URL; only rotate changes it.
                const token = existing?.token ?? (yield* newWebhookToken);
                const signature =
                  input.schedule.type === "webhook" ? input.schedule.signature : null;
                // A secretRef is a value the user entered for an agent; this
                // save consumes it, so it cannot be used again. A replay of a
                // save that already used it keeps the secret that save stored.
                const replay = input.commandId !== undefined && existing?.secret != null;
                const fromRef =
                  signature?.secretRef === undefined
                    ? undefined
                    : yield* secretRequests
                        .consume({ ref: signature.secretRef, projectId: input.projectId })
                        .pipe(
                          Effect.catch((error) =>
                            replay
                              ? Effect.succeed(undefined)
                              : Effect.fail(taskError(error.message, { taskId: id })),
                          ),
                        );
                // A ref, when given, is the only source: a plain secret sent
                // alongside it must not replace what a replayed save stored.
                const provided = signature?.secretRef === undefined ? signature?.secret : fromRef;
                const secret = signature == null ? null : (provided ?? existing?.secret ?? null);
                const secretChanged =
                  signature == null || provided !== undefined || existing === null;
                if (signature != null && secret === null) {
                  return yield* taskError("A webhook signature check needs a signing secret.", {
                    taskId: id,
                  });
                }
                return { token, secret, secretChanged };
              })
            : { token: null, secret: null, secretChanged: true };
        const runtimeMode = yield* taskRuntimeMode(input, id);
        yield* authorizeTaskMode({
          upsert: input,
          taskId: id,
          existing: existingTask,
          runtimeMode,
        });
        const scheduleUnchanged =
          existingTask !== null &&
          existingTask.enabled === input.enabled &&
          isSameSchedule(existingTask.schedule, schedule);
        const task: ScheduledTask = {
          id,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule,
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          runtimeMode,
          interactionMode: input.interactionMode,
          createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
          creationSource: input.creationSource ?? "web",
          createdAt: existingTask?.createdAt ?? iso(now),
          updatedAt: iso(now),
          nextRunAt: scheduleUnchanged
            ? existingTask.nextRunAt
            : nextRunAt({ enabled: input.enabled, schedule }, now),
          lastRunAt: existingTask?.lastRunAt ?? null,
          lastRunStatus: existingTask?.lastRunStatus ?? "never",
          lastRunError: existingTask?.lastRunError ?? null,
          runCount: existingTask?.runCount ?? 0,
        };
        yield* saveTask(task, input.requireExisting === true, webhook);
        yield* notifyChanged;
        return { task: (yield* findTask(id)) ?? task };
      });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* loadTask(input.id);
        if (existing.enabled === input.enabled) return { task: existing };
        const now = yield* localNow;
        const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
        // RETURNING so a task deleted between the load and this UPDATE is a
        // visible not-found error, not a false success.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET enabled = ${input.enabled ? 1 : 0},
              next_run_at = ${next},
              updated_at = ${iso(now)}
          WHERE task_id = ${input.id}
          RETURNING task_id
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not update schedule task.", { taskId: input.id, cause }),
          ),
        );
        if (updated.length === 0) {
          return yield* taskError("Schedule task not found.", { taskId: input.id });
        }
        yield* notifyChanged;
        return {
          task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
        };
      });

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(
        Effect.andThen(
          Effect.all([
            Ref.update(webhookRateWindows, (windows) => {
              const next = new Map(windows);
              next.delete(input.id);
              return next;
            }),
            Ref.update(webhookPermits, (permits) => {
              const next = new Map(permits);
              next.delete(input.id);
              return next;
            }),
          ]),
        ),
        Effect.andThen(notifyChanged),
        Effect.as({ id: input.id }),
      );

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        if (task.schedule.type === "webhook") {
          // There is no request to render the prompt from.
          return yield* taskError("Webhook tasks run when their URL receives a request.", {
            taskId: input.id,
          });
        }
        const outcome = yield* runTask(task, { trigger: "manual", clickId: input.commandId }).pipe(
          // The run belongs to the service, not the request: a client that
          // disconnects mid-dispatch must not leave it half-recorded.
          Effect.forkIn(serviceScope),
          Effect.flatMap(Fiber.join),
          Effect.mapError((cause) =>
            taskError("Could not run schedule task.", { taskId: input.id, cause }),
          ),
        );
        const { task: next, run } = outcome;
        return run === null ? { task: next } : { task: next, run };
      });

    const rotateWebhookToken: ScheduledTaskService["Service"]["rotateWebhookToken"] = (input) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        if (task.schedule.type !== "webhook") {
          return yield* taskError("Only webhook tasks have a URL token.", { taskId: input.id });
        }
        const token = yield* newWebhookToken;
        const now = yield* localNow;
        // Matching created_at keeps a rotation from landing on a task deleted
        // and recreated under the same id since it was loaded.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET webhook_token = ${token}, updated_at = ${iso(now)}
          WHERE task_id = ${input.id} AND created_at = ${task.createdAt}
          RETURNING task_id
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not rotate webhook token.", { taskId: input.id, cause }),
          ),
        );
        if (updated.length === 0) {
          return yield* taskError("Schedule task was deleted or replaced.", { taskId: input.id });
        }
        yield* notifyChanged;
        return { task: yield* loadTask(input.id) };
      });

    const deliveryHeaders = (row: WebhookDeliveryRow): Readonly<Record<string, string>> =>
      Option.getOrElse(decodeHeadersJson(row.headers_json), () => ({}));
    const decodeDeliverySummary = (row: WebhookDeliveryRow) => ({
      id: ScheduledTaskWebhookDeliveryId.make(row.delivery_id),
      taskId: ScheduledTaskId.make(row.task_id),
      receivedAt: row.received_at,
      method: row.method,
      contentType: deliveryHeaders(row)["content-type"] ?? null,
      bodyBytes: row.body_bytes,
      outcome: row.outcome as ScheduledTaskWebhookDeliveryOutcome,
      signatureVerified: row.signature_verified === 1,
      missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
      error: row.error,
    });

    const listWebhookDeliveries: ScheduledTaskService["Service"]["listWebhookDeliveries"] = (
      input,
    ) =>
      sql<WebhookDeliveryRow>`
        SELECT * FROM scheduled_task_webhook_deliveries
        WHERE task_id = ${input.id}
        ORDER BY received_at DESC, rowid DESC
      `.pipe(
        Effect.map((rows) => ({ deliveries: rows.map(decodeDeliverySummary) })),
        Effect.mapError((cause) =>
          taskError("Could not list webhook deliveries.", { taskId: input.id, cause }),
        ),
      );

    const getWebhookDelivery: ScheduledTaskService["Service"]["getWebhookDelivery"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<WebhookDeliveryRow>`
          SELECT * FROM scheduled_task_webhook_deliveries
          WHERE task_id = ${input.id} AND delivery_id = ${input.deliveryId}
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not load webhook delivery.", { taskId: input.id, cause }),
          ),
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* taskError("Webhook delivery not found.", { taskId: input.id });
        }
        return {
          delivery: {
            ...decodeDeliverySummary(row),
            query: row.query,
            headers: deliveryHeaders(row),
            body: row.body,
            bodyTruncated: row.body_truncated === 1,
            renderedPrompt: row.rendered_prompt,
          },
        };
      });

    const recordDelivery = (input: {
      readonly id: string;
      readonly taskId: ScheduledTaskId;
      readonly receivedAt: string;
      readonly request: WebhookTriggerRequest;
      readonly outcome: ScheduledTaskWebhookDeliveryOutcome;
      readonly signatureVerified: boolean;
      readonly missing: ReadonlyArray<string>;
      readonly renderedPrompt: string | null;
      readonly error?: string;
      /** The run an accepted delivery waits as, written with the log entry so neither exists without the other. */
      readonly run?: { readonly row: NewRun; readonly now: DateTime.DateTime };
    }) => {
      const truncated = input.request.body.byteLength > WEBHOOK_DELIVERY_LOG_BODY_LIMIT;
      const loggedBody = truncated
        ? new TextDecoder().decode(input.request.body.subarray(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT))
        : input.request.bodyText;
      return sql
        .withTransaction(
          Effect.gen(function* () {
            // Conditional on the task existing, so a delivery racing a delete
            // cannot leave rows that a recreated task with the same id would show.
            yield* sql`
              INSERT INTO scheduled_task_webhook_deliveries (
                delivery_id, task_id, received_at, method, query, headers_json, body,
                body_bytes, body_truncated, outcome, signature_verified,
                missing_fields_json, rendered_prompt, error
              )
              SELECT
                ${input.id}, ${input.taskId}, ${input.receivedAt}, ${input.request.method},
                ${redactQuery(input.request.query)},
                ${encodeHeadersJson(redactHeaders(input.request.headers))},
                ${loggedBody},
                ${input.request.body.byteLength}, ${truncated ? 1 : 0}, ${input.outcome},
                ${input.signatureVerified ? 1 : 0}, ${encodeMissingFieldsJson(input.missing)},
                ${input.renderedPrompt?.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT) ?? null},
                ${input.error ?? null}
              WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${input.taskId})
              -- A held request retried after a rate limit reuses its relay
              -- delivery id; the newer attempt replaces the logged one.
              ON CONFLICT (delivery_id) DO UPDATE SET
                outcome = excluded.outcome,
                signature_verified = excluded.signature_verified,
                missing_fields_json = excluded.missing_fields_json,
                rendered_prompt = excluded.rendered_prompt,
                error = excluded.error
            `;
            yield* sql`
            DELETE FROM scheduled_task_webhook_deliveries
            WHERE task_id = ${input.taskId}
              AND delivery_id NOT IN (
                SELECT delivery_id FROM scheduled_task_webhook_deliveries
                WHERE task_id = ${input.taskId}
                -- rowid breaks timestamp ties in arrival order; delivery ids are random.
                ORDER BY received_at DESC, rowid DESC
                LIMIT ${WEBHOOK_DELIVERY_RETENTION}
              )
          `;
            if (input.run !== undefined) {
              yield* insertRun(sql, input.run.row);
              yield* pruneRuns(sql, input.taskId, DateTime.toUtc(input.run.now));
            }
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not record webhook delivery.", { taskId: input.taskId, cause }),
          ),
        );
    };

    const markDeliveryFailed = (deliveryId: string, message: string) =>
      sql`
        UPDATE scheduled_task_webhook_deliveries
        SET outcome = 'dispatch_failed', error = ${message}
        WHERE delivery_id = ${deliveryId}
      `.pipe(Effect.ignore);

    /**
     * Sliding one-minute window counting every request with a valid token,
     * including ones the signature check later rejects.
     */
    const takeRateSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(
        webhookRateWindows,
        (
          windows,
        ): readonly [
          "allowed" | "first_rejected" | "rejected",
          ReadonlyMap<ScheduledTaskId, RateWindow>,
        ] => {
          const current = windows.get(id);
          const recent = (current?.accepted ?? []).filter((at) => nowMs - at < 60_000);
          if (recent.length >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
            const first = current?.rejectedLogged !== true;
            return [
              first ? "first_rejected" : "rejected",
              new Map(windows).set(id, { accepted: recent, rejectedLogged: true }),
            ];
          }
          return [
            "allowed",
            new Map(windows).set(id, { accepted: [...recent, nowMs], rejectedLogged: false }),
          ];
        },
      );

    const webhookPermit = (id: ScheduledTaskId) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(webhookPermits)).get(id);
        if (existing !== undefined) return existing;
        const created = yield* Semaphore.make(1);
        return yield* Ref.modify(webhookPermits, (permits) => {
          const raced = permits.get(id);
          return raced === undefined
            ? [created, new Map(permits).set(id, created)]
            : [raced, permits];
        });
      });

    /**
     * Records one handled request on the span and in metrics. `outcome` is
     * finer than the result tag: it separates a full queue and an oversized
     * prompt from the rest, which is what an operator needs to act on.
     */
    const observeDelivery = (
      request: WebhookTriggerRequest,
      outcome: WebhookDeliveryOutcome,
      receivedAt: DateTime.DateTime | undefined,
      now: DateTime.DateTime | undefined,
    ) =>
      Effect.gen(function* () {
        const source = request.relayDeliveryId === undefined ? "direct" : "relay";
        yield* Effect.annotateCurrentSpan({
          "scheduled_task.webhook.outcome": outcome,
          "scheduled_task.webhook.source": source,
        });
        yield* Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome, source });
        if (request.receivedAt !== undefined && receivedAt !== undefined && now !== undefined) {
          const heldMs = Math.max(
            0,
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt),
          );
          yield* Effect.annotateCurrentSpan({ "scheduled_task.webhook.held_ms": heldMs });
          yield* Metric.update(Metrics.webhookHeldDelay, Duration.millis(heldMs));
        }
      });

    const triggerWebhook: ScheduledTaskService["Service"]["triggerWebhook"] = (request) =>
      triggerWebhookUnobserved(request).pipe(
        Effect.tapError(() => observeDelivery(request, "error", undefined, undefined)),
        Metrics.withMetrics({ timer: Metrics.webhookDeliveryDuration }),
        Effect.withSpan("ScheduledTaskService.triggerWebhook", {
          attributes: {
            "scheduled_task.webhook.method": request.method,
            "scheduled_task.webhook.body_bytes": request.body.byteLength,
            "scheduled_task.webhook.source":
              request.relayDeliveryId === undefined ? "direct" : "relay",
          },
        }),
      );

    const triggerWebhookUnobserved = (request: WebhookTriggerRequest) =>
      Effect.gen(function* () {
        const taskId = decodeTaskId(request.hookId);
        const notFound = observeDelivery(request, "not_found", undefined, undefined).pipe(
          Effect.as({ _tag: "not_found" as const }),
        );
        if (Option.isNone(taskId)) return yield* notFound;
        const rows = yield* getRows(taskId.value).pipe(
          Effect.mapError((cause) =>
            taskError("Could not load schedule task.", { taskId: taskId.value, cause }),
          ),
        );
        const row = rows[0];
        // A wrong token is indistinguishable from an unknown hook, so the URL
        // does not reveal which hooks exist.
        if (
          row === undefined ||
          row.webhook_token === null ||
          !constantTimeEquals(request.token, row.webhook_token)
        ) {
          return yield* notFound;
        }
        const task = yield* decodeRow(row);
        yield* Effect.annotateCurrentSpan({ "scheduled_task.id": task.id });
        const schedule = task.schedule;
        if (schedule.type !== "webhook") return yield* notFound;

        const now = yield* localNow;
        // Anyone can reach the tunnel directly and set the relay's header, so
        // a receive time is never later than now: a future one would pin the
        // delivery in the log and slip past the task's max age.
        const receivedAt =
          request.receivedAt === undefined
            ? now
            : DateTime.min(
                Option.getOrElse(DateTime.make(request.receivedAt), () => now),
                now,
              );
        const observe = (outcome: WebhookDeliveryOutcome) =>
          observeDelivery(request, outcome, receivedAt, now);
        const deliveryId = ScheduledTaskWebhookDeliveryId.make(
          request.relayDeliveryId === undefined
            ? `delivery:${yield* crypto
                .randomUUIDv4()
                .pipe(
                  Effect.mapError((cause) =>
                    taskError("Could not generate delivery id.", { cause }),
                  ),
                )}`
            : `delivery:relay:${request.relayDeliveryId}`,
        );
        // A held request may already have reached this environment directly
        // before a timeout; it runs once. Claimed in its own table, kept longer
        // than the relay holds a request, because the delivery log is trimmed.
        // A rate-limited delivery stays held on the relay, so it must give up
        // its claim or the next pass would treat it as already delivered.
        const releaseClaim = <A>(result: A) =>
          request.relayDeliveryId === undefined
            ? Effect.succeed(result)
            : sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE relay_delivery_id = ${request.relayDeliveryId}
              `.pipe(Effect.ignore, Effect.as(result));
        // From the claim until the run is forked nothing may interrupt: a
        // request dropped in between (the relay hangs up after its timeout)
        // would leave a claimed delivery that never runs, or a queue slot
        // that is never released. Everything in here is local and quick.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (request.relayDeliveryId !== undefined) {
              const claimed = yield* sql<{ relay_delivery_id: string }>`
                INSERT INTO scheduled_task_webhook_relay_deliveries
                  (relay_delivery_id, task_id, seen_at)
                VALUES (${request.relayDeliveryId}, ${task.id}, ${iso(now)})
                ON CONFLICT (relay_delivery_id) DO NOTHING
                RETURNING relay_delivery_id
              `.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not record webhook delivery.", { taskId: task.id, cause }),
                ),
              );
              if (claimed.length === 0) {
                // A held request this environment already ran: accepted, not run twice.
                yield* observe("duplicate");
                return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
              }
              // Older claims can no longer be replayed by the relay.
              yield* sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE seen_at < ${iso(DateTime.subtract(now, { hours: 48 }))}
              `.pipe(Effect.ignore);
            }
            const log = (
              outcome: ScheduledTaskWebhookDeliveryOutcome,
              details: {
                readonly signatureVerified?: boolean;
                readonly missing?: ReadonlyArray<string>;
                readonly renderedPrompt?: string;
                readonly error?: string;
                readonly run?: NewRun;
              } = {},
            ) =>
              recordDelivery({
                id: deliveryId,
                taskId: task.id,
                receivedAt: iso(receivedAt),
                request,
                outcome,
                signatureVerified: details.signatureVerified ?? false,
                missing: details.missing ?? [],
                renderedPrompt: details.renderedPrompt ?? null,
                ...(details.error === undefined ? {} : { error: details.error }),
                ...(details.run === undefined ? {} : { run: { row: details.run, now } }),
              });

            // Only the first rejected request in a window is logged, so a flood
            // cannot write rows or push the real deliveries out of the log.
            const slot = yield* takeRateSlot(task.id, DateTime.toEpochMillis(now));
            if (slot !== "allowed") {
              if (slot === "first_rejected") yield* log("rate_limited");
              yield* observe("rate_limited");
              return yield* releaseClaim({
                _tag: "rate_limited" as const,
                outcome: "rate_limited" as const,
              });
            }
            if (!task.enabled) {
              yield* log("disabled");
              yield* observe("disabled");
              return { _tag: "disabled" as const };
            }
            const signature = schedule.signature;
            if (signature !== null) {
              const verified =
                row.webhook_secret !== null &&
                verifyWebhookSignature({
                  signature,
                  secret: row.webhook_secret,
                  headers: request.headers,
                  body: request.body,
                });
              if (!verified) {
                yield* log("rejected_signature");
                yield* observe("rejected_signature");
                return { _tag: "rejected_signature" as const };
              }
            }
            const maxAgeMinutes = schedule.maxDeliveryAgeMinutes ?? null;
            if (
              maxAgeMinutes !== null &&
              DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt) >
                maxAgeMinutes * 60_000
            ) {
              yield* log("expired", { signatureVerified: signature !== null });
              yield* observe("expired");
              return { _tag: "expired" as const };
            }

            const rendered = renderWebhookPrompt(task.prompt, request);
            // A provider refuses a turn this long, so it is not started. The
            // delivery is not retryable, so the claim is kept. Providers trim
            // the prompt before checking, so whitespace around it is free.
            if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
              yield* log("dispatch_failed", {
                signatureVerified: signature !== null,
                missing: rendered.missing,
                renderedPrompt: rendered.prompt,
                error: "The filled-in prompt is too long.",
              });
              yield* observe("prompt_too_long");
              return { _tag: "accepted" as const, deliveryId, outcome: "prompt_too_long" as const };
            }
            const runId = yield* newRunId;
            // Bound the deliveries one task holds, so steady traffic to a stuck
            // task cannot pile up parked fibers. A refused request is not logged,
            // so it cannot push real deliveries out of the log.
            const queueKey = `${task.id}\u0000${task.createdAt}`;
            const queued = yield* Ref.modify(webhookQueued, (counts) => {
              const count = counts.get(queueKey) ?? 0;
              return count >= WEBHOOK_MAX_QUEUED_PER_TASK
                ? ([false, counts] as const)
                : ([true, new Map(counts).set(queueKey, count + 1)] as const);
            });
            if (!queued) {
              // The task is busy with WEBHOOK_MAX_QUEUED_PER_TASK deliveries already.
              yield* observe("queue_full");
              return yield* releaseClaim({
                _tag: "rate_limited" as const,
                outcome: "queue_full" as const,
              });
            }
            // Entries leave the map when their count reaches zero, so a deleted
            // task's key does not linger once its last delivery finishes.
            const release = Ref.update(webhookQueued, (counts) => {
              const next = new Map(counts);
              const count = (next.get(queueKey) ?? 1) - 1;
              if (count <= 0) next.delete(queueKey);
              else next.set(queueKey, count);
              return next;
            }).pipe(Effect.andThen(releaseRun(runId)));
            yield* holdRun(runId);
            // The delivery waits as a run, visible in the run history until its
            // turn comes, and marked interrupted if the server stops first.
            yield* log("accepted", {
              signatureVerified: signature !== null,
              missing: rendered.missing,
              renderedPrompt: rendered.prompt,
              run: {
                runId,
                task,
                trigger: "webhook",
                occurrenceKey: occurrenceKeys.webhook(task.id, deliveryId),
                webhookDeliveryId: deliveryId,
                dispatchState: "waiting",
                createdAt: iso(now),
                startedAt: null,
              },
            }).pipe(Effect.onError(() => release));
            yield* observe("accepted");
            yield* notifyChanged;
            const permit = yield* webhookPermit(task.id);
            const runOutcome = (outcome: "started" | "skipped" | "failed") =>
              Effect.all([
                Effect.annotateCurrentSpan({ "scheduled_task.webhook.run_outcome": outcome }),
                Metrics.increment(Metrics.webhookRunsTotal, { outcome }),
              ]);
            // A run that never reached an agent ends with the same fixed
            // reason its delivery shows.
            const endRun = (state: "skipped" | "failed", reason: string) =>
              settleRun({ runId, from: ["waiting", "dispatching"], state, error: reason }).pipe(
                Effect.andThen(notifyChanged),
                Effect.ignore,
              );
            yield* runTask(task, {
              trigger: "webhook",
              webhook: { deliveryId, prompt: rendered.prompt, runId },
            }).pipe(
              Effect.flatMap((completed) =>
                completed.task.lastRunStatus === "failed"
                  ? runOutcome("failed").pipe(
                      Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                    )
                  : runOutcome("started"),
              ),
              Effect.catchTags({
                WebhookDeliverySkipped: (skipped) =>
                  runOutcome("skipped").pipe(
                    Effect.andThen(markDeliveryFailed(deliveryId, skipped.reason)),
                    Effect.andThen(endRun("skipped", skipped.reason)),
                  ),
              }),
              // The log is readable over RPC, so it gets a fixed reason; the
              // cause, which can carry request data, stays in the server log.
              Effect.catchCause((cause) =>
                Effect.logWarning("Webhook dispatch failed", { taskId: task.id, cause }).pipe(
                  Effect.andThen(runOutcome("failed")),
                  Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                  Effect.andThen(endRun("failed", RUN_ERRORS.notStarted)),
                ),
              ),
              permit.withPermits(1),
              // Its own trace: the request that triggered it has already been answered.
              Effect.withSpan("ScheduledTaskService.runWebhookDelivery", {
                root: true,
                attributes: {
                  "scheduled_task.id": task.id,
                  "scheduled_task.webhook.delivery_id": deliveryId,
                },
              }),
              Effect.ensuring(release),
              Effect.forkIn(serviceScope),
            );
            return { _tag: "accepted" as const, deliveryId, outcome: "accepted" as const };
          }),
        );
      });

    const listRuns: ScheduledTaskService["Service"]["listRuns"] = (input) =>
      selectTaskRuns(sql, input.id, input.limit ?? RUN_HISTORY_LIMIT).pipe(
        Effect.map((rows) => ({ runs: rows.map(toScheduledTaskRun) })),
        Effect.mapError((cause) =>
          taskError("Could not list schedule task runs.", { taskId: input.id, cause }),
        ),
      );

    const observeRun: ScheduledTaskService["Service"]["observeRun"] = (observation) =>
      Effect.gen(function* () {
        const rows = yield* selectObservedRuns(sql, observation.run);
        if (rows.length === 0) return;
        const observedAt = yield* DateTime.now;
        let changed = false;
        for (const row of rows) {
          const applied = yield* applyAgentObservation(sql, {
            runId: row.run_id,
            run: observation.run,
            sequence: observation.sequence,
            observedAt,
          });
          changed ||= applied;
        }
        if (changed) yield* notifyChanged;
      }).pipe(Effect.mapError(runError("Could not record schedule task run state.")));

    /**
     * Settles one open run, or moves one a restart cut on to its continuation,
     * from what the orchestrator recorded for it. Returns whether it changed.
     */
    const reconcileRun = (
      row: ScheduledTaskRunRow,
      inspect: ScheduledTaskRunInspector,
      observedAt: DateTime.Utc,
    ) =>
      Effect.gen(function* () {
        if (row.dispatch_state === "waiting") {
          // The fiber that would have run this delivery stopped with the old process.
          const settled = yield* settleRun({
            runId: row.run_id,
            from: ["waiting"],
            state: "interrupted",
            error: RUN_ERRORS.restartBeforeDelivery,
          });
          if (settled && row.webhook_delivery_id !== null) {
            yield* markDeliveryFailed(row.webhook_delivery_id, RUN_ERRORS.restartBeforeDelivery);
          }
          return settled;
        }
        const recovery = yield* inspect({
          commandId: CommandId.make(row.command_id),
          messageId: MessageId.make(row.message_id),
          projectId: ProjectId.make(row.project_id),
          threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
          dispatchKind: row.dispatch_kind === "send" ? "send" : "launch",
          agentRunId: row.agent_run_id === null ? null : RunId.make(row.agent_run_id),
        });
        // A finished run moves on only to a restart continuation of it. Nothing
        // else read now, such as a since-deleted thread, changes how it ended.
        if (isFinishedAgentStatus(row.agent_status)) {
          return recovery._tag === "Observed" && recovery.run.id !== row.agent_run_id
            ? yield* applyAgentObservation(sql, {
                runId: row.run_id,
                run: recovery.run,
                sequence: recovery.sequence,
                observedAt,
              })
            : false;
        }
        const undelivered = ["dispatching", "dispatched"] as const;
        switch (recovery._tag) {
          case "Unknown":
            return false;
          case "Observed":
            return yield* applyAgentObservation(sql, {
              runId: row.run_id,
              run: recovery.run,
              sequence: recovery.sequence,
              observedAt,
            });
          case "NotDispatched":
            return yield* settleRun({
              runId: row.run_id,
              from: ["dispatching"],
              state: "interrupted",
              error: RUN_ERRORS.restartBeforeStart,
            });
          case "ThreadOnly":
            return yield* settleRun({
              runId: row.run_id,
              from: undelivered,
              state: "interrupted",
              error: RUN_ERRORS.restartBeforePrompt,
              threadId: recovery.threadId,
            });
          case "Rejected":
            return yield* settleRun({
              runId: row.run_id,
              from: undelivered,
              state: "failed",
              error: RUN_ERRORS.notStarted,
              threadId: recovery.threadId,
            });
          case "Missing":
            return yield* settleRun({
              runId: row.run_id,
              from: undelivered,
              state: "interrupted",
              error: RUN_ERRORS.threadMissing,
              threadId: recovery.threadId,
              forgetAgent: true,
            });
        }
      });

    const reconcileRuns: ScheduledTaskService["Service"]["reconcileRuns"] = (inspect) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const rows = yield* selectUnsettledRuns(sql, now).pipe(
          Effect.mapError(runError("Could not list open schedule task runs.")),
        );
        let changed = false;
        for (const row of rows) {
          // Read per row: a run reserved while this pass works is this process's own.
          if ((yield* Ref.get(heldRuns)).has(row.run_id)) continue;
          const settled = yield* reconcileRun(row, inspect, now).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not reconcile schedule task run", {
                runId: row.run_id,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
          changed ||= settled;
        }
        if (changed) yield* notifyChanged;
      });

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      runNow,
      rotateWebhookToken,
      listWebhookDeliveries,
      getWebhookDelivery,
      triggerWebhook,
      listRuns,
      observeRun,
      reconcileRuns,
    });
  }),
);

/**
 * Admits a run's reservation through the maintenance gate. A scheduled slot
 * is skipped during an update and runs on a later tick, since its
 * `next_run_at` is untouched; Run now is refused so the person can retry. A
 * webhook delivery was accepted before the gate closed and already counts as
 * a blocker, so it runs.
 */
const maintenanceGuardReservation = <A, E, R>(
  maintenance: MaintenanceGate.MaintenanceGateService,
  trigger: ScheduledTaskRun["trigger"],
  acceptedWebhook: boolean,
  reserve: Effect.Effect<A, E, R>,
): Effect.Effect<A | "maintenance-skipped", E | ScheduledTaskError, R> =>
  Effect.gen(function* () {
    if (acceptedWebhook) return yield* reserve;
    const source = trigger === "scheduled" ? "scheduler" : "manual-run";
    const reserved = yield* maintenance.guard(source, reserve);
    if (Option.isSome(reserved)) return reserved.value;
    if (trigger === "scheduled") return "maintenance-skipped" as const;
    const refusal = yield* maintenance.refusal(source);
    return yield* taskError(
      Option.match(refusal, {
        onNone: () => "Stark Code is updating; try again in a moment.",
        onSome: (error) => error.message,
      }),
    );
  });
