// @effect-diagnostics nodeBuiltinImport:off - The snapshot is taken on a native read-only SQLite handle, and publication needs fsync and rename.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  LAST_RUNNING_VERSION_FILE,
  LastRunningVersion,
  STATE_BACKUP_FORMAT,
  STATE_BACKUPS_DIRECTORY,
  StateBackupManifest,
  type StateBackupFile,
  type StateBackupFileRole,
  type StateBackupManifest as StateBackupManifestValue,
  type StateBackupReason,
} from "@starkfuture/contracts";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { binaryMaxMigrationId, historyHash, readMigrationHistory } from "./StateCompatibility.ts";
import * as StateFiles from "./StateFiles.ts";

/**
 * State files copied next to the database, by name under the state
 * directory. Credentials stay out: see `EXCLUDED_STATE`.
 */
export const BACKED_UP_STATE_FILES = [
  "settings.json",
  "keybindings.json",
  "environment-id",
  "desktop-settings.json",
  "client-settings.json",
] as const;

/**
 * Recorded by name only. The database copy still holds webhook secrets and
 * pairing credentials, which is why backups never leave this machine.
 */
const EXCLUDED_STATE = [
  "secrets/",
  "connection-catalog.json",
  "saved-environments.json",
  "clerk storage",
  "electron profile",
  "keychain",
  "logs/",
  "caches/",
  "worktrees/",
  "state.sqlite",
  "server-owner.sqlite",
  "maintenance-owner.sqlite",
] as const;

export const DATABASE_FILE = "statev2.sqlite";
const MANIFEST_FILE = "manifest.json";
const STAGING_SUFFIX = ".staging";
/** Room kept free beyond the copy itself, so the backup never fills the disk. */
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

export class StateBackupSpaceError extends Schema.TaggedError<StateBackupSpaceError>()(
  "StateBackupSpaceError",
  { backupsDir: Schema.String, requiredBytes: Schema.Number, availableBytes: Schema.Number },
) {
  override get message(): string {
    const megabytes = (bytes: number) => Math.ceil(bytes / (1024 * 1024));
    return `Not enough free space for a backup: ${megabytes(this.requiredBytes)} MB needed, ${megabytes(this.availableBytes)} MB free. Nothing was changed.`;
  }
}

export class StateBackupError extends Schema.TaggedError<StateBackupError>()("StateBackupError", {
  stage: Schema.Literals(["prepare", "snapshot", "check", "copy", "manifest", "publish"]),
  backupsDir: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The backup failed while it ${STAGE_WORDING[this.stage]}. Your data was not changed.`;
  }
}

const STAGE_WORDING = {
  prepare: "was preparing its folder",
  snapshot: "was copying the database",
  check: "was checking the database copy",
  copy: "was copying settings and drafts",
  manifest: "was writing its manifest",
  publish: "was being published",
} as const;

export class StateBackupVerifyError extends Schema.TaggedError<StateBackupVerifyError>()(
  "StateBackupVerifyError",
  {
    backupDir: Schema.String,
    reason: Schema.Literals(["manifest", "missing-file", "size", "hash", "integrity"]),
    file: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Backup ${NodePath.basename(this.backupDir)} failed verification (${this.reason}${this.file === undefined ? "" : `: ${this.file}`}).`;
  }
}

export interface StateBackupInput {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly reason: StateBackupReason;
  readonly appVersion: string;
  readonly appCommit?: string | null;
  readonly targetVersion?: string | null;
  /** Renderer drafts and stash acknowledged before an install, as JSON files. */
  readonly drafts?: { readonly path: string; readonly format: number } | undefined;
  readonly stash?: { readonly path: string; readonly format: string } | undefined;
  /** Pending uploads the drafts or stash reference, as files in the attachments directory. */
  readonly attachmentPaths?: ReadonlyArray<string>;
}

export interface StateBackupResult {
  readonly id: string;
  readonly path: string;
  readonly manifest: StateBackupManifestValue;
}

export const backupsDirectory = (baseDir: string) =>
  NodePath.join(baseDir, STATE_BACKUPS_DIRECTORY);

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(StateBackupManifest));
const decodeLastRunningVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(LastRunningVersion),
);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(StateBackupManifest));

const tableExists = (database: NodeSqlite.DatabaseSync, table: string) =>
  database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
  undefined;

