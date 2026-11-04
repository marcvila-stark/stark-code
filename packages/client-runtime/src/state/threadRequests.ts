import type {
  OrchestrationV2ProposedFileChange,
  OrchestrationV2ThreadProjection,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2RuntimeRequestLoss,
  OrchestrationV2TurnItem,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@starkfuture/contracts";
import {
  lostRuntimeRequestDetail,
  lostRuntimeRequestLabel,
  openLostRuntimeRequests,
} from "@starkfuture/shared/orchestrationV2LostRequests";
import * as DateTime from "effect/DateTime";

import {
  approvalNeverAllowed,
  approvalRecord,
  approvalRequestScope,
  type ApprovalRecord,
  type ApprovalRequestScope,
} from "../approvals/permissionPresentation.ts";
import { turnItemDetailRevision } from "../work-log/itemDetail.ts";

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  /** Exact input from the approval's own command item; never inferred from its prose prompt. */
  readonly command?: string;
  /**
   * The non-shell tool call this approval gates, from the approval's own tool
   * item. `input` is what the timeline carries: a large one arrives summarized
   * and loads in full as the item's detail (`revision` keys that read).
   */
  readonly toolCall?: {
    readonly itemId: TurnItemId;
    readonly threadId: ThreadId;
    readonly toolName: string;
    readonly input: unknown;
    readonly revision: string;
  };
  /** App requesting access for mcp-elicitation approvals (#8058). */
  readonly appName?: string;
  /** Approval choices advertised by the provider (#8058); defaults apply when absent. */
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
  /** Files a file-change approval would write, with their proposed diffs. */
  readonly proposedChanges?: ReadonlyArray<OrchestrationV2ProposedFileChange>;
  /** Files the provider named beyond `proposedChanges`. */
  readonly proposedChangesOmitted?: number;
  /** Who asked and what the approval reaches beyond its command or files, when reported. */
  readonly scope?: ApprovalRequestScope;
  /** Whether a given answer reached the agent; servers that don't track it send none. */
  readonly delivery?: OrchestrationV2RuntimeRequest["delivery"];
}

export interface ThreadUserInputQuestion extends Omit<
  OrchestrationV2UserInputQuestion,
  "multiSelect"
> {
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
  readonly dismissible: boolean;
}

export interface PendingThreadRequests {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
}

/** Seed each question once. Existing edits, cleared answers, and option selections win. */
export function seedUserInputDraftAnswers<Draft extends { readonly customAnswer?: string }>(
  questions: ReadonlyArray<
    Pick<OrchestrationV2UserInputQuestion, "id" | "allowCustomAnswer" | "initialAnswer">
  >,
  drafts: Record<string, Draft>,
): Record<string, Draft | { customAnswer: string }> {
  let seeded: Record<string, Draft | { customAnswer: string }> = drafts;
  for (const question of questions) {
    if (
      question.initialAnswer === undefined ||
      question.allowCustomAnswer === false ||
      seeded[question.id] !== undefined
    )
      continue;
    if (seeded === drafts) seeded = { ...drafts };
    seeded[question.id] = { customAnswer: question.initialAnswer };
  }
  return seeded;
}

