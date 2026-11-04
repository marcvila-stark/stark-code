import { describe, expect, it } from "vite-plus/test";
import {
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import type { TurnCheck } from "@starkfuture/client-runtime/state/review-chain";
import * as DateTime from "effect/DateTime";
import {
  deriveFinishEvidence,
  finishApprovalDeliveryNotes,
  finishApprovalDeliverySummary,
} from "./finishEvidence";
import { turnCheckResultLabel } from "./turnChecks";

const time = (seconds: number) =>
  DateTime.makeUnsafe(`2026-10-20T12:00:${String(seconds).padStart(2, "0")}Z`);
const run = {
  id: RunId.make("run"),
  threadId: ThreadId.make("thread"),
  status: "completed",
  completedAt: time(50),
} satisfies Pick<OrchestrationV2Run, "id" | "threadId" | "status" | "completedAt">;
const base = {
  threadId: run.threadId,
  runId: run.id,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: time(10),
  completedAt: time(20),
  updatedAt: time(20),
} as const;
function command(
  input = "pnpm test",
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    ...base,
    id: TurnItemId.make("command"),
    type: "command_execution",
    input,
    exitCode: 0,
    ...overrides,
  };
}
function edit(
  path: string,
  at: number,
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "file_change" }>> = {},
): OrchestrationV2TurnItem {
  return {
    ...base,
    id: TurnItemId.make(path),
    type: "file_change",
    fileName: path,
    completedAt: time(at),
    updatedAt: time(at),
    ...overrides,
  };
}

