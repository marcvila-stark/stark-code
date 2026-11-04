import {
  CommandId,
  MessageId,
  OrchestrationV2RunStatus,
  ScheduledTaskId,
  ScheduledTaskRunId,
  ScheduledTaskRunTrigger,
  ScheduledTaskWebhookDeliveryId,
  ThreadId,
  type OrchestrationV2Run,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskRunState,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Message ids of scheduled runs start with this. The run tracker links an
 * orchestration run to the scheduled run that sent its prompt by this id.
 */
const SCHEDULED_TASK_MESSAGE_PREFIX = "scheduled-task-message:";

/** Runs a task's history shows, newest first. */
export const RUN_HISTORY_LIMIT = 100;

/**
 * How long a finished run is kept after it falls out of the history list. Its
 * occurrence key is the dedupe record, so a repeated scheduler tick, Run now
 * click or webhook delivery within this window still finds its run instead
 * of starting another one. A day covers a client retrying after a dropped
 * connection and the longest a sender holds a request.
 */
const RUN_OCCURRENCE_RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * What this server did with a run's prompt, kept apart from the agent run it
 * started:
 * - `waiting`: a webhook delivery behind earlier ones for the same task.
 * - `dispatching`: reserved; the launch or send may or may not have landed.
 * - `dispatched`: the orchestrator accepted the prompt.
 * - `failed`, `skipped`, `interrupted`: the prompt never reached an agent.
 */
export type RunDispatchState =
  | "waiting"
  | "dispatching"
  | "dispatched"
  | "failed"
  | "skipped"
  | "interrupted";

/** Whether the run launches a new thread or sends to the task's bound thread. */
export type RunDispatchKind = "launch" | "send";

/**
 * Fixed reasons shown under read scope. Dispatch causes can carry request
 * data or provider output, so they stay in the server log.
 */
export const RUN_ERRORS = {
  notStarted: "The run could not start.",
  providerDisabled: "The task's provider is turned off for this project.",
  restartBeforeStart: "The server stopped before this run started.",
  restartBeforePrompt:
    "The server stopped after creating the thread but before sending the prompt.",
  restartBeforeDelivery: "The server restarted before this delivery ran.",
  threadMissing: "This run's thread is no longer available.",
  alreadyRan: "This delivery already ran.",
  missedSlot: "Skipped because the server was not running at the scheduled time.",
} as const;

export interface ScheduledTaskRunRow {
  readonly run_id: string;
  readonly task_id: string;
  readonly task_created_at: string;
  readonly project_id: string;
  readonly trigger_kind: string;
  readonly occurrence_key: string;
  readonly dispatch_kind: string;
  readonly command_id: string;
  readonly message_id: string;
  readonly webhook_delivery_id: string | null;
  readonly thread_id: string | null;
  readonly dispatch_state: string;
  readonly error: string | null;
  readonly agent_run_id: string | null;
  readonly agent_status: string | null;
  readonly agent_sequence: number;
  readonly agent_started_at: string | null;
  readonly agent_ended_at: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

const AGENT_RUN_STATES: Record<OrchestrationV2Run["status"], ScheduledTaskRunState> = {
  preparing: "starting",
  starting: "starting",
  queued: "queued",
  running: "running",
  waiting: "running",
  completed: "succeeded",
  failed: "failed",
  rolled_back: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

const DISPATCH_RUN_STATES: Record<RunDispatchState, ScheduledTaskRunState> = {
  waiting: "waiting",
  dispatching: "starting",
  dispatched: "starting",
  failed: "failed",
  skipped: "skipped",
  interrupted: "interrupted",
};

const isAgentStatus = Schema.is(OrchestrationV2RunStatus);
const isTrigger = Schema.is(ScheduledTaskRunTrigger);
const isDispatchState = (value: string): value is RunDispatchState =>
  Object.hasOwn(DISPATCH_RUN_STATES, value);

const TERMINAL_AGENT_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "completed",
  "failed",
  "rolled_back",
  "cancelled",
  "interrupted",
];

/** Whether an observed agent status is one its run does not leave on its own. */
export const isFinishedAgentStatus = (status: string | null) =>
  status !== null && isAgentStatus(status) && TERMINAL_AGENT_STATUSES.includes(status);

/**
 * The status restart recovery gives a run it cut. The continuation it may
 * start names that run in `restartContinuationOfRunId`. A user's stop leaves
 * `interrupted`, which is never continued.
 */
const RESTART_CUT_AGENT_STATUS: OrchestrationV2Run["status"] = "cancelled";

/** SQL condition for a run that will not change again on its own. */
const finishedCondition = (sql: SqlClient.SqlClient) => sql`(
  agent_status IN ${sql.in(TERMINAL_AGENT_STATUSES)}
  OR (agent_status IS NULL AND dispatch_state IN ('failed', 'skipped', 'interrupted'))
)`;

/**
 * A run's state: the agent run's when one was observed, which is the
 * authoritative record once the prompt landed, else this server's dispatch
 * state.
 */
function runState(
  row: Pick<ScheduledTaskRunRow, "agent_status" | "dispatch_state">,
): ScheduledTaskRunState {
  if (row.agent_status !== null && isAgentStatus(row.agent_status)) {
    return AGENT_RUN_STATES[row.agent_status];
  }
  return isDispatchState(row.dispatch_state) ? DISPATCH_RUN_STATES[row.dispatch_state] : "starting";
}

export function toScheduledTaskRun(row: ScheduledTaskRunRow): ScheduledTaskRun {
  const observed = row.agent_status !== null && isAgentStatus(row.agent_status);
  return {
    id: ScheduledTaskRunId.make(row.run_id),
    taskId: ScheduledTaskId.make(row.task_id),
    trigger: isTrigger(row.trigger_kind) ? row.trigger_kind : "scheduled",
    state: runState(row),
    // Only dispatch outcomes carry a reason; an agent run's outcome is in its thread.
    error: observed ? null : row.error,
    threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
    webhookDeliveryId:
      row.webhook_delivery_id === null
        ? null
        : ScheduledTaskWebhookDeliveryId.make(row.webhook_delivery_id),
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: observed ? row.agent_ended_at : row.ended_at,
  };
}

type TaskIncarnation = Pick<ScheduledTask, "id" | "createdAt">;

/**
 * Occurrence keys name the trigger occurrence a run belongs to. Keys of a
 * task's own triggers include its creation time, so a task deleted and
 * recreated under the same id never collides with its earlier runs; webhook
 * delivery ids are unique on their own and keep the command ids webhook runs
 * have always used.
 */
export const occurrenceKeys = {
  scheduled: (task: TaskIncarnation, slot: string) =>
    `${task.id}@${task.createdAt}:scheduled:${slot}`,
  missed: (task: TaskIncarnation, slot: string) => `${task.id}@${task.createdAt}:missed:${slot}`,
  manual: (task: TaskIncarnation, clickId: string) =>
    `${task.id}@${task.createdAt}:manual:${clickId}`,
  webhook: (taskId: ScheduledTaskId, deliveryId: string) => `${taskId}:webhook:${deliveryId}`,
};

export const runCommandId = (occurrenceKey: string) =>
  CommandId.make(`scheduled-task:${occurrenceKey}`);
export const runMessageId = (occurrenceKey: string) =>
  MessageId.make(`${SCHEDULED_TASK_MESSAGE_PREFIX}${occurrenceKey}`);

export interface NewRun {
  readonly runId: ScheduledTaskRunId;
  readonly task: Pick<ScheduledTask, "id" | "createdAt" | "projectId" | "threadId">;
  readonly trigger: ScheduledTaskRun["trigger"];
  readonly occurrenceKey: string;
  readonly webhookDeliveryId: string | null;
  readonly dispatchState: RunDispatchState;
  readonly error?: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt?: string;
}

/**
 * Reserves the run for its occurrence. Returns false when the occurrence
 * already has a run, or when the task was deleted or replaced: a run never
 * outlives its task.
 */
export const insertRun = (sql: SqlClient.SqlClient, run: NewRun) =>
  sql<{ run_id: string }>`
    INSERT INTO scheduled_task_runs (
      run_id, task_id, task_created_at, project_id, trigger_kind, occurrence_key,
      dispatch_kind, command_id, message_id, webhook_delivery_id, thread_id,
      dispatch_state, error, created_at, started_at, ended_at
    )
    SELECT
      ${run.runId}, ${run.task.id}, ${run.task.createdAt}, ${run.task.projectId}, ${run.trigger},
      ${run.occurrenceKey}, ${run.task.threadId === null ? "launch" : "send"},
      ${runCommandId(run.occurrenceKey)}, ${runMessageId(run.occurrenceKey)},
      ${run.webhookDeliveryId}, ${run.task.threadId}, ${run.dispatchState}, ${run.error ?? null},
      ${run.createdAt}, ${run.startedAt}, ${run.endedAt ?? null}
    WHERE EXISTS (
      SELECT 1 FROM scheduled_tasks
      WHERE task_id = ${run.task.id} AND created_at = ${run.task.createdAt}
    )
    ON CONFLICT (occurrence_key) DO NOTHING
    RETURNING run_id
  `.pipe(Effect.map((rows) => rows.length > 0));

/**
 * Keeps the newest RUN_HISTORY_LIMIT runs of a task, plus every run that is
 * not finished and every run younger than RUN_OCCURRENCE_RETENTION_MS, so the
 * dedupe window never depends on how long the visible history is.
 */
export const pruneRuns = (sql: SqlClient.SqlClient, taskId: ScheduledTaskId, now: DateTime.Utc) =>
  sql`
    DELETE FROM scheduled_task_runs
    WHERE task_id = ${taskId}
      AND created_at < ${DateTime.formatIso(DateTime.subtract(now, { milliseconds: RUN_OCCURRENCE_RETENTION_MS }))}
      AND ${finishedCondition(sql)}
      AND run_id NOT IN (
        SELECT run_id FROM scheduled_task_runs
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${RUN_HISTORY_LIMIT}
      )
  `;

export const selectRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql<ScheduledTaskRunRow>`SELECT * FROM scheduled_task_runs WHERE run_id = ${runId}`.pipe(
    Effect.map((rows) => rows[0] ?? null),
  );

export const selectRunByOccurrence = (sql: SqlClient.SqlClient, occurrenceKey: string) =>
  sql<ScheduledTaskRunRow>`
    SELECT * FROM scheduled_task_runs WHERE occurrence_key = ${occurrenceKey}
  `.pipe(Effect.map((rows) => rows[0] ?? null));

export const selectTaskRuns = (sql: SqlClient.SqlClient, taskId: ScheduledTaskId, limit: number) =>
  sql<ScheduledTaskRunRow>`
    SELECT * FROM scheduled_task_runs
    WHERE task_id = ${taskId}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ${limit}
  `;

/** The newest run of every task, in one query for the task list. */
export const selectLatestRuns = (sql: SqlClient.SqlClient) =>
  sql<ScheduledTaskRunRow>`
    SELECT * FROM scheduled_task_runs AS runs
    WHERE runs.rowid = (
      SELECT newest.rowid FROM scheduled_task_runs AS newest
      WHERE newest.task_id = runs.task_id
      ORDER BY newest.created_at DESC, newest.rowid DESC
      LIMIT 1
    )
  `;

/**
 * Runs whose outcome this server cannot know from its own writes: a dispatch
 * that was in flight or waiting when the server stopped, a prompt the
 * orchestrator accepted but the tracker has not seen run, an agent run that
 * was still active, or one a restart cut within RUN_OCCURRENCE_RETENTION_MS,
 * whose continuation may have run while nothing was watching.
 */
export const selectUnsettledRuns = (sql: SqlClient.SqlClient, now: DateTime.Utc) =>
  sql<ScheduledTaskRunRow>`
    SELECT * FROM scheduled_task_runs
    WHERE dispatch_state IN ('waiting', 'dispatching')
       OR (agent_status IS NULL AND dispatch_state = 'dispatched')
       OR (agent_status IS NOT NULL AND agent_status NOT IN ${sql.in(TERMINAL_AGENT_STATUSES)})
       OR (
         agent_status = ${RESTART_CUT_AGENT_STATUS}
         AND agent_ended_at >= ${DateTime.formatIso(DateTime.subtract(now, { milliseconds: RUN_OCCURRENCE_RETENTION_MS }))}
       )
    ORDER BY created_at ASC, rowid ASC
  `;

/**
 * Scheduled runs an orchestration run event is about: the run each one
 * follows, a run not yet linked whose prompt this is, or one whose followed
 * run a restart continued as this run. A row already following a
 * continuation ignores later events of the run it replaced.
 */
export const selectObservedRuns = (sql: SqlClient.SqlClient, run: OrchestrationV2Run) =>
  sql<ScheduledTaskRunRow>`
    SELECT * FROM scheduled_task_runs
    WHERE agent_run_id = ${run.id}
       OR (agent_run_id IS NULL AND message_id = ${run.userMessageId})
       ${
         run.restartContinuationOfRunId === undefined
           ? sql``
           : sql`OR agent_run_id = ${run.restartContinuationOfRunId}`
       }
  `;

const isoOrNull = (value: DateTime.Utc | null) =>
  value === null ? null : DateTime.formatIso(value);

/**
 * Records `run` as the agent run `runId` follows, as observed at `sequence`.
 * Observations are versioned by event sequence, not ranked by state, so a
 * run that legitimately moves back (starting to queued behind a busy thread,
 * failed to preparing on a workspace retry, a cut run to its continuation)
 * is followed, while an older observation arriving late is ignored. Returns
 * whether the row changed.
 */
export const applyAgentObservation = (
  sql: SqlClient.SqlClient,
  input: {
    readonly runId: string;
    readonly run: OrchestrationV2Run;
    readonly sequence: number;
    readonly observedAt: DateTime.Utc;
  },
) => {
  const { run } = input;
  const terminal = TERMINAL_AGENT_STATUSES.includes(run.status);
  return sql<{ run_id: string }>`
    UPDATE scheduled_task_runs
    SET agent_run_id = ${run.id},
        agent_status = ${run.status},
        agent_sequence = ${input.sequence},
        agent_started_at = ${isoOrNull(run.startedAt)},
        agent_ended_at = ${terminal ? (isoOrNull(run.completedAt) ?? DateTime.formatIso(input.observedAt)) : null},
        thread_id = COALESCE(thread_id, ${run.threadId}),
        dispatch_state = CASE
          WHEN dispatch_state IN ('waiting', 'dispatching') THEN 'dispatched'
          ELSE dispatch_state
        END
    WHERE run_id = ${input.runId} AND agent_sequence < ${input.sequence}
    RETURNING run_id
  `.pipe(Effect.map((rows) => rows.length > 0));
};
