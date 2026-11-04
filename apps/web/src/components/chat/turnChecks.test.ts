import { describe, expect, it } from "vite-plus/test";
import { CommandId, MessageId, RunId, ThreadId, type ProjectScript } from "@starkfuture/contracts";

import {
  buildTurnCheckDispatch,
  checkFixPrompt,
  checkRanAfterLabel,
  checkScripts,
  shellOutputAttachment,
  turnCheckAvailability,
  turnCheckResultLabel,
} from "./turnChecks";
import { userShellStatus } from "./UserShellCommandRow";

const script = (id: string, icon: ProjectScript["icon"], command = `vp ${id}`): ProjectScript => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  command,
  icon,
  runOnWorktreeCreate: false,
});

const ready = {
  capability: true,
  allowed: true,
  canOperateThread: true,
  canOperateTerminal: true,
  driver: "codex",
  nativeAgentRunning: false,
  providerSubagent: false,
  subject: { ok: true as const, subject: {} as never },
};

describe("turn checks", () => {
  it("offers only test and lint project actions, in their configured order", () => {
    expect(
      checkScripts([
        script("dev", "play"),
        script("lint", "lint"),
        script("build", "build"),
        script("test", "test"),
      ]).map((entry) => entry.id),
    ).toEqual(["lint", "test"]);
  });

  it("keeps the human shell command boundary and says why a check cannot run", () => {
    expect(turnCheckAvailability(ready)).toEqual({ kind: "available" });
    expect(turnCheckAvailability({ ...ready, driver: "claudeAgent" }).kind).toBe("available");
    expect(turnCheckAvailability({ ...ready, capability: false })).toEqual({ kind: "hidden" });
    const reasons = [
      { ...ready, allowed: false },
      { ...ready, canOperateTerminal: false },
      { ...ready, canOperateThread: false },
      { ...ready, driver: "cursor" },
      { ...ready, driver: null },
      { ...ready, nativeAgentRunning: true },
      { ...ready, providerSubagent: true },
      { ...ready, subject: null },
      { ...ready, subject: { ok: false as const, reason: "unfinished" as const } },
      { ...ready, subject: { ok: false as const, reason: "superseded" as const } },
    ].map((input) => {
      const availability = turnCheckAvailability(input);
      return availability.kind === "unavailable" ? availability.reason : availability.kind;
    });
    expect(reasons).toEqual([
      "Shell commands are turned off for this environment.",
      "Running checks needs permission to operate threads and terminals here.",
      "Running checks needs permission to operate threads and terminals here.",
      "Recorded checks need a Codex or Claude thread. Run the script from Project actions instead.",
      "Recorded checks need a Codex or Claude thread. Run the script from Project actions instead.",
      "The native agent is still running in this thread's terminal.",
      "This thread belongs to an agent the provider started, so it cannot run checks.",
      "No finished turn to check yet.",
      "Checks run after the turn finishes.",
      "Checks run after queued messages have run.",
    ]);
  });

  it("dispatches a recorded, non-responding shell command linked to its turn", () => {
    const dispatch = buildTurnCheckDispatch({
      commandId: CommandId.make("command"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("message"),
      script: script("test", "test", "  vp test run  "),
      subjectRunId: RunId.make("run-5"),
      running: true,
      nativeAgentRunning: false,
    });
    expect(dispatch).toMatchObject({
      type: "thread.shell-command.dispatch",
      command: "vp test run",
      respond: false,
      createdBy: "user",
      dispatchMode: { type: "queue_after_active" },
      check: { subjectRunId: "run-5", scriptId: "test", scriptName: "Test" },
    });
    expect(() =>
      buildTurnCheckDispatch({
        commandId: CommandId.make("command"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("message"),
        script: script("test", "test"),
        subjectRunId: RunId.make("run-5"),
        running: false,
        nativeAgentRunning: true,
      }),
    ).toThrow("native agent");
  });

  it("drafts a fix request with a bounded tail of the output", () => {
    const output = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const prompt = checkFixPrompt({
      turnLabel: "Turn 5",
      command: "vp test",
      exitCode: 1,
      timedOut: false,
      output,
    });
    expect(prompt.split("\n").slice(0, 2)).toEqual([
      "`vp test` exited 1 when run after Turn 5.",
      "Fix the failures it reported.",
    ]);
    expect(prompt).toContain("line 99");
    expect(prompt).toContain("line 60");
    expect(prompt).not.toContain("line 59\n");
    const long = checkFixPrompt({
      turnLabel: "Turn 5",
      command: "vp test",
      exitCode: null,
      timedOut: true,
      output: "x".repeat(10_000),
    });
    expect(long).toContain("timed out when run after Turn 5");
    expect(long.length).toBeLessThan(4_200);
    expect(
      checkFixPrompt({
        turnLabel: "Turn 5",
        command: "vp lint",
        exitCode: 2,
        timedOut: false,
        output: "```\nnested fence\n```",
      }),
    ).toContain("````text");
    const omitted = checkFixPrompt({
      turnLabel: "Turn 5",
      command: "vp test",
      exitCode: 1,
      timedOut: false,
      output: null,
    });
    expect(omitted).toContain("Its output is recorded in this thread.");
    expect(omitted).not.toContain("```");
  });

  it("says a check ran after its turn in the live folder, never that it verified the turn", () => {
    expect(checkRanAfterLabel("Turn 5")).toBe("ran after Turn 5 in the live folder");
    expect(checkRanAfterLabel("Turn 5")).not.toMatch(/verif|pass/i);
  });

  it("labels results with the exit code and never as passed", () => {
    const item = (exitCode: number) => ({ exitCode, durationMs: 12_400 }) as never;
    expect(turnCheckResultLabel({ outcome: "exit-zero", item: item(0) })).toBe("exit 0 · 12.4s");
    expect(turnCheckResultLabel({ outcome: "failed", item: item(1) })).toBe("exit 1 · 12.4s");
    expect(turnCheckResultLabel({ outcome: "failed", item: null })).toBe("failed to start");
    expect(turnCheckResultLabel({ outcome: "skipped", item: null })).toBe("skipped");
    expect(turnCheckResultLabel({ outcome: "unknown", item: null })).toBe("result not recorded");
  });

  it("opens only saved shell logs as attachments", () => {
    expect(shellOutputAttachment("/data/attachments/abc-log.log")).toMatchObject({
      id: "abc-log",
      name: "shell-output.log",
    });
    expect(shellOutputAttachment("/data/attachments/abc.txt")).toBeNull();
  });

  it("shows a shell command that never started as not run instead of queued", () => {
    expect(userShellStatus(null, "cancelled")).toBe("not run");
    expect(userShellStatus(null, "queued")).toBe("Queued");
  });
});
