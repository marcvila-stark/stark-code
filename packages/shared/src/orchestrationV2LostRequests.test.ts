import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

import {
  askAgainText,
  isOpenLostRuntimeRequest,
  isPersonFacingRuntimeRequest,
  lostRuntimeRequestCauseText,
  lostRuntimeRequestDetail,
  lostRuntimeRequestLabel,
  openLostRuntimeRequests,
} from "./orchestrationV2LostRequests.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const request = (
  id: string,
  overrides: Partial<OrchestrationV2RuntimeRequest> = {},
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make(`node-${id}`),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "expired",
  responseCapability: { type: "not_resumable", reason: "The server restarted." },
  createdAt: at("2026-10-29T10:00:00.000Z"),
  resolvedAt: at("2026-10-29T10:05:00.000Z"),
  ...overrides,
});

describe("isPersonFacingRuntimeRequest", () => {
  it.each([
    ["an approval", "command", "live", true],
    ["a live question", "user_input", "live", true],
    ["a message-capable question", "user_input", "message", false],
    ["a tool call", "dynamic_tool_call", "live", false],
    ["a sign-in refresh", "auth_refresh", "live", false],
  ] as const)("%s: %s", (_case, kind, capability, expected) => {
    expect(
      isPersonFacingRuntimeRequest({
        kind,
        responseCapability:
          capability === "live"
            ? { type: "live", providerSessionId: ProviderSessionId.make("session") }
            : { type: "message" },
      }),
    ).toBe(expected);
  });
});

