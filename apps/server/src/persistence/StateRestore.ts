// @effect-diagnostics nodeBuiltinImport:off - A crash-safe restore is a sequence of fsynced renames recorded in a journal.
import * as NodePath from "node:path";

import {
  ATTACHMENT_HOLDS_FILE,
  AttachmentHolds,
  MaintenanceRecoveryHold,
  MAINTENANCE_SUPPORTED_FORMATS,
  RECOVERY_HOLD_FILE,
  RESTORE_JOURNAL_FILE,
  RESTORED_DRAFTS_FILE,
  RESTORED_STASH_FILE,
  type StateBackupManifest,
} from "@starkfuture/contracts";
import { compareSemverVersions } from "@starkfuture/shared/semver";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as FailedUpdate from "../maintenance/FailedUpdate.ts";
import {
  type MigrationHistory,
  binaryMigrationHistory,
  isRestorableUnderBinary,
} from "./StateCompatibility.ts";
import * as StateBackup from "./StateBackup.ts";
import * as StateFiles from "./StateFiles.ts";

export class StateRestoreIncompatibleError extends Schema.TaggedError<StateRestoreIncompatibleError>()(
  "StateRestoreIncompatibleError",
  {
    backupId: Schema.String,
    reason: Schema.Literals(["schema", "app-version", "format"]),
    /** The version that wrote the backup and can read it. */
    backupAppVersion: Schema.String,
  },
) {
  override get message(): string {
    return `This backup can only be restored by Stark Code ${this.backupAppVersion} or a compatible later version. Nothing was changed.`;
  }
}

export class StateRestoreError extends Schema.TaggedError<StateRestoreError>()(
  "StateRestoreError",
  {
    stage: Schema.Literals(["stage", "journal", "displace", "publish", "finish", "recover"]),
    backupId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.stage === "stage"
      ? `Could not prepare backup ${this.backupId} for restoring. Nothing was changed.`
      : `Restoring backup ${this.backupId} stopped while it was at the "${this.stage}" step. The next start finishes or undoes it; replaced files are kept.`;
  }
}

const RestoreJournal = Schema.Struct({
  version: Schema.Literal(1),
  backupId: Schema.String,
  backupAppVersion: Schema.String,
  phase: Schema.Literals(["staged", "displaced", "published"]),
  stagingDir: Schema.String,
  displacedDir: Schema.String,
  stateDir: Schema.String,
  attachmentsDir: Schema.String,
  /** Every live file the restore replaces, where it is moved, and what replaces it. */
  moves: Schema.Array(
    Schema.Struct({
      target: Schema.String,
      displaced: Schema.String,
      staged: Schema.NullOr(Schema.String),
    }),
  ),
  /** Attachments copied back next to live ones; they never replace a live file. */
  attachments: Schema.Array(Schema.String),
});
type RestoreJournal = typeof RestoreJournal.Type;
const decodeJournal = Schema.decodeUnknownOption(Schema.fromJsonString(RestoreJournal));
const encodeJournal = Schema.encodeSync(Schema.fromJsonString(RestoreJournal));
const encodeHold = Schema.encodeSync(Schema.fromJsonString(MaintenanceRecoveryHold));
const encodeAttachmentHolds = Schema.encodeSync(Schema.fromJsonString(AttachmentHolds));

export const journalPath = (baseDir: string) =>
  NodePath.join(StateBackup.backupsDirectory(baseDir), RESTORE_JOURNAL_FILE);

export interface StateRestoreInput {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly backupId: string;
  readonly runningVersion: string;
  readonly binaryHistory?: MigrationHistory;
  /** The windows' current drafts and stash, exported before the restore; kept with the displaced set. */
  readonly currentDrafts?: string | undefined;
  readonly currentStash?: string | undefined;
}

/**
 * Why `manifest` cannot be restored under this build, or none. Compatible
 * means: its migration history is a prefix of this build's, its app version is
 * not newer than the running one, and this build reads every recorded format.
 */
