import {
  SERVER_EXIT_CODE_BACKUP_FAILED,
  SERVER_EXIT_CODE_MIGRATION_FAILED,
  SERVER_EXIT_CODE_SCHEMA_DIVERGENT,
  SERVER_EXIT_CODE_SCHEMA_NEWER,
} from "@starkfuture/contracts";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@starkfuture/shared/nodeSqliteClient";

import * as AppBuild from "../appBuild.ts";
import * as FailedUpdate from "../maintenance/FailedUpdate.ts";
import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";
import * as StateAccess from "./StateAccess.ts";
import * as StateBackup from "./StateBackup.ts";
import * as StateCompatibility from "./StateCompatibility.ts";
import * as StateFiles from "./StateFiles.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

export class StateSchemaNewerError extends Schema.TaggedError<StateSchemaNewerError>()(
  "StateSchemaNewerError",
  { dbPath: Schema.String, unknownMigrations: Schema.Array(Schema.String) },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_SCHEMA_NEWER;

  override get message(): string {
    return "This data was last used by a newer version of Stark Code. Install that version again, or restore a backup this version made. Nothing was changed.";
  }
}

export class StateSchemaDivergentError extends Schema.TaggedError<StateSchemaDivergentError>()(
  "StateSchemaDivergentError",
  { dbPath: Schema.String, conflicts: Schema.Array(Schema.String) },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_SCHEMA_DIVERGENT;

  override get message(): string {
    return "This data was written by a different build of Stark Code. Start the build that wrote it, or restore a backup this version made. Nothing was changed.";
  }
}

export class StatePreMigrationBackupError extends Schema.TaggedError<StatePreMigrationBackupError>()(
  "StatePreMigrationBackupError",
  { dbPath: Schema.String, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_BACKUP_FAILED;

  override get message(): string {
    return "Stark Code could not back up your data before updating its database, so the database was not updated. Nothing was changed.";
  }
}

export class StateMigrationFailedError extends Schema.TaggedError<StateMigrationFailedError>()(
  "StateMigrationFailedError",
  {
    dbPath: Schema.String,
    /** The V2 preview reconciliation commits on its own, before the migrations. */
    previewReconciliationCommitted: Schema.Boolean,
    backupId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_MIGRATION_FAILED;

  override get message(): string {
    return this.previewReconciliationCommitted
      ? "Updating the database failed after the preview history was renumbered; the migrations themselves were rolled back. A backup from just before is kept."
      : "Updating the database failed and was rolled back; your data is as it was. A backup from just before is kept.";
  }
}

interface MigrationGuard {
  readonly dbPath: string;
  readonly historyHash: string;
  readonly backupId: string;
  /** Ends the exclusive window: downgrades the maintenance lock, releases the server exclusion. */
  readonly release: Effect.Effect<void>;
  /** Fails the migration step once, for the update rehearsal (see `REHEARSAL_MIGRATION_FAULT`). */
  readonly injectFault: ReturnType<typeof runMigrations> | null;
  /** Records this version as a failed update, so the updater stops offering it. */
  readonly recordFailure: Effect.Effect<void>;
}

/**
 * Update rehearsals only: a mock rehearsal build bakes this fault and the
 * desktop app passes it as `STARK_CODE_REHEARSAL_FAULT`. The next database
 * open then takes its fresh pre-migrate backup and fails one migration step
 * inside its transaction, as a broken migration would, and exits with
 * `SERVER_EXIT_CODE_MIGRATION_FAILED`. A marker in the state directory makes
 * it fire once per data directory.
 */
export const REHEARSAL_MIGRATION_FAULT = "migration-fail";
const REHEARSAL_MIGRATION_FAULT_MARKER = "rehearsal-migration-fault.json";

export class RehearsalMigrationFault extends Schema.TaggedError<RehearsalMigrationFault>()(
  "RehearsalMigrationFault",
  {},
) {
  override get message(): string {
    return "Rehearsal fault: this migration step failed on purpose.";
  }
}

const rehearsalFault = Config.String("STARK_CODE_REHEARSAL_FAULT").pipe(Config.withDefault(""));

const readHistoryHash = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return StateCompatibility.historyHash(rows.map((row) => [row.migration_id, row.name] as const));
});

