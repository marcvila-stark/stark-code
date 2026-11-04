import {
  threadWorkerIsActive,
  threadWorkerNeedsUser,
  type ThreadWorker,
  type ThreadWorkerState,
} from "@starkfuture/client-runtime/state/thread-workers";
import type { WorkerRetry } from "@starkfuture/shared/workerRetry";

export const WORKER_STATE_LABELS: Record<ThreadWorkerState, string> = {
  queued: "Queued",
  preparing: "Preparing worktree",
  working: "Working",
  needs_approval: "Needs approval",
  needs_answer: "Needs answer",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

/** Where the worker edits files, as one row line. */
export function workerWorkspaceLabel(
  worker: Pick<ThreadWorker, "workspace" | "branch" | "worktreePath">,
): string {
  switch (worker.workspace) {
    case "own_worktree":
      return `Own worktree · ${worker.branch ?? worker.worktreePath}`;
    case "shared_folder":
      return worker.branch ? `Shared folder · ${worker.branch}` : "Shared folder";
    case "preparing":
      return "Own worktree, not ready yet";
    case "unknown":
      return "Chat not loaded";
  }
}

/** One line for the list header: how many workers, and which ones need attention. */
export function summarizeWorkers(
  workers: ReadonlyArray<Pick<ThreadWorker, "state" | "lostDecision">>,
): string {
  const needYou = workers.filter(threadWorkerNeedsUser).length;
  const active = workers.filter(
    (worker) => threadWorkerIsActive(worker.state) && !threadWorkerNeedsUser(worker),
  ).length;
  const failed = workers.filter((worker) => worker.state === "failed").length;
  return [
    `${workers.length} ${workers.length === 1 ? "worker" : "workers"}`,
    ...(needYou > 0 ? [`${needYou} ${needYou === 1 ? "needs" : "need"} you`] : []),
    ...(active > 0 ? [`${active} working`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
  ].join(" · ");
}

/**
 * The row's Open action. A lost decision is resolved in the worker's chat
 * notice, with Ask again or Dismiss.
 */
export function workerOpenLabel(worker: Pick<ThreadWorker, "state" | "lostDecision">): string {
  if (worker.state === "needs_approval" || worker.state === "needs_answer") {
    return "Open to respond";
  }
  return worker.lostDecision === null ? "Open" : "Open to resolve";
}

export type WorkerRetryOffer =
  | {
      readonly kind: "action";
      readonly expected: "prepare" | "run_again";
      readonly label: string;
      readonly hint: string;
    }
  /** The action the worker would offer, held until its lost decision is resolved. */
  | { readonly kind: "blocked"; readonly label: string; readonly hint: string }
  | { readonly kind: "unavailable"; readonly hint: string };

const LOST_DECISION_HINT =
  "Resolve the lost decision first. Open this worker and choose Ask again or Dismiss.";

/**
 * What the worker's retry control offers. Repeating a failed setup and running
 * the brief again are different operations, so they carry different labels.
 * An open lost decision holds either one: a new run does not close it, and the
 * brief would start over without the user's missed answer.
 */
export function workerRetryOffer(
  retry: WorkerRetry,
  worker: Pick<ThreadWorker, "lostDecision">,
): WorkerRetryOffer {
  switch (retry.type) {
    case "prepare":
      return worker.lostDecision !== null
        ? { kind: "blocked", label: "Retry setup", hint: LOST_DECISION_HINT }
        : {
            kind: "action",
            expected: "prepare",
            label: "Retry setup",
            hint: "Runs the worktree setup again, then starts the original brief.",
          };
    case "run_again":
      return worker.lostDecision !== null
        ? { kind: "blocked", label: "Run again", hint: LOST_DECISION_HINT }
        : {
            kind: "action",
            expected: "run_again",
            label: "Run again",
            hint: "Sends the original brief again in this worker's chat. The agent that delegated it is told the new result.",
          };
    case "unavailable":
      switch (retry.reason) {
        case "active":
          return {
            kind: "unavailable",
            hint: "This worker is still busy. Stop it to run it again.",
          };
        case "queue_held":
          return {
            kind: "unavailable",
            hint: "Messages are waiting in this worker's paused queue. Open it to resume or remove them first.",
          };
        case "worktree_missing":
          return {
            kind: "unavailable",
            hint: "This worker's worktree was never created. Open it to see why setup stopped.",
          };
        case "closed":
          return { kind: "unavailable", hint: "This worker's chat is archived." };
      }
  }
}
