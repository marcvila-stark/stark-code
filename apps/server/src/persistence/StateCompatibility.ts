// @effect-diagnostics nodeBuiltinImport:off - The inspection must open a read-only native handle before the Effect SQL client opens the database writable.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { migrationEntries } from "./Migrations.ts";
import { sha256Text } from "./StateFiles.ts";

export type MigrationHistory = ReadonlyArray<readonly [number, string]>;

/** V2's own migrations start here; earlier ids may carry site-local names from old builds. */
const FIRST_V2_MIGRATION_ID = 55;

export const binaryMigrationHistory: MigrationHistory = migrationEntries.map(
  ([id, name]) => [id, name] as const,
);
export const binaryMaxMigrationId = Math.max(...binaryMigrationHistory.map(([id]) => id));

/**
 * How a database relates to this build, by migration names and history rather
 * than the highest id: a database at the same id with another name was written
 * by a different build.
 */
export type StateCompatibility =
  /** No database or no migration history yet. */
  | { readonly _tag: "Fresh" }
  | { readonly _tag: "Current"; readonly history: MigrationHistory; readonly historyHash: string }
  | {
      readonly _tag: "Pending";
      readonly history: MigrationHistory;
      readonly historyHash: string;
      readonly pending: MigrationHistory;
      /** A V2 preview ledger that `reconcileV2PreviewMigration` rewrites first. */
      readonly previewReconciliation: boolean;
    }
  /** A newer build migrated this database past this build's last migration. */
  | {
      readonly _tag: "Newer";
      readonly history: MigrationHistory;
      readonly historyHash: string;
      readonly unknown: MigrationHistory;
    }
  /** Recorded V2 migrations disagree with this build's names at the same ids. */
  | {
      readonly _tag: "Divergent";
      readonly history: MigrationHistory;
      readonly historyHash: string;
      readonly conflicts: ReadonlyArray<string>;
    };

export class StateCompatibilityReadError extends Schema.TaggedError<StateCompatibilityReadError>()(
  "StateCompatibilityReadError",
  { dbPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read the migration history of ${this.dbPath}.`;
  }
}

export const historyHash = (history: MigrationHistory): string =>
  sha256Text(JSON.stringify(history));

/** Reads `effect_sql_migrations` through an already open handle. */
export const readMigrationHistory = (
  database: NodeSqlite.DatabaseSync,
): MigrationHistory | null => {
  const table = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
    )
    .get();
  if (table === undefined) return null;
  return database
    .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
    .all()
    .map((row) => [Number(row.migration_id), String(row.name)] as const);
};

const isV2PreviewLedger = (history: MigrationHistory) =>
  history.some(([id, name]) => name === "OrchestrationV2" && (id === 53 || id === 54));

/** Classifies a recorded history against `binary` (this build's manifest by default). */
export const classifyHistory = (
  history: MigrationHistory | null,
  binary: MigrationHistory = binaryMigrationHistory,
): StateCompatibility => {
  if (history === null || history.length === 0) return { _tag: "Fresh" };
  const hash = historyHash(history);
  if (isV2PreviewLedger(history)) {
    const recorded = new Set(history.map(([id]) => id));
    return {
      _tag: "Pending",
      history,
      historyHash: hash,
      pending: binary.filter(([id]) => !recorded.has(id)),
      previewReconciliation: true,
    };
  }
  const binaryNames = new Map(binary.map(([id, name]) => [id, name]));
  const binaryMax = Math.max(0, ...binary.map(([id]) => id));
  const recordedNames = new Map(history.map(([id, name]) => [id, name]));
  const recordedMax = Math.max(0, ...history.map(([id]) => id));
  const conflicts: Array<string> = [];
  const unknown: Array<readonly [number, string]> = [];
  for (const [id, name] of history) {
    const expected = binaryNames.get(id);
    if (expected === undefined) {
      if (id > binaryMax) unknown.push([id, name]);
      else if (id >= FIRST_V2_MIGRATION_ID) conflicts.push(`${id}_${name} (unknown to this build)`);
      continue;
    }
    if (expected !== name && id >= FIRST_V2_MIGRATION_ID) {
      conflicts.push(`${id}_${name} (this build: ${expected})`);
    }
  }
  // The migrator skips every id up to the highest recorded one, so a V2 id this
  // build has but the database lacks would never run.
  for (const [id, name] of binary) {
    if (id >= FIRST_V2_MIGRATION_ID && id < recordedMax && !recordedNames.has(id)) {
      conflicts.push(`${id}_${name} (recorded: nothing)`);
    }
  }
  if (conflicts.length > 0) return { _tag: "Divergent", history, historyHash: hash, conflicts };
  if (unknown.length > 0) return { _tag: "Newer", history, historyHash: hash, unknown };
  const pending = binary.filter(([id]) => id > recordedMax);
  return pending.length === 0
    ? { _tag: "Current", history, historyHash: hash }
    : { _tag: "Pending", history, historyHash: hash, pending, previewReconciliation: false };
};

/**
 * Inspects the database before anything opens it writable: a read-only
 * handle, no pragma writes, so a refusal leaves the main file and its `-wal`
 * exactly as they were.
 */
export const inspect = Effect.fn("StateCompatibility.inspect")(function* (
  dbPath: string,
  binary: MigrationHistory = binaryMigrationHistory,
) {
  const history = yield* Effect.try({
    try: () => {
      if (!NodeFS.existsSync(dbPath)) return null;
      const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        return readMigrationHistory(database);
      } finally {
        database.close();
      }
    },
    catch: (cause) => new StateCompatibilityReadError({ dbPath, cause }),
  });
  return classifyHistory(history, binary);
});

/**
 * Whether a backup with `backupHistory` can be restored under this build: its
 * history must be a prefix of this build's migrations, matched by name (with
 * the same tolerance for pre-V2 site-local names the migrator has).
 */
export const isRestorableUnderBinary = (
  backupHistory: MigrationHistory,
  binary: MigrationHistory = binaryMigrationHistory,
): boolean => {
  const classified = classifyHistory(backupHistory, binary);
  return classified._tag === "Current" || classified._tag === "Pending";
};
