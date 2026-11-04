import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2RuntimeRequestLoss,
  OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

type LostCause = OrchestrationV2RuntimeRequestLoss["cause"];
type RequestKind = OrchestrationV2RuntimeRequest["kind"];

const DETAIL_LIMIT = 300;
const ANSWER_LIMIT = 500;

/**
 * Whether closing this request without an answer loses a decision the user
 * owes. Tool calls and sign-in refreshes do not wait on a person, and a
 * message-capable question stays answerable after its provider is gone.
 */
export function isPersonFacingRuntimeRequest(
  request: Pick<OrchestrationV2RuntimeRequest, "kind" | "responseCapability">,
): boolean {
  return (
    request.kind !== "dynamic_tool_call" &&
    request.kind !== "auth_refresh" &&
    request.responseCapability.type !== "message"
  );
}

/**
 * A lost request the user still owes a decision on. Only Ask again and
 * Dismiss close it; newer turns do not, because a queued run or an automatic
 * wake has not shown the user what was lost.
 */
export function isOpenLostRuntimeRequest(
  request: Pick<OrchestrationV2RuntimeRequest, "lost">,
): boolean {
  return (
    request.lost !== undefined &&
    request.lost.askedAgainAt === undefined &&
    request.lost.dismissedAt === undefined
  );
}

/**
 * The loss to keep once the provider took the answer, or closed the request
 * itself. A loss that only said delivery failed or was uncertain is closed,
 * like a dismissal, so nothing offers to ask again for an answer that arrived;
 * it stays on the request as history. Any other loss is kept as it is.
 */
export function closeDeliveryLoss(
  lost: OrchestrationV2RuntimeRequestLoss | undefined,
  closedAt: DateTime.Utc,
): { readonly lost?: OrchestrationV2RuntimeRequestLoss } {
  if (lost === undefined) return {};
  const aboutDelivery = lost.cause === "delivery_failed" || lost.deliveryUncertain === true;
  return aboutDelivery && isOpenLostRuntimeRequest({ lost })
    ? { lost: { ...lost, dismissedAt: closedAt } }
    : { lost };
}

/**
 * Open lost requests, oldest loss first; creation time and then id (compared
 * by code unit, like SQLite) break ties, so the newest is last.
 */
export function openLostRuntimeRequests<
  Request extends Pick<OrchestrationV2RuntimeRequest, "id" | "createdAt" | "lost">,
>(requests: ReadonlyArray<Request>): Request[] {
  return requests
    .filter(isOpenLostRuntimeRequest)
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(left.lost!.lostAt) - DateTime.toEpochMillis(right.lost!.lostAt) ||
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
}

/**
 * The cause as a clause, e.g. "Stark Code restarted". `sentenceStart`
 * capitalizes the clause for the start of a sentence.
 */
export function lostRuntimeRequestCauseText(cause: LostCause, sentenceStart = false): string {
  switch (cause) {
    case "server_restart":
      return "Stark Code restarted";
    case "server_shutdown":
      return "Stark Code shut down";
    case "provider_exit":
      return sentenceStart ? "The agent process stopped" : "the agent process stopped";
    case "delivery_failed":
      return sentenceStart
        ? "The answer could not be delivered"
        : "the answer could not be delivered";
  }
}

/**
 * The lost request's title: the timeline row and the chat banner both show
 * it, e.g. "Approval lost: Stark Code restarted".
 */
export function lostRuntimeRequestLabel(input: {
  readonly kind: RequestKind;
  readonly cause: LostCause;
  readonly deliveryUncertain?: boolean | undefined;
}): string {
  // A failed delivery is about the answer, not the request: say whether
  // anything ran.
  if (input.cause === "delivery_failed") {
    return input.deliveryUncertain === true ? "Delivery uncertain" : "Not delivered: nothing ran";
  }
  const cause = lostRuntimeRequestCauseText(input.cause);
  if (input.deliveryUncertain === true) {
    return `Answer may not have reached the agent: ${cause}`;
  }
  return `${input.kind === "user_input" ? "Question" : "Approval"} lost: ${cause}`;
}

/** What a lost request asked, read from its timeline item and linked command. */
export interface LostRuntimeRequestDetail {
  /** The command the approval would have run: the linked command item's, else the approval's own. */
  readonly command?: string;
  /** The approval's own prompt. */
  readonly prompt?: string;
  readonly questions?: ReadonlyArray<{ readonly id: string; readonly question: string }>;
}

/**
 * Reads what the request asked. The command is taken from the command item
 * the approval node directly hangs off, never from a sibling, and otherwise
 * from the command the approval item itself carries.
 */
