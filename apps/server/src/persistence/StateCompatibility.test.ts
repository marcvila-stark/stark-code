// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  SERVER_EXIT_CODE_SCHEMA_DIVERGENT,
  SERVER_EXIT_CODE_SCHEMA_NEWER,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import {
  homeConfigLayer,
  makeTestHome,
  migrateHome,
  migrationIds,
  readBytes,
  type TestHome,
  withDatabase,
} from "../testUtils/stateFixtures.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import * as StateBackup from "./StateBackup.ts";
import {
  binaryMaxMigrationId,
  binaryMigrationHistory,
  classifyHistory,
  inspect,
  isRestorableUnderBinary,
} from "./StateCompatibility.ts";

const newerId = binaryMaxMigrationId + 1;

const openWith = <E>(home: TestHome, config: Layer.Layer<ServerConfig.ServerConfig, E>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
  }).pipe(
    Effect.provide(
      SqlitePersistence.layerConfig.pipe(Layer.provide(config), Layer.provide(NodeServices.layer)),
    ),
  );

/** A WAL database left by a newer build: its last commits are still in `-wal`. */
const leaveNewerDatabase = (home: TestHome) => {
  const database = new NodeSqlite.DatabaseSync(home.dbPath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  database
    .prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, 'FromANewerBuild')")
    .run(newerId);
  return database;
};

const exitCodeOf = (error: unknown) =>
  typeof error === "object" && error !== null && Runtime.errorExitCode in error
    ? (error as { readonly [Runtime.errorExitCode]: number })[Runtime.errorExitCode]
    : undefined;

describe("StateCompatibility", () => {
  it("classifies by migration names and history, not the highest id", () => {
    assert.strictEqual(classifyHistory(null)._tag, "Fresh");
    assert.strictEqual(classifyHistory(binaryMigrationHistory)._tag, "Current");
    const pending = classifyHistory(binaryMigrationHistory.slice(0, -1));
    assert.strictEqual(pending._tag, "Pending");
    assert.deepStrictEqual(pending._tag === "Pending" && pending.pending, [
      binaryMigrationHistory.at(-1)!,
    ]);
    assert.strictEqual(
      classifyHistory([...binaryMigrationHistory, [newerId, "FromANewerBuild"]])._tag,
      "Newer",
    );
    // Same highest id, another name: written by a different build.
    const renamed = binaryMigrationHistory.map(([id, name]) =>
      id === binaryMaxMigrationId ? ([id, "SomethingElse"] as const) : ([id, name] as const),
    );
    assert.strictEqual(classifyHistory(renamed)._tag, "Divergent");
    // A V2 id missing below the recorded maximum would be skipped by the migrator.
    const gap = binaryMigrationHistory.filter(([id]) => id !== 56);
    assert.strictEqual(classifyHistory(gap)._tag, "Divergent");
    // Pre-V2 site-local names keep working, as the migrator allows.
    const siteLocal = binaryMigrationHistory.map(([id, name]) =>
      id === 30 ? ([id, "SiteLocal"] as const) : ([id, name] as const),
    );
    assert.strictEqual(classifyHistory(siteLocal)._tag, "Current");
    const preview = classifyHistory([
      ...binaryMigrationHistory.filter(([id]) => id <= 52),
      [53, "OrchestrationV2"],
    ]);
    assert.isTrue(preview._tag === "Pending" && preview.previewReconciliation);
  });

  it("restores only histories this build can migrate forward", () => {
    assert.isTrue(isRestorableUnderBinary(binaryMigrationHistory.slice(0, -2)));
    assert.isTrue(isRestorableUnderBinary(binaryMigrationHistory));
    assert.isFalse(
      isRestorableUnderBinary([...binaryMigrationHistory, [newerId, "FromANewerBuild"]]),
    );
  });

  it.effect("inspects a newer database without changing a byte of it or its WAL", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      const writer = leaveNewerDatabase(home);
      try {
        const main = readBytes(home.dbPath);
        const wal = readBytes(`${home.dbPath}-wal`);
        assert.isAbove(wal?.length ?? 0, 0);
        const result = yield* inspect(home.dbPath);
        assert.strictEqual(result._tag, "Newer");
        assert.deepStrictEqual(readBytes(home.dbPath), main);
        assert.deepStrictEqual(readBytes(`${home.dbPath}-wal`), wal);
      } finally {
        writer.close();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a packaged build refuses a newer database before opening it writable", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      leaveNewerDatabase(home).close();
      const before = readBytes(home.dbPath);

      const error = yield* Effect.flip(openWith(home, homeConfigLayer(home)));
      assert.strictEqual(error._tag, "StateSchemaNewerError");
      assert.strictEqual(exitCodeOf(error), SERVER_EXIT_CODE_SCHEMA_NEWER);
      assert.deepStrictEqual(readBytes(home.dbPath), before);
      assert.strictEqual(Math.max(...migrationIds(home.dbPath)), newerId);
      assert.lengthOf(yield* StateBackup.list(home.baseDir), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("a packaged build refuses a divergent history; a dev build keeps starting", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      withDatabase(home, (database) =>
        database
          .prepare("UPDATE effect_sql_migrations SET name = 'SomethingElse' WHERE migration_id = ?")
          .run(binaryMaxMigrationId),
      );
      const before = readBytes(home.dbPath);
      const error = yield* Effect.flip(openWith(home, homeConfigLayer(home)));
      assert.strictEqual(error._tag, "StateSchemaDivergentError");
      assert.strictEqual(exitCodeOf(error), SERVER_EXIT_CODE_SCHEMA_DIVERGENT);
      assert.deepStrictEqual(readBytes(home.dbPath), before);

      // Development keeps today's behaviour for a newer database: a warning.
      withDatabase(home, (database) => {
        database
          .prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?")
          .run(binaryMigrationHistory.at(-1)![1], binaryMaxMigrationId);
        database
          .prepare(
            "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, 'FromANewerBuild')",
          )
          .run(newerId);
      });
      const devConfig = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return {
            ...config,
            devUrl: new URL("http://127.0.0.1:5173"),
            dbPath: NodePath.join(home.stateDir, "statev2.sqlite"),
          };
        }),
      ).pipe(Layer.provide(homeConfigLayer(home)));
      yield* openWith(home, devConfig);
    }).pipe(Effect.scoped),
  );
});
