// @effect-diagnostics nodeBuiltinImport:off - The maintenance lock is a native SQLite handle main holds until it exits.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  MAINTENANCE_INTENT_FILE,
  MAINTENANCE_LOCK_FILE,
  MAINTENANCE_RENEW_INTERVAL_MS,
  MAINTENANCE_SUPPORTED_FORMATS,
  type DesktopMaintenanceRequest,
  MaintenanceBlocker,
  MaintenanceIntent,
  type MaintenanceIntentPhase,
  MaintenanceOutcome,
  type MaintenancePrepareMode,
  type MaintenanceStatus,
  StateBackupManifest,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import type { BackendStopOutcome } from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopDataRecovery from "../recovery/DesktopDataRecovery.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

/**
 * The install handoff (PLAN-002 §3.1, §2.4 step 4): after the update is
 * verified and the windows' drafts are preserved, close every backend's
 * maintenance gate, record the intent, stop the backends and prove they
 * exited, take the maintenance lock exclusively, back the data up, write the
 * install record and mark the intent `handoff`. Every side effect goes
 * through `InstallPreflightPorts`.
 *
 * Any failure, defect or interruption before the handle is returned undoes
 * what was done: release the lock, clear the intent, restart the backends,
 * release the gates. There is no "install anyway" path.
 */

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-install-preflight");

// ---------------------------------------------------------------------------
// Port errors
// ---------------------------------------------------------------------------

export class MaintenanceGateUnavailableError extends Schema.TaggedError<MaintenanceGateUnavailableError>()(
  "MaintenanceGateUnavailableError",
  { backendIds: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return "A Stark Code server did not answer the update request.";
  }
}

