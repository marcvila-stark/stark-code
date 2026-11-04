// @effect-diagnostics nodeBuiltinImport:off - Durable writes need fsync and rename semantics the Effect FileSystem does not expose.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type MaintenanceOutcome,
  RESTORE_REQUEST_FILE,
  SERVER_EXIT_CODE_BACKUP_FAILED,
  SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS,
  SERVER_EXIT_CODE_MIGRATION_FAILED,
  SERVER_EXIT_CODE_SCHEMA_DIVERGENT,
  SERVER_EXIT_CODE_SCHEMA_NEWER,
  TrimmedNonEmptyString,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Desktop side of data recovery: what a backend's data-protection exit code
 * means, how each outcome is worded, the restore request a relaunch picks up,
 * and the bundled-CLI invocations (`stark-code backup ...`) main runs while no
 * backend is up. See `docs/internals/server-updates.md`.
 */

// ---------------------------------------------------------------------------
// Recovery states and wording
// ---------------------------------------------------------------------------

/**
 * What the recovery UI explains: an update outcome, or why a backend refused
 * to open the data at startup.
 */
export type DataRecoveryState =
  | MaintenanceOutcome
  /** The backup before a migration failed, so the migration did not run. */
  | { readonly type: "backup-failed"; readonly runningVersion: string }
  /** Another process (an update, backup or restore) holds the data. */
  | { readonly type: "maintenance-in-progress" };

/**
 * Maps a backend exit code in `SERVER_TERMINAL_EXIT_CODES` to its recovery
 * state. Null for any other code, including 78 (state directory owned by
 * another server), which has its own dialog.
 */
export const recoveryStateForExitCode = (
  exitCode: number,
  runningVersion: string,
): DataRecoveryState | null => {
  switch (exitCode) {
    case SERVER_EXIT_CODE_SCHEMA_NEWER:
      return { type: "schema-newer", runningVersion };
    case SERVER_EXIT_CODE_SCHEMA_DIVERGENT:
      return { type: "schema-divergent", runningVersion };
    case SERVER_EXIT_CODE_BACKUP_FAILED:
      return { type: "backup-failed", runningVersion };
    case SERVER_EXIT_CODE_MIGRATION_FAILED:
      return { type: "migration-failed", targetVersion: runningVersion };
    case SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS:
      return { type: "maintenance-in-progress" };
    default:
      return null;
  }
};

export interface RecoveryWordingContext {
  /** The first sentence for a refused or failed update (why it stopped), when known. */
  readonly reason?: string;
  /** The last version that reached activation on this data (`last-running-version.json`). */
  readonly lastRunningVersion?: string | null;
}

/**
 * The sentence the user reads for an outcome. Says only what is true: "Nothing
 * was stopped" only before anything stopped, a kept backup only when one
 * exists, and "Nothing was changed" only where the data was not opened for
 * writing. Never "Up to date".
 */
export const recoveryMessage = (
  state: DataRecoveryState,
  context: RecoveryWordingContext = {},
): string => {
  const newer =
    context.lastRunningVersion === undefined || context.lastRunningVersion === null
      ? null
      : context.lastRunningVersion;
  switch (state.type) {
    case "refused-before-stop":
      return `${context.reason ?? "The update did not start."} Nothing was stopped.`;
    case "failed-after-drain":
      return state.backupId === null
        ? `${context.reason ?? "The update did not install."} Your tasks were restarted.`
        : `${context.reason ?? "The update did not install."} Your tasks were restarted; a backup from just before is kept.`;
    case "migration-failed":
      return `${state.targetVersion} stopped before changing your data.`;
    case "migration-failed-after-preview-reconciliation":
      return `${state.targetVersion} stopped while updating your data. One step had already finished: it renumbered the database history a preview build left behind. Nothing after that step changed.`;
    case "schema-newer":
      return newer === null
        ? `This data was last used by a newer version of Stark Code than ${state.runningVersion}. Install that version again to open it. Nothing was changed.`
        : `This data was last used by Stark Code ${newer}, which is newer than ${state.runningVersion}. Install ${newer} again to open it. Nothing was changed.`;
    case "schema-divergent":
      return newer === null
        ? `This data was changed by a different build of Stark Code, which ${state.runningVersion} cannot read. Install the version that last used it to open it. Nothing was changed.`
        : `This data was changed by Stark Code ${newer}, a different build that ${state.runningVersion} cannot read. Install ${newer} again to open it. Nothing was changed.`;
    case "restored":
      return `Restored from the ${state.backupAppVersion} backup; replaced data is in ${state.displacedPath}; background work is paused until you resume.`;
    case "backup-failed":
      return `${state.runningVersion} could not back up your data before updating it, so it did not update it. Check that the disk has free space, then open Stark Code again.`;
    case "maintenance-in-progress":
      return "Another Stark Code process is updating, backing up or restoring this data. Try again in a moment.";
  }
};

