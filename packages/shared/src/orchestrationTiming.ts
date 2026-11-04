import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

/** Unknown settled timing must not turn a task's age into its work duration. */
export function deriveSubagentElapsedMs(
  agent: {
    readonly status: OrchestrationV2Subagent["status"];
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  },
  nowMs: number,
): number | null {
  if (agent.startedAt === null) return null;
  const end = isOrchestrationV2WorkActive(agent.status)
    ? nowMs
    : agent.completedAt === null
      ? null
      : Date.parse(agent.completedAt);
  if (end === null) return null;
  const start = Date.parse(agent.startedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

type LatestRunTiming = {
  readonly runId: string | null;
  /** Set when the turn is created; `startedAt` waits for the provider. */
  readonly requestedAt?: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

type RuntimeActivityState = {
  readonly orchestrationStatus: string;
  readonly activeRunId?: string | null;
};

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function isLatestRunSettled(
  latestRun: LatestRunTiming | null,
  runtime: RuntimeActivityState | null,
): boolean {
  if (!latestRun) return false;
  if (!latestRun.completedAt) return false;
  if (!runtime) return true;
  if (runtime.orchestrationStatus === "running") return false;
  return true;
}

/**
 * When the working indicator should be counting, and from when.
 *
 * `requestedAt` is the floor for an unsettled turn. The projector only stamps
 * `startedAt` in the same update that moves the session to "running", so while
 * the provider spins up (session "starting") a requested turn has no
 * `startedAt` at all — and returning null there blinks the indicator out for
 * the whole spin-up. A settled turn still falls through to `sendStartedAt`, so
 * this cannot leave the indicator counting after the work is done.
 */
export function deriveActiveWorkStartedAt(
  latestRun: LatestRunTiming | null,
  runtime: RuntimeActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (runtime?.activeRunId && runtime.activeRunId !== latestRun?.runId) {
    return sendStartedAt;
  }
  if (!isLatestRunSettled(latestRun, runtime)) {
    return latestRun?.startedAt ?? latestRun?.requestedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

/**
 * A stretch of a turn spent waiting on the user: an approval or a question
 * card, from when it was shown until it was answered or closed. `endedAtMs`
 * is null while the card is still open.
 */
export interface HumanWait {
  readonly kind: "approval" | "answer";
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}

/** The wait an approval or question item stands for; null for any other item. */
export function humanWaitFromTurnItem(item: OrchestrationV2TurnItem): HumanWait | null {
  if (item.type !== "approval_request" && item.type !== "user_input_request") return null;
  const open = item.status === "pending" || item.status === "running" || item.status === "waiting";
  return {
    kind: item.type === "approval_request" ? "approval" : "answer",
    startedAtMs: DateTime.toEpochMillis(item.startedAt ?? item.updatedAt),
    endedAtMs: open ? null : DateTime.toEpochMillis(item.completedAt ?? item.updatedAt),
  };
}

/**
 * How much of `[startMs, endMs]` the turn spent waiting on the user. Waits
 * that overlap count once, and an open wait runs to `endMs`.
 */
export function humanWaitMs(
  waits: ReadonlyArray<HumanWait>,
  startMs: number,
  endMs: number,
): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  // `map` and `filter` copy the array, so sorting in place is safe.
  const spans = waits
    .map((wait) => ({
      from: Math.max(startMs, wait.startedAtMs),
      to: Math.min(endMs, wait.endedAtMs ?? endMs),
    }))
    .filter(({ from, to }) => Number.isFinite(from) && Number.isFinite(to) && to > from)
    .sort((left, right) => left.from - right.from);
  let total = 0;
  let coveredUntil = startMs;
  for (const { from, to } of spans) {
    const start = Math.max(from, coveredUntil);
    if (to > start) total += to - start;
    coveredUntil = Math.max(coveredUntil, to);
  }
  return total;
}

/** Whole seconds under a minute, so a live counter does not flicker tenths. */
function formatLiveDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1_000);
}

/**
 * The live header of a working turn. While a card waits on the user it says
 * so and counts that wait; otherwise it counts work time only, leaving out
 * earlier waits.
 */
export function liveTurnLabel(input: {
  readonly startedAtMs: number;
  readonly waits: ReadonlyArray<HumanWait>;
  readonly nowMs: number;
}): string {
  const openWait = input.waits
    .filter((wait) => wait.endedAtMs === null && wait.startedAtMs <= input.nowMs)
    .sort((left, right) => left.startedAtMs - right.startedAtMs)[0];
  if (openWait !== undefined) {
    const waiting = openWait.kind === "approval" ? "your approval" : "your answer";
    return `Waiting for ${waiting} · ${formatLiveDuration(input.nowMs - Math.max(input.startedAtMs, openWait.startedAtMs))}`;
  }
  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);
  const waitedMs = humanWaitMs(input.waits, input.startedAtMs, input.nowMs);
  return `Working for ${formatLiveDuration(elapsedMs - waitedMs)}`;
}

/**
 * The settled fold label: time the agent worked, and how long it waited on
 * the user when it did, so approval time is not counted as work.
 */
export function workedForLabel(elapsedMs: number | null, waitedMs: number): string {
  if (elapsedMs === null) return "Worked";
  const waited = Math.min(Math.max(0, waitedMs), elapsedMs);
  const worked = `Worked for ${formatDuration(elapsedMs - waited)}`;
  return waited >= 1_000 ? `${worked} · waited ${formatDuration(waited)} for you` : worked;
}
