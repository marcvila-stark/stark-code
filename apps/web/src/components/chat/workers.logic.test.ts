import type { ThreadWorkerLostDecision } from "@starkfuture/client-runtime/state/thread-workers";
import { RunId, RuntimeRequestId } from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  summarizeWorkers,
  workerOpenLabel,
  workerRetryOffer,
  workerWorkspaceLabel,
} from "./workers.logic";

const lostDecision: ThreadWorkerLostDecision = {
  requestId: RuntimeRequestId.make("lost"),
  kind: "user_input",
  cause: "server_restart",
  lostAt: DateTime.makeUnsafe("2026-06-20T00:04:00.000Z"),
  deliveryUncertain: true,
  label: "Answer may not have reached the agent: Stark Code restarted",
};

describe("summarizeWorkers", () => {
  it("counts workers waiting on the user apart from those still working", () => {
    expect(
      summarizeWorkers(
        (
          ["needs_approval", "needs_answer", "working", "preparing", "failed", "completed"] as const
        ).map((state) => ({ state, lostDecision: null })),
      ),
    ).toBe("6 workers · 2 need you · 2 working · 1 failed");
    expect(summarizeWorkers([{ state: "completed", lostDecision: null }])).toBe("1 worker");
  });

  it("counts a lost decision as needing you while the run keeps its own state", () => {
    expect(
      summarizeWorkers([
        { state: "stopped", lostDecision },
        // A wake can start a new run while the loss is still open.
        { state: "working", lostDecision },
        { state: "failed", lostDecision: null },
      ]),
    ).toBe("3 workers · 2 need you · 1 failed");
  });
});

describe("workerOpenLabel", () => {
  it("sends the user to respond, to resolve a lost decision, or just to open", () => {
    expect(workerOpenLabel({ state: "needs_answer", lostDecision: null })).toBe("Open to respond");
    expect(workerOpenLabel({ state: "stopped", lostDecision })).toBe("Open to resolve");
    expect(workerOpenLabel({ state: "completed", lostDecision: null })).toBe("Open");
  });
});

describe("workerRetryOffer", () => {
  const prepare = { type: "prepare", runId: RunId.make("run-1") } as const;

  it("names a setup retry and a run-again differently", () => {
    expect(workerRetryOffer(prepare, { lostDecision: null })).toMatchObject({
      kind: "action",
      expected: "prepare",
      label: "Retry setup",
    });
    expect(workerRetryOffer({ type: "run_again" }, { lostDecision: null })).toMatchObject({
      kind: "action",
      expected: "run_again",
      label: "Run again",
    });
  });

  it("holds either retry until the lost decision is asked again for or dismissed", () => {
    for (const [retry, label] of [
      [prepare, "Retry setup"],
      [{ type: "run_again" }, "Run again"],
    ] as const) {
      expect(workerRetryOffer(retry, { lostDecision })).toEqual({
        kind: "blocked",
        label,
        hint: "Resolve the lost decision first. Open this worker and choose Ask again or Dismiss.",
      });
    }
  });

  it("explains instead of offering a run-again that would jump a paused queue", () => {
    const offer = workerRetryOffer(
      { type: "unavailable", reason: "queue_held" },
      { lostDecision: null },
    );
    expect(offer.kind).toBe("unavailable");
    expect(offer.hint).toContain("paused queue");
  });
});

describe("workerWorkspaceLabel", () => {
  it("tells an own worktree from the parent's shared folder", () => {
    expect(
      workerWorkspaceLabel({
        workspace: "own_worktree",
        branch: "worker-a",
        worktreePath: "/worktrees/a",
      }),
    ).toBe("Own worktree · worker-a");
    expect(
      workerWorkspaceLabel({
        workspace: "own_worktree",
        branch: null,
        worktreePath: "/worktrees/a",
      }),
    ).toBe("Own worktree · /worktrees/a");
    expect(
      workerWorkspaceLabel({ workspace: "shared_folder", branch: null, worktreePath: null }),
    ).toBe("Shared folder");
  });
});
