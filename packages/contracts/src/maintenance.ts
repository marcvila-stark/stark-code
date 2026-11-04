import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Data protection for updates: the maintenance gate a backend closes before
 * it is stopped, the files that coordinate every process opening the state
 * database, and the backup manifest. See `docs/internals/server-updates.md`.
 */

/** Kinds of admitted work that keep a backend from being stopped. */
export const MaintenanceBlockerKind = Schema.Literals([
  /** A run that is preparing, starting, running, or waiting. */
  "run",
  /** A request that waits on a person (approval, question). */
  "pending-request",
  /** A provider thread that is active or still reports background tasks. */
  "provider-work",
  /** An outbox effect that is executing. */
  "effect",
  /** A scheduled-task or webhook run that was accepted and has not started its agent yet. */
  "scheduled-run",
  /** A command or scheduled run admitted just before the gate closed, still being recorded. */
  "admission",
]);
export type MaintenanceBlockerKind = typeof MaintenanceBlockerKind.Type;

export const MaintenanceBlocker = Schema.Struct({
  kind: MaintenanceBlockerKind,
  /** The run, request, provider thread, effect, or scheduled run. */
  id: Schema.String,
  threadId: Schema.NullOr(Schema.String),
});
export type MaintenanceBlocker = typeof MaintenanceBlocker.Type;

/**
 * `open`: normal operation. `closing`: new root work is refused while admitted
 * work drains. `closed`: nothing is running and effect claims are paused; the
 * backend can be stopped.
 */
export const MaintenanceGateState = Schema.Literals(["open", "closing", "closed"]);
export type MaintenanceGateState = typeof MaintenanceGateState.Type;

/**
 * `probe` reopens the gate at once when anything blocks, so showing the
 * blockers refuses nothing. `drain` keeps refusing new work until the
 * blockers finish or the lease expires ("Restart when done").
 */
export const MaintenancePrepareMode = Schema.Literals(["probe", "drain"]);
export type MaintenancePrepareMode = typeof MaintenancePrepareMode.Type;

/** A backup restored on this data; background work waits until the user resumes. */
export const MaintenanceRecoveryHold = Schema.Struct({
  version: Schema.Literal(1),
  backupId: TrimmedNonEmptyString,
  /** The app version that wrote the restored backup. */
  backupAppVersion: Schema.String,
  /** Where the replaced files were moved. */
  displacedPath: Schema.String,
  heldSince: Schema.String,
});
export type MaintenanceRecoveryHold = typeof MaintenanceRecoveryHold.Type;

export const MaintenanceStatus = Schema.Struct({
  /** The request that owns the gate; null while the gate is open. */
  requestId: Schema.NullOr(Schema.String),
  state: MaintenanceGateState,
  /** True only when the gate is closed and nothing blocks: the backend may be stopped now. */
  ready: Schema.Boolean,
  blockers: Schema.Array(MaintenanceBlocker),
  /** When the gate reopens unless it is renewed; null while open. */
  leaseExpiresAtUnixMs: Schema.NullOr(NonNegativeInt),
  recoveryHold: Schema.NullOr(MaintenanceRecoveryHold),
});
export type MaintenanceStatus = typeof MaintenanceStatus.Type;

/** How long a gate stays closed without a renewal. The desktop renews every 10 s. */
export const MAINTENANCE_LEASE_MS = 30_000;
export const MAINTENANCE_RENEW_INTERVAL_MS = 10_000;

/** Files under the state directory (`<starkHome>/userdata`). */
export const MAINTENANCE_LOCK_FILE = "maintenance-owner.sqlite";
export const MAINTENANCE_INTENT_FILE = "maintenance.json";
export const RECOVERY_HOLD_FILE = "recovery-hold.json";
export const RESTORE_REQUEST_FILE = "restore-request.json";
export const ATTACHMENT_HOLDS_FILE = "attachment-holds.json";
export const LAST_RUNNING_VERSION_FILE = "last-running-version.json";
/** Directory under the Stark home that holds backups, displaced sets and the restore journal. */
export const STATE_BACKUPS_DIRECTORY = "backups";
export const RESTORE_JOURNAL_FILE = "restore-journal.json";
/** Renderer drafts and stash a restore brought back; the desktop app hands them to the windows. */
export const RESTORED_DRAFTS_FILE = "restored-drafts.json";
export const RESTORED_STASH_FILE = "restored-stash.json";
/** An update that failed on this data; a restore leaves it in place. */
export const FAILED_UPDATE_FILE = "failed-update.json";

/**
 * Written by the process that takes the maintenance lock exclusively. Openers
 * resolve the intent of an owner that died before they open the database.
 */
export const MaintenanceIntentPhase = Schema.Literals([
  /** Backends are being stopped. Nothing changed yet. */
  "preparing",
  /** A backup is being written. Nothing in the state directory changed yet. */
  "backup",
  /** The backup is verified and the install is being handed to the updater. */
  "handoff",
  /** A restore is in progress; `restore-journal.json` says how far it got. */
  "restoring",
]);
export type MaintenanceIntentPhase = typeof MaintenanceIntentPhase.Type;

