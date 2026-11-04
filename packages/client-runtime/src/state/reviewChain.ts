import {
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
  USER_SHELL_CHECK_SUPERSEDED_CODE,
} from "@starkfuture/contracts";

type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
type ReviewProjection = Pick<OrchestrationV2ThreadProjection, "runs" | "messages" | "turnItems">;

export interface ReviewHistoryOptions {
  /** False while older history is outside the loaded window; missing records then stay unknown. */
  readonly historyComplete: boolean;
}

/**
 * What a check run reports. A check ran in the live folder after its turn, so even
 * `exit-zero` only says what the command returned then, not that the turn was verified.
 */
export type TurnCheckOutcome =
  | "queued"
  | "running"
  | "exit-zero"
  | "failed"
  | "timed-out"
  | "stopped"
  | "skipped"
  | "cancelled"
  | "unknown";

export interface TurnCheck {
  readonly runId: RunId;
  readonly ordinal: number;
  readonly subjectRunId: RunId;
  readonly scriptId: string | null;
  readonly scriptName: string | null;
  readonly command: string;
  readonly runStatus: OrchestrationV2Run["status"];
  readonly item: CommandItem | null;
  readonly outcome: TurnCheckOutcome;
  /** Why the server skipped a queued check, when it did. */
  readonly skipReason: string | null;
  /** Other work ran in the folder after this check started, so its result may be out of date. */
  readonly laterWork: boolean;
}

export interface TurnChecks {
  readonly checks: ReadonlyArray<TurnCheck>;
  /** Some runs or messages after the turn are outside the loaded history window. */
  readonly incomplete: boolean;
}

export type CorrectionLink =
  | { readonly kind: "linked"; readonly reviewedRunId: RunId; readonly commentCount: number }
  /** The comments name a turn outside the loaded history window. */
  | { readonly kind: "incomplete"; readonly commentCount: number }
  /** The run's own message is outside the loaded history window, so its comments are unknown. */
  | { readonly kind: "unknown" };

function messagesById(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): ReadonlyMap<MessageId, OrchestrationV2ConversationMessage> {
  return new Map(messages.map((message) => [message.id, message]));
}

function executed(run: OrchestrationV2Run): boolean {
  return run.status !== "queued" && !(run.status === "cancelled" && run.startedAt === null);
}

function checkOutcome(
  run: OrchestrationV2Run,
  item: CommandItem | null,
  skipReason: string | null,
): TurnCheckOutcome {
  if (run.status === "queued") return "queued";
  if (run.status === "cancelled" && run.startedAt === null && item === null) {
    return skipReason === null ? "cancelled" : "skipped";
  }
  if (item?.timedOut) return "timed-out";
  if (
    item?.interrupted ||
    item?.status === "interrupted" ||
    item?.status === "cancelled" ||
    run.status === "interrupted" ||
    run.status === "cancelled"
  ) {
    return "stopped";
  }
  if (["preparing", "starting", "running", "waiting"].includes(run.status)) return "running";
  if (item?.exitCode !== undefined) return item.exitCode === 0 ? "exit-zero" : "failed";
  if (run.status === "failed" || item?.status === "failed") return "failed";
  return "unknown";
}

/**
 * The checks dispatched after `subjectRunId`, oldest first. With a windowed history, a run whose
 * message is not loaded could be one of them, so the result says it is incomplete instead of
 * presenting the loaded checks as all there are.
 */