describe("open lost requests", () => {
  const lostAt = at("2026-10-29T10:05:00.000Z");
  it("stays open until the user asks again or dismisses it", () => {
    expect(isOpenLostRuntimeRequest(request("plain"))).toBe(false);
    expect(
      isOpenLostRuntimeRequest(request("open", { lost: { cause: "server_restart", lostAt } })),
    ).toBe(true);
    expect(
      isOpenLostRuntimeRequest(
        request("asked", { lost: { cause: "server_restart", lostAt, askedAgainAt: lostAt } }),
      ),
    ).toBe(false);
    expect(
      isOpenLostRuntimeRequest(
        request("dismissed", { lost: { cause: "provider_exit", lostAt, dismissedAt: lostAt } }),
      ),
    ).toBe(false);
  });

  it("orders by loss, then creation, then id", () => {
    const later = at("2026-10-29T11:00:00.000Z");
    const ordered = openLostRuntimeRequests([
      request("c", { lost: { cause: "provider_exit", lostAt: later } }),
      request("b", { lost: { cause: "server_restart", lostAt } }),
      request("a", { lost: { cause: "server_restart", lostAt } }),
      request("done", { lost: { cause: "server_restart", lostAt, dismissedAt: later } }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

describe("lostRuntimeRequestLabel", () => {
  it.each([
    [{ kind: "command", cause: "server_restart" }, "Approval lost: Stark Code restarted"],
    [{ kind: "file-change", cause: "server_shutdown" }, "Approval lost: Stark Code shut down"],
    [{ kind: "user_input", cause: "provider_exit" }, "Question lost: the agent process stopped"],
    [
      { kind: "command", cause: "server_restart", deliveryUncertain: true },
      "Answer may not have reached the agent: Stark Code restarted",
    ],
    [{ kind: "command", cause: "delivery_failed" }, "Not delivered: nothing ran"],
    [{ kind: "command", cause: "delivery_failed", deliveryUncertain: true }, "Delivery uncertain"],
  ] as const)("%o", (input, label) => {
    expect(lostRuntimeRequestLabel(input)).toBe(label);
  });

  it("names a failed delivery as the cause, mid-sentence or leading", () => {
    expect(lostRuntimeRequestCauseText("delivery_failed")).toBe(
      "the answer could not be delivered",
    );
    expect(lostRuntimeRequestCauseText("delivery_failed", true)).toBe(
      "The answer could not be delivered",
    );
  });
});

describe("lostRuntimeRequestDetail", () => {
  const threadId = ThreadId.make("thread");
  const now = at("2026-10-29T10:00:00.000Z");
  const base = {
    threadId,
    runId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "cancelled",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  } as const;

  it("joins the command the approval node hangs off, not a sibling", () => {
    const lost = request("cmd");
    const commandNodeId = NodeId.make("command-node");
    const items: OrchestrationV2TurnItem[] = [
      {
        ...base,
        id: TurnItemId.make("command"),
        nodeId: commandNodeId,
        type: "command_execution",
        input: "npm test",
      } as OrchestrationV2TurnItem,
      {
        ...base,
        id: TurnItemId.make("sibling"),
        nodeId: NodeId.make("sibling-node"),
        type: "command_execution",
        input: "rm -rf build",
      } as OrchestrationV2TurnItem,
      {
        ...base,
        id: TurnItemId.make("approval"),
        nodeId: lost.nodeId,
        type: "approval_request",
        requestId: lost.id,
        requestKind: "command",
        prompt: "Run the tests",
      },
    ];
    const detail = lostRuntimeRequestDetail(lost, {
      turnItems: items,
      nodes: [
        {
          id: lost.nodeId,
          threadId,
          runId: null,
          parentNodeId: commandNodeId,
          rootNodeId: commandNodeId,
          kind: "approval_request",
          status: "cancelled",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: lost.id,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      ],
    });
    expect(detail).toEqual({ command: "npm test", prompt: "Run the tests" });
  });

  it("falls back to the approval's own command when no command item links to it", () => {
    // A native subagent's Bash approval has no command item; the approval carries the command.
    const lost = request("subagent-cmd");
    const approval = {
      ...base,
      id: TurnItemId.make("subagent-approval"),
      nodeId: lost.nodeId,
      type: "approval_request",
      requestId: lost.id,
      requestKind: "command",
      prompt: "Claude wants to run npm test",
      command: "npm test",
    } as const;
    expect(lostRuntimeRequestDetail(lost, { turnItems: [approval], nodes: [] })).toEqual({
      command: "npm test",
      prompt: "Claude wants to run npm test",
    });
    // A blank command is no command.
    expect(
      lostRuntimeRequestDetail(lost, {
        turnItems: [{ ...approval, command: "  " }],
        nodes: [],
      }),
    ).toEqual({ prompt: "Claude wants to run npm test" });
  });

  it("prefers the linked command item over the approval's own command", () => {
    const lost = request("linked-cmd");
    const commandNodeId = NodeId.make("linked-command-node");
    const detail = lostRuntimeRequestDetail(lost, {
      turnItems: [
        {
          ...base,
          id: TurnItemId.make("linked-command"),
          nodeId: commandNodeId,
          type: "command_execution",
          input: "npm test -- --run",
        } as OrchestrationV2TurnItem,
        {
          ...base,
          id: TurnItemId.make("linked-approval"),
          nodeId: lost.nodeId,
          type: "approval_request",
          requestId: lost.id,
          requestKind: "command",
          command: "npm test",
        },
      ],
      nodes: [
        {
          id: lost.nodeId,
          threadId,
          runId: null,
          parentNodeId: commandNodeId,
          rootNodeId: commandNodeId,
          kind: "approval_request",
          status: "cancelled",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: lost.id,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      ],
    });
    expect(detail).toEqual({ command: "npm test -- --run" });
  });

  it("reads a question's text", () => {
    const lost = request("question", { kind: "user_input" });
    expect(
      lostRuntimeRequestDetail(lost, {
        turnItems: [
          {
            ...base,
            id: TurnItemId.make("question"),
            nodeId: lost.nodeId,
            type: "user_input_request",
            requestId: lost.id,
            questions: [{ id: "color", header: "Color", question: "Which color?", options: [] }],
          },
        ],
      }),
    ).toEqual({ questions: [{ id: "color", question: "Which color?" }] });
  });
});

describe("askAgainText", () => {
  const lostAt = at("2026-10-29T10:05:00.000Z");

  it("names the command and asks the agent to retry it", () => {
    expect(
      askAgainText([
        { kind: "command", lost: { cause: "server_restart", lostAt }, command: "npm test" },
      ]),
    ).toBe(
      "Stark Code restarted before I answered your request to run `npm test`, so that request was lost. If the step is still needed, try it again and ask me again.",
    );
  });

  it("names a lost question and the agent process stopping", () => {
    expect(
      askAgainText([
        {
          kind: "user_input",
          lost: { cause: "provider_exit", lostAt },
          questions: [
            { id: "a", question: "Which color?" },
            { id: "b", question: "Which size?" },
          ],
        },
      ]),
    ).toBe(
      "The agent process stopped before I answered your question: `Which color?` (and 1 more), so that question was lost. If the step is still needed, try it again and ask me again.",
    );
  });

  it("keeps an answer whose delivery is uncertain and asks the agent to check first", () => {
    const text = askAgainText([
      {
        kind: "command",
        lost: { cause: "server_shutdown", lostAt, deliveryUncertain: true },
        decision: "acceptAlways",
        command: "git push",
      },
    ]);
    expect(text).toBe(
      "I answered your request to run `git push` (I approved it), but Stark Code shut down before my answer was confirmed, so it may not have reached you. Check whether that step already ran. If it did not and it is still needed, try it again and ask me again.",
    );
  });

  it("lists several requests and bounds quoted text", () => {
    const text = askAgainText([
      { kind: "file-change", lost: { cause: "server_restart", lostAt } },
      {
        kind: "command",
        lost: { cause: "server_restart", lostAt },
        command: `echo ${"x".repeat(1_000)}`,
      },
      {
        kind: "user_input",
        lost: { cause: "server_restart", lostAt, deliveryUncertain: true },
        questions: [{ id: "color", question: "Which color?" }],
        answers: { color: "Blue" },
      },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("These requests were lost before my answers reached you:");
    expect(lines[1]).toBe(
      "- Stark Code restarted before I answered your request to change files, so that request was lost.",
    );
    expect(lines[2]!.length).toBeLessThan(420);
    expect(lines[3]).toContain("(my answer was Which color?: Blue)");
    expect(lines.at(-1)).toContain("Check whether each step already ran.");
  });

  it("fences commands that contain backticks", () => {
    expect(
      askAgainText([
        { kind: "command", lost: { cause: "server_restart", lostAt }, command: "echo `date`" },
      ]),
    ).toContain("run `` echo `date` ``");
  });
});