export const incompatibility = (
  manifest: StateBackupManifest,
  runningVersion: string,
  binaryHistory: MigrationHistory = binaryMigrationHistory,
): StateRestoreIncompatibleError["reason"] | null => {
  if (!isRestorableUnderBinary(manifest.schema.history, binaryHistory)) return "schema";
  if (compareSemverVersions(manifest.app.version, runningVersion) > 0) return "app-version";
  const { formats } = manifest;
  if (
    (formats.settings !== null && formats.settings > MAINTENANCE_SUPPORTED_FORMATS.settings) ||
    (formats.drafts !== null && formats.drafts > MAINTENANCE_SUPPORTED_FORMATS.drafts) ||
    (formats.stash !== null && formats.stash !== MAINTENANCE_SUPPORTED_FORMATS.stash)
  ) {
    return "format";
  }
  return null;
};

/** Where each backed-up file goes back to. Renderer state goes to a hand-off file. */
const targetFor = (
  input: { readonly stateDir: string },
  file: StateBackupManifest["files"][number],
) => {
  switch (file.role) {
    case "database":
      return NodePath.join(input.stateDir, StateBackup.DATABASE_FILE);
    case "state-file":
      return NodePath.join(input.stateDir, NodePath.basename(file.name));
    case "drafts":
      return NodePath.join(input.stateDir, RESTORED_DRAFTS_FILE);
    case "stash":
      return NodePath.join(input.stateDir, RESTORED_STASH_FILE);
    case "attachment":
      return null;
  }
};

const writeJournal = (
  ops: StateFiles.StateFileOperations,
  baseDir: string,
  journal: RestoreJournal,
) => StateFiles.writeFileDurably(ops, journalPath(baseDir), `${encodeJournal(journal)}\n`);

/**
 * Applies the journal's remaining steps. Before `displaced` is recorded the
 * restore is undone (every displaced file moves back); from `displaced` on it
 * is finished (every staged file moves in). Each step is a rename, so running
 * this again after another crash converges on the same result.
 */
const settleJournal = (
  ops: StateFiles.StateFileOperations,
  baseDir: string,
  journal: RestoreJournal,
  nowIso: string,
) => {
  if (journal.phase === "staged") {
    for (const move of journal.moves) {
      if (StateFiles.exists(move.displaced) && !StateFiles.exists(move.target)) {
        ops.rename(move.displaced, move.target);
      }
    }
    ops.fsync(journal.stateDir);
    ops.remove(journal.stagingDir);
    ops.remove(journal.displacedDir);
    StateFiles.removeDurably(ops, journalPath(baseDir));
    return "rolled-back" as const;
  }
  if (journal.phase === "displaced") {
    for (const move of journal.moves) {
      if (move.staged !== null && StateFiles.exists(move.staged)) {
        ops.rename(move.staged, move.target);
      }
    }
    ops.fsync(journal.stateDir);
    writeJournal(ops, baseDir, { ...journal, phase: "published" });
  }
  for (const attachment of journal.attachments) {
    const target = NodePath.join(journal.attachmentsDir, NodePath.basename(attachment));
    if (StateFiles.exists(attachment) && !StateFiles.exists(target))
      ops.copyFile(attachment, target);
  }
  if (journal.attachments.length > 0) ops.fsync(journal.attachmentsDir);
  if (journal.attachments.length > 0) {
    StateFiles.writeFileDurably(
      ops,
      NodePath.join(journal.stateDir, ATTACHMENT_HOLDS_FILE),
      `${encodeAttachmentHolds({
        version: 1,
        heldAt: nowIso,
        attachmentIds: journal.attachments.map((path) =>
          NodePath.basename(path, NodePath.extname(path)),
        ),
      })}\n`,
    );
  }
  const hold: MaintenanceRecoveryHold = {
    version: 1,
    backupId: journal.backupId,
    backupAppVersion: journal.backupAppVersion,
    displacedPath: journal.displacedDir,
    heldSince: nowIso,
  };
  const holdPath = NodePath.join(journal.stateDir, RECOVERY_HOLD_FILE);
  if (!StateFiles.exists(holdPath)) {
    StateFiles.writeFileDurably(ops, holdPath, `${encodeHold(hold)}\n`);
  }
  ops.remove(journal.stagingDir);
  StateFiles.removeDurably(ops, journalPath(baseDir));
  return "restored" as const;
};