const configureConnection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
  yield* sql`PRAGMA busy_timeout = 5000;`;
  yield* sql`PRAGMA foreign_keys = ON;`;
  yield* sql`PRAGMA journal_mode = WAL;`;
  // FULL fsyncs the WAL on every commit, on the main thread. Every provider
  // event is its own commit, so a slow or busy disk stalls the event loop
  // and clients drop. In WAL mode NORMAL only fsyncs at checkpoints. It
  // cannot corrupt the database and an app crash loses nothing; an OS crash
  // or power loss can roll back commits since the last checkpoint.
  yield* sql`PRAGMA synchronous = NORMAL;`;
  // Checkpoints are now the only sync, and macOS fsync() does not flush the
  // drive cache. F_FULLFSYNC makes them reach disk; other platforms ignore it.
  // Per-commit fullfsync stays off.
  yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
  // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
  // largest size until the last connection closes.
  yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
});

// Without sqlite_stat1 the planner guesses at index selectivity. 0x10012
// analyzes tables whose indexes lack stats or whose row count changed 10x,
// under a temporary analysis_limit. Otherwise it only checks table sizes.
const optimize = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA optimize = 0x10012;`;
});

const layerSetup = Layer.effectDiscard(
  configureConnection.pipe(Effect.andThen(runMigrations()), Effect.andThen(optimize)),
);

/** Migrates inside the exclusive window a pending migration opened, then ends it. */
const makeGuardedLayerSetup = (guard: MigrationGuard) =>
  Layer.effectDiscard(
    configureConnection.pipe(
      Effect.andThen(
        (guard.injectFault ?? runMigrations()).pipe(
          // The migrator turns a failing migration into a defect, so the
          // whole cause is mapped, interruption aside.
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              readHistoryHash.pipe(
                Effect.orElseSucceed(() => guard.historyHash),
                Effect.tap(() => guard.recordFailure),
                Effect.flatMap((after) =>
                  Effect.fail(
                    new StateMigrationFailedError({
                      dbPath: guard.dbPath,
                      previewReconciliationCommitted: after !== guard.historyHash,
                      backupId: guard.backupId,
                      cause: Cause.squash(cause),
                    }),
                  ),
                ),
              ),
          ),
          Effect.ensuring(guard.release),
        ),
      ),
      Effect.andThen(optimize),
    ),
  );

const layerFromPathWith = <E>(dbPath: string, setup: Layer.Layer<never, E, SqlClient.SqlClient>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

      return Layer.provideMerge(
        setup,
        NodeSqliteClient.layer({
          filename: dbPath,
          readerWorker: true,
          spanAttributes: {
            "db.name": path.basename(dbPath),
            "service.name": "starkcode-server",
          },
        }),
      );
    }).pipe(Effect.withSpan("makeSqlitePersistenceLive")),
  );

export const layerFromPath = (dbPath: string) => layerFromPathWith(dbPath, layerSetup);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

/**
 * Opens the configured state database for this process. Every opener (the
 * server and CLI `auth`, `pair` and `project`) comes through here, so every
 * opener holds the maintenance lock shared and is refused during an update.
 *
 * Before the writable open, a read-only inspection compares the recorded
 * migration history with this build's by name. A packaged build refuses a
 * newer or divergent history without touching it. A pending migration first
 * takes a fresh, verified backup with every other writer excluded, and the
 * exclusion lasts until the migrations commit or roll back.
 */
export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const { dbPath } = config;
    const stateDir = path.dirname(dbPath);
    const lock = yield* StateAccess.open({ stateDir, baseDir: config.baseDir });
    const openWith = (
      setup: Layer.Layer<
        never,
        Layer.Error<typeof layerSetup> | StateMigrationFailedError,
        SqlClient.SqlClient
      >,
    ) => layerFromPathWith(dbPath, setup);
    yield* initializeV2Database(dbPath);
    const inspected = yield* StateCompatibility.inspect(dbPath);
    const faultMarker = path.join(stateDir, REHEARSAL_MIGRATION_FAULT_MARKER);
    const injectFault =
      (yield* rehearsalFault).trim() === REHEARSAL_MIGRATION_FAULT &&
      inspected._tag === "Current" &&
      !StateFiles.exists(faultMarker);
    // The rehearsal's fault turns a current database into one with a pending
    // step, so it goes through the same backup and exclusion as a real one.
    const compatibility: StateCompatibility.StateCompatibility = injectFault
      ? { ...inspected, _tag: "Pending", pending: [], previewReconciliation: false }
      : inspected;
    // Development builds keep starting on a newer or forked history, with the
    // migrator's warning, so switching branches keeps working.
    const packaged = config.devUrl === undefined;
    switch (compatibility._tag) {
      case "Fresh":
      case "Current":
        return openWith(layerSetup);
      case "Newer":
        if (packaged) {
          return yield* new StateSchemaNewerError({
            dbPath,
            unknownMigrations: compatibility.unknown.map(([id, name]) => `${id}_${name}`),
          });
        }
        yield* Effect.logWarning("The database was migrated by a newer build").pipe(
          Effect.annotateLogs({
            unknown: compatibility.unknown.map(([id, name]) => `${id}_${name}`),
          }),
        );
        return openWith(layerSetup);
      case "Divergent":
        if (packaged) {
          return yield* new StateSchemaDivergentError({
            dbPath,
            conflicts: compatibility.conflicts,
          });
        }
        return openWith(layerSetup);
      case "Pending": {
        const exclusion = yield* Scope.make();
        const release = Scope.close(exclusion, Exit.void).pipe(
          Effect.andThen(lock.downgrade),
          Effect.ignore({ log: true }),
        );
        const build = yield* AppBuild.current;
        const backup = yield* Effect.gen(function* () {
          yield* lock.upgrade;
          yield* StateAccess.excludeServer(stateDir).pipe(Scope.provide(exclusion));
          return yield* StateBackup.create({
            baseDir: config.baseDir,
            stateDir,
            dbPath,
            reason: "pre-migrate",
            appVersion: build.version,
            appCommit: build.commit,
          }).pipe(Effect.mapError((cause) => new StatePreMigrationBackupError({ dbPath, cause })));
        }).pipe(Effect.onError(() => release));
        yield* Effect.logInfo("Backed up the state before migrating it", {
          backupId: backup.id,
          pending: compatibility.pending.map(([id, name]) => `${id}_${name}`),
        });
        // Also on any failure before the migrations run.
        yield* Effect.addFinalizer(() => release);
        return openWith(
          makeGuardedLayerSetup({
            dbPath,
            historyHash: compatibility.historyHash,
            backupId: backup.id,
            release,
            recordFailure: FailedUpdate.record(stateDir, {
              failedVersion: build.version,
              reason: "migration-failed",
              fromVersion: backup.manifest.lastRunningVersion,
            }),
            injectFault: injectFault
              ? Effect.gen(function* () {
                  const ops = yield* StateFiles.StateFileOps;
                  yield* Effect.sync(() =>
                    StateFiles.writeFileDurably(
                      ops,
                      faultMarker,
                      `${REHEARSAL_MIGRATION_FAULT} after backup ${backup.id}\n`,
                    ),
                  );
                  const client = yield* SqlClient.SqlClient;
                  return yield* client.withTransaction(Effect.die(new RehearsalMigrationFault()));
                })
              : null,
          }),
        );
      }
    }
  }),
);
