import { describe, expect, it } from "vite-plus/test";
import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import { deriveFinishEvidence } from "./finishEvidence";

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