// ---------------------------------------------------------------------------
// Durable files
// ---------------------------------------------------------------------------

const FILE_MODE = 0o600;

const fsyncPath = (path: string) => {
  const fd = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * Replaces `path` so a crash leaves either the old or the new file: write a
 * temporary sibling, fsync it, rename it over, fsync the directory. Throws.
 */
export const writeFileDurably = (path: string, contents: string) => {
  const directory = NodePath.dirname(path);
  NodeFS.mkdirSync(directory, { recursive: true });
  const temporary = NodePath.join(
    directory,
    `.${NodePath.basename(path)}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`,
  );
  NodeFS.writeFileSync(temporary, contents, { mode: FILE_MODE, flag: "wx" });
  try {
    fsyncPath(temporary);
    NodeFS.renameSync(temporary, path);
  } catch (cause) {
    NodeFS.rmSync(temporary, { force: true });
    throw cause;
  }
  fsyncPath(directory);
};

/** Removes `path` if it exists and fsyncs its directory. Throws. */
export const removeFileDurably = (path: string) => {
  if (!NodeFS.existsSync(path)) return;
  NodeFS.rmSync(path, { force: true });
  fsyncPath(NodePath.dirname(path));
};

const readTextIfExists = (path: string): string | null => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
};

// ---------------------------------------------------------------------------
// Restore request
// ---------------------------------------------------------------------------

/** Written when the user chooses a backup; main runs the restore on the next launch. */
export const RestoreRequest = Schema.Struct({
  version: Schema.Literal(1),
  backupId: TrimmedNonEmptyString,
  requestedAt: Schema.String,
});
export type RestoreRequest = typeof RestoreRequest.Type;

const encodeRestoreRequest = Schema.encodeSync(Schema.fromJsonString(RestoreRequest));
const decodeRestoreRequest = Schema.decodeUnknownOption(Schema.fromJsonString(RestoreRequest));

export class RestoreRequestError extends Schema.TaggedError<RestoreRequestError>()(
  "RestoreRequestError",
  {
    operation: Schema.Literals(["write", "read", "remove"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the restore request at ${this.path}.`;
  }
}

export const restoreRequestPath = (stateDir: string) =>
  NodePath.join(stateDir, RESTORE_REQUEST_FILE);

/** Records the user's choice durably; the restore runs before any backend starts on the next launch. */
export const writeRestoreRequest = Effect.fn("desktop.dataRecovery.writeRestoreRequest")(function* (
  stateDir: string,
  backupId: string,
) {
  const path = restoreRequestPath(stateDir);
  const requestedAt = DateTime.formatIso(yield* DateTime.now);
  const contents = `${encodeRestoreRequest({ version: 1, backupId, requestedAt })}\n`;
  yield* Effect.try({
    try: () => writeFileDurably(path, contents),
    catch: (cause) => new RestoreRequestError({ operation: "write", path, cause }),
  });
});

/**
 * Reads and removes the pending restore request, at startup before any
 * backend starts. An unreadable request is removed and counts as none, so a
 * bad file cannot block every launch.
 */
export const takeRestoreRequest = Effect.fn("desktop.dataRecovery.takeRestoreRequest")(function* (
  stateDir: string,
) {
  const path = restoreRequestPath(stateDir);
  const text = yield* Effect.try({
    try: () => readTextIfExists(path),
    catch: (cause) => new RestoreRequestError({ operation: "read", path, cause }),
  });
  if (text === null) return Option.none<RestoreRequest>();
  yield* Effect.try({
    try: () => removeFileDurably(path),
    catch: (cause) => new RestoreRequestError({ operation: "remove", path, cause }),
  });
  return decodeRestoreRequest(text);
});

// ---------------------------------------------------------------------------
// Bundled CLI invocations
// ---------------------------------------------------------------------------

/** How main runs the bundled server entry as a CLI, like the launcher in `DesktopCliShim.ts`. */
export interface ServerCliTarget {
  /** `process.execPath`: Electron, run as Node through `ELECTRON_RUN_AS_NODE`. */
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  /** The Stark home whose data the command works on. */
  readonly starkHome: string;
}

export type ServerCliCommandName = "backup create" | "backup restore";

export interface ServerCliInvocation {
  readonly name: ServerCliCommandName;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Merged over main's environment. */
  readonly env: Readonly<Record<string, string>>;
}

export const serverCliInvocation = (
  target: ServerCliTarget,
  name: ServerCliCommandName,
  args: ReadonlyArray<string>,
): ServerCliInvocation => ({
  name,
  command: target.executablePath,
  args: [target.entryPath, ...args],
  cwd: target.cwd,
  env: { ELECTRON_RUN_AS_NODE: "1", STARK_CODE_HOME: target.starkHome },
});

/**
 * `backup restore <id> --json`. It takes the maintenance lock itself, so main
 * runs it before any backend starts and without holding the lock.
 */
export const backupRestoreInvocation = (
  target: ServerCliTarget,
  input: {
    readonly backupId: string;
    /** The running app version; the restore refuses a backup it cannot read. */
    readonly appVersion: string;
    readonly dryRun?: boolean;
    /** The windows' current drafts and stash, moved aside with the replaced data. */
    readonly currentDraftsFile?: string;
    readonly currentStashFile?: string;
  },
): ServerCliInvocation =>
  serverCliInvocation(target, "backup restore", [
    "backup",
    "restore",
    input.backupId,
    ...(input.dryRun === true ? ["--dry-run"] : []),
    "--app-version",
    input.appVersion,
    ...(input.currentDraftsFile === undefined ? [] : ["--current-drafts", input.currentDraftsFile]),
    ...(input.currentStashFile === undefined ? [] : ["--current-stash", input.currentStashFile]),
    "--json",
  ]);

export class ServerCliRunError extends Schema.TaggedError<ServerCliRunError>()(
  "ServerCliRunError",
  {
    command: Schema.Literals(["backup create", "backup restore"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not run the bundled \`stark-code ${this.command}\`.`;
  }
}

/** The `{ ok: false, ... }` line every `--json` command prints on failure. */
export const ServerCliFailureLine = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
  message: Schema.String,
});

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * Runs a `--json` CLI command to completion and returns its exit code and its
 * last stdout line that parses as JSON. Stderr goes to main's own stderr.
 */
