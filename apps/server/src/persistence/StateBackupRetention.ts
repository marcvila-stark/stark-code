// @effect-diagnostics nodeBuiltinImport:off - Sizes of published backup folders are read from disk directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as StateBackup from "./StateBackup.ts";
import * as StateFiles from "./StateFiles.ts";

const RECENT_UPDATE_BACKUPS = 3;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_SIZE_CAP_BYTES = 256 * 1024 * 1024;

export interface RetentionCandidate {
  readonly id: string;
  readonly createdAtMs: number;
  readonly reason: "pre-install" | "pre-migrate" | "manual";
  readonly appVersion: string;
  readonly bytes: number;
}

export interface RetentionPlan {
  readonly keep: ReadonlyArray<string>;
  readonly prune: ReadonlyArray<string>;
  /** The newest backup written by an earlier version: the way back. */
  readonly protectedId: string | null;
}

/**
 * Which backups to keep. Kept: the three newest update backups and the
 * protected one (the newest written by a version other than the running one).
 * The rest go by age (30 days), then oldest first while the total exceeds a
 * soft cap of three database sizes (at least 256 MB). Kept backups never count
 * against the cap's deletions, so the cap can be exceeded. Displaced sets are
 * not candidates at all.
 */
export const planRetention = (input: {
  readonly backups: ReadonlyArray<RetentionCandidate>;
  readonly nowMs: number;
  readonly runningVersion: string;
  readonly databaseBytes: number;
}): RetentionPlan => {
  const newestFirst = input.backups.toSorted((left, right) => right.createdAtMs - left.createdAtMs);
  const protectedBackup = newestFirst.find((backup) => backup.appVersion !== input.runningVersion);
  const kept = new Set(
    newestFirst
      .filter((backup) => backup.reason !== "manual")
      .slice(0, RECENT_UPDATE_BACKUPS)
      .map((backup) => backup.id),
  );
  if (protectedBackup) kept.add(protectedBackup.id);
  const prune = new Set<string>();
  for (const backup of newestFirst) {
    if (!kept.has(backup.id) && input.nowMs - backup.createdAtMs > MAX_AGE_MS) prune.add(backup.id);
  }
  const cap = Math.max(MIN_SIZE_CAP_BYTES, input.databaseBytes * 3);
  let total = newestFirst
    .filter((backup) => !prune.has(backup.id))
    .reduce((sum, backup) => sum + backup.bytes, 0);
  for (const backup of newestFirst.toReversed()) {
    if (total <= cap) break;
    if (kept.has(backup.id) || prune.has(backup.id)) continue;
    prune.add(backup.id);
    total -= backup.bytes;
  }
  return {
    keep: newestFirst.filter((backup) => !prune.has(backup.id)).map((backup) => backup.id),
    prune: newestFirst.filter((backup) => prune.has(backup.id)).map((backup) => backup.id),
    protectedId: protectedBackup?.id ?? null,
  };
};

const directoryBytes = (path: string): number =>
  NodeFS.readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = NodePath.join(path, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(child) : NodeFS.statSync(child).size);
  }, 0);

/** Applies `planRetention` to the published backups under `baseDir`. */
export const apply = Effect.fn("StateBackupRetention.apply")(function* (input: {
  readonly baseDir: string;
  readonly dbPath: string;
  readonly runningVersion: string;
  readonly nowMs: number;
}) {
  const ops = yield* StateFiles.StateFileOps;
  const backups = yield* StateBackup.list(input.baseDir);
  const plan = planRetention({
    backups: backups.map((backup) => ({
      id: backup.id,
      createdAtMs: DateTime.toEpochMillis(DateTime.makeUnsafe(backup.manifest.createdAt)),
      reason: backup.manifest.reason,
      appVersion: backup.manifest.app.version,
      bytes: directoryBytes(backup.path),
    })),
    nowMs: input.nowMs,
    runningVersion: input.runningVersion,
    databaseBytes: StateFiles.exists(input.dbPath) ? StateFiles.fileSize(input.dbPath) : 0,
  });
  for (const id of plan.prune) {
    yield* Effect.try(() =>
      ops.remove(NodePath.join(StateBackup.backupsDirectory(input.baseDir), id)),
    ).pipe(Effect.ignore({ log: true }));
  }
  return plan;
});
