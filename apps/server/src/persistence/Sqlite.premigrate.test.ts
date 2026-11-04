// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  FAILED_UPDATE_FILE,
  LAST_RUNNING_VERSION_FILE,
  SERVER_EXIT_CODE_BACKUP_FAILED,
  SERVER_EXIT_CODE_MIGRATION_FAILED,
} from "@starkfuture/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as AppBuild from "../appBuild.ts";
import {
  homeConfigLayer,
  makeTestHome,
  migrateHome,
  migrationIds,
  seedRows,
  type TestHome,
  withDatabase,
  writeStateFile,
} from "../testUtils/stateFixtures.ts";
import { binaryMaxMigrationId } from "./StateCompatibility.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import * as StateAccess from "./StateAccess.ts";
import * as StateBackup from "./StateBackup.ts";
import * as StateFiles from "./StateFiles.ts";

const previousId = binaryMaxMigrationId - 1;

/** Opens the home the way every opener does, and reads the migration count through it. */
const openHome = (home: TestHome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly id: number }>`
      SELECT max(migration_id) AS id FROM effect_sql_migrations
    `;
    return rows[0]?.id;
  }).pipe(
    Effect.provide(
      SqlitePersistence.layerConfig.pipe(
        Layer.provide(homeConfigLayer(home)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

const seedSchedule = (home: TestHome, prompt: string) =>
  withDatabase(home, (database) => {
    database
      .prepare(
        `INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
          workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by,
          creation_source, created_at, updated_at, next_run_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', ?, 1, '{"type":"interval","everyMinutes":60}', 'project-1',
          '{"type":"local"}', '{}', 'approval-required', 'default', 'user', 'web',
          '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z', '2026-10-30T01:00:00.000Z', 'never', 0)
        ON CONFLICT(task_id) DO UPDATE SET prompt = excluded.prompt`,
      )
      .run(prompt);
    database
      .prepare(
        `INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'phone', '[]', 'pairing', '2026-10-30T00:00:00.000Z', '2027-10-30T00:00:00.000Z')
        ON CONFLICT(session_id) DO NOTHING`,
      )
      .run();
  });

const backupDatabaseValue = (backupPath: string, query: string) => {
  const database = new NodeSqlite.DatabaseSync(
    NodePath.join(backupPath, StateBackup.DATABASE_FILE),
    { readOnly: true },
  );
  try {
    return database.prepare(query).get();
  } finally {
    database.close();
  }
};

/** Makes the last migration pending again, as on an upgrade to a build that adds it. */
const forgetLastMigration = (home: TestHome) =>
  withDatabase(home, (database) => {
    // Recreate the actual pre-064 schema, not just a missing ledger entry:
    // replaying ALTER TABLE against its already-migrated schema must fail.
    assert.strictEqual(
      binaryMaxMigrationId,
      64,
      "Update this fixture when the last migration changes",
    );
    database.exec("ALTER TABLE orchestration_v2_projection_threads DROP COLUMN permission_source");
    database.exec("DROP TABLE permission_migration_audit");
    database
      .prepare("DELETE FROM effect_sql_migrations WHERE migration_id = ?")
      .run(binaryMaxMigrationId);
  });

const exitCodeOf = (error: unknown) =>
  typeof error === "object" && error !== null && Runtime.errorExitCode in error
    ? (error as { readonly [Runtime.errorExitCode]: number })[Runtime.errorExitCode]
    : undefined;

describe("pre-migration backups", () => {
  it.effect("backs up a database with a pending migration, then migrates it", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home, previousId);
      seedRows(home, "before-upgrade", 4);

      assert.strictEqual(yield* openHome(home), binaryMaxMigrationId);
      const backups = yield* StateBackup.list(home.baseDir);
      assert.lengthOf(backups, 1);
      const manifest = backups[0]!.manifest;
      assert.strictEqual(manifest.reason, "pre-migrate");
      assert.strictEqual(manifest.schema.recordedMaxId, previousId);
      assert.strictEqual(manifest.events.maxSequence, 4);
      // A development build has no commit to record.
      assert.isNull(manifest.app.commit);
    }).pipe(Effect.scoped),
  );

  it.effect("records the packaged build's version and commit in its pre-migrate backup", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home, previousId);
      // The asar root of a packaged app: the package.json the release build stages.
      NodeFS.writeFileSync(
        NodePath.join(home.baseDir, "package.json"),
        JSON.stringify({
          name: "starkcode",
          version: "0.0.46-alpha.2",
          starkcodeCommitHash: "b46209a1a7b46209a1a7b46209a1a7b46209a1a7",
        }),
      );
      yield* openHome(home).pipe(Effect.provideService(AppBuild.AppBundleRoot, home.baseDir));
      const [backup] = yield* StateBackup.list(home.baseDir);
      assert.deepInclude(backup!.manifest.app, {
        version: "0.0.46-alpha.2",
        commit: "b46209a1a7b46209a1a7b46209a1a7b46209a1a7",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("takes no backup when nothing is pending", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      assert.strictEqual(yield* openHome(home), binaryMaxMigrationId);
      assert.lengthOf(yield* StateBackup.list(home.baseDir), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("covers settings, auth and schedule changes made without an event, every upgrade", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home, previousId);
      seedSchedule(home, "first prompt");
      writeStateFile(home, "settings.json", '{"generation":1}');
      yield* openHome(home);

      // Changes that touch no orchestration event: a settings write, a
      // session revocation (AuthSessions.ts) and a schedule edit.
      writeStateFile(home, "settings.json", '{"generation":2}');
      withDatabase(home, (database) => {
        database
          .prepare(
            "UPDATE auth_sessions SET revoked_at = '2026-10-30T02:00:00.000Z' WHERE session_id = 'session-1'",
          )
          .run();
      });
      seedSchedule(home, "edited prompt");
      forgetLastMigration(home);
      yield* TestClock.adjust("1 hour");
      yield* openHome(home);

      const backups = yield* StateBackup.list(home.baseDir);
      assert.lengthOf(backups, 2);
      const [second, first] = backups;
      assert.notStrictEqual(second!.id, first!.id);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(first!.path, "state", "settings.json"), "utf8"),
        '{"generation":1}',
      );
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(second!.path, "state", "settings.json"), "utf8"),
        '{"generation":2}',
      );
      assert.deepStrictEqual(
        backupDatabaseValue(first!.path, "SELECT revoked_at FROM auth_sessions"),
        { revoked_at: null },
      );
      assert.deepStrictEqual(
        backupDatabaseValue(second!.path, "SELECT revoked_at FROM auth_sessions"),
        { revoked_at: "2026-10-30T02:00:00.000Z" },
      );
      assert.deepStrictEqual(
        backupDatabaseValue(second!.path, "SELECT prompt FROM scheduled_tasks"),
        {
          prompt: "edited prompt",
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not migrate when the backup fails", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home, previousId);
      const error = yield* Effect.flip(
        openHome(home).pipe(
          Effect.provideService(StateFiles.StateFileOps, {
            ...StateFiles.nodeStateFileOperations,
            availableBytes: () => 0,
          }),
        ),
      );
      assert.strictEqual(error._tag, "StatePreMigrationBackupError");
      assert.strictEqual(exitCodeOf(error), SERVER_EXIT_CODE_BACKUP_FAILED);
      assert.strictEqual(Math.max(...migrationIds(home.dbPath)), previousId);
      assert.lengthOf(yield* StateBackup.list(home.baseDir), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the history and the backup when a migration fails", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home, previousId);
      // The pending permission migration adds this column; a conflicting
      // column makes its DDL fail inside the migration transaction.
      withDatabase(home, (database) =>
        database.exec(
          "ALTER TABLE orchestration_v2_projection_threads ADD COLUMN permission_source TEXT",
        ),
      );
      const error = yield* Effect.flip(openHome(home));
      assert.strictEqual(error._tag, "StateMigrationFailedError");
      assert.strictEqual(exitCodeOf(error), SERVER_EXIT_CODE_MIGRATION_FAILED);
      assert.isFalse(
        error._tag === "StateMigrationFailedError" && error.previewReconciliationCommitted,
      );
      assert.strictEqual(Math.max(...migrationIds(home.dbPath)), previousId);
      assert.lengthOf(yield* StateBackup.list(home.baseDir), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("records the version whose migration failed, so it is not offered again", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home, previousId);
      writeStateFile(
        home,
        LAST_RUNNING_VERSION_FILE,
        JSON.stringify({ version: "0.0.46-alpha.1", recordedAt: "2026-10-31T00:00:00.000Z" }),
      );
      withDatabase(home, (database) =>
        database.exec(
          "ALTER TABLE orchestration_v2_projection_threads ADD COLUMN permission_source TEXT",
        ),
      );
      const asVersion = Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { STARK_CODE_APP_VERSION: "0.0.46-alpha.2" } }),
        ),
      );
      const error = yield* Effect.flip(openHome(home).pipe(asVersion));
      assert.strictEqual(error._tag, "StateMigrationFailedError");
      assert.deepInclude(
        JSON.parse(NodeFS.readFileSync(NodePath.join(home.stateDir, FAILED_UPDATE_FILE), "utf8")),
        {
          failedVersion: "0.0.46-alpha.2",
          reason: "migration-failed",
          fromVersion: "0.0.46-alpha.1",
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails one migration step once after a fresh backup under the rehearsal fault", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      seedRows(home, "before-fault", 3);
      const withFault = Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { STARK_CODE_REHEARSAL_FAULT: SqlitePersistence.REHEARSAL_MIGRATION_FAULT },
          }),
        ),
      );

      const error = yield* Effect.flip(openHome(home).pipe(withFault));
      assert.strictEqual(error._tag, "StateMigrationFailedError");
      assert.strictEqual(exitCodeOf(error), SERVER_EXIT_CODE_MIGRATION_FAILED);
      // Nothing changed: the history is complete and a pre-migrate backup exists.
      assert.isFalse(
        error._tag === "StateMigrationFailedError" && error.previewReconciliationCommitted,
      );
      assert.strictEqual(Math.max(...migrationIds(home.dbPath)), binaryMaxMigrationId);
      const backups = yield* StateBackup.list(home.baseDir);
      assert.lengthOf(backups, 1);
      assert.strictEqual(backups[0]!.manifest.reason, "pre-migrate");
      assert.strictEqual(backups[0]!.manifest.events.maxSequence, 3);

      // Once per data directory: the next open starts normally.
      assert.strictEqual(yield* openHome(home).pipe(withFault), binaryMaxMigrationId);
      assert.lengthOf(yield* StateBackup.list(home.baseDir), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to migrate while another process has the data open", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home, previousId);
      yield* StateAccess.acquireMaintenanceLock(home.stateDir, "shared");
      const error = yield* Effect.flip(openHome(home));
      assert.strictEqual(error._tag, "StateMaintenanceInProgressError");
      assert.strictEqual(
        error._tag === "StateMaintenanceInProgressError" && error.holder,
        "in-use",
      );
      assert.strictEqual(Math.max(...migrationIds(home.dbPath)), previousId);
      assert.lengthOf(yield* StateBackup.list(home.baseDir), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to migrate under a running server", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home, previousId);
      const owner = new NodeSqlite.DatabaseSync(
        NodePath.join(home.stateDir, "server-owner.sqlite"),
      );
      owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
      try {
        const error = yield* Effect.flip(openHome(home));
        assert.strictEqual(
          error._tag === "StateMaintenanceInProgressError" && error.holder,
          "server",
        );
        assert.strictEqual(Math.max(...migrationIds(home.dbPath)), previousId);
      } finally {
        owner.close();
      }
    }).pipe(Effect.scoped),
  );
});
