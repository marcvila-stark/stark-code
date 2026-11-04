import {
  MessageId,
  RunId,
  TurnItemId,
  USER_SHELL_CHECK_SUPERSEDED_CODE,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserShellCheck,
  type ReviewCommentContextRecord,
} from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { checksForRun, correctionLinkOfRun, correctionsOfRun } from "./reviewChain.ts";

function run(
  ordinal: number,
  status: OrchestrationV2Run["status"] = "completed",
): OrchestrationV2Run {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId: v2ThreadId,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: v2Now,
    startedAt: status === "queued" ? null : v2Now,
    completedAt: status === "completed" ? v2Now : null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function message(
  ordinal: number,
  extra: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(`message-${ordinal}`),
    threadId: v2ThreadId,
    runId: RunId.make(`run-${ordinal}`),
    nodeId: null,
    role: "user",
    text: `message ${ordinal}`,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: v2Now,
    updatedAt: v2Now,
    ...extra,
  };
}

function checkMessage(ordinal: number, check: OrchestrationV2UserShellCheck) {
  return message(ordinal, {
    text: "vp test",
    userShell: { command: "vp test", respond: false, check },
  });
}

function commandItem(ordinal: number, exitCode: number): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`command-${ordinal}`),
    threadId: v2ThreadId,
    runId: RunId.make(`run-${ordinal}`),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: ordinal * 100 + 1,
    status: "completed",
    title: null,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
    type: "command_execution",
    source: "user_shell",
    input: "vp test",
    output: "1 failed",
    exitCode,
    durationMs: 1200,
  };
}

function reviewComment(
  id: string,
  fields: Partial<ReviewCommentContextRecord> = {},
): ReviewCommentContextRecord {
  return {
    version: 1,
    contextId: `review-comment:${id}` as ReviewCommentContextRecord["contextId"],
    kind: "review-comment",
    label: "app.ts +3",
    sectionId: "turn:run-1",
    sectionTitle: "Turn 1",
    filePath: "src/app.ts",
    startIndex: 2,
    endIndex: 2,
    rangeLabel: "+3",
    text: "Use the helper",
    diff: "+const value = 1;",
    ...fields,
  };
}

function correction(ordinal: number, comments: ReadonlyArray<ReviewCommentContextRecord>) {
  return message(ordinal, { context: { version: 1, records: comments } });
}

const subjectId = RunId.make("run-1");
const complete = { historyComplete: true };
const windowed = { historyComplete: false };

describe("checksForRun", () => {
  it("lists the checks run after a turn with their recorded result", () => {
    const projection = {
      ...v2Projection,
      runs: [run(1), run(2), run(3, "running")],
      messages: [
        message(1),
        checkMessage(2, { subjectRunId: subjectId, scriptId: "test", scriptName: "Test" }),
        checkMessage(3, { subjectRunId: subjectId }),
      ],
      turnItems: [commandItem(2, 1)],
    };
    const result = checksForRun(projection, subjectId, complete);
    expect(result.incomplete).toBe(false);
    expect(
      result.checks.map((check) => [check.runId, check.scriptName, check.outcome, check.laterWork]),
    ).toEqual([
      [RunId.make("run-2"), "Test", "failed", false],
      [RunId.make("run-3"), null, "running", false],
    ]);
    expect(result.checks[0]?.item?.exitCode).toBe(1);
  });

  it("flags checks that later work may have outdated", () => {
    const projection = {
      ...v2Projection,
      runs: [run(1), run(2), run(3)],
      messages: [message(1), checkMessage(2, { subjectRunId: subjectId }), message(3)],
      turnItems: [commandItem(2, 0)],
    };
    const [check] = checksForRun(projection, subjectId, complete).checks;
    expect(check?.outcome).toBe("exit-zero");
    expect(check?.laterWork).toBe(true);
  });

  it("reports a skipped check with the server's reason", () => {
    const skipped = { ...run(2, "cancelled"), startedAt: null };
    const projection = {
      ...v2Projection,
      runs: [run(1), skipped, run(3)],
      messages: [message(1), checkMessage(2, { subjectRunId: subjectId }), message(3)],
      turnItems: [
        {
          id: TurnItemId.make("skip-2"),
          threadId: v2ThreadId,
          runId: skipped.id,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 201,
          status: "failed",
          title: "Check skipped",
          startedAt: v2Now,
          completedAt: v2Now,
          updatedAt: v2Now,
          type: "error",
          failure: {
            class: "validation_error",
            message: "Check skipped: newer work ran in this folder after Turn 1.",
            code: USER_SHELL_CHECK_SUPERSEDED_CODE,
            retryable: false,
          },
        } satisfies OrchestrationV2TurnItem,
      ],
    };
    const [check] = checksForRun(projection, subjectId, complete).checks;
    expect(check?.outcome).toBe("skipped");
    expect(check?.skipReason).toContain("after Turn 1");
  });

  it("says the list is incomplete instead of empty when records are outside the window", () => {
    const unloadedMessage = {
      ...v2Projection,
      runs: [run(1), run(2)],
      messages: [message(1)],
    };
    expect(checksForRun(unloadedMessage, subjectId, windowed)).toEqual({
      checks: [],
      incomplete: true,
    });
    expect(checksForRun(unloadedMessage, subjectId, complete).incomplete).toBe(false);
    expect(
      checksForRun({ ...v2Projection, runs: [run(4)] }, RunId.make("run-old"), windowed).incomplete,
    ).toBe(true);
  });
});