describe("finish evidence", () => {
  it("omits successful internal preparation but preserves failures and agent commands", () => {
    const legacy = command("Preparing workspace", {
      title: "Workspace ready",
      id: TurnItemId.make("turn-item:provider:claude:native-item:workspace-preparation%3Arun"),
    });
    expect(deriveFinishEvidence(run, [legacy])).toBeNull();
    expect(
      deriveFinishEvidence(run, [
        command("Preparing workspace", { internalOperation: "workspace_preparation" }),
      ]),
    ).toBeNull();
    expect(
      deriveFinishEvidence(run, [
        command("Preparing workspace", {
          internalOperation: "workspace_preparation",
          exitCode: 1,
          status: "failed",
        }),
      ])?.failedCount,
    ).toBe(1);
    expect(deriveFinishEvidence(run, [command("Preparing workspace")])?.commands).toHaveLength(1);
    expect(
      deriveFinishEvidence(run, [
        command("npm test"),
        command("Preparing workspace", { internalOperation: "workspace_preparation" }),
      ])?.zeroExitChecks,
    ).toBe(1);
  });
  it("does not count help, listing and collection-only commands as checks", () => {
    for (const input of [
      "npm test --help",
      "tsc --version",
      "pytest --collect-only",
      "vitest list",
      "go test -list=.",
    ]) {
      expect(deriveFinishEvidence(run, [command(input)])?.zeroExitChecks, input).toBe(0);
    }
    expect(deriveFinishEvidence(run, [command("node --test check.test.cjs")])?.zeroExitChecks).toBe(
      1,
    );
  });
  it("never treats assistant claims as proof or shows an active/rolled-back run as finished", () => {
    const unsupported = {
      ...base,
      id: TurnItemId.make("reply"),
      type: "reasoning",
      text: "All 500 tests pass; ship it.",
      streaming: false,
    } as const;
    expect(deriveFinishEvidence(run, [unsupported])).toBeNull();
    expect(deriveFinishEvidence(null, [command()])).toBeNull();
    expect(deriveFinishEvidence({ ...run, status: "running" }, [command()])).toBeNull();
    expect(deriveFinishEvidence({ ...run, status: "rolled_back" }, [command()])).toBeNull();
  });

  it("isolates the run and reports literal exit results without invented test counts", () => {
    const result = deriveFinishEvidence(run, [
      command(),
      command("cargo test", {
        id: TurnItemId.make("other"),
        runId: RunId.make("other-run"),
        exitCode: 1,
      }),
      edit("other.ts", 40, { threadId: ThreadId.make("other-thread") }),
    ])!;
    expect(result.commands).toHaveLength(1);
    expect(result.zeroExitChecks).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.commands[0]).toMatchObject({
      command: "pnpm test",
      exitCode: 0,
      startedAt: "2026-10-20T12:00:10.000Z",
      completedAt: "2026-10-20T12:00:20.000Z",
    });
  });

  it("marks a previously successful check stale after final edits and during a check", () => {
    const result = deriveFinishEvidence(run, [
      command(),
      edit("after.ts", 30),
      edit("during.ts", 15),
      edit("before.ts", 5),
    ])!;
    expect(result.staleChecks).toBe(1);
    expect(result.commands[0]?.laterFiles).toEqual(["after.ts", "during.ts"]);
    expect(result.files).toEqual(["after.ts", "before.ts", "during.ts"]);
  });

  it("does not mark a check stale when all reported edits happened before it started", () => {
    const result = deriveFinishEvidence(run, [edit("app.ts", 5), command()])!;
    expect(result.staleChecks).toBe(0);
    expect(result.commands[0]?.freshness).toBe("no-later-reported-edits");
  });

  it("uses file-change metadata for multiple and renamed files and deduplicates paths", () => {
    const result = deriveFinishEvidence(run, [
      command(),
      edit("batch", 30, {
        changes: [
          { operation: "rename", path: "new.ts", oldPath: "old.ts" },
          { operation: "edit", path: "new.ts" },
        ],
      }),
    ])!;
    expect(result.files).toEqual(["new.ts", "old.ts"]);
  });

  it("keeps absent exit codes, unfinished commands and missing start times uncertain", () => {
    const result = deriveFinishEvidence(run, [
      command("pytest", { startedAt: null }),
      command("ls", { id: TurnItemId.make("unknown"), exitCode: undefined }),
      command("npm test", { id: TurnItemId.make("running"), status: "running", completedAt: null }),
      edit("app.ts", 30),
    ])!;
    expect(result.unknownCount).toBe(2);
    expect(result.unknownTimingChecks).toBe(1);
    expect(result.zeroExitChecks).toBe(1);
  });

  it("does not count failed or cancelled file operations as confirmed edits", () => {
    const result = deriveFinishEvidence(run, [
      command(),
      edit("failed.ts", 30, { status: "failed" }),
    ])!;
    expect(result.files).toEqual([]);
    expect(result.unconfirmedFileChanges).toBe(1);
    expect(result.unknownTimingChecks).toBe(1);
  });

  it.each([
    { exitCode: 2 },
    { timedOut: true },
    { interrupted: true },
    { outputIndicatesFailure: true },
    { status: "failed" as const },
  ])("keeps failure evidence even if another success signal exists: %j", (failure) => {
    const result = deriveFinishEvidence(run, [command("npm test", failure)])!;
    expect(result.failedCount).toBe(1);
    expect(result.zeroExitChecks).toBe(0);
  });

  it.each([
    "npm test",
    "pnpm run lint",
    "vp test run src/one.test.ts",
    "node_modules/.bin/vp test run",
    "CI=1 npm test",
    "python3 -m pytest test_one.py",
    "cargo check",
    "go test ./pkg",
  ])("recognizes only simple check commands: %s", (input) =>
    expect(deriveFinishEvidence(run, [command(input)])?.zeroExitChecks).toBe(1),
  );

  it.each([
    "echo npm test",
    "npm test && echo done",
    "npm test || true",
    "npm test; touch app.ts",
    "ls",
    "node arbitrary-script.js",
    "git status",
    "printf 'all tests pass'",
  ])("does not infer a check from prose or opaque/compound commands: %s", (input) =>
    expect(deriveFinishEvidence(run, [command(input)])?.zeroExitChecks).toBe(0),
  );
});

