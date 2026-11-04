import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ThreadProjection,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  createQuestionHistoryProjector,
  deriveApprovalRecords,
  deriveDeclinedApprovalItemIds,
  deriveLostThreadRequests,
  derivePendingThreadRequests,
  seedUserInputDraftAnswers,
} from "./threadRequests.ts";

const requestId = RuntimeRequestId.make("async-question");
const nodeId = NodeId.make("async-question-node");

describe("initial user input drafts", () => {
  const questions = [
    { id: "editor", initialAnswer: "  Proposed commit\n\n" },
    { id: "empty", initialAnswer: "" },
    { id: "ordinary" },
    { id: "choices", initialAnswer: "Ignore this", allowCustomAnswer: false },
  ];

  it("seeds editable answers and preserves edits and selections on later snapshots", () => {
    const seeded = seedUserInputDraftAnswers(questions, {});
    expect(seeded).toEqual({
      editor: { customAnswer: "  Proposed commit\n\n" },
      empty: { customAnswer: "" },
    });
    const edits = {
      ...seeded,
      editor: { customAnswer: "" },
      empty: { selectedOptionValues: ["empty"], customAnswer: "" },
    };
    expect(seedUserInputDraftAnswers(questions, edits)).toEqual(edits);
    expect(
      seedUserInputDraftAnswers(questions, { editor: { customAnswer: "Edited commit" } }).editor,
    ).toEqual({ customAnswer: "Edited commit" });
    expect(seedUserInputDraftAnswers(questions, {}).editor).toEqual({
      customAnswer: "  Proposed commit\n\n",
    });
  });
});
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("async-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      responseMode: "message",
      questions: [
        {
          id: "next",
          header: "Next",
          question: "What should happen next?",
          required: true,
          allowCustomAnswer: false,
          options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
        },
      ],
    },
  ],
};

describe("pending v2 questions", () => {
  it("keeps message responses available after the originating runtime exits", () => {
    expect(projection.providerSessions).toEqual([]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([
      {
        requestId,
        createdAt: "2026-06-20T00:00:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What should happen next?",
            required: true,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
          },
        ],
      },
    ]);
  });

  it("only marks asynchronous questions as dismissible", () => {
    const live = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("live-session"),
        },
      })),
      turnItems: projection.turnItems.map((item) =>
        item.type === "user_input_request" ? { ...item, responseMode: undefined } : item,
      ),
    };
    expect(derivePendingThreadRequests(live).userInputs[0]?.dismissible).toBe(false);
  });

  it("removes answered requests from the composer while retaining their answers in projection data", () => {
    const answered = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        status: "resolved" as const,
        resolvedAt: v2Now,
        answers: { next: "  continue  " },
      })),
    };
    expect(derivePendingThreadRequests(answered).userInputs).toEqual([]);
    expect(answered.runtimeRequests[0]?.answers).toEqual({ next: "  continue  " });
  });
});

it("restores old text answers without mutating history or replacing unchanged rows", () => {
  const project = createQuestionHistoryProjector();
  const item = projection.turnItems[0]!;
  const row = {
    item,
    position: 0,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: "local" as const,
  };
  const rows = [row];
  const pending = { visibleTurnItems: rows, runtimeRequests: projection.runtimeRequests };
  expect(project(pending)).toBe(rows);
  const answered = {
    ...pending,
    runtimeRequests: [
      {
        ...projection.runtimeRequests[0]!,
        status: "resolved" as const,
        answers: { next: "Continue" },
      },
    ],
  };
  const result = project(answered);
  expect(result[0]?.item).toMatchObject({
    questionAnswer: {
      answers: { next: "Continue" },
      attachmentsByQuestionId: {},
      questionTextById: { next: "What should happen next?" },
    },
  });
  expect(row.item).not.toHaveProperty("questionAnswer");
  expect(project(answered)).toBe(result);
  expect(project({ ...answered, visibleTurnItems: [...rows] })[0]).toBe(result[0]);
});