export const MaintenanceIntent = Schema.Struct({
  version: Schema.Literal(1),
  requestId: TrimmedNonEmptyString,
  phase: MaintenanceIntentPhase,
  ownerPid: NonNegativeInt,
  fromVersion: Schema.String,
  toVersion: Schema.NullOr(Schema.String),
  backupId: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type MaintenanceIntent = typeof MaintenanceIntent.Type;

/** Formats this build can read back after a restore. */
export const MAINTENANCE_SUPPORTED_FORMATS = {
  settings: 1,
  /** `COMPOSER_DRAFT_STORAGE_VERSION` in `apps/web/src/composerDraftStore.ts`. */
  drafts: 9,
  stash: "prompt-stash:v2",
} as const;

export const StateBackupReason = Schema.Literals(["pre-install", "pre-migrate", "manual"]);
export type StateBackupReason = typeof StateBackupReason.Type;

/** What a backup file is, so a restore knows where it goes. */
export const StateBackupFileRole = Schema.Literals([
  "database",
  "state-file",
  "drafts",
  "stash",
  "attachment",
]);
export type StateBackupFileRole = typeof StateBackupFileRole.Type;

export const StateBackupFile = Schema.Struct({
  /** Path inside the backup directory, with `/` separators. */
  name: TrimmedNonEmptyString,
  role: StateBackupFileRole,
  bytes: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
});
export type StateBackupFile = typeof StateBackupFile.Type;

export const STATE_BACKUP_FORMAT = "stark-state-backup/1";

export const StateBackupManifest = Schema.Struct({
  format: Schema.Literal(STATE_BACKUP_FORMAT),
  id: TrimmedNonEmptyString,
  reason: StateBackupReason,
  createdAt: Schema.String,
  app: Schema.Struct({
    version: Schema.String,
    commit: Schema.NullOr(Schema.String),
    arch: Schema.String,
    platform: Schema.String,
  }),
  /** The version being installed, for a `pre-install` backup. */
  targetVersion: Schema.NullOr(Schema.String),
  /** The last version that reached activation on this data, when known. */
  lastRunningVersion: Schema.NullOr(Schema.String),
  schema: Schema.Struct({
    /** Recorded migration history, `[id, name]`, in id order. */
    history: Schema.Array(Schema.Tuple([NonNegativeInt, Schema.String])),
    historyHash: Schema.String,
    recordedMaxId: NonNegativeInt,
    /** The highest migration id the writing binary knows. */
    binaryMaxId: NonNegativeInt,
  }),
  events: Schema.Struct({
    maxSequence: NonNegativeInt,
    /** sha256 over every event's sequence and id, in sequence order. */
    chainHash: Schema.String,
  }),
  sqlite: Schema.Struct({
    version: Schema.String,
    pageSize: NonNegativeInt,
    pageCount: NonNegativeInt,
    integrity: Schema.Literal("ok"),
  }),
  counts: Schema.Struct({
    threads: NonNegativeInt,
    messages: NonNegativeInt,
    projects: NonNegativeInt,
    scheduledTasks: NonNegativeInt,
  }),
  formats: Schema.Struct({
    settings: Schema.NullOr(NonNegativeInt),
    drafts: Schema.NullOr(NonNegativeInt),
    stash: Schema.NullOr(Schema.String),
  }),
  files: Schema.Array(StateBackupFile),
  /** Names of state the backup leaves out on purpose. Never their contents. */
  excluded: Schema.Array(Schema.String),
  baseDir: Schema.String,
  stateDir: Schema.String,
});
export type StateBackupManifest = typeof StateBackupManifest.Type;

/**
 * Outcomes the desktop reports after a refused, failed, or recovered update,
 * each with its own wording (`apps/desktop/src/recovery/DesktopDataRecovery.ts`).
 */
export const MaintenanceOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("refused-before-stop") }),
  Schema.Struct({
    type: Schema.Literal("failed-after-drain"),
    backupId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("migration-failed"), targetVersion: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("migration-failed-after-preview-reconciliation"),
    targetVersion: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("schema-newer"), runningVersion: Schema.String }),
  Schema.Struct({ type: Schema.Literal("schema-divergent"), runningVersion: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("restored"),
    backupAppVersion: Schema.String,
    displacedPath: Schema.String,
  }),
]);
export type MaintenanceOutcome = typeof MaintenanceOutcome.Type;

/** The last version that reached activation on this data; recorded on every good boot. */
export const LastRunningVersion = Schema.Struct({
  version: Schema.String,
  recordedAt: Schema.String,
});
export type LastRunningVersion = typeof LastRunningVersion.Type;

/**
 * Why an update counts as failed on this data: its migration failed, or the
 * data was restored from a backup taken before it was installed.
 */
export const FailedUpdateReason = Schema.Literals(["migration-failed", "restored"]);
export type FailedUpdateReason = typeof FailedUpdateReason.Type;

/**
 * The desktop updater does not offer `failedVersion` on its own again: only a
 * check the user starts does, and a newer version replaces the record.
 */
export const FailedUpdate = Schema.Struct({
  version: Schema.Literal(1),
  failedVersion: TrimmedNonEmptyString,
  reason: FailedUpdateReason,
  /** The version this data ran on before the failed one, when known. */
  fromVersion: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
});
export type FailedUpdate = typeof FailedUpdate.Type;

/**
 * Pending uploads that drafts or a restore still reference. The startup sweep
 * keeps them past their usual 24 hours while the hold is younger than 30 days.
 */
export const AttachmentHolds = Schema.Struct({
  version: Schema.Literal(1),
  heldAt: Schema.String,
  attachmentIds: Schema.Array(Schema.String),
});
export type AttachmentHolds = typeof AttachmentHolds.Type;