describe("checks run after the turn", () => {
  const check = (exitCode: number, overrides: Partial<TurnCheck> = {}): TurnCheck => {
    const item = command("vp test", {
      id: TurnItemId.make(`check-${exitCode}`),
      runId: RunId.make("check-run"),
      source: "user_shell",
      exitCode,
      durationMs: 1_200,
      fullOutputPath: "/attachments/out-log.log",
    });
    return {
      runId: RunId.make(`check-run-${exitCode}`),
      ordinal: 6,
      subjectRunId: run.id,
      scriptId: "test",
      scriptName: "Test",
      command: "vp test",
      runStatus: "completed",
      item: item.type === "command_execution" ? item : null,
      outcome: exitCode === 0 ? "exit-zero" : "failed",
      skipReason: null,
      laterWork: false,
      ...overrides,
    };
  };

  it("keeps recorded check results with their live-folder freshness", () => {
    const evidence = deriveFinishEvidence(run, [], {
      turnOrdinal: 5,
      checks: { checks: [check(1), check(0, { laterWork: true })], incomplete: false },
    })!;
    expect(evidence.turnOrdinal).toBe(5);
    expect(evidence.checks?.map((entry) => [entry.name, entry.exitCode, entry.freshness])).toEqual([
      ["Test", 1, "no-later-turns"],
      ["Test", 0, "later-work"],
    ]);
    expect(evidence.checks?.[0]?.fullOutputPath).toBe("/attachments/out-log.log");
    const omitted = check(1);
    expect(
      deriveFinishEvidence(run, [], {
        turnOrdinal: 5,
        checks: {
          checks: [{ ...omitted, item: { ...omitted.item!, output: "x", outputOmitted: true } }],
          incomplete: false,
        },
      })?.checks?.[0]?.output,
    ).toBeNull();
    const unknown = deriveFinishEvidence(run, [], {
      turnOrdinal: 5,
      checks: { checks: [check(0)], incomplete: true },
    })!;
    expect(unknown.checks?.[0]?.freshness).toBe("unknown");
    expect(unknown.checksIncomplete).toBe(true);
  });

  it("labels each check by its exit code, never as passed", () => {
    const evidence = deriveFinishEvidence(run, [command("ls")], {
      turnOrdinal: 5,
      checks: { checks: [check(1), check(0)], incomplete: false },
    })!;
    const labels = (evidence.checks ?? []).map(
      (entry) => `${entry.name}: ${turnCheckResultLabel(entry.check)}`,
    );
    expect(labels).toEqual(["Test: exit 1 · 1.2s", "Test: exit 0 · 1.2s"]);
    expect(labels.join("\n")).not.toMatch(/passed|verified/i);
    expect(
      deriveFinishEvidence(run, [command("ls")], {
        turnOrdinal: 5,
        checks: { checks: [], incomplete: true },
      })?.checksIncomplete,
    ).toBe(true);
    expect(
      deriveFinishEvidence(run, [], { turnOrdinal: 5, checks: { checks: [], incomplete: false } }),
    ).toBeNull();
  });
});

describe("approval delivery in finish evidence", () => {
  const approval = (id: string): OrchestrationV2TurnItem => ({
    ...base,
    id: TurnItemId.make(`approval:${id}`),
    type: "approval_request",
    requestId: RuntimeRequestId.make(id),
    requestKind: "command",
  });
  const delivery = (state: "delivered" | "not_delivered" | "uncertain") => ({
    state,
    attempts: 1,
    updatedAt: "2026-10-20T12:00:30.000Z",
  });

  it("never reads as done when an answer did not, or may not, reach the agent", () => {
    const evidence = deriveFinishEvidence(
      run,
      [command(), approval("a"), approval("b"), approval("c"), approval("d")],
      undefined,
      [
        { id: RuntimeRequestId.make("a"), delivery: delivery("delivered") },
        { id: RuntimeRequestId.make("b"), delivery: delivery("not_delivered") },
        { id: RuntimeRequestId.make("c"), delivery: delivery("uncertain") },
        {
          id: RuntimeRequestId.make("d"),
          lost: { cause: "delivery_failed", deliveryUncertain: true },
        },
      ],
    );
    expect(evidence?.approvalDelivery).toEqual({ notDelivered: 1, uncertain: 2 });
    expect(finishApprovalDeliverySummary(evidence!)).toBe("Answer not delivered");
    expect(finishApprovalDeliveryNotes(evidence!)).toEqual([
      "1 approval answer was not delivered: nothing ran.",
      "Delivery of 2 approval answers is uncertain: check whether they ran.",
    ]);
  });

  it("lets a confirmed delivery outrank a loss kept as history", () => {
    // An uncertain answer later confirmed: its dismissed loss stays recorded on the request.
    const settled = deriveFinishEvidence(
      run,
      [command(), approval("a"), approval("b"), approval("c"), approval("d")],
      undefined,
      [
        {
          id: RuntimeRequestId.make("a"),
          delivery: delivery("delivered"),
          lost: { cause: "delivery_failed", deliveryUncertain: true },
        },
        {
          id: RuntimeRequestId.make("b"),
          delivery: { ...delivery("delivered"), state: "not_needed" },
          lost: { cause: "delivery_failed" },
        },
        // A loss still speaks while delivery is open, whatever its cause.
        {
          id: RuntimeRequestId.make("c"),
          delivery: { ...delivery("delivered"), state: "pending" },
          lost: { cause: "server_restart", deliveryUncertain: true },
        },
        {
          id: RuntimeRequestId.make("d"),
          delivery: delivery("not_delivered"),
          lost: { cause: "delivery_failed", deliveryUncertain: true },
        },
      ],
    );
    expect(settled?.approvalDelivery).toEqual({ notDelivered: 1, uncertain: 1 });
  });

  it("keeps a run with only an undelivered answer, and adds nothing when all arrived", () => {
    const failed = deriveFinishEvidence(run, [approval("x")], undefined, [
      { id: RuntimeRequestId.make("x"), lost: { cause: "delivery_failed" } },
    ]);
    expect(failed?.approvalDelivery).toEqual({ notDelivered: 1, uncertain: 0 });
    expect(finishApprovalDeliverySummary(failed!)).toBe("Answer not delivered");
    const fine = deriveFinishEvidence(run, [command(), approval("y")], undefined, [
      { id: RuntimeRequestId.make("y"), delivery: delivery("delivered") },
    ]);
    expect(fine?.approvalDelivery).toBeUndefined();
    expect(finishApprovalDeliveryNotes(fine!)).toEqual([]);
  });
});