export function lostRuntimeRequestDetail(
  request: Pick<OrchestrationV2RuntimeRequest, "id" | "kind" | "nodeId">,
  records: {
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode> | undefined;
  },
): LostRuntimeRequestDetail {
  const item = records.turnItems.findLast(
    (candidate) =>
      (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
      candidate.requestId === request.id,
  );
  if (item?.type === "user_input_request") {
    return {
      questions: item.questions.map((question) => ({
        id: question.id,
        question: question.question,
      })),
    };
  }
  const node = records.nodes?.find(
    (candidate) => candidate.id === request.nodeId && candidate.runtimeRequestId === request.id,
  );
  const commandItem =
    request.kind === "command" && node?.parentNodeId
      ? records.turnItems.findLast(
          (candidate) =>
            candidate.type === "command_execution" &&
            candidate.nodeId === node.parentNodeId &&
            candidate.threadId === node.threadId &&
            candidate.runId === node.runId &&
            candidate.providerTurnId === node.providerTurnId &&
            candidate.providerThreadId === node.providerThreadId,
        )
      : undefined;
  // A request no command item links to (a native subagent's) carries its own command.
  const command =
    commandItem?.type === "command_execution" && commandItem.input.trim()
      ? commandItem.input
      : item?.type === "approval_request" && item.command?.trim()
        ? item.command
        : undefined;
  const prompt = item?.type === "approval_request" && item.prompt ? item.prompt : undefined;
  return {
    ...(command === undefined ? {} : { command }),
    ...(prompt === undefined ? {} : { prompt }),
  };
}

function bounded(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

const APPROVAL_SUBJECT: Record<Exclude<RequestKind, "user_input">, string> = {
  command: "your request to run a command",
  "file-read": "your request to read files",
  "file-change": "your request to change files",
  "mcp-elicitation": "your request for app access",
  permission: "your permission request",
  dynamic_tool_call: "your tool call",
  auth_refresh: "your sign-in request",
};

const DECISION_TEXT: Record<NonNullable<OrchestrationV2RuntimeRequest["decision"]>, string> = {
  accept: "I approved it",
  acceptForSession: "I approved it",
  acceptAlways: "I approved it",
  decline: "I declined it",
  cancel: "I cancelled it",
};

export interface LostRuntimeRequestPromptEntry extends LostRuntimeRequestDetail {
  readonly kind: RequestKind;
  readonly lost: OrchestrationV2RuntimeRequestLoss;
  readonly decision?: OrchestrationV2RuntimeRequest["decision"];
  readonly answers?: OrchestrationV2RuntimeRequest["answers"];
}

function subject(entry: LostRuntimeRequestPromptEntry): string {
  if (entry.kind === "user_input") {
    const [first, ...rest] = entry.questions ?? [];
    if (first === undefined) return "your question";
    const more = rest.length === 0 ? "" : ` (and ${rest.length} more)`;
    return `your question: ${codeSpan(bounded(first.question, DETAIL_LIMIT))}${more}`;
  }
  if (entry.command !== undefined) {
    return `your request to run ${codeSpan(bounded(entry.command, DETAIL_LIMIT))}`;
  }
  if (entry.prompt !== undefined) {
    return `your request: ${codeSpan(bounded(entry.prompt, DETAIL_LIMIT))}`;
  }
  return APPROVAL_SUBJECT[entry.kind];
}

/** The answer the user gave before the loss, for a request whose delivery is uncertain. */
function givenAnswer(entry: LostRuntimeRequestPromptEntry): string | undefined {
  if (entry.kind !== "user_input") {
    return entry.decision === undefined ? undefined : DECISION_TEXT[entry.decision];
  }
  const replies = (entry.questions ?? []).flatMap((question) => {
    const answer = entry.answers?.[question.id];
    const text = Array.isArray(answer)
      ? answer.filter((value): value is string => typeof value === "string").join(", ")
      : answer;
    return typeof text === "string" && text.trim()
      ? [`${bounded(question.question, DETAIL_LIMIT)}: ${bounded(text, ANSWER_LIMIT)}`]
      : [];
  });
  return replies.length === 0 ? undefined : `my answer was ${replies.join("; ")}`;
}

function entryLine(entry: LostRuntimeRequestPromptEntry): string {
  if (entry.lost.deliveryUncertain === true) {
    const answer = givenAnswer(entry);
    return `I answered ${subject(entry)}${answer === undefined ? "" : ` (${answer})`}, but ${lostRuntimeRequestCauseText(entry.lost.cause)} before my answer was confirmed, so it may not have reached you.`;
  }
  return `${lostRuntimeRequestCauseText(entry.lost.cause, true)} before I answered ${subject(entry)}, so that ${entry.kind === "user_input" ? "question" : "request"} was lost.`;
}

/**
 * The message an Ask again turn sends. It names what was lost so the agent
 * retries the step and the provider asks for the decision again; it never
 * grants anything itself. Every quoted detail is bounded.
 */
export function askAgainText(entries: ReadonlyArray<LostRuntimeRequestPromptEntry>): string {
  const uncertain = entries.some((entry) => entry.lost.deliveryUncertain === true);
  const closing = uncertain
    ? "Check whether that step already ran. If it did not and it is still needed, try it again and ask me again."
    : "If the step is still needed, try it again and ask me again.";
  if (entries.length === 1) return `${entryLine(entries[0]!)} ${closing}`;
  return [
    "These requests were lost before my answers reached you:",
    ...entries.map((entry) => `- ${entryLine(entry)}`),
    "",
    uncertain
      ? "Check whether each step already ran. If one did not and it is still needed, try it again and ask me again."
      : "If a step is still needed, try it again and ask me again.",
  ].join("\n");
}