export class MaintenanceIntentWriteError extends Schema.TaggedError<MaintenanceIntentWriteError>()(
  "MaintenanceIntentWriteError",
  {
    operation: Schema.Literals(["write", "clear"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the maintenance intent at ${this.path}.`;
  }
}

export class MaintenanceLockBusyError extends Schema.TaggedError<MaintenanceLockBusyError>()(
  "MaintenanceLockBusyError",
  { stateDir: Schema.String },
) {
  override get message(): string {
    return "Another Stark Code process is using this data.";
  }
}

export class MaintenanceLockError extends Schema.TaggedError<MaintenanceLockError>()(
  "MaintenanceLockError",
  { stateDir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not lock ${this.stateDir} for the update.`;
  }
}

export class StateBackupSpaceError extends Schema.TaggedError<StateBackupSpaceError>()(
  "StateBackupSpaceError",
  {},
) {
  override get message(): string {
    return "There is not enough free disk space for the backup.";
  }
}

export class StateBackupFailedError extends Schema.TaggedError<StateBackupFailedError>()(
  "StateBackupFailedError",
  {
    /** The backup command's error tag; null when it printed no result. */
    errorTag: Schema.NullOr(Schema.String),
    /** Null when the command could not be run at all. */
    exitCode: Schema.NullOr(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The backup before the update failed.";
  }
}

export class BackendNotExitedError extends Schema.TaggedError<BackendNotExitedError>()(
  "BackendNotExitedError",
  { backendIds: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return "A Stark Code server did not exit when it was stopped.";
  }
}

// ---------------------------------------------------------------------------
// Preflight errors: each carries the outcome to report (§3.3)
// ---------------------------------------------------------------------------

const BackendBlocker = Schema.Struct({ backendId: Schema.String, blocker: MaintenanceBlocker });

/** A backend still has work running; nothing was stopped. */
export class InstallPreflightBusyError extends Schema.TaggedError<InstallPreflightBusyError>()(
  "InstallPreflightBusyError",
  { blockers: Schema.Array(BackendBlocker) },
) {
  get outcome(): MaintenanceOutcome {
    return { type: "refused-before-stop" };
  }

  override get message(): string {
    return "Agents are still working, so the update did not start.";
  }
}

/** Another process (the CLI) holds the data; the backends were restarted. */
export class InstallPreflightDataInUseError extends Schema.TaggedError<InstallPreflightDataInUseError>()(
  "InstallPreflightDataInUseError",
  { cause: Schema.Defect() },
) {
  get outcome(): MaintenanceOutcome {
    return { type: "failed-after-drain", backupId: null };
  }

  override get message(): string {
    return "Another Stark Code process is using your data, so the update did not install.";
  }
}

/** The backup found too little free space; the backends were restarted. */
export class InstallPreflightBackupSpaceError extends Schema.TaggedError<InstallPreflightBackupSpaceError>()(
  "InstallPreflightBackupSpaceError",
  { cause: Schema.Defect() },
) {
  get outcome(): MaintenanceOutcome {
    return { type: "failed-after-drain", backupId: null };
  }

  override get message(): string {
    return "There is not enough free disk space to back up your data, so the update did not install.";
  }
}

export const InstallPreflightStep = Schema.Literals([
  "prepare",
  "intent",
  "stop",
  "lock",
  "backup",
  "install-record",
  "handoff",
]);
export type InstallPreflightStep = typeof InstallPreflightStep.Type;

export class InstallPreflightFailedError extends Schema.TaggedError<InstallPreflightFailedError>()(
  "InstallPreflightFailedError",
  {
    step: InstallPreflightStep,
    outcome: MaintenanceOutcome,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.outcome.type === "refused-before-stop"
      ? "The update could not start."
      : "The update could not finish preparing, so it did not install.";
  }
}

/**
 * Show with `recoveryMessage(error.outcome, { reason: error.message })` from
 * `recovery/DesktopDataRecovery.ts`.
 */
export type InstallPreflightError =
  | InstallPreflightBusyError
  | InstallPreflightDataInUseError
  | InstallPreflightBackupSpaceError
  | InstallPreflightFailedError;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface BackendGateStatus {
  readonly backendId: string;
  readonly status: MaintenanceStatus;
}

/** `status` and `resumeRecovery` serve the recovery notice; the preflight uses the rest. */
export type MaintenanceGateAction = DesktopMaintenanceRequest["action"];

export interface MaintenanceLockHandle {
  /** Ends the exclusive hold. After a handoff main keeps it until it exits. */
  readonly release: Effect.Effect<void>;
}

export interface StateBackupRequest {
  /** The intent's request id, which admits the backup child. */
  readonly requestId: string;
  readonly appVersion: string;
  readonly targetVersion: string;
  /** The windows' drafts and stash as JSON files, from their acknowledgements. */
  readonly draftsFile: string | null;
  readonly stashFile: string | null;
  /** Pending uploads the drafts or stash reference. */
  readonly attachmentIds: ReadonlyArray<string>;
}

export interface StateBackupCreated {
  readonly id: string;
  readonly path: string;
  readonly manifest: StateBackupManifest;
}

export class InstallPreflightPorts extends Context.Service<
  InstallPreflightPorts,
  {
    /** The backends running on this data; each is prepared and stopped. */
    readonly backends: Effect.Effect<ReadonlyArray<string>>;
    /**
     * Sends one gate request to these backends. Every action but `release`
     * returns each backend's status, or fails when one does not answer;
     * `release` does not wait for answers.
     */
    readonly requestGate: (input: {
      readonly backendIds: ReadonlyArray<string>;
      readonly requestId: string;
      readonly action: MaintenanceGateAction;
      readonly mode?: MaintenancePrepareMode;
    }) => Effect.Effect<ReadonlyArray<BackendGateStatus>, MaintenanceGateUnavailableError>;
    /** Replaces `<stateDir>/maintenance.json` durably. */
    readonly writeIntent: (
      intent: MaintenanceIntent,
    ) => Effect.Effect<void, MaintenanceIntentWriteError>;
    readonly clearIntent: Effect.Effect<void, MaintenanceIntentWriteError>;
    /** SIGTERM, 10 s, SIGKILL; says whether the process is gone. */
    readonly stopBackend: (backendId: string) => Effect.Effect<BackendStopOutcome>;
    readonly startBackend: (backendId: string) => Effect.Effect<void>;
    /** `maintenance-owner.sqlite` EXCLUSIVE, `busy_timeout=0`. */
    readonly acquireLock: Effect.Effect<
      MaintenanceLockHandle,
      MaintenanceLockBusyError | MaintenanceLockError
    >;
    /** Runs `backup create --reason pre-install` admitted by the intent. */
    readonly createBackup: (
      request: StateBackupRequest,
    ) => Effect.Effect<StateBackupCreated, StateBackupSpaceError | StateBackupFailedError>;
  }
>()("@starkfuture/desktop/updates/DesktopInstallPreflight/InstallPreflightPorts") {}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface InstallPreflightInput {
  /** Owns the gates, names the intent and admits the backup child. */
  readonly requestId: string;
  /** `probe` refuses at once when anything blocks; `drain` keeps new work out ("Restart when done"). */
  readonly mode: MaintenancePrepareMode;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly draftsFile: string | null;
  readonly stashFile: string | null;
  readonly attachmentIds: ReadonlyArray<string>;
  /**
   * Writes the install record and the location anchor once the backup exists.
   * When a later step fails the caller removes the record, as its install
   * recovery already does.
   */
  readonly writeInstallRecord: (backup: StateBackupCreated) => Effect.Effect<void, Error>;
}

export interface InstallPreflightHandle {
  readonly requestId: string;
  readonly backup: StateBackupCreated;
  /** Held until the app exits: committing the install must not release it. */
  readonly lock: MaintenanceLockHandle;
  /**
   * Undoes the preflight when the handoff fails: releases the lock, clears the
   * intent, restarts the backends and releases their gates. Runs once and
   * returns the outcome to show.
   */
  readonly abort: Effect.Effect<MaintenanceOutcome>;
}

export class DesktopInstallPreflight extends Context.Service<
  DesktopInstallPreflight,
  {
    readonly run: (
      input: InstallPreflightInput,
    ) => Effect.Effect<InstallPreflightHandle, InstallPreflightError>;
  }
>()("@starkfuture/desktop/updates/DesktopInstallPreflight") {}

interface Progress {
  intentWritten: boolean;
  stopStarted: boolean;
  lock: Option.Option<MaintenanceLockHandle>;
  backupId: string | null;
}

const make = Effect.gen(function* () {
  const ports = yield* InstallPreflightPorts;

  const writeIntent = (
    input: InstallPreflightInput,
    phase: MaintenanceIntentPhase,
    backupId: string | null,
  ) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        ports.writeIntent({
          version: 1,
          requestId: input.requestId,
          phase,
          ownerPid: process.pid,
          fromVersion: input.fromVersion,
          toVersion: input.toVersion,
          backupId,
          updatedAt: DateTime.formatIso(now),
        }),
      ),
    );

  // Every step runs and only logs on failure: the next one may still help.
  const undo = (
    input: InstallPreflightInput,
    backendIds: ReadonlyArray<string>,
    progress: Progress,
  ) =>
    Effect.gen(function* () {
      if (Option.isSome(progress.lock)) {
        yield* progress.lock.value.release;
      }
      if (progress.intentWritten) {
        yield* ports.clearIntent.pipe(
          Effect.catchTags({
            MaintenanceIntentWriteError: (error) =>
              logWarning("could not clear the maintenance intent", { path: error.path }),
          }),
        );
      }
      if (progress.stopStarted) {
        yield* Effect.forEach(backendIds, ports.startBackend, {
          concurrency: "unbounded",
          discard: true,
        });
      }
      if (backendIds.length > 0) {
        yield* ports
          .requestGate({ backendIds, requestId: input.requestId, action: "release" })
          .pipe(
            Effect.catchTags({
              MaintenanceGateUnavailableError: (error) =>
                logWarning("could not release a maintenance gate", {
                  backendIds: error.backendIds.join(","),
                }),
            }),
          );
      }
    }).pipe(Effect.uninterruptible);

  const renewForever = (backendIds: ReadonlyArray<string>, requestId: string) =>
    Effect.sleep(Duration.millis(MAINTENANCE_RENEW_INTERVAL_MS)).pipe(
      Effect.andThen(
        ports.requestGate({ backendIds, requestId, action: "renew" }).pipe(
          Effect.catchTags({
            MaintenanceGateUnavailableError: (error) =>
              logWarning("a maintenance gate did not answer a renewal", {
                backendIds: error.backendIds.join(","),
              }),
          }),
        ),
      ),
      Effect.forever,
    );

  const run = Effect.fn("desktop.installPreflight.run")(function* (input: InstallPreflightInput) {
    const backendIds = yield* ports.backends;
    const progress: Progress = {
      intentWritten: false,
      stopStarted: false,
      lock: Option.none(),
      backupId: null,
    };
    const refused: MaintenanceOutcome = { type: "refused-before-stop" };
    const afterDrain = (): MaintenanceOutcome => ({
      type: "failed-after-drain",
      backupId: progress.backupId,
    });

    // 1. Close every gate. Nothing has changed if this refuses.
    const prepared = yield* ports
      .requestGate({ backendIds, requestId: input.requestId, action: "prepare", mode: input.mode })
      .pipe(
        Effect.catchTags({
          MaintenanceGateUnavailableError: (cause) =>
            undo(input, backendIds, progress).pipe(
              Effect.andThen(
                Effect.fail(
                  new InstallPreflightFailedError({ step: "prepare", outcome: refused, cause }),
                ),
              ),
            ),
        }),
      );
    const answered = new Set(prepared.map((entry) => entry.backendId));
    const silent = backendIds.filter((backendId) => !answered.has(backendId));
    if (silent.length > 0) {
      yield* undo(input, backendIds, progress);
      return yield* new InstallPreflightFailedError({
        step: "prepare",
        outcome: refused,
        cause: new MaintenanceGateUnavailableError({ backendIds: silent }),
      });
    }
    if (prepared.some((entry) => !entry.status.ready)) {
      yield* undo(input, backendIds, progress);
      return yield* new InstallPreflightBusyError({
        blockers: prepared.flatMap((entry) =>
          entry.status.blockers.map((blocker) => ({ backendId: entry.backendId, blocker })),
        ),
      });
    }

    // The lease lapses 30 s after the last renewal; keep it until the backends exit.
    const renewal = yield* renewForever(backendIds, input.requestId).pipe(Effect.forkChild);

    const handoff = Effect.gen(function* () {
      // 2. Record the intent before anything stops.
      yield* writeIntent(input, "preparing", null).pipe(
        Effect.mapError(
          (cause) => new InstallPreflightFailedError({ step: "intent", outcome: refused, cause }),
        ),
      );
      progress.intentWritten = true;

      // 3. Stop the backends and prove they exited.
      progress.stopStarted = true;
      const stops = yield* Effect.forEach(
        backendIds,
        (backendId) =>
          ports.stopBackend(backendId).pipe(Effect.map((outcome) => ({ backendId, outcome }))),
        { concurrency: "unbounded" },
      );
      yield* Fiber.interrupt(renewal);
      const running = stops.filter((stop) => !stop.outcome.exited).map((stop) => stop.backendId);
      if (running.length > 0) {
        return yield* new InstallPreflightFailedError({
          step: "stop",
          outcome: afterDrain(),
          cause: new BackendNotExitedError({ backendIds: running }),
        });
      }

      // 4. Exclude every other opener. A busy lock means the CLI holds the data.
      const lock = yield* ports.acquireLock.pipe(
        Effect.catchTags({
          MaintenanceLockBusyError: (cause) =>
            Effect.fail(new InstallPreflightDataInUseError({ cause })),
          MaintenanceLockError: (cause) =>
            Effect.fail(
              new InstallPreflightFailedError({ step: "lock", outcome: afterDrain(), cause }),
            ),
        }),
      );
      progress.lock = Option.some(lock);

      // 5. Back up, admitted by the intent.
      yield* writeIntent(input, "backup", null).pipe(
        Effect.mapError(
          (cause) =>
            new InstallPreflightFailedError({ step: "intent", outcome: afterDrain(), cause }),
        ),
      );
      const backup = yield* ports
        .createBackup({
          requestId: input.requestId,
          appVersion: input.fromVersion,
          targetVersion: input.toVersion,
          draftsFile: input.draftsFile,
          stashFile: input.stashFile,
          attachmentIds: input.attachmentIds,
        })
        .pipe(
          Effect.catchTags({
            StateBackupSpaceError: (cause) =>
              Effect.fail(new InstallPreflightBackupSpaceError({ cause })),
            StateBackupFailedError: (cause) =>
              Effect.fail(
                new InstallPreflightFailedError({ step: "backup", outcome: afterDrain(), cause }),
              ),
          }),
        );
      progress.backupId = backup.id;

      // 6. Install record and anchor, then mark the handoff.
      yield* input.writeInstallRecord(backup).pipe(
        Effect.mapError(
          (cause) =>
            new InstallPreflightFailedError({
              step: "install-record",
              outcome: afterDrain(),
              cause,
            }),
        ),
      );
      yield* writeIntent(input, "handoff", backup.id).pipe(
        Effect.mapError(
          (cause) =>
            new InstallPreflightFailedError({ step: "handoff", outcome: afterDrain(), cause }),
        ),
      );
      return { backup, lock };
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Fiber.interrupt(renewal).pipe(Effect.andThen(undo(input, backendIds, progress))),
      ),
    );
    const { backup, lock } = yield* handoff;

    const aborted = yield* Ref.make(false);
    return {
      requestId: input.requestId,
      backup,
      lock,
      abort: Ref.getAndSet(aborted, true).pipe(
        Effect.flatMap((already) => (already ? Effect.void : undo(input, backendIds, progress))),
        Effect.as<MaintenanceOutcome>({ type: "failed-after-drain", backupId: backup.id }),
        Effect.uninterruptible,
      ),
    } satisfies InstallPreflightHandle;
  });

  return DesktopInstallPreflight.of({ run });
});

export const layer = Layer.effect(DesktopInstallPreflight, make);

// ---------------------------------------------------------------------------
// Live ports
// ---------------------------------------------------------------------------

/** How long a backend gets to answer a gate request over the telemetry channel. */
const GATE_REPLY_TIMEOUT = Duration.seconds(5);

/** `backup create --reason pre-install ... --json`, run while main holds the lock. */
export const backupCreateInvocation = (
  target: DesktopDataRecovery.ServerCliTarget,
  request: StateBackupRequest,
): DesktopDataRecovery.ServerCliInvocation =>
  DesktopDataRecovery.serverCliInvocation(target, "backup create", [
    "backup",
    "create",
    "--reason",
    "pre-install",
    "--intent",
    request.requestId,
    "--app-version",
    request.appVersion,
    "--target-version",
    request.targetVersion,
    ...(request.draftsFile === null
      ? []
      : [
          "--drafts",
          request.draftsFile,
          "--drafts-format",
          `${MAINTENANCE_SUPPORTED_FORMATS.drafts}`,
        ]),
    ...(request.stashFile === null
      ? []
      : ["--stash", request.stashFile, "--stash-format", MAINTENANCE_SUPPORTED_FORMATS.stash]),
    ...request.attachmentIds.flatMap((attachmentId) => ["--attachment", attachmentId]),
    "--json",
  ]);

const BackupCreateLine = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    id: Schema.String,
    path: Schema.String,
    manifest: StateBackupManifest,
  }),
  DesktopDataRecovery.ServerCliFailureLine,
]);
const decodeBackupCreateLine = Schema.decodeUnknownOption(BackupCreateLine);
const encodeIntent = Schema.encodeSync(Schema.fromJsonString(MaintenanceIntent));

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