describe("commands an approval kept from running", () => {
  it("reads a declined, lost or expired command as declined, never as failed", () => {
    // Claude records a declined command as failed; Codex records a lost one as cancelled.
    const claude = command("mkdir -p build", { status: "failed" });
    const codex = command("/bin/zsh -lc 'touch stamp.md'", {
      id: TurnItemId.make("codex-command"),
      status: "cancelled",
    });
    const evidence = deriveFinishEvidence(
      run,
      [claude, codex],
      undefined,
      undefined,
      new Set([TurnItemId.make("command"), TurnItemId.make("codex-command")]),
    );
    expect(evidence).toMatchObject({ failedCount: 0, declinedCount: 2, unknownCount: 0 });
    expect(evidence?.commands.map((entry) => entry.outcome)).toEqual(["declined", "declined"]);
  });

  it("keeps counting a command that ran and failed beside one that was declined", () => {
    const evidence = deriveFinishEvidence(
      run,
      [
        command("pnpm test", { exitCode: 1 }),
        command("rm -rf build", { id: TurnItemId.make("declined"), status: "failed" }),
      ],
      undefined,
      undefined,
      new Set([TurnItemId.make("declined")]),
    );
    expect(evidence).toMatchObject({ failedCount: 1, declinedCount: 1 });
  });
});

describe("file edits an approval kept from being written", () => {
  it("reads a declined edit as a decided outcome, not as incomplete evidence", () => {
    // Claude records a declined edit as failed; Codex records a declined one as cancelled.
    const claude = edit("calc.py", 30, { status: "failed" });
    const codex = edit("test_calc.py", 31, { status: "cancelled" });
    const evidence = deriveFinishEvidence(
      run,
      [command("python3 test_calc.py", { exitCode: 0 }), claude, codex],
      undefined,
      undefined,
      new Set([TurnItemId.make("calc.py"), TurnItemId.make("test_calc.py")]),
    );
    expect(evidence).toMatchObject({
      unconfirmedFileChanges: 0,
      declinedFileChanges: 2,
      files: [],
    });
  });

  it("shows the card for a run whose only work was a declined edit", () => {
    const evidence = deriveFinishEvidence(
      run,
      [edit("calc.py", 30, { status: "failed" })],
      undefined,
      undefined,
      new Set([TurnItemId.make("calc.py")]),
    );
    expect(evidence).toMatchObject({ declinedFileChanges: 1, unconfirmedFileChanges: 0 });
  });

  it("still counts an edit with no confirmed completion and no declined approval", () => {
    const evidence = deriveFinishEvidence(run, [
      command("pnpm test", { exitCode: 0 }),
      edit("calc.py", 30, { status: "failed" }),
    ]);
    expect(evidence).toMatchObject({ unconfirmedFileChanges: 1, declinedFileChanges: 0 });
  });
});