describe("lost requests", () => {
  const lostAt = DateTime.add(v2Now, { minutes: 1 });
  const lostRequest = (
    id: string,
    overrides: Partial<OrchestrationV2ThreadProjection["runtimeRequests"][number]> = {},
  ): OrchestrationV2ThreadProjection["runtimeRequests"][number] => ({
    id: RuntimeRequestId.make(id),
    nodeId: NodeId.make(`${id}-node`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "expired",
    responseCapability: { type: "not_resumable", reason: "The server restarted." },
    createdAt: v2Now,
    resolvedAt: lostAt,
    lost: { cause: "server_restart", lostAt },
    ...overrides,
  });
  const itemBase = {
    threadId: v2Projection.thread.id,
    runId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "cancelled",
    title: null,
    startedAt: v2Now,
    completedAt: lostAt,
    updatedAt: lostAt,
  } as const;

  it("lists open lost decisions newest last with what each asked", () => {
    const approval = lostRequest("lost-approval");
    const question = lostRequest("lost-question", {
      kind: "user_input",
      lost: { cause: "provider_exit", lostAt: DateTime.add(lostAt, { seconds: 1 }) },
    });
    const uncertain = lostRequest("lost-answer", {
      kind: "file-change",
      decision: "accept",
      lost: {
        cause: "server_shutdown",
        lostAt: DateTime.add(lostAt, { seconds: 2 }),
        deliveryUncertain: true,
      },
    });
    const dismissed = lostRequest("lost-dismissed", {
      lost: { cause: "server_restart", lostAt, dismissedAt: lostAt },
    });
    const lost = deriveLostThreadRequests({
      runtimeRequests: [uncertain, dismissed, question, approval, ...projection.runtimeRequests],
      turnItems: [
        {
          ...itemBase,
          id: TurnItemId.make("lost-approval-item"),
          nodeId: approval.nodeId,
          type: "approval_request",
          requestId: approval.id,
          requestKind: "command",
          prompt: "Run the test suite",
        },
        {
          ...itemBase,
          id: TurnItemId.make("lost-question-item"),
          nodeId: question.nodeId,
          type: "user_input_request",
          requestId: question.id,
          questions: [{ id: "branch", header: "Branch", question: "Which branch?", options: [] }],
        },
      ],
    });
    expect(lost.map(({ requestId, label, detail }) => ({ requestId, label, detail }))).toEqual([
      {
        requestId: approval.id,
        label: "Approval lost: Stark Code restarted",
        detail: "Run the test suite",
      },
      {
        requestId: question.id,
        label: "Question lost: the agent process stopped",
        detail: "Which branch?",
      },
      {
        requestId: uncertain.id,
        label: "Answer may not have reached the agent: Stark Code shut down",
        detail: undefined,
      },
    ]);
    expect(lost[2]?.deliveryUncertain).toBe(true);
  });

  it("returns nothing once every lost decision was asked again or dismissed", () => {
    expect(
      deriveLostThreadRequests({
        runtimeRequests: [
          lostRequest("asked", {
            lost: { cause: "server_restart", lostAt, askedAgainAt: lostAt },
          }),
          lostRequest("plain", { lost: undefined }),
        ],
        turnItems: [],
      }),
    ).toEqual([]);
  });
});

it("carries a file-change approval's proposed files and diff to its card", () => {
  const approvalId = RuntimeRequestId.make("file-change-approval");
  const approvalNodeId = NodeId.make("file-change-node");
  const proposedChanges = [
    {
      path: "/work/a.ts",
      operation: "update",
      patch: "--- /work/a.ts\n+++ /work/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    },
  ];
  const withApproval: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    runtimeRequests: [
      {
        id: approvalId,
        nodeId: approvalNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "file-change",
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("live-session"),
        },
        createdAt: v2Now,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("file-change-approval-item"),
        threadId: v2Projection.thread.id,
        runId: null,
        nodeId: approvalNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "waiting",
        title: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
        type: "approval_request",
        requestId: approvalId,
        requestKind: "file-change",
        proposedChanges,
        proposedChangesOmitted: 3,
        grantRoot: "/repo",
        defaultToNo: true,
      },
    ],
  };
  const [approval] = derivePendingThreadRequests(withApproval).approvals;
  expect(approval?.proposedChanges).toEqual(proposedChanges);
  expect(approval?.proposedChangesOmitted).toBe(3);
  expect(approval?.scope).toEqual({ grantRoot: "/repo", defaultToNo: true });
});