const countRows = (database: NodeSqlite.DatabaseSync, table: string) =>
  tableExists(database, table)
    ? Number(database.prepare(`SELECT count(*) AS count FROM "${table}"`).get()?.count ?? 0)
    : 0;

/** Reads what the manifest records about a database copy, on a read-only handle. */
const describeDatabase = (path: string) => {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => String(Object.values(row)[0]));
    const history = readMigrationHistory(database) ?? [];
    let maxSequence = 0;
    const chain = NodeCrypto.createHash("sha256");
    if (tableExists(database, "orchestration_v2_events")) {
      for (const row of database
        .prepare("SELECT sequence, event_id FROM orchestration_v2_events ORDER BY sequence")
        .iterate()) {
        maxSequence = Number(row.sequence);
        chain.update(`${row.sequence}:${String(row.event_id)}\n`);
      }
    }
    return {
      integrity,
      history,
      events: { maxSequence, chainHash: chain.digest("hex") },
      sqlite: {
        version: String(database.prepare("SELECT sqlite_version() AS version").get()?.version),
        pageSize: Number(database.prepare("PRAGMA page_size").get()?.page_size ?? 0),
        pageCount: Number(database.prepare("PRAGMA page_count").get()?.page_count ?? 0),
      },
      counts: {
        threads: countRows(database, "orchestration_v2_projection_threads"),
        messages: countRows(database, "orchestration_v2_projection_messages"),
        projects: countRows(database, "projection_projects"),
        scheduledTasks: countRows(database, "scheduled_tasks"),
      },
    };
  } finally {
    database.close();
  }
};

