import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  deriveThreadWorkers,
  threadWorkerNeedsUser,
  workerRunAgainText,
  workerStopInput,
  type ThreadWorker,
} from "./threadWorkers.ts";

const parentId = ThreadId.make("parent");
const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-06-20T00:${String(minute).padStart(2, "0")}:00.000Z`);

function task(
  id: string,
  child: string | null,
  minute: number,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: parentId,
    runId: RunId.make("run-parent"),
    parentNodeId: NodeId.make("node-parent"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: child === null ? null : ThreadId.make(child),
    nativeTaskRef: null,
    prompt: `Brief for ${id}`,
    title: null,
    model: "gpt-5.4",
    status: "running",
    result: null,
    startedAt: at(minute),
    completedAt: null,
    updatedAt: at(minute),
    ...overrides,
  };
}

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: `Worker ${id}`,
    lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "subagent" },
    forkedFrom: { type: "node", nodeId: NodeId.make(`task-${id}`) },
    latestRunId: RunId.make(`run-${id}`),
    status: "running",
    activityRunStatus: "running",
    ...overrides,
  };
}

function workers(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  parentWorktreePath: string | null = null,
) {
  return deriveThreadWorkers({
    projection: {
      thread: { ...v2Projection.thread, id: parentId, worktreePath: parentWorktreePath },
      subagents,
    },
    shells,
  });
}

function only(list: ReadonlyArray<ThreadWorker>): ThreadWorker {
  expect(list).toHaveLength(1);
  return list[0]!;
}

describe("deriveThreadWorkers", () => {
  it("groups each child's attempts and binds the result to the latest one", () => {
    const list = workers(
      [
        task("task-b", "b", 2, { status: "completed", result: "b done" }),
        task("task-a", "a", 1, { status: "completed", result: "first answer" }),
        // A follow-up after the result: a new attempt that has not ended yet.
        task("task-a-again", "a", 5, { createdBy: "user", prompt: "Run again" }),
      ],
      [shell("a"), shell("b", { status: "completed", activityRunStatus: null })],
    );
    expect(list.map((worker) => worker.childThreadId)).toEqual(["a", "b"]);
    const [first, second] = list;
    expect(first).toMatchObject({
      brief: "Brief for task-a",
      originalTaskId: "task-a",
      attempts: 2,
      state: "working",
      // The earlier attempt's answer is not shown as this attempt's outcome.
      result: null,
    });
    expect(first!.latestTask.id).toBe("task-a-again");
    expect(second).toMatchObject({ attempts: 1, state: "completed", result: "b done" });
  });

  it("takes the original brief from the task the child thread was created for", () => {
    const worker = only(
      workers(
        [
          task("task-follow-up", "a", 1, { prompt: "Follow-up text" }),
          task("task-a", "a", 3, { prompt: "The real brief" }),
        ],
        [shell("a")],
      ),
    );
    expect(worker.brief).toBe("The real brief");
    expect(worker.latestTask.id).toBe("task-a");
  });

  it.each([
    [
      "needs_answer",
      {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("question"),
          kind: "user_input",
          createdAt: at(3),
        },
      },
    ],
    [
      "needs_approval",
      {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("approval"),
          kind: "command",
          createdAt: at(3),
        },
      },
    ],
    ["preparing", { status: "preparing", activityRunStatus: "preparing" }],
    ["queued", { status: "queued", activityRunStatus: null }],
    ["working", { status: "waiting", activityRunStatus: "waiting" }],
    ["failed", { status: "failed", activityRunStatus: null }],
    ["stopped", { status: "interrupted", activityRunStatus: null }],
    ["stopped", { status: "rolled_back", activityRunStatus: null }],
    ["completed", { status: "completed", activityRunStatus: null }],
  ] as const)("shows %s from the child thread", (state, overrides) => {
    const worker = only(workers([task("task-a", "a", 1)], [shell("a", overrides)]));
    expect(worker.state).toBe(state);
  });

  it.each([
    ["queued", "pending"],
    ["working", "running"],
    ["idle", "idle"],
    ["stopped", "cancelled"],
    ["failed", "failed"],
  ] as const)("falls back to the task (%s) when the child has no app runs", (state, status) => {
    const worker = only(
      workers(
        [task("task-a", "a", 1, { status })],
        [shell("a", { latestRunId: null, status: "idle", activityRunStatus: null })],
      ),
    );
    expect(worker.state).toBe(state);
  });

  it("labels a worker's own worktree apart from the parent's folder", () => {
    const [own, shared, preparing] = workers(
      [task("task-a", "a", 1), task("task-b", "b", 2), task("task-c", "c", 3)],
      [
        shell("a", { worktreePath: "/worktrees/a", branch: "worker-a" }),
        shell("b", { worktreePath: "/worktrees/parent" }),
        shell("c", { status: "preparing", activityRunStatus: "preparing" }),
      ],
      "/worktrees/parent",
    );
    expect(own).toMatchObject({ workspace: "own_worktree", branch: "worker-a" });
    expect(shared!.workspace).toBe("shared_folder");
    expect(preparing!.workspace).toBe("preparing");
  });

  it("offers Stop for active work and Retry only for app-owned workers that ended", () => {
    const strongRef = {
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeId: "agent-1",
      strength: "strong",
    } as const;
    const [running, failed, queued, claude, codexNative, archived] = workers(
      [
        task("task-a", "a", 1),
        task("task-b", "b", 2, { status: "failed", result: "boom" }),
        task("task-c", "c", 3, { status: "pending" }),
        task("task-d", "d", 4, {
          origin: "provider_native",
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeTaskRef: strongRef,
        }),
        task("task-e", "e", 5, { origin: "provider_native" }),
        task("task-f", "f", 6, { status: "completed", result: "done" }),
      ],
      [
        shell("a"),
        shell("b", { status: "failed", activityRunStatus: null }),
        shell("c", { status: "queued", activityRunStatus: null }),
        shell("d", { latestRunId: null, status: "idle", activityRunStatus: null }),
        shell("e", { latestRunId: null, status: "idle", activityRunStatus: null }),
        shell("f", { status: "completed", activityRunStatus: null, archivedAt: at(9) }),
      ],
    );
    expect(running).toMatchObject({ canStop: true, retryable: false });
    expect(workerStopInput(running!)).toEqual({ threadId: "a" });
    expect(failed).toMatchObject({ canStop: false, retryable: true, result: "boom" });
    // A queued worker has no run to interrupt yet.
    expect(queued).toMatchObject({ canStop: false, retryable: false });
    expect(claude).toMatchObject({ canStop: true, retryable: false });
    expect(workerStopInput(claude!)).toEqual({ threadId: parentId, subagentId: "task-d" });
    expect(codexNative).toMatchObject({ canStop: false, retryable: false });
    expect(archived).toMatchObject({ available: false, retryable: false });
  });

  it("leaves workflow coordinators and their members in Lineage", () => {
    const worker = only(
      workers(
        [
          task("task-coordinator", "coordinator", 1, {
            workflow: {
              phases: [],
              agents: [
                {
                  index: 0,
                  label: "Member",
                  state: "running",
                  childThreadId: ThreadId.make("member"),
                },
              ],
            },
          }),
          task("task-member", "member", 2, { origin: "provider_native" }),
          task("task-a", "a", 3),
          task("task-no-thread", null, 4),
        ],
        [shell("coordinator"), shell("member"), shell("a")],
      ),
    );
    expect(worker.childThreadId).toBe("a");
  });

  // After a restart the worker's run has ended, but the approval or question it
  // lost is still owed: the row keeps how the run ended and adds the decision.
  it.each([
    [
      "a lost approval",
      { status: "interrupted", activityRunStatus: null },
      { kind: "command", cause: "server_restart" },
      "stopped",
      "Approval lost: Stark Code restarted",
    ],
    [
      "a lost question",
      { status: "failed", activityRunStatus: null },
      { kind: "user_input", cause: "provider_exit" },
      "failed",
      "Question lost: the agent process stopped",
    ],
    [
      "an answer whose delivery is uncertain",
      { status: "interrupted", activityRunStatus: null },
      { kind: "user_input", cause: "server_shutdown", deliveryUncertain: true },
      "stopped",
      "Answer may not have reached the agent: Stark Code shut down",
    ],
  ] as const)("keeps the run's state and shows %s apart", (_, run, lost, state, label) => {
    const worker = only(
      workers(
        [task("task-a", "a", 1, { status: "interrupted" })],
        [
          shell("a", {
            ...run,
            lostRuntimeRequest: { id: RuntimeRequestId.make("lost"), lostAt: at(4), ...lost },
          }),
        ],
      ),
    );
    expect(worker.state).toBe(state);
    expect(worker.lostDecision).toEqual({
      requestId: "lost",
      kind: lost.kind,
      cause: lost.cause,
      lostAt: at(4),
      deliveryUncertain: "deliveryUncertain" in lost,
      label,
    });
    expect(threadWorkerNeedsUser(worker)).toBe(true);
    // Retry still follows the run; the Workers tab holds it until the loss is resolved.
    expect(worker.retryable).toBe(true);
  });

  it("drops the lost decision once it is resolved, or with a deleted chat", () => {
    const lost = {
      id: RuntimeRequestId.make("lost"),
      kind: "command",
      cause: "server_restart",
      lostAt: at(4),
    } as const;
    const [resolved, deleted] = workers(
      [task("task-a", "a", 1), task("task-b", "b", 2)],
      [
        // The shell names only open losses, so Ask again or Dismiss clears it.
        shell("a", { status: "interrupted", activityRunStatus: null, lostRuntimeRequest: null }),
        shell("b", { lostRuntimeRequest: lost, deletedAt: at(6) }),
      ],
    );
    expect(resolved!.lostDecision).toBeNull();
    expect(threadWorkerNeedsUser(resolved!)).toBe(false);
    expect(deleted!.lostDecision).toBeNull();
  });

  it("keeps a worker whose thread is not loaded, from its task alone", () => {
    const worker = only(workers([task("task-a", "a", 1, { status: "completed" })], []));
    expect(worker).toMatchObject({
      available: false,
      workspace: "unknown",
      state: "completed",
      retryable: false,
    });
  });
});

describe("workerRunAgainText", () => {
  it("restates how the last attempt ended and repeats the original brief", () => {
    expect(workerRunAgainText({ state: "failed", brief: "Fix the flaky test." })).toBe(
      "Run again requested by the user. The previous attempt failed. Start again from the original brief below.\n\nFix the flaky test.",
    );
  });
});