it("links a tool approval only to the tool call that is its own parent", () => {
  const approvalId = RuntimeRequestId.make("tool-approval");
  const approvalNodeId = NodeId.make("tool-approval-node");
  const toolNodeId = NodeId.make("tool-node");
  const node = (
    id: NodeId,
    overrides: Partial<OrchestrationV2ExecutionNode> = {},
  ): OrchestrationV2ExecutionNode => ({
    id,
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: toolNodeId,
    kind: "tool_call",
    status: "running",
    countsForRun: true,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: v2Now,
    completedAt: null,
    ...overrides,
  });
  const itemBase = {
    threadId: v2Projection.thread.id,
    runId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    title: null,
    startedAt: v2Now,
    completedAt: null,
    updatedAt: v2Now,
  } as const;
  const input = { html: '<img src="/tmp/a.png">', title: "Lunch", height: 400 };
  const projection = (
    toolParent: NodeId,
    kind: "command" | "mcp-elicitation" | "file-change" = "command",
  ) => ({
    runtimeRequests: [
      {
        id: approvalId,
        nodeId: approvalNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending" as const,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("live-session"),
        },
        createdAt: v2Now,
        resolvedAt: null,
      },
    ],
    nodes: [
      node(toolNodeId),
      node(approvalNodeId, {
        kind: "approval_request",
        parentNodeId: toolParent,
        runtimeRequestId: approvalId,
      }),
    ],
    turnItems: [
      {
        ...itemBase,
        id: TurnItemId.make("sibling-tool-item"),
        nodeId: NodeId.make("sibling-node"),
        status: "running" as const,
        type: "dynamic_tool" as const,
        toolName: "mcp__other__tool",
        input: { unrelated: true },
      },
      {
        ...itemBase,
        id: TurnItemId.make("tool-item"),
        nodeId: toolNodeId,
        status: "running" as const,
        type: "dynamic_tool" as const,
        toolName: "mcp__stark-code__html_render",
        input,
      },
    ],
  });
  const [linked] = derivePendingThreadRequests(projection(toolNodeId)).approvals;
  expect(linked?.toolCall).toEqual({
    itemId: TurnItemId.make("tool-item"),
    threadId: v2Projection.thread.id,
    toolName: "mcp__stark-code__html_render",
    input,
    revision: "live",
  });
  expect(linked?.command).toBeUndefined();
  // The most recent tool call is not evidence; only the approval's own parent is.
  const [unlinked] = derivePendingThreadRequests(projection(NodeId.make("other"))).approvals;
  expect(unlinked?.toolCall).toBeUndefined();
  // A Codex MCP tool approval arrives as an elicitation whose parent is the tool call it gates.
  const [elicitation] = derivePendingThreadRequests(
    projection(toolNodeId, "mcp-elicitation"),
  ).approvals;
  expect(elicitation?.toolCall?.itemId).toBe(TurnItemId.make("tool-item"));
  expect(elicitation?.command).toBeUndefined();
  const [unrelatedElicitation] = derivePendingThreadRequests(
    projection(NodeId.make("other"), "mcp-elicitation"),
  ).approvals;
  expect(unrelatedElicitation?.toolCall).toBeUndefined();
  // Other approval kinds never borrow a tool call.
  const [fileChange] = derivePendingThreadRequests(projection(toolNodeId, "file-change")).approvals;
  expect(fileChange?.toolCall).toBeUndefined();
});

