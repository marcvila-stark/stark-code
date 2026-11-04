import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";

import { latestExecutedRun } from "./orchestrationV2ThreadError.ts";

/**
 * Runs a Retry can prepare again: their workspace preparation failed and the
 * run still ended there. Older servers record no preparation on the run, so
 * they never offer it. These are the runs the server's prepared-run.retry
 * accepts, whether or not the failed setup already created the worktree.
 */
export function workspacePreparationRetryRunIds(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "workspacePreparation">>,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlySet<OrchestrationV2Run["id"]> {
  const failedRuns = new Set(
    runs.flatMap((run) =>
      run.status === "failed" && run.workspacePreparation !== undefined ? [run.id] : [],
    ),
  );
  const retryable = new Set<OrchestrationV2Run["id"]>();
  if (failedRuns.size === 0) return retryable;
  for (const item of items) {
    if (
      item.type === "error" &&
      item.status === "failed" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE &&
      item.runId !== null &&
      failedRuns.has(item.runId)
    )
      retryable.add(item.runId);
  }
  return retryable;
}

/** Why a delegated worker cannot be run again right now. */
export type WorkerRetryUnavailableReason =
  /** A run is preparing, starting, running or waiting, or a queued one is about to start. */
  | "active"
  /** Stop or a failure held queued messages; a new message would start ahead of them. */
  | "queue_held"
  /** Its worktree was never created, so a message would run in the shared project folder. */
  | "worktree_missing"
  /** The worker's thread is archived or deleted. */
  | "closed";

export type WorkerRetry =
  /** Repeat the failed workspace preparation of this run (prepared-run.retry). */
  | { readonly type: "prepare"; readonly runId: OrchestrationV2Run["id"] }
  /** Send the brief again as the user's follow-up in the same worker thread. */
  | { readonly type: "run_again" }
  | { readonly type: "unavailable"; readonly reason: WorkerRetryUnavailableReason };

function runIsActive(run: Pick<OrchestrationV2Run, "status">): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

/**
 * How a user can run a delegated worker again from where its thread stands.
 * Clients use it to label the action and again at dispatch, against a fresh
 * read of the thread, so a worker that changed in between is not sent a
 * second copy of its brief.
 */
export function resolveWorkerRetry(child: {
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "archivedAt" | "deletedAt" | "worktreePath"
  >;
  readonly runs: OrchestrationV2ThreadProjection["runs"];
  readonly turnItems: OrchestrationV2ThreadProjection["turnItems"];
}): WorkerRetry {
  if (child.thread.archivedAt !== null || child.thread.deletedAt !== null) {
    return { type: "unavailable", reason: "closed" };
  }
  if (child.runs.some(runIsActive)) return { type: "unavailable", reason: "active" };
  const latest = latestExecutedRun(child.runs);
  // Checked before held messages: the server releases the queue a failed
  // preparation held when that preparation runs again.
  if (
    latest !== null &&
    workspacePreparationRetryRunIds([latest], child.turnItems).has(latest.id)
  ) {
    return { type: "prepare", runId: latest.id };
  }
  const queued = child.runs.filter((run) => run.status === "queued");
  if (queued.some((run) => run.queueHeld === true)) {
    return { type: "unavailable", reason: "queue_held" };
  }
  if (queued.length > 0) return { type: "unavailable", reason: "active" };
  if (
    (latest?.status === "failed" || latest?.status === "interrupted") &&
    latest.workspacePreparation?.type === "worktree" &&
    child.thread.worktreePath === null
  ) {
    return { type: "unavailable", reason: "worktree_missing" };
  }
  return { type: "run_again" };
}
