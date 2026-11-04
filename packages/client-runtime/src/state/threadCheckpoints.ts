import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointFileOrigin,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
    readonly origin?: OrchestrationV2CheckpointFileOrigin | undefined;
  }>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

/** Derives the checkpoint/diff rows needed by review UIs from native V2 entities. */
export function deriveThreadCheckpointSummaries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const assistantMessageId =
      projection.messages.findLast(
        (message) => message.runId === checkpoint.runId && message.role === "assistant",
      )?.id ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}

/**
 * A turn's changed files, split by who changed them. A checkpoint snapshots the whole folder,
 * so it also holds edits that people or other programs made while the turn ran.
 */
export interface CheckpointFileGroups<File> {
  /** Written by the agent's edit tools, or recorded before origins existed. */
  readonly agent: ReadonlyArray<File>;
  /** Not from an edit tool, but the turn ran commands or tools that could have written them. */
  readonly unknown: ReadonlyArray<File>;
  /** Nothing the agent ran could have written these. */
  readonly outside: ReadonlyArray<File>;
}

export function groupCheckpointFilesByOrigin<
  File extends { readonly origin?: OrchestrationV2CheckpointFileOrigin | undefined },
>(files: ReadonlyArray<File>): CheckpointFileGroups<File> {
  return {
    agent: files.filter((file) => file.origin === undefined || file.origin === "agent"),
    unknown: files.filter((file) => file.origin === "unknown"),
    outside: files.filter((file) => file.origin === "outside"),
  };
}

/**
 * Whether a reply should show its changed files. A turn whose tools could not have written
 * anything shows none, even when the folder changed while it ran.
 */
export function replyChangedSomething(groups: CheckpointFileGroups<unknown>) {
  return groups.agent.length > 0 || groups.unknown.length > 0;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One-line labels for each non-empty group, in the order a reviewer reads them. */
export function describeCheckpointFileGroups(groups: CheckpointFileGroups<unknown>) {
  return [
    ...(groups.agent.length > 0
      ? [
          {
            origin: "agent" as const,
            label: `Agent edits (${plural(groups.agent.length, "file")})`,
          },
        ]
      : []),
    ...(groups.unknown.length > 0
      ? [
          {
            origin: "unknown" as const,
            label: `Changed while the agent ran commands, source unknown (${plural(groups.unknown.length, "file")})`,
          },
        ]
      : []),
    ...(groups.outside.length > 0
      ? [
          {
            origin: "outside" as const,
            label: `Other changes in the folder during this turn (${plural(groups.outside.length, "file")})`,
          },
        ]
      : []),
  ];
}

/** Why a turn's diff can't be loaded from its checkpoint, or null when it can. */
export function checkpointUnavailableReason(status: ThreadCheckpointSummary["status"]) {
  switch (status) {
    case "ready":
      return null;
    case "missing":
      return "No checkpoint was saved for this turn, so its changes can't be shown.";
    case "error":
      return "Saving this turn's checkpoint failed, so its changes can't be shown.";
    case "stale":
      return "This turn was rolled back, so its checkpoint is gone.";
  }
}

/**
 * The newest run whose provider turn ended but whose checkpoint is still being captured.
 * While it exists, the newest checkpoint summary belongs to an older turn.
 */
export function findRunAwaitingCheckpoint<
  Run extends Pick<
    OrchestrationV2ThreadProjection["runs"][number],
    "id" | "ordinal" | "status" | "checkpointId"
  >,
>(runs: ReadonlyArray<Run>, checkpoints: ReadonlyArray<Pick<ThreadCheckpointSummary, "runId">>) {
  const newest = runs.reduce<Run | undefined>(
    (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
    undefined,
  );
  if (newest === undefined || newest.status !== "waiting" || newest.checkpointId !== null) {
    return null;
  }
  return checkpoints.some((checkpoint) => checkpoint.runId === newest.id) ? null : newest;
}