/** Joins pending request entities to the request items that carry display data. */
export function derivePendingThreadRequests(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> &
    Partial<Pick<OrchestrationV2ThreadProjection, "nodes">>,
): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];

  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      userInputs.push({
        requestId: request.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability,
        dismissible: item.responseMode === "message" || responseCapability === "message",
        ...(item.responseMode === "message" || responseCapability === "message"
          ? { responseMode: "message" as const }
          : {}),
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    const scope = item?.type === "approval_request" ? approvalRequestScope(item) : undefined;
    const approvalNode = projection.nodes?.find(
      (node) => node.id === request.nodeId && node.runtimeRequestId === request.id,
    );
    // A sibling or most recent command can belong to a different tool or agent.
    // Only a directly linked parent in the same run/provider turn is evidence. A
    // command approval gates a shell command or a tool call; an MCP elicitation
    // that asks about a tool call (Codex MCP tool approvals) gates that call.
    const linkedItem = <Type extends OrchestrationV2TurnItem["type"]>(type: Type) =>
      (request.kind === "command" || request.kind === "mcp-elicitation") &&
      approvalNode?.parentNodeId
        ? (projection.turnItems.findLast(
            (candidate) =>
              candidate.type === type &&
              candidate.nodeId === approvalNode.parentNodeId &&
              candidate.threadId === approvalNode.threadId &&
              candidate.runId === approvalNode.runId &&
              candidate.providerTurnId === approvalNode.providerTurnId &&
              candidate.providerThreadId === approvalNode.providerThreadId,
          ) as Extract<OrchestrationV2TurnItem, { type: Type }> | undefined)
        : undefined;
    const commandItem = request.kind === "command" ? linkedItem("command_execution") : undefined;
    const toolItem = commandItem === undefined ? linkedItem("dynamic_tool") : undefined;
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      createdAt: DateTime.formatIso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      // The linked command item first; a native subagent's request may name its command only on
      // the approval item itself.
      ...(commandItem?.input.trim()
        ? { command: commandItem.input }
        : item?.type === "approval_request" && item.command?.trim()
          ? { command: item.command }
          : {}),
      ...(toolItem?.toolName
        ? {
            toolCall: {
              itemId: toolItem.id,
              threadId: toolItem.threadId,
              toolName: toolItem.toolName,
              input: toolItem.input,
              revision: turnItemDetailRevision(toolItem),
            },
          }
        : {}),
      ...(item?.type === "approval_request" && item.appName ? { appName: item.appName } : {}),
      ...(item?.type === "approval_request" && item.options !== undefined
        ? { options: item.options }
        : {}),
      responseCapability: responseCapability === "live" ? "live" : "not_resumable",
      ...(item?.type === "approval_request" && item.proposedChanges?.length
        ? { proposedChanges: item.proposedChanges }
        : {}),
      ...(item?.type === "approval_request" && item.proposedChangesOmitted
        ? { proposedChangesOmitted: item.proposedChangesOmitted }
        : {}),
      ...(scope === undefined ? {} : { scope }),
      ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
    });
  }

  return { approvals, userInputs };
}

/** An approval or question lost to a restart, shutdown or provider exit that the user still owes. */
export interface ThreadLostRequest {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: OrchestrationV2RuntimeRequest["kind"];
  readonly cause: OrchestrationV2RuntimeRequestLoss["cause"];
  readonly lostAt: string;
  /** The answer was given but may not have reached the agent. */
  readonly deliveryUncertain: boolean;
  /** Banner and card title, the same text the timeline row shows. */
  readonly label: string;
  /** The command, approval prompt or first question, when the projection still has it. */
  readonly detail?: string;
}

/** Open lost requests, oldest loss first, so the newest is last. */
export function deriveLostThreadRequests(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> &
    Partial<Pick<OrchestrationV2ThreadProjection, "nodes">>,
): ReadonlyArray<ThreadLostRequest> {
  return openLostRuntimeRequests(projection.runtimeRequests).flatMap((request) => {
    if (request.lost === undefined) return [];
    const asked = lostRuntimeRequestDetail(request, {
      turnItems: projection.turnItems,
      nodes: projection.nodes,
    });
    const detail = asked.command ?? asked.prompt ?? asked.questions?.[0]?.question;
    const deliveryUncertain = request.lost.deliveryUncertain === true;
    return [
      {
        requestId: request.id,
        requestKind: request.kind,
        cause: request.lost.cause,
        lostAt: DateTime.formatIso(request.lost.lostAt),
        deliveryUncertain,
        label: lostRuntimeRequestLabel({
          kind: request.kind,
          cause: request.lost.cause,
          deliveryUncertain,
        }),
        ...(detail === undefined ? {} : { detail }),
      },
    ];
  });
}

