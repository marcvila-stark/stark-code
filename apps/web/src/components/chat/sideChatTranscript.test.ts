import {
  MessageId,
  PlanId,
  RunId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../../test-fixtures";
import { sideChatTranscript } from "./sideChatTranscript";

const time = (seconds: number) => DateTime.makeUnsafe(`2026-10-23T10:00:0${seconds}Z`);
const base = makeThreadProjectionFixture();
const runId = RunId.make("plan-run");
const plan: Extract<OrchestrationV2TurnItem, { type: "proposed_plan" }> = {
  id: TurnItemId.make("plan-item"),
  threadId: base.thread.id,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: time(1),
  completedAt: time(1),
  updatedAt: time(1),
  type: "proposed_plan",
  planId: PlanId.make("plan"),
  markdown: "Keep the existing queue and add bounded retries.",
  streaming: false,
};
const message = (id: string, role: "user" | "assistant", text: string, seconds: number) => ({
  id: MessageId.make(id),
  threadId: base.thread.id,
  runId,
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdBy: "user" as const,
  creationSource: "web" as const,
  createdAt: time(seconds),
  updatedAt: time(seconds),
});

describe("side chat plan answers", () => {
  it("places a plan-only answer between its question and the next follow-up", () => {
    const transcript = sideChatTranscript({
      messages: [
        message("question", "user", "How should retries work?", 0),
        message("followup", "user", "What about failures?", 2),
      ],
      turnItems: [plan],
    });
    expect(transcript.map((entry) => entry.text)).toEqual([
      "How should retries work?",
      plan.markdown,
      "What about failures?",
    ]);
    expect(transcript[1]).toMatchObject({ isPlan: true, canBringBack: true });
    expect(transcript[1]?.citationMessageId).toBeUndefined();
  });

  it("does not duplicate a plan that is already represented by an assistant message", () => {
    const transcript = sideChatTranscript({
      messages: [message("answer", "assistant", plan.markdown, 1)],
      turnItems: [plan],
    });
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      text: plan.markdown,
      citationMessageId: "answer",
      canBringBack: true,
    });
  });

  it.each([
    { status: "running" as const, streaming: true },
    { status: "running" as const, streaming: false },
    { status: "failed" as const, streaming: false },
  ])("shows an unfinished plan but does not offer it as a finished reply: %j", (state) => {
    const transcript = sideChatTranscript({ messages: [], turnItems: [{ ...plan, ...state }] });
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({ text: plan.markdown, canBringBack: false });
  });
});
