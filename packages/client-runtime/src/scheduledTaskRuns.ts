import {
  CommandId,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type ScheduledTaskId,
  type ScheduledTaskRun,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunState,
} from "@starkfuture/contracts";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./state/runtime.ts";

const STATE_LABELS: Record<ScheduledTaskRunState, string> = {
  waiting: "Waiting",
  starting: "Starting",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  skipped: "Skipped",
};

const TRIGGER_LABELS: Record<ScheduledTaskRun["trigger"], string> = {
  scheduled: "Scheduled",
  manual: "Run now",
  webhook: "Webhook",
};

/** How a run's state reads at a glance; each surface maps it to its own colours. */
export type ScheduledTaskRunTone = "success" | "error" | "active" | "muted";

const STATE_TONES: Record<ScheduledTaskRunState, ScheduledTaskRunTone> = {
  waiting: "active",
  starting: "active",
  queued: "active",
  running: "active",
  succeeded: "success",
  failed: "error",
  interrupted: "error",
  cancelled: "muted",
  skipped: "muted",
};

export function scheduledTaskRunStateLabel(state: ScheduledTaskRunState): string {
  return STATE_LABELS[state];
}

export function scheduledTaskRunTriggerLabel(trigger: ScheduledTaskRun["trigger"]): string {
  return TRIGGER_LABELS[trigger];
}

export function scheduledTaskRunTone(state: ScheduledTaskRunState): ScheduledTaskRunTone {
  return STATE_TONES[state];
}

/** Whether the run may still change on its own. */
export function isScheduledTaskRunActive(state: ScheduledTaskRunState): boolean {
  return STATE_TONES[state] === "active";
}

/** Whether the environment keeps run history; older servers do not answer `listRuns`. */
export function supportsScheduledTaskRuns(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "scheduledTaskRuns"> | null | undefined,
): boolean {
  return capabilities?.scheduledTaskRuns === true;
}

/**
 * How long a run took, or has taken so far while it is active, such as
 * "45s", "3m 12s" or "1h 5m". Null before the run started, or when a
 * finished run has no end time.
 */
export function scheduledTaskRunDurationLabel(run: ScheduledTaskRun, nowMs: number): string | null {
  if (run.startedAt === null) return null;
  const endMs =
    run.endedAt !== null
      ? Date.parse(run.endedAt)
      : isScheduledTaskRunActive(run.state)
        ? nowMs
        : Number.NaN;
  const elapsedMs = endMs - Date.parse(run.startedAt);
  if (!Number.isFinite(elapsedMs)) return null;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Whether a Run now request is known to have ended. `unknown` covers a
 * request whose answer never arrived (a dropped connection, a cancelled
 * wait), which the server may still have acted on.
 */
export type RunNowOutcome = "known" | "unknown";

/** Errors the server itself answered with; anything else may have left a run behind. */
const SERVER_ANSWERS: ReadonlySet<string> = new Set([
  "ScheduledTaskError",
  "EnvironmentAuthorizationError",
]);

export function runNowFailureOutcome(error: unknown): RunNowOutcome {
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    SERVER_ANSWERS.has(error._tag)
    ? "known"
    : "unknown";
}

/** Whether a settled Run now command is known to have ended. */
function runNowOutcome(result: AtomCommandResult<unknown, unknown>): RunNowOutcome {
  if (result._tag === "Success") return "known";
  if (isAtomCommandInterrupted(result)) return "unknown";
  return runNowFailureOutcome(squashAtomCommandFailure(result));
}

/**
 * Command ids for Run now, one per intent. A click while an earlier click for
 * the same task is still pending, or after one whose outcome is unknown,
 * reuses that click's id, so the server answers with the run it started
 * instead of starting another. A known outcome with nothing else in flight
 * frees the task for a new intent.
 */
export function createRunNowClickIds(makeId: () => string) {
  const entries = new Map<string, { readonly id: string; inFlight: number }>();
  return {
    /** The id to send for `key`, usually `${environmentId}:${taskId}`. */
    begin(key: string): string {
      const entry = entries.get(key) ?? { id: makeId(), inFlight: 0 };
      entry.inFlight += 1;
      entries.set(key, entry);
      return entry.id;
    },
    /** Records how one request for `key` ended. */
    end(key: string, outcome: RunNowOutcome): void {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (outcome === "known" && entry.inFlight === 0) entries.delete(key);
    },
  };
}

export type RunNowClickIds = ReturnType<typeof createRunNowClickIds>;

/**
 * Sends Run now with one command id per intent, so a double click or a retry
 * after a lost answer gets back the run the first click started. Servers
 * without run history get the request without an id, as before.
 */
export async function runScheduledTaskNowOnce<A, E>(input: {
  readonly clickIds: RunNowClickIds;
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId;
  readonly keepsRunHistory: boolean;
  readonly run: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: ScheduledTaskRunNowInput;
  }) => Promise<AtomCommandResult<A, E>>;
}): Promise<AtomCommandResult<A, E>> {
  const { environmentId, taskId } = input;
  if (!input.keepsRunHistory) return input.run({ environmentId, input: { id: taskId } });
  const key = `${environmentId}:${taskId}`;
  const commandId = CommandId.make(input.clickIds.begin(key));
  const result = await input.run({ environmentId, input: { id: taskId, commandId } });
  input.clickIds.end(key, runNowOutcome(result));
  return result;
}