export const runServerCliJson = Effect.fn("desktop.dataRecovery.runServerCliJson")(function* (
  invocation: ServerCliInvocation,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(invocation.command, [...invocation.args], {
          cwd: invocation.cwd,
          env: { ...invocation.env },
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
        }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), json: lastJsonLine(stdout) };
    }),
  ).pipe(Effect.mapError((cause) => new ServerCliRunError({ command: invocation.name, cause })));
});

/** The last stdout line that parses as JSON; log lines around it are skipped. */
const lastJsonLine = (stdout: string): Option.Option<unknown> => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  for (const line of lines.toReversed()) {
    const json = decodeJsonLine(line);
    if (Option.isSome(json)) return json;
  }
  return Option.none();
};

const BackupRestoreLine = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    dryRun: Schema.Boolean,
    backupId: Schema.String,
    backupAppVersion: Schema.String,
    restorable: Schema.Boolean,
    incompatibility: Schema.NullOr(Schema.String),
    displacedPath: Schema.NullOr(Schema.String),
  }),
  ServerCliFailureLine,
]);
const decodeBackupRestoreLine = Schema.decodeUnknownOption(BackupRestoreLine);

export interface BackupRestoreResult {
  readonly dryRun: boolean;
  readonly backupId: string;
  readonly backupAppVersion: string;
  readonly restorable: boolean;
  /** Why this version cannot restore the backup (dry run only). */
  readonly incompatibility: string | null;
  /** Where the replaced files went; null for a dry run. */
  readonly displacedPath: string | null;
}

export class BackupRestoreError extends Schema.TaggedError<BackupRestoreError>()(
  "BackupRestoreError",
  {
    backupId: Schema.String,
    /** The CLI's error tag; null when it printed no result. */
    errorTag: Schema.NullOr(Schema.String),
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return "The backup could not be restored.";
  }
}

/** Runs `backup restore` and returns its result; the recovery state to show is `restored`. */
export const runBackupRestore = Effect.fn("desktop.dataRecovery.runBackupRestore")(function* (
  target: ServerCliTarget,
  input: Parameters<typeof backupRestoreInvocation>[1],
) {
  const { exitCode, json } = yield* runServerCliJson(backupRestoreInvocation(target, input));
  const line = Option.flatMap(json, decodeBackupRestoreLine);
  if (Option.isSome(line) && line.value.ok && exitCode === 0) {
    const { ok: _ok, ...result } = line.value;
    return result satisfies BackupRestoreResult;
  }
  return yield* new BackupRestoreError({
    backupId: input.backupId,
    errorTag: Option.isSome(line) && !line.value.ok ? boundedErrorTag(line.value.error) : null,
    exitCode,
  });
});

/** A CLI error tag, kept only when it looks like one; never free text. */
export const boundedErrorTag = (tag: string): string | null =>
  /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(tag) ? tag : null;