/** Older V2 answers were saved on requests without updating their timeline items. */
export function createQuestionHistoryProjector() {
  type Rows = OrchestrationV2ThreadProjection["visibleTurnItems"];
  type Requests = OrchestrationV2ThreadProjection["runtimeRequests"];
  let previousRows: Rows | undefined;
  let previousRequests: Requests | undefined;
  let previousResult: Rows | undefined;
  const cache = new WeakMap<Rows[number], { request: Requests[number]; row: Rows[number] }>();
  return (
    projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems" | "runtimeRequests">,
  ): Rows => {
    const { visibleTurnItems: rows, runtimeRequests: requests } = projection;
    if (rows === previousRows && requests === previousRequests && previousResult)
      return previousResult;
    const byId = new Map(requests.map((request) => [request.id, request]));
    let result: Rows[number][] | undefined;
    for (const [index, row] of rows.entries()) {
      const item = row.item;
      const request =
        item.type === "user_input_request" && !item.questionAnswer
          ? byId.get(item.requestId)
          : undefined;
      let next = row;
      if (
        item.type === "user_input_request" &&
        request?.status === "resolved" &&
        request.answers !== undefined
      ) {
        const cached = cache.get(row);
        next =
          cached?.request === request
            ? cached.row
            : {
                ...row,
                item: {
                  ...item,
                  questionAnswer: {
                    requestId: request.id,
                    answers: request.answers,
                    attachmentsByQuestionId: {},
                    questionTextById: Object.fromEntries(
                      item.questions.map((question) => [question.id, question.question]),
                    ),
                  },
                },
              };
        cache.set(row, { request, row: next });
      }
      if (next !== row) result ??= rows.slice(0, index);
      result?.push(next);
    }
    previousRows = rows;
    previousRequests = requests;
    previousResult = result ?? rows;
    return previousResult;
  };
}

/**
 * What became of each approval, keyed by request id, for its timeline row and the turn's finish
 * card: the recorded choice, then whether it reached the agent. Questions, tool calls and sign-in
 * refreshes are left out.
 */
export function deriveApprovalRecords(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests">,
  providerName?: string,
): ReadonlyMap<RuntimeRequestId, ApprovalRecord> {
  const records = new Map<RuntimeRequestId, ApprovalRecord>();
  for (const request of projection.runtimeRequests) {
    if (
      request.kind === "user_input" ||
      request.kind === "dynamic_tool_call" ||
      request.kind === "auth_refresh"
    )
      continue;
    records.set(request.id, approvalRecord(request, providerName));
  }
  return records;
}

/**
 * The tool items (commands, file edits, and tool calls an approval gates) whose own approval
 * closed without allowing them: declined, expired, or lost before an answer. They never ran,
 * whatever their item says (Claude records a declined command or edit as failed, Codex a lost or
 * declined one as cancelled), so the work log and the finish card call them declined. An item is
 * linked only through the approval node's direct parent, never as the nearest sibling.
 */
export function deriveDeclinedApprovalItemIds(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> &
    Partial<Pick<OrchestrationV2ThreadProjection, "nodes">>,
): ReadonlySet<TurnItemId> {
  const declined = new Set<TurnItemId>();
  const requests = projection.runtimeRequests.filter(
    (request) =>
      (request.kind === "command" ||
        request.kind === "file-change" ||
        request.kind === "mcp-elicitation") &&
      approvalNeverAllowed(request),
  );
  if (requests.length === 0 || !projection.nodes?.length) return declined;
  const nodeById = new Map(projection.nodes.map((node) => [node.id, node]));
  const gatedByNode = new Map<string, OrchestrationV2TurnItem[]>();
  for (const item of projection.turnItems) {
    if (item.nodeId === null) continue;
    if (
      item.type !== "command_execution" &&
      item.type !== "file_change" &&
      item.type !== "dynamic_tool"
    )
      continue;
    const items = gatedByNode.get(item.nodeId);
    if (items) items.push(item);
    else gatedByNode.set(item.nodeId, [item]);
  }
  // A file-change approval gates the edit; a command approval any item on its node, as before.
  const gates = (kind: OrchestrationV2RuntimeRequest["kind"], item: OrchestrationV2TurnItem) =>
    kind === "file-change"
      ? item.type === "file_change"
      : kind === "command"
        ? item.type !== "file_change"
        : item.type === "dynamic_tool";
  for (const request of requests) {
    const node = nodeById.get(request.nodeId);
    if (node?.runtimeRequestId !== request.id || !node.parentNodeId) continue;
    const gated = gatedByNode
      .get(node.parentNodeId)
      ?.findLast(
        (candidate) =>
          gates(request.kind, candidate) &&
          candidate.threadId === node.threadId &&
          candidate.runId === node.runId &&
          candidate.providerTurnId === node.providerTurnId &&
          candidate.providerThreadId === node.providerThreadId,
      );
    if (gated !== undefined) declined.add(gated.id);
  }
  return declined;
}