describe("correctionLinkOfRun", () => {
  it("links a correction to the turn its comments name", () => {
    const projection = {
      ...v2Projection,
      runs: [run(1), run(2)],
      messages: [
        message(1),
        correction(2, [
          reviewComment("a", { runId: subjectId, sectionId: "turn:3" }),
          reviewComment("b", { runId: subjectId }),
        ]),
      ],
    };
    expect(correctionLinkOfRun(projection, RunId.make("run-2"), complete)).toEqual({
      kind: "linked",
      reviewedRunId: subjectId,
      commentCount: 2,
    });
    expect(correctionsOfRun(projection, subjectId, complete).map((entry) => entry.id)).toEqual([
      RunId.make("run-2"),
    ]);
  });

  it("falls back to a web section id only when that run exists, and ignores mobile ordinals", () => {
    const projection = {
      ...v2Projection,
      runs: [run(1), run(2), run(3)],
      messages: [
        message(1),
        correction(2, [reviewComment("web")]),
        correction(3, [reviewComment("mobile", { sectionId: "turn:1" })]),
      ],
    };
    expect(correctionLinkOfRun(projection, RunId.make("run-2"), complete)).toMatchObject({
      kind: "linked",
      reviewedRunId: subjectId,
    });
    expect(correctionLinkOfRun(projection, RunId.make("run-3"), complete)).toBeNull();
  });

  it("only links backward, which keeps corrections free of cycles", () => {
    const projection = {
      ...v2Projection,
      runs: [run(1), run(2)],
      messages: [
        correction(1, [reviewComment("forward", { runId: RunId.make("run-2") })]),
        correction(2, [reviewComment("self", { runId: RunId.make("run-2") })]),
      ],
    };
    expect(correctionLinkOfRun(projection, subjectId, complete)).toBeNull();
    expect(correctionLinkOfRun(projection, RunId.make("run-2"), complete)).toBeNull();
  });

  it("ignores a pasted comment from another thread but keeps an unloaded turn unknown", () => {
    const projection = {
      ...v2Projection,
      runs: [run(5)],
      messages: [correction(5, [reviewComment("elsewhere", { runId: RunId.make("run-x") })])],
    };
    expect(correctionLinkOfRun(projection, RunId.make("run-5"), complete)).toBeNull();
    expect(correctionLinkOfRun(projection, RunId.make("run-5"), windowed)).toEqual({
      kind: "incomplete",
      commentCount: 1,
    });
    const unloadedMessage = { ...projection, messages: [] };
    expect(correctionLinkOfRun(unloadedMessage, RunId.make("run-5"), windowed)).toEqual({
      kind: "unknown",
    });
    expect(correctionLinkOfRun(unloadedMessage, RunId.make("run-5"), complete)).toBeNull();
  });

  it("picks the newest reviewed turn when comments name several", () => {
    const projection = {
      ...v2Projection,
      runs: [run(1), run(2), run(3)],
      messages: [
        message(1),
        message(2),
        correction(3, [
          reviewComment("older", { runId: subjectId }),
          reviewComment("newer", { runId: RunId.make("run-2") }),
        ]),
      ],
    };
    expect(correctionLinkOfRun(projection, RunId.make("run-3"), complete)).toEqual({
      kind: "linked",
      reviewedRunId: RunId.make("run-2"),
      commentCount: 1,
    });
  });
});