const makeLivePorts = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The status stream has one consumer; requests that wait for answers take turns.
  const gateMutex = yield* Semaphore.make(1);
  // Keeps held lock handles reachable, so a collected handle never drops the lock.
  const heldLocks = new Set<NodeSqlite.DatabaseSync>();
  const stateDir = environment.stateDir;
  const intentPath = NodePath.join(stateDir, MAINTENANCE_INTENT_FILE);
  const cliTarget: DesktopDataRecovery.ServerCliTarget = {
    executablePath: process.execPath,
    entryPath: environment.backendEntryPath,
    cwd: environment.backendCwd,
    starkHome: environment.baseDir,
  };
  type Ports = InstallPreflightPorts["Service"];

  const backends: Ports["backends"] = pool.list.pipe(
    Effect.flatMap((instances) =>
      Effect.forEach(instances, (instance) =>
        instance.snapshot.pipe(Effect.map((snapshot) => ({ id: instance.id, snapshot }))),
      ),
    ),
    Effect.map((entries) =>
      entries.filter((entry) => entry.snapshot.desiredRunning).map((entry) => `${entry.id}`),
    ),
  );

  const requestGate: Ports["requestGate"] = (input) => {
    if (input.backendIds.length === 0) return Effect.succeed([]);
    const request = {
      version: 1,
      type: "maintenanceRequest",
      requestId: input.requestId,
      action: input.action,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    } as const;
    if (input.action === "release") {
      return publisher.sendMaintenanceRequest(request).pipe(Effect.as([]));
    }
    return gateMutex.withPermits(1)(
      Effect.gen(function* () {
        const wanted = new Set(input.backendIds);
        const statuses = new Map<string, MaintenanceStatus>();
        yield* publisher.sendMaintenanceRequest(request);
        yield* publisher.maintenanceStatuses.pipe(
          Stream.runForEachWhile((received) =>
            Effect.sync(() => {
              if (received.message.replyTo === input.requestId && wanted.has(received.sourceId)) {
                statuses.set(received.sourceId, received.message.status);
              }
              return statuses.size < wanted.size;
            }),
          ),
          Effect.timeoutOption(GATE_REPLY_TIMEOUT),
        );
        const answers = input.backendIds.flatMap((backendId) => {
          const status = statuses.get(backendId);
          return status === undefined ? [] : [{ backendId, status }];
        });
        if (answers.length < input.backendIds.length) {
          return yield* new MaintenanceGateUnavailableError({
            backendIds: input.backendIds.filter((backendId) => !statuses.has(backendId)),
          });
        }
        return answers;
      }),
    );
  };

  const writeIntent: Ports["writeIntent"] = (intent) =>
    Effect.try({
      try: () => DesktopDataRecovery.writeFileDurably(intentPath, `${encodeIntent(intent)}\n`),
      catch: (cause) =>
        new MaintenanceIntentWriteError({ operation: "write", path: intentPath, cause }),
    });

  const clearIntent: Ports["clearIntent"] = Effect.try({
    try: () => DesktopDataRecovery.removeFileDurably(intentPath),
    catch: (cause) =>
      new MaintenanceIntentWriteError({ operation: "clear", path: intentPath, cause }),
  });

  const instance = (backendId: string) => pool.get(DesktopBackendPool.BackendInstanceId(backendId));

  const stopBackend: Ports["stopBackend"] = (backendId) =>
    instance(backendId).pipe(
      Effect.flatMap(
        Option.match({
          // Unregistered meanwhile: its exit cannot be proven from here.
          onNone: () => Effect.succeed<BackendStopOutcome>({ exited: false, forced: false }),
          onSome: (backend) =>
            backend.stopAndAwaitExit?.() ??
            backend.stop().pipe(Effect.as<BackendStopOutcome>({ exited: false, forced: false })),
        }),
      ),
    );

  const startBackend: Ports["startBackend"] = (backendId) =>
    instance(backendId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (backend) => backend.start,
        }),
      ),
    );

  const acquireLock: Ports["acquireLock"] = Effect.try({
    try: () => {
      NodeFS.mkdirSync(stateDir, { recursive: true });
      // Never WAL and never unlinked: the OS drops the lock when main dies.
      const database = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, MAINTENANCE_LOCK_FILE));
      try {
        database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
      } catch (cause) {
        database.close();
        throw cause;
      }
      heldLocks.add(database);
      return database;
    },
    catch: (cause) =>
      isSqliteBusy(cause)
        ? new MaintenanceLockBusyError({ stateDir })
        : new MaintenanceLockError({ stateDir, cause }),
  }).pipe(
    Effect.map((database): MaintenanceLockHandle => ({
      release: Effect.try(() => {
        if (!heldLocks.delete(database)) return;
        try {
          database.exec("ROLLBACK");
        } finally {
          database.close();
        }
      }).pipe(Effect.ignore),
    })),
  );

  const createBackup: Ports["createBackup"] = (request) =>
    DesktopDataRecovery.runServerCliJson(backupCreateInvocation(cliTarget, request)).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catchTags({
        ServerCliRunError: (cause) =>
          Effect.fail(new StateBackupFailedError({ errorTag: null, exitCode: null, cause })),
      }),
      Effect.flatMap(
        ({
          exitCode,
          json,
        }): Effect.Effect<StateBackupCreated, StateBackupSpaceError | StateBackupFailedError> => {
          const line = Option.flatMap(json, decodeBackupCreateLine);
          if (Option.isNone(line)) {
            return Effect.fail(new StateBackupFailedError({ errorTag: null, exitCode }));
          }
          if (!line.value.ok) {
            return line.value.error === "StateBackupSpaceError"
              ? Effect.fail(new StateBackupSpaceError())
              : Effect.fail(
                  new StateBackupFailedError({
                    errorTag: DesktopDataRecovery.boundedErrorTag(line.value.error),
                    exitCode,
                  }),
                );
          }
          if (exitCode !== 0) {
            return Effect.fail(new StateBackupFailedError({ errorTag: null, exitCode }));
          }
          return Effect.succeed<StateBackupCreated>({
            id: line.value.id,
            path: line.value.path,
            manifest: line.value.manifest,
          });
        },
      ),
    );

  return InstallPreflightPorts.of({
    backends,
    requestGate,
    writeIntent,
    clearIntent,
    stopBackend,
    startBackend,
    acquireLock,
    createBackup,
  });
});

/** Ports over the backend pool, the telemetry channel, node:sqlite and the bundled CLI. */
export const layerLivePorts = Layer.effect(InstallPreflightPorts, makeLivePorts);