/**
 * Restores a verified backup over the live state. The caller holds the
 * maintenance lock exclusively and the server ownership lock.
 *
 * 1. Stage: copy every file out of the backup next to the state, and check it.
 * 2. Journal: record every move before making any.
 * 3. Displace: move every live file the restore replaces (database, its WAL
 *    and SHM, state files, current drafts and stash) to
 *    `backups/<id>-displaced-<time>`. Nothing is deleted.
 * 4. Publish: rename the staged files into place.
 * 5. Hold: write `recovery-hold.json`, so scheduling, continuations and
 *    cleanup wait for the user's Resume on every boot until then.
 */
export const restore = Effect.fn("StateRestore.restore")(function* (input: StateRestoreInput) {
  const ops = yield* StateFiles.StateFileOps;
  const backupsDir = StateBackup.backupsDirectory(input.baseDir);
  const backupDir = NodePath.join(backupsDir, input.backupId);
  const manifest = yield* StateBackup.verify(backupDir);
  const reason = incompatibility(manifest, input.runningVersion, input.binaryHistory);
  if (reason !== null) {
    return yield* new StateRestoreIncompatibleError({
      backupId: input.backupId,
      reason,
      backupAppVersion: manifest.app.version,
    });
  }
  const nowMs = yield* Clock.currentTimeMillis;
  const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
  const stamp = nowIso.replaceAll(/[:.]/g, "-");
  const stagingDir = NodePath.join(backupsDir, `${input.backupId}.restore.staging`);
  const displacedDir = NodePath.join(backupsDir, `${input.backupId}-displaced-${stamp}`);
  const fail = (stage: StateRestoreError["stage"]) => (cause: unknown) =>
    new StateRestoreError({ stage, backupId: input.backupId, cause });

  const journal = yield* Effect.try({
    try: (): RestoreJournal => {
      ops.remove(stagingDir);
      ops.mkdir(stagingDir, StateFiles.DIRECTORY_MODE);
      const moves: Array<RestoreJournal["moves"][number]> = [];
      const attachments: Array<string> = [];
      const displacedName = (target: string) =>
        NodePath.join(displacedDir, NodePath.basename(target));
      for (const file of manifest.files) {
        const source = NodePath.join(backupDir, ...file.name.split("/"));
        if (file.role === "attachment") {
          const staged = NodePath.join(stagingDir, "attachments", NodePath.basename(file.name));
          ops.mkdir(NodePath.dirname(staged), StateFiles.DIRECTORY_MODE);
          ops.copyFile(source, staged);
          attachments.push(staged);
          continue;
        }
        const target = targetFor(input, file);
        if (target === null) continue;
        const staged = NodePath.join(stagingDir, NodePath.basename(target));
        ops.copyFile(source, staged);
        ops.chmod(staged, StateFiles.FILE_MODE);
        ops.fsync(staged);
        if (StateFiles.sha256File(staged) !== file.sha256) {
          throw new Error(`Staged copy of ${file.name} does not match the manifest.`);
        }
        moves.push({ target, displaced: displacedName(target), staged });
      }
      // The live database's WAL and SHM belong to the database being replaced.
      const database = NodePath.join(input.stateDir, StateBackup.DATABASE_FILE);
      for (const suffix of ["-wal", "-shm"]) {
        moves.push({
          target: `${database}${suffix}`,
          displaced: displacedName(`${database}${suffix}`),
          staged: null,
        });
      }
      // Every backed-up kind of state file is replaced, even one the backup
      // lacks: a newer file would otherwise outlive the restore.
      for (const name of StateBackup.BACKED_UP_STATE_FILES) {
        // The environment's identity is only ever replaced by a recorded one.
        if (name === "environment-id") continue;
        const target = NodePath.join(input.stateDir, name);
        if (!moves.some((move) => move.target === target)) {
          moves.push({ target, displaced: displacedName(target), staged: null });
        }
      }
      ops.fsync(stagingDir);
      return {
        version: 1,
        backupId: input.backupId,
        backupAppVersion: manifest.app.version,
        phase: "staged",
        stagingDir,
        displacedDir,
        stateDir: input.stateDir,
        attachmentsDir: input.attachmentsDir,
        moves,
        attachments,
      };
    },
    catch: fail("stage"),
  }).pipe(Effect.tapError(() => Effect.try(() => ops.remove(stagingDir)).pipe(Effect.ignore)));

  yield* Effect.try({
    try: () => writeJournal(ops, input.baseDir, journal),
    catch: fail("journal"),
  }).pipe(
    // Nothing moved yet: without a journal the staged copies are just litter.
    Effect.tapError(() => Effect.try(() => ops.remove(stagingDir)).pipe(Effect.ignore)),
  );
  yield* Effect.try({
    try: () => {
      ops.mkdir(displacedDir, StateFiles.DIRECTORY_MODE);
      for (const move of journal.moves) {
        if (StateFiles.exists(move.target)) ops.rename(move.target, move.displaced);
      }
      if (input.currentDrafts && StateFiles.exists(input.currentDrafts)) {
        ops.copyFile(input.currentDrafts, NodePath.join(displacedDir, "current-drafts.json"));
      }
      if (input.currentStash && StateFiles.exists(input.currentStash)) {
        ops.copyFile(input.currentStash, NodePath.join(displacedDir, "current-stash.json"));
      }
      ops.fsync(displacedDir);
      ops.fsync(input.stateDir);
      writeJournal(ops, input.baseDir, { ...journal, phase: "displaced" });
    },
    catch: fail("displace"),
  });
  const outcome = yield* Effect.try({
    try: () => settleJournal(ops, input.baseDir, { ...journal, phase: "displaced" }, nowIso),
    catch: fail("publish"),
  });
  // A backup from before an update, restored by an older version than that
  // update: the update is rolled back and must not be offered on its own again.
  const rolledBackFrom = manifest.targetVersion;
  if (rolledBackFrom !== null && compareSemverVersions(rolledBackFrom, input.runningVersion) > 0) {
    yield* FailedUpdate.record(input.stateDir, {
      failedVersion: rolledBackFrom,
      reason: "restored",
      fromVersion: manifest.app.version,
    });
  }
  return {
    outcome,
    backupId: input.backupId,
    backupAppVersion: manifest.app.version,
    displacedPath: displacedDir,
  };
});

/**
 * Finishes or undoes a restore a crash interrupted, before anything opens
 * the database. Returns none when no restore was in progress.
 */
export const recoverInterrupted = Effect.fn("StateRestore.recoverInterrupted")(function* (
  baseDir: string,
) {
  const ops = yield* StateFiles.StateFileOps;
  const text = yield* Effect.try({
    try: () => StateFiles.readTextIfExists(journalPath(baseDir)),
    catch: (cause) => new StateRestoreError({ stage: "recover", backupId: "unknown", cause }),
  });
  if (text === null) return Option.none();
  const journal = decodeJournal(text);
  if (Option.isNone(journal)) {
    return yield* new StateRestoreError({
      stage: "recover",
      backupId: "unknown",
      cause: "The restore journal is unreadable.",
    });
  }
  const nowIso = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  const outcome = yield* Effect.try({
    try: () => settleJournal(ops, baseDir, journal.value, nowIso),
    catch: (cause) =>
      new StateRestoreError({ stage: "recover", backupId: journal.value.backupId, cause }),
  });
  return Option.some({ outcome, backupId: journal.value.backupId });
});
