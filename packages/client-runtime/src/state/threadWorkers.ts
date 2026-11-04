import type {
  NodeId,
  OrchestrationV2LostRuntimeRequestSummary,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@starkfuture/contracts";
import { lostRuntimeRequestLabel } from "@starkfuture/shared/orchestrationV2LostRequests";
import * as DateTime from "effect/DateTime";

import type { InterruptThreadTurnInput } from "../operations/commands.ts";
import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";

/** What a worker is doing, read from its thread's persisted state. */
export type ThreadWorkerState =
  | "queued"
  | "preparing"
  | "working"
  | "needs_approval"
  | "needs_answer"
  | "idle"
  | "completed"
  | "failed"
  | "stopped";

/**
 * Where a worker edits files. A shared folder is the parent's checkout, so its
 * changes mix with the parent's and other shared workers'.
 */
export type ThreadWorkerWorkspace = "own_worktree" | "shared_folder" | "preparing" | "unknown";

/**
 * An approval or question the worker lost to a restart, shutdown or agent
 * process exit, which the user has neither asked again for nor dismissed.
 * Both choices live in the worker's own chat.
 */
export interface ThreadWorkerLostDecision {
  readonly requestId: OrchestrationV2LostRuntimeRequestSummary["id"];
  readonly kind: OrchestrationV2LostRuntimeRequestSummary["kind"];
  readonly cause: OrchestrationV2LostRuntimeRequestSummary["cause"];
  readonly lostAt: OrchestrationV2LostRuntimeRequestSummary["lostAt"];
  /** The user had answered, but the loss may have kept the answer from the agent. */
  readonly deliveryUncertain: boolean;
  /** The chat notice's title, e.g. "Approval lost: Stark Code restarted". */
  readonly label: string;
}

/** One child conversation the parent delegated work to, across all its attempts. */
export interface ThreadWorker {
  readonly childThreadId: ThreadId;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly title: string;
  /** The brief of the task the child thread was created for. */
  readonly brief: string;
  readonly originalTaskId: NodeId;
  /** The newest task for this thread: the original delegation or a later follow-up. */
  readonly latestTask: OrchestrationV2Subagent;
  /** Tasks recorded for this thread; every follow-up after a result adds one. */
  readonly attempts: number;
  readonly state: ThreadWorkerState;
  /**
   * The newest open lost decision, kept apart from `state`, which still says
   * how the run ended. The worker needs the user until it is resolved.
   */
  readonly lostDecision: ThreadWorkerLostDecision | null;
  /**
   * The latest task's own result, recorded when that task ended. Null while it
   * runs, even when an earlier attempt has a result.
   */
  readonly result: string | null;
  readonly providerInstanceId: OrchestrationV2Subagent["providerInstanceId"];
  readonly driver: OrchestrationV2Subagent["driver"];
  readonly model: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly workspace: ThreadWorkerWorkspace;
  /** False when no shell is loaded for the child thread, for example once it is archived. */
  readonly available: boolean;
  readonly canStop: boolean;
  /**
   * Whether Retry may apply. The exact action needs the child's runs, so
   * clients resolve it with resolveWorkerRetry from its projection.
   */
  readonly retryable: boolean;
}

const ACTIVE_STATES: ReadonlySet<ThreadWorkerState> = new Set([
  "queued",
  "preparing",
  "working",
  "needs_approval",
  "needs_answer",
]);

export function threadWorkerIsActive(state: ThreadWorkerState): boolean {
  return ACTIVE_STATES.has(state);
}

/** Whether the worker waits on the user: an open approval or question, or a lost decision. */
export function threadWorkerNeedsUser(
  worker: Pick<ThreadWorker, "state" | "lostDecision">,
): boolean {
  return (
    worker.state === "needs_approval" ||
    worker.state === "needs_answer" ||
    worker.lostDecision !== null
  );
}

function taskMillis(task: OrchestrationV2Subagent): number {
  return DateTime.toEpochMillis(task.startedAt ?? task.updatedAt);
}

function taskState(status: OrchestrationV2Subagent["status"]): ThreadWorkerState {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
    case "waiting":
      return "working";
    case "idle":
      return "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

/**
 * The child thread's own state wins: it covers queued follow-ups, worktree
 * preparation and pending requests that the task does not record. A child
 * without app runs (a provider's native subagent) falls back to its task.
 */
function workerState(
  shell: OrchestrationV2ThreadShell | null,
  task: OrchestrationV2Subagent,
): ThreadWorkerState {
  const request = shell?.pendingRuntimeRequest?.kind;
  if (request === "user_input") return "needs_answer";
  if (request !== undefined && request !== "auth_refresh") return "needs_approval";
  if (shell !== null && shell.latestRunId !== null) {
    switch (shell.activityRunStatus) {
      case "preparing":
        return "preparing";
      case "starting":
      case "running":
      case "waiting":
        return "working";
    }
    switch (shell.status) {
      case "preparing":
        return "preparing";
      case "queued":
        return "queued";
      case "starting":
      case "running":
      case "waiting":
        return "working";
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "interrupted":
      case "cancelled":
      case "rolled_back":
        return "stopped";
      case "idle":
        break;
    }
  }
  return taskState(task.status);
}

function lostDecision(shell: OrchestrationV2ThreadShell | null): ThreadWorkerLostDecision | null {
  // Deleted chats are left out, as in Needs you.
  const lost = shell?.deletedAt === null ? shell.lostRuntimeRequest : null;
  if (lost == null) return null;
  return {
    requestId: lost.id,
    kind: lost.kind,
    cause: lost.cause,
    lostAt: lost.lostAt,
    deliveryUncertain: lost.deliveryUncertain === true,
    label: lostRuntimeRequestLabel(lost),
  };
}

/** Lineage's Stop rule: Claude is the only provider whose native subagents stop alone. */
function canStopWorker(task: OrchestrationV2Subagent, state: ThreadWorkerState): boolean {
  if (state === "queued" || !threadWorkerIsActive(state)) return false;
  if (task.origin === "app_owned") return true;
  return (
    task.driver === "claudeAgent" &&
    task.runId !== null &&
    task.nativeTaskRef?.strength === "strong" &&
    task.nativeTaskRef.nativeId !== null &&
    (task.status === "pending" || task.status === "running" || task.status === "waiting")
  );
}

/**
 * The parent's delegated workers, one per child thread, oldest delegation
 * first so rows do not move as workers change. Workflow coordinators and
 * their members stay in Lineage, where their phases are shown.
 */
export function deriveThreadWorkers(input: {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">;
  readonly shells: ReadonlyArray<OrchestrationV2ThreadShell>;
}): ReadonlyArray<ThreadWorker> {
  const workflowThreadIds = new Set<ThreadId>();
  for (const task of input.projection.subagents) {
    if (task.workflow === undefined) continue;
    if (task.childThreadId !== null) workflowThreadIds.add(task.childThreadId);
    for (const agent of task.workflow.agents) {
      if (agent.childThreadId !== undefined) workflowThreadIds.add(agent.childThreadId);
    }
  }
  const tasksByThread = new Map<ThreadId, OrchestrationV2Subagent[]>();
  for (const task of input.projection.subagents) {
    if (task.childThreadId === null || workflowThreadIds.has(task.childThreadId)) continue;
    const tasks = tasksByThread.get(task.childThreadId);
    if (tasks) tasks.push(task);
    else tasksByThread.set(task.childThreadId, [task]);
  }
  const shellsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const shell of input.shells) {
    if (!shellsById.has(shell.id)) shellsById.set(shell.id, shell);
  }
  const parentWorktreePath = input.projection.thread.worktreePath;

  const workers = [...tasksByThread].map(([childThreadId, unordered]) => {
    const tasks = [...unordered].sort((left, right) => taskMillis(left) - taskMillis(right));
    const shell = shellsById.get(childThreadId) ?? null;
    const forkedFromTaskId = shell?.forkedFrom?.type === "node" ? shell.forkedFrom.nodeId : null;
    const original = tasks.find((task) => task.id === forkedFromTaskId) ?? tasks[0]!;
    const latestTask = tasks.at(-1)!;
    const state = workerState(shell, latestTask);
    const ownWorktree = shell?.worktreePath != null && shell.worktreePath !== parentWorktreePath;
    const worker: ThreadWorker = {
      childThreadId,
      origin: original.origin,
      title: formatSubagentDisplayTitle(
        shell?.title ?? original.title ?? original.prompt.split("\n")[0]!.slice(0, 80),
      ),
      brief: original.prompt,
      originalTaskId: original.id,
      latestTask,
      attempts: tasks.length,
      state,
      lostDecision: lostDecision(shell),
      result: latestTask.result,
      providerInstanceId: latestTask.providerInstanceId,
      driver: latestTask.driver,
      model: latestTask.model ?? shell?.modelSelection.model ?? null,
      branch: shell?.branch ?? null,
      worktreePath: shell?.worktreePath ?? null,
      workspace:
        shell === null
          ? "unknown"
          : ownWorktree
            ? "own_worktree"
            : state === "preparing"
              ? "preparing"
              : "shared_folder",
      available: shell !== null && shell.archivedAt === null && shell.deletedAt === null,
      canStop: canStopWorker(latestTask, state),
      retryable:
        original.origin === "app_owned" &&
        shell !== null &&
        shell.archivedAt === null &&
        shell.deletedAt === null &&
        !threadWorkerIsActive(state),
    };
    return { worker, startedAt: taskMillis(original) };
  });
  return workers
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        (left.worker.childThreadId < right.worker.childThreadId ? -1 : 1),
    )
    .map(({ worker }) => worker);
}

/**
 * Stop for one worker, as Lineage sends it: an app-owned worker's own thread
 * is interrupted (holding its queue); a provider's native subagent is stopped
 * through its parent.
 */
export function workerStopInput(worker: {
  readonly childThreadId: ThreadId;
  readonly origin: ThreadWorker["origin"];
  readonly latestTask: Pick<OrchestrationV2Subagent, "id" | "threadId">;
}): InterruptThreadTurnInput {
  return worker.origin === "provider_native"
    ? { threadId: worker.latestTask.threadId, subagentId: worker.latestTask.id }
    : { threadId: worker.childThreadId };
}

const ENDED_WORDS: Partial<Record<ThreadWorkerState, string>> = {
  completed: "completed",
  failed: "failed",
  stopped: "was stopped",
  idle: "went idle",
};

/**
 * The user's follow-up that runs a worker again in its own thread. The server
 * records it as a new task of the parent, which is woken with its result.
 */
export function workerRunAgainText(worker: Pick<ThreadWorker, "state" | "brief">): string {
  const ended = ENDED_WORDS[worker.state];
  return [
    `Run again requested by the user.${ended ? ` The previous attempt ${ended}.` : ""} Start again from the original brief below.`,
    worker.brief,
  ].join("\n\n");
}
