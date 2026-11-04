import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  RunId,
} from "@starkfuture/contracts";
import { latestExecutedRun } from "./orchestrationV2ThreadError.ts";

type CheckMessage = Pick<OrchestrationV2ConversationMessage, "id" | "userShell">;

interface UserShellCheckProjection {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly messages: ReadonlyArray<CheckMessage>;
}

/** Why a check may not run after a turn. The server turns each reason into user-facing text. */
export type UserShellCheckSubjectRejection = "not-found" | "is-check" | "unfinished" | "superseded";

export type UserShellCheckSubjectValidation =
  | { readonly ok: true; readonly subject: OrchestrationV2Run }
  | { readonly ok: false; readonly reason: UserShellCheckSubjectRejection };

const FINISHED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

function checkMessageIds(messages: ReadonlyArray<CheckMessage>): ReadonlySet<MessageId> {
  const ids = new Set<MessageId>();
  for (const message of messages) if (message.userShell?.check) ids.add(message.id);
  return ids;
}

/** The turn a new check runs after: the latest executed run that is not itself a check. */
export function latestCheckSubjectRun(
  projection: UserShellCheckProjection,
): OrchestrationV2Run | null {
  const checks = checkMessageIds(projection.messages);
  return latestExecutedRun(projection.runs.filter((run) => !checks.has(run.userMessageId)));
}

/**
 * Whether a check may run after `subjectRunId`. Checks run in the thread's live folder, so the
 * subject must be the latest finished work. At `dispatch`, queued work also rejects, because it
 * would run first; at `start`, only work that has run since the subject does. Checks never
 * supersede each other.
 */
export function validateUserShellCheckSubject(
  projection: UserShellCheckProjection,
  subjectRunId: RunId,
  phase: "dispatch" | "start",
): UserShellCheckSubjectValidation {
  const subject = projection.runs.find((run) => run.id === subjectRunId);
  if (subject === undefined || (subject.status === "cancelled" && subject.startedAt === null)) {
    return { ok: false, reason: "not-found" };
  }
  const checks = checkMessageIds(projection.messages);
  if (checks.has(subject.userMessageId)) return { ok: false, reason: "is-check" };
  if (subject.status === "rolled_back") return { ok: false, reason: "superseded" };
  if (!FINISHED_RUN_STATUSES.has(subject.status)) return { ok: false, reason: "unfinished" };
  const work = projection.runs.filter((run) => !checks.has(run.userMessageId));
  if (phase === "dispatch" && work.some((run) => run.status === "queued")) {
    return { ok: false, reason: "superseded" };
  }
  return latestExecutedRun(work)?.id === subject.id
    ? { ok: true, subject }
    : { ok: false, reason: "superseded" };
}
