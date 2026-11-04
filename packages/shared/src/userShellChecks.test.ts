import {
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2UserShellCheck,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { latestCheckSubjectRun, validateUserShellCheckSubject } from "./userShellChecks.ts";

const at = (second: number) =>
  DateTime.makeUnsafe(`2026-10-29T12:00:${String(second).padStart(2, "0")}Z`);

function run(
  ordinal: number,
  status: OrchestrationV2Run["status"],
  times: { readonly started?: number; readonly completed?: number } = {},
): OrchestrationV2Run {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId: ThreadId.make("thread"),
    ordinal,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: at(ordinal),
    startedAt: times.started === undefined ? null : at(times.started),
    completedAt: times.completed === undefined ? null : at(times.completed),
    checkpointId: null,
    contextHandoffId: null,
  };
}

function message(ordinal: number, check?: OrchestrationV2UserShellCheck) {
  return {
    id: MessageId.make(`message-${ordinal}`),
    ...(check === undefined ? {} : { userShell: { command: "vp test", respond: false, check } }),
  };
}

const subject = run(1, "completed", { started: 1, completed: 5 });
const checkOfSubject = { subjectRunId: subject.id, scriptName: "Test" };

describe("user shell check subjects", () => {
  it("chooses the latest executed work and skips checks run after it", () => {
    const projection = {
      runs: [subject, run(2, "completed", { started: 6, completed: 9 })],
      messages: [message(1), message(2, checkOfSubject)],
    };
    expect(latestCheckSubjectRun(projection)?.id).toBe(subject.id);
    expect(validateUserShellCheckSubject(projection, subject.id, "dispatch")).toEqual({
      ok: true,
      subject,
    });
  });

  it("rejects a missing run, a check, and unfinished work", () => {
    const check = run(2, "completed", { started: 6, completed: 9 });
    const messages = [message(1), message(2, checkOfSubject)];
    expect(
      validateUserShellCheckSubject(
        { runs: [subject, check], messages },
        RunId.make("elsewhere"),
        "dispatch",
      ),
    ).toEqual({ ok: false, reason: "not-found" });
    expect(
      validateUserShellCheckSubject({ runs: [subject, check], messages }, check.id, "dispatch"),
    ).toEqual({ ok: false, reason: "is-check" });
    for (const status of ["running", "starting", "queued"] as const) {
      expect(
        validateUserShellCheckSubject(
          { runs: [run(1, status, { started: 1 })], messages: [message(1)] },
          subject.id,
          "dispatch",
        ),
      ).toEqual({ ok: false, reason: "unfinished" });
    }
    expect(
      validateUserShellCheckSubject(
        { runs: [run(1, "cancelled", { completed: 2 })], messages: [message(1)] },
        subject.id,
        "dispatch",
      ),
    ).toEqual({ ok: false, reason: "not-found" });
  });

  it("rejects work superseded by newer work, rollback, or queued work at dispatch", () => {
    const messages = [message(1), message(2)];
    expect(
      validateUserShellCheckSubject(
        { runs: [subject, run(2, "completed", { started: 6, completed: 9 })], messages },
        subject.id,
        "dispatch",
      ),
    ).toEqual({ ok: false, reason: "superseded" });
    expect(
      validateUserShellCheckSubject(
        { runs: [{ ...subject, status: "rolled_back" }], messages },
        subject.id,
        "dispatch",
      ),
    ).toEqual({ ok: false, reason: "superseded" });
    const queuedWork = { runs: [subject, run(2, "queued")], messages };
    expect(validateUserShellCheckSubject(queuedWork, subject.id, "dispatch")).toEqual({
      ok: false,
      reason: "superseded",
    });
    // Queued work behind a starting check has not touched the folder yet.
    expect(validateUserShellCheckSubject(queuedWork, subject.id, "start").ok).toBe(true);
  });

  it("rejects a starting check once reordered work has run since its turn", () => {
    const projection = {
      runs: [
        subject,
        { ...run(2, "queued"), queuePosition: 2 },
        run(3, "completed", { started: 6, completed: 9 }),
      ],
      messages: [message(1), message(2, checkOfSubject), message(3)],
    };
    expect(validateUserShellCheckSubject(projection, subject.id, "start")).toEqual({
      ok: false,
      reason: "superseded",
    });
  });
});