const newBackupId = (reason: StateBackupReason, nowMs: number) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(nowMs)).replaceAll(/[:.]/g, "-")}-${reason}-${NodeCrypto.randomBytes(3).toString("hex")}`;

const readLastRunningVersion = (stateDir: string) =>
  Option.getOrNull(
    Option.map(
      Option.flatMap(
        Option.fromNullishOr(
          StateFiles.readTextIfExists(NodePath.join(stateDir, LAST_RUNNING_VERSION_FILE)),
        ),
        decodeLastRunningVersion,
      ),
      (record) => record.version,
    ),
  );

/**
 * Takes a fresh, verified backup of the selected state. The caller must hold
 * writers off (the maintenance lock exclusively and the server ownership
 * lock); a backup is never reused.
 *
 * The copy is staged as `<id>.staging`, fsynced, checked, hashed and
 * described in `manifest.json`, then renamed into place. Any failure removes
 * the staging folder and leaves the live state untouched.
 */
export const create = Effect.fn("StateBackup.create")(function* (input: StateBackupInput) {
  const ops = yield* StateFiles.StateFileOps;
  const backupsDir = backupsDirectory(input.baseDir);
  const nowMs = yield* Clock.currentTimeMillis;
  const id = newBackupId(input.reason, nowMs);
  const staging = NodePath.join(backupsDir, `${id}${STAGING_SUFFIX}`);
  const finalPath = NodePath.join(backupsDir, id);
  const fail = (stage: StateBackupError["stage"]) => (cause: unknown) =>
    new StateBackupError({ stage, backupsDir, cause });

  const stateFiles = BACKED_UP_STATE_FILES.map((name) => ({
    name,
    source: NodePath.join(input.stateDir, name),
  })).filter((file) => StateFiles.exists(file.source));
  const attachmentPaths = (input.attachmentPaths ?? []).filter(StateFiles.exists);

  yield* Effect.try({
    try: () => ops.mkdir(backupsDir, StateFiles.DIRECTORY_MODE),
    catch: fail("prepare"),
  });
  // VACUUM INTO writes a compacted copy; the WAL can hold most of the data,
  // so both count, twice over for the temporary space SQLite needs.
  const databaseBytes =
    (StateFiles.exists(input.dbPath) ? StateFiles.fileSize(input.dbPath) : 0) +
    (StateFiles.exists(`${input.dbPath}-wal`) ? StateFiles.fileSize(`${input.dbPath}-wal`) : 0);
  const otherBytes = [
    ...stateFiles.map((file) => file.source),
    ...attachmentPaths,
    ...(input.drafts ? [input.drafts.path] : []),
    ...(input.stash ? [input.stash.path] : []),
  ].reduce((total, path) => total + StateFiles.fileSize(path), 0);
  const requiredBytes = databaseBytes * 2 + otherBytes + SPACE_MARGIN_BYTES;
  const availableBytes = yield* Effect.try({
    try: () => ops.availableBytes(backupsDir),
    catch: fail("prepare"),
  });
  if (availableBytes < requiredBytes) {
    return yield* new StateBackupSpaceError({ backupsDir, requiredBytes, availableBytes });
  }

  const removeStaging = Effect.sync(() => {
    try {
      ops.remove(staging);
    } catch {
      // A leftover staging folder is never published and is removed on the next open.
    }
  });

  return yield* Effect.gen(function* () {
    yield* Effect.try({
      try: () => ops.mkdir(staging, StateFiles.DIRECTORY_MODE),
      catch: fail("prepare"),
    });
    const files: Array<StateBackupFile> = [];
    const record = (name: string, role: StateBackupFileRole) => {
      const path = NodePath.join(staging, name);
      ops.chmod(path, StateFiles.FILE_MODE);
      ops.fsync(path);
      files.push({
        name,
        role,
        bytes: StateFiles.fileSize(path),
        sha256: StateFiles.sha256File(path),
      });
    };

    // One read transaction: committed WAL frames are included, open
    // transactions are not.
    yield* Effect.try({
      try: () => {
        const source = new NodeSqlite.DatabaseSync(input.dbPath, { readOnly: true });
        try {
          source.prepare("VACUUM INTO ?").run(NodePath.join(staging, DATABASE_FILE));
        } finally {
          source.close();
        }
        record(DATABASE_FILE, "database");
      },
      catch: fail("snapshot"),
    });
    const description = yield* Effect.try({
      try: () => describeDatabase(NodePath.join(staging, DATABASE_FILE)),
      catch: fail("check"),
    });
    if (description.integrity.length !== 1 || description.integrity[0] !== "ok") {
      return yield* new StateBackupError({
        stage: "check",
        backupsDir,
        cause: `integrity_check: ${description.integrity.slice(0, 5).join("; ")}`,
      });
    }

    yield* Effect.try({
      try: () => {
        ops.mkdir(NodePath.join(staging, "state"), StateFiles.DIRECTORY_MODE);
        for (const file of stateFiles) {
          ops.copyFile(file.source, NodePath.join(staging, "state", file.name));
          record(`state/${file.name}`, "state-file");
        }
        if (input.drafts || input.stash) {
          ops.mkdir(NodePath.join(staging, "renderer"), StateFiles.DIRECTORY_MODE);
        }
        if (input.drafts) {
          ops.copyFile(input.drafts.path, NodePath.join(staging, "renderer", "drafts.json"));
          record("renderer/drafts.json", "drafts");
        }
        if (input.stash) {
          ops.copyFile(input.stash.path, NodePath.join(staging, "renderer", "stash.json"));
          record("renderer/stash.json", "stash");
        }
        if (attachmentPaths.length > 0) {
          ops.mkdir(NodePath.join(staging, "attachments"), StateFiles.DIRECTORY_MODE);
          for (const path of attachmentPaths) {
            const name = NodePath.basename(path);
            ops.copyFile(path, NodePath.join(staging, "attachments", name));
            record(`attachments/${name}`, "attachment");
          }
        }
        for (const directory of ["state", "renderer", "attachments"]) {
          const path = NodePath.join(staging, directory);
          if (StateFiles.isDirectory(path)) ops.fsync(path);
        }
      },
      catch: fail("copy"),
    });

    const manifest: StateBackupManifestValue = {
      format: STATE_BACKUP_FORMAT,
      id,
      reason: input.reason,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      app: {
        version: input.appVersion,
        commit: input.appCommit ?? null,
        arch: yield* HostProcess.Architecture,
        platform: yield* HostProcess.Platform,
      },
      targetVersion: input.targetVersion ?? null,
      lastRunningVersion: readLastRunningVersion(input.stateDir),
      schema: {
        history: description.history.map(([migrationId, name]) => [migrationId, name] as const),
        historyHash: historyHash(description.history),
        recordedMaxId: Math.max(0, ...description.history.map(([migrationId]) => migrationId)),
        binaryMaxId: binaryMaxMigrationId,
      },
      events: description.events,
      sqlite: { ...description.sqlite, integrity: "ok" },
      counts: description.counts,
      formats: {
        settings: stateFiles.some((file) => file.name === "settings.json") ? 1 : null,
        drafts: input.drafts?.format ?? null,
        stash: input.stash?.format ?? null,
      },
      files,
      excluded: [...EXCLUDED_STATE],
      baseDir: input.baseDir,
      stateDir: input.stateDir,
    };
    yield* Effect.try({
      try: () => {
        const path = NodePath.join(staging, MANIFEST_FILE);
        ops.writeFile(path, `${encodeManifest(manifest)}\n`, StateFiles.FILE_MODE);
        ops.fsync(path);
        ops.fsync(staging);
      },
      catch: fail("manifest"),
    });
    yield* Effect.try({
      try: () => {
        ops.rename(staging, finalPath);
        ops.fsync(backupsDir);
      },
      catch: fail("publish"),
    });
    yield* verify(finalPath);
    return { id, path: finalPath, manifest } satisfies StateBackupResult;
  }).pipe(Effect.onError(() => removeStaging));
});

/** Reads a published backup's manifest. */
const readManifest = Effect.fn("StateBackup.readManifest")(function* (backupDir: string) {
  const text = yield* Effect.try({
    try: () => StateFiles.readTextIfExists(NodePath.join(backupDir, MANIFEST_FILE)),
    catch: () => new StateBackupVerifyError({ backupDir, reason: "manifest" }),
  });
  const manifest = text === null ? Option.none() : decodeManifest(text);
  if (Option.isNone(manifest) || manifest.value.id !== NodePath.basename(backupDir)) {
    return yield* new StateBackupVerifyError({ backupDir, reason: "manifest" });
  }
  return manifest.value;
});

/**
 * Checks every file against the manifest (size, then sha256) and the
 * database copy's integrity. A single flipped byte or a truncation fails.
 */
export const verify = Effect.fn("StateBackup.verify")(function* (backupDir: string) {
  const manifest = yield* readManifest(backupDir);
  for (const file of manifest.files) {
    const path = NodePath.join(backupDir, ...file.name.split("/"));
    if (!StateFiles.exists(path)) {
      return yield* new StateBackupVerifyError({
        backupDir,
        reason: "missing-file",
        file: file.name,
      });
    }
    if (StateFiles.fileSize(path) !== file.bytes) {
      return yield* new StateBackupVerifyError({ backupDir, reason: "size", file: file.name });
    }
    if (StateFiles.sha256File(path) !== file.sha256) {
      return yield* new StateBackupVerifyError({ backupDir, reason: "hash", file: file.name });
    }
  }
  const integrity = yield* Effect.try({
    try: () => describeDatabase(NodePath.join(backupDir, DATABASE_FILE)).integrity,
    catch: () => new StateBackupVerifyError({ backupDir, reason: "integrity" }),
  });
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    return yield* new StateBackupVerifyError({ backupDir, reason: "integrity" });
  }
  return manifest;
});

export interface StateBackupListing {
  readonly id: string;
  readonly path: string;
  readonly manifest: StateBackupManifestValue;
}

/** Published backups, newest first. Staging and displaced folders are not backups. */
export const list = Effect.fn("StateBackup.list")(function* (baseDir: string) {
  const backupsDir = backupsDirectory(baseDir);
  const listings: Array<StateBackupListing> = [];
  for (const entry of StateFiles.listDirectory(backupsDir)) {
    if (entry.endsWith(STAGING_SUFFIX) || entry.includes("-displaced-")) continue;
    const path = NodePath.join(backupsDir, entry);
    if (!StateFiles.isDirectory(path)) continue;
    const manifest = yield* readManifest(path).pipe(Effect.option);
    if (Option.isSome(manifest)) listings.push({ id: entry, path, manifest: manifest.value });
  }
  return listings.toSorted((left, right) =>
    right.manifest.createdAt.localeCompare(left.manifest.createdAt),
  );
});

/** Removes staging folders a crashed backup left. They were never published. */
export const removeStaleStaging = Effect.fn("StateBackup.removeStaleStaging")(function* (
  baseDir: string,
) {
  const ops = yield* StateFiles.StateFileOps;
  const backupsDir = backupsDirectory(baseDir);
  const stale = StateFiles.listDirectory(backupsDir).filter((entry) =>
    entry.endsWith(STAGING_SUFFIX),
  );
  for (const entry of stale) {
    yield* Effect.try(() => ops.remove(NodePath.join(backupsDir, entry))).pipe(Effect.ignore);
  }
  return stale.length;
});