export function checksForRun(
  projection: ReviewProjection,
  subjectRunId: RunId,
  options: ReviewHistoryOptions,
): TurnChecks {
  const subject = projection.runs.find((run) => run.id === subjectRunId);
  const byId = messagesById(projection.messages);
  let incomplete = subject === undefined && !options.historyComplete;
  const isCheck = (run: OrchestrationV2Run) =>
    byId.get(run.userMessageId)?.userShell?.check !== undefined;
  const checks: TurnCheck[] = [];
  for (const run of [...projection.runs].sort((left, right) => left.ordinal - right.ordinal)) {
    if (subject !== undefined && run.ordinal <= subject.ordinal) continue;
    const message = byId.get(run.userMessageId);
    if (message === undefined) {
      if (!options.historyComplete) incomplete = true;
      continue;
    }
    const check = message.userShell?.check;
    if (check === undefined || check.subjectRunId !== subjectRunId) continue;
    const item =
      projection.turnItems.find(
        (candidate): candidate is CommandItem =>
          candidate.type === "command_execution" &&
          candidate.source === "user_shell" &&
          candidate.runId === run.id,
      ) ?? null;
    const skipItem = projection.turnItems.find(
      (candidate) =>
        candidate.type === "error" &&
        candidate.runId === run.id &&
        candidate.failure.code === USER_SHELL_CHECK_SUPERSEDED_CODE,
    );
    const skipReason = skipItem?.type === "error" ? skipItem.failure.message : null;
    checks.push({
      runId: run.id,
      ordinal: run.ordinal,
      subjectRunId,
      scriptId: check.scriptId ?? null,
      scriptName: check.scriptName ?? null,
      command: message.userShell?.command ?? message.text,
      runStatus: run.status,
      item,
      outcome: checkOutcome(run, item, skipReason),
      skipReason,
      laterWork: projection.runs.some(
        (other) =>
          other.ordinal > run.ordinal &&
          executed(other) &&
          byId.has(other.userMessageId) &&
          !isCheck(other),
      ),
    });
  }
  return { checks, incomplete };
}

/**
 * The earlier turn a run corrects, from the review comments its message carries. Only links
 * to an earlier run of this thread count, which also rules out cycles. A record's `runId`
 * wins; older web comments name the run only in `sectionId` (`turn:<runId>`), which is used
 * when that run exists here. Mobile's `turn:<n>` ids never match a run id. A `runId` that is
 * not loaded makes the link incomplete while older history is outside the window.
 */
export function correctionLinkOfRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  options: ReviewHistoryOptions,
): CorrectionLink | null {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  const message =
    run === undefined
      ? undefined
      : projection.messages.find((candidate) => candidate.id === run.userMessageId);
  if (run === undefined || message === undefined) {
    return options.historyComplete ? null : { kind: "unknown" };
  }
  const comments = (message.context?.records ?? []).flatMap((record) =>
    record.kind === "review-comment" && !("payload" in record) ? [record] : [],
  );
  if (comments.length === 0) return null;
  const runsById = new Map(projection.runs.map((candidate) => [candidate.id, candidate]));
  const counts = new Map<RunId, number>();
  let missing = false;
  for (const comment of comments) {
    const sectionRunId = /^turn:(.+)$/.exec(comment.sectionId)?.[1];
    const reviewedId =
      comment.runId ??
      projection.runs.find((candidate) => candidate.id === sectionRunId)?.id ??
      null;
    if (reviewedId === null) continue;
    const reviewed = runsById.get(reviewedId);
    if (reviewed === undefined) {
      if (!options.historyComplete) missing = true;
      continue;
    }
    if (reviewed.ordinal >= run.ordinal) continue;
    counts.set(reviewed.id, (counts.get(reviewed.id) ?? 0) + 1);
  }
  const newest = [...counts.keys()]
    .map((id) => runsById.get(id)!)
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  if (newest !== undefined) {
    return { kind: "linked", reviewedRunId: newest.id, commentCount: counts.get(newest.id)! };
  }
  return missing ? { kind: "incomplete", commentCount: comments.length } : null;
}

/** Later loaded turns whose review comments correct `runId`, oldest first. */
export function correctionsOfRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  options: ReviewHistoryOptions,
): ReadonlyArray<OrchestrationV2Run> {
  return projection.runs
    .filter((candidate) => {
      const link = correctionLinkOfRun(projection, candidate.id, options);
      return link?.kind === "linked" && link.reviewedRunId === runId;
    })
    .sort((left, right) => left.ordinal - right.ordinal);
}
