import {
  MessageId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkerRetry } from "./workerRetry.ts";

const threadId = ThreadId.make("worker");
const instanceId = ProviderInstanceId.make("codex");
const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-06-20T00:${String(minute).padStart(2, "0")}:00.000Z`);
const worktree = { type: "worktree", baseRef: "main" } as const;

function run(
  ordinal: number,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run {
  const ended = status !== "queued" && status !== "preparing" && status !== "running";
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: at(ordinal),
    startedAt: status === "queued" ? null : at(ordinal),
    completedAt: ended ? at(ordinal + 1) : null,
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

function preparationFailure(runId: RunId, status: "failed" | "cancelled" = "failed") {
  return {
    id: TurnItemId.make(`failure-${runId}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: "Workspace preparation failed",
    startedAt: at(1),
    completedAt: at(1),
    updatedAt: at(1),
    type: "error",
    failure: {
      class: "validation_error",
      message: "setup script exited with 1",
      code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
      retryable: false,
    },
  } satisfies OrchestrationV2TurnItem;
}

function child(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> = [],
  thread: { worktreePath?: string | null; archived?: boolean } = {},
) {
  return {
    thread: {
      archivedAt: thread.archived ? at(30) : null,
      deletedAt: null,
      worktreePath: thread.worktreePath === undefined ? "/worktrees/worker" : thread.worktreePath,
    },
    runs,
    turnItems,
  };
}

describe("resolveWorkerRetry", () => {
  it("prepares again when setup failed, even after the worktree was created", () => {
    const failed = run(1, "failed", { workspacePreparation: worktree });
    expect(resolveWorkerRetry(child([failed], [preparationFailure(failed.id)]))).toEqual({
      type: "prepare",
      runId: failed.id,
    });
    // Its own held messages do not block it: the retry releases them.
    expect(
      resolveWorkerRetry(
        child([failed, run(2, "queued", { queueHeld: true })], [preparationFailure(failed.id)], {
          worktreePath: null,
        }),
      ),
    ).toEqual({ type: "prepare", runId: failed.id });
  });

  it("runs a provider failure again as a follow-up", () => {
    const failed = run(1, "failed", { workspacePreparation: worktree });
    expect(resolveWorkerRetry(child([failed]))).toEqual({ type: "run_again" });
    // A preparation the user already retried is no longer the run's failure.
    expect(
      resolveWorkerRetry(child([failed], [preparationFailure(failed.id, "cancelled")])),
    ).toEqual({ type: "run_again" });
  });

  it("refuses a follow-up that would start ahead of held messages", () => {
    expect(
      resolveWorkerRetry(child([run(1, "interrupted"), run(2, "queued", { queueHeld: true })])),
    ).toEqual({ type: "unavailable", reason: "queue_held" });
  });

  it("refuses while work is active or about to start", () => {
    expect(resolveWorkerRetry(child([run(1, "preparing")]))).toEqual({
      type: "unavailable",
      reason: "active",
    });
    expect(resolveWorkerRetry(child([run(1, "completed"), run(2, "queued")]))).toEqual({
      type: "unavailable",
      reason: "active",
    });
  });

  it("refuses a follow-up that would run outside a worktree that was never created", () => {
    expect(
      resolveWorkerRetry(
        child([run(1, "interrupted", { workspacePreparation: worktree })], [], {
          worktreePath: null,
        }),
      ),
    ).toEqual({ type: "unavailable", reason: "worktree_missing" });
  });

  it("refuses an archived worker and runs a finished one again", () => {
    expect(resolveWorkerRetry(child([run(1, "completed")], [], { archived: true }))).toEqual({
      type: "unavailable",
      reason: "closed",
    });
    expect(resolveWorkerRetry(child([run(1, "completed")]))).toEqual({ type: "run_again" });
  });
});