it("records each approval's decision and delivery, and skips questions", () => {
  const approval = (
    id: string,
    extra: Partial<OrchestrationV2ThreadProjection["runtimeRequests"][number]>,
  ) => ({
    id: RuntimeRequestId.make(id),
    nodeId: NodeId.make(`${id}-node`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command" as const,
    status: "resolved" as const,
    responseCapability: { type: "live" as const, providerSessionId: ProviderSessionId.make("s") },
    createdAt: v2Now,
    resolvedAt: v2Now,
    ...extra,
  });
  const records = deriveApprovalRecords(
    {
      runtimeRequests: [
        ...projection.runtimeRequests,
        approval("delivered", {
          decision: "accept",
          chosen: { optionId: "once:0", decision: "accept", scope: "once", effect: "allow" },
          delivery: { state: "delivered", attempts: 1, updatedAt: v2Now },
        }),
        approval("failed", {
          decision: "acceptForSession",
          delivery: { state: "not_delivered", attempts: 5, updatedAt: v2Now },
        }),
        approval("expired", { status: "expired", resolvedAt: null }),
      ],
    },
    "Claude",
  );
  expect([...records.keys()]).toEqual(["delivered", "failed", "expired"]);
  expect(records.get(RuntimeRequestId.make("delivered"))).toEqual({
    label: "Allowed once",
    tone: "success",
    success: true,
  });
  expect(records.get(RuntimeRequestId.make("failed"))).toMatchObject({
    label: "Answer not delivered",
    detail: "You chose Allow for this session. Nothing ran.",
    success: false,
  });
  expect(records.get(RuntimeRequestId.make("expired"))?.label).toBe("Expired");
});

it("marks a command declined only when its own approval never allowed it", () => {
  type Request = OrchestrationV2ThreadProjection["runtimeRequests"][number];
  const lostAt = DateTime.add(v2Now, { minutes: 1 });
  const cases: ReadonlyArray<[string, Partial<Request>, boolean]> = [
    ["declined", { status: "resolved", decision: "decline" }, true],
    [
      "declined-and-stopped",
      {
        status: "resolved",
        decision: "cancel",
        chosen: { decision: "cancel", effect: "deny_and_stop" },
      },
      true,
    ],
    ["allowed", { status: "resolved", decision: "accept" }, false],
    ["expired", { status: "expired" }, true],
    // Codex after a restart: cancelled, lost, never answered.
    ["lost", { status: "cancelled", lost: { cause: "server_shutdown", lostAt } }, true],
    // An allow that may not have arrived may have run; its delivery note says so.
    [
      "lost-allow",
      {
        status: "cancelled",
        decision: "accept",
        lost: { cause: "server_shutdown", lostAt, deliveryUncertain: true },
      },
      false,
    ],
    ["pending", { status: "pending" }, false],
  ];
  const itemBase = {
    threadId: v2Projection.thread.id,
    runId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    title: null,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  } as const;
  const node = (id: string, parent: string | null, request?: RuntimeRequestId) =>
    ({
      id: NodeId.make(id),
      threadId: v2Projection.thread.id,
      runId: null,
      parentNodeId: parent === null ? null : NodeId.make(parent),
      rootNodeId: NodeId.make("root"),
      kind: request === undefined ? "tool_call" : "approval_request",
      status: "completed",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: request ?? null,
      checkpointScopeId: null,
      startedAt: v2Now,
      completedAt: v2Now,
    }) satisfies OrchestrationV2ExecutionNode;
  const runtimeRequests = cases.map(([name, extra]): Request => ({
    id: RuntimeRequestId.make(`${name}-request`),
    nodeId: NodeId.make(`${name}-approval-node`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "resolved",
    responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("s") },
    createdAt: v2Now,
    resolvedAt: v2Now,
    ...extra,
  }));
  const declined = deriveDeclinedApprovalItemIds({
    runtimeRequests,
    nodes: cases.flatMap(([name]) => [
      node(`${name}-command-node`, null),
      node(
        `${name}-approval-node`,
        `${name}-command-node`,
        RuntimeRequestId.make(`${name}-request`),
      ),
    ]),
    turnItems: [
      ...cases.map(([name]) => ({
        ...itemBase,
        id: TurnItemId.make(`${name}-command`),
        nodeId: NodeId.make(`${name}-command-node`),
        status: "failed" as const,
        type: "command_execution" as const,
        input: "touch stamp.md",
      })),
      // A sibling command beside a declined approval is not what it gated.
      {
        ...itemBase,
        id: TurnItemId.make("sibling-command"),
        nodeId: NodeId.make("sibling-node"),
        status: "completed" as const,
        type: "command_execution" as const,
        input: "ls",
      },
    ],
  });
  expect(cases.map(([name]) => [name, declined.has(TurnItemId.make(`${name}-command`))])).toEqual(
    cases.map(([name, , expected]) => [name, expected]),
  );
  expect(declined.has(TurnItemId.make("sibling-command"))).toBe(false);
  expect(deriveDeclinedApprovalItemIds({ runtimeRequests, turnItems: [] }).size).toBe(0);
});

it("marks a file edit declined when its own file-change approval never allowed it", () => {
  const itemBase = {
    threadId: v2Projection.thread.id,
    runId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    title: null,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  } as const;
  const node = (id: string, parent: string | null, request?: RuntimeRequestId) =>
    ({
      id: NodeId.make(id),
      threadId: v2Projection.thread.id,
      runId: null,
      parentNodeId: parent === null ? null : NodeId.make(parent),
      rootNodeId: NodeId.make("root"),
      kind: request === undefined ? "tool_call" : "approval_request",
      status: "completed",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: request ?? null,
      checkpointScopeId: null,
      startedAt: v2Now,
      completedAt: v2Now,
    }) satisfies OrchestrationV2ExecutionNode;
  const request = (name: string, decision: "decline" | "accept") => ({
    id: RuntimeRequestId.make(`${name}-request`),
    nodeId: NodeId.make(`${name}-approval-node`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "file-change" as const,
    status: "resolved" as const,
    responseCapability: { type: "live" as const, providerSessionId: ProviderSessionId.make("s") },
    createdAt: v2Now,
    resolvedAt: v2Now,
    decision,
  });
  const edit = (name: string, status: "failed" | "completed") => ({
    ...itemBase,
    id: TurnItemId.make(`${name}-edit`),
    nodeId: NodeId.make(`${name}-edit-node`),
    status,
    type: "file_change" as const,
    fileName: "stamp.md",
  });
  const declined = deriveDeclinedApprovalItemIds({
    runtimeRequests: [request("declined", "decline"), request("allowed", "accept")],
    nodes: ["declined", "allowed"].flatMap((name) => [
      node(`${name}-edit-node`, null),
      node(`${name}-approval-node`, `${name}-edit-node`, RuntimeRequestId.make(`${name}-request`)),
    ]),
    turnItems: [edit("declined", "failed"), edit("allowed", "completed")],
  });
  expect(declined.has(TurnItemId.make("declined-edit"))).toBe(true);
  expect(declined.has(TurnItemId.make("allowed-edit"))).toBe(false);
});

it("shows the command a subagent's approval names when no command item links to it", () => {
  const approvalId = RuntimeRequestId.make("subagent-approval");
  const approvalNodeId = NodeId.make("subagent-approval-node");
  const projection = (command: string | undefined): OrchestrationV2ThreadProjection => ({
    ...v2Projection,
    runtimeRequests: [
      {
        id: approvalId,
        nodeId: approvalNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("live-session"),
        },
        createdAt: v2Now,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("subagent-approval-item"),
        threadId: v2Projection.thread.id,
        runId: null,
        nodeId: approvalNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "waiting",
        title: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
        type: "approval_request",
        requestId: approvalId,
        requestKind: "command",
        prompt: "Create the stamp file",
        ...(command === undefined ? {} : { command }),
        agentId: "a98f6eb54b59f5b21",
        agentName: "general-purpose",
      },
    ],
  });
  const [approval] = derivePendingThreadRequests(projection("touch subagent-stamp.md")).approvals;
  expect(approval).toMatchObject({
    detail: "Create the stamp file",
    command: "touch subagent-stamp.md",
    scope: { agentId: "a98f6eb54b59f5b21", agentName: "general-purpose" },
  });
  expect(derivePendingThreadRequests(projection("   ")).approvals[0]?.command).toBeUndefined();
  expect(derivePendingThreadRequests(projection(undefined)).approvals[0]?.command).toBeUndefined();
});

it("keeps a pending approval's own proposed files through reload and never borrows another request", () => {
  const proposedChanges = [
    { operation: "delete", path: "/old.ts" },
    { operation: "rename", oldPath: "/before", path: "/after", patch: "patch" },
  ];
  const request = {
    ...projection.runtimeRequests[0]!,
    kind: "file-change" as const,
    responseCapability: {
      type: "live" as const,
      providerSessionId: ProviderSessionId.make("session"),
    },
  };
  const source = projection.turnItems[0]!;
  if (source.type !== "user_input_request") throw new Error("Expected the question fixture");
  const { questions: _questions, responseMode: _responseMode, ...base } = source;
  const item = {
    ...base,
    type: "approval_request" as const,
    requestId,
    requestKind: "file-change" as const,
    proposedChanges,
  };
  const reloaded = {
    runtimeRequests: [request],
    turnItems: [
      item,
      {
        ...item,
        requestId: RuntimeRequestId.make("unrelated"),
        proposedChanges: [{ operation: "add", path: "/wrong" }],
      },
    ],
  };
  expect(derivePendingThreadRequests(reloaded).approvals[0]?.proposedChanges).toEqual(
    proposedChanges,
  );
  expect(
    derivePendingThreadRequests({ ...reloaded, turnItems: reloaded.turnItems.slice(1) })
      .approvals[0]?.proposedChanges,
  ).toBeUndefined();
  expect(
    derivePendingThreadRequests({
      ...reloaded,
      runtimeRequests: [{ ...request, status: "resolved" }],
    }).approvals,
  ).toEqual([]);
});
