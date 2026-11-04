// @effect-diagnostics nodeBuiltinImport:off - Test fixtures write a disposable Stark home on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@starkfuture/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";

export interface TestHome {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly attachmentsDir: string;
  readonly backupsDir: string;
}

/** A disposable Stark home, removed when the scope closes. */
export const makeTestHome = Effect.acquireRelease(
  Effect.sync((): TestHome => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-state-"));
    const stateDir = NodePath.join(baseDir, "userdata");
    NodeFS.mkdirSync(NodePath.join(stateDir, "attachments"), { recursive: true });
    return {
      baseDir,
      stateDir,
      dbPath: NodePath.join(stateDir, "statev2.sqlite"),
      attachmentsDir: NodePath.join(stateDir, "attachments"),
      backupsDir: NodePath.join(baseDir, "backups"),
    };
  }),
  (home) => Effect.sync(() => NodeFS.rmSync(home.baseDir, { recursive: true, force: true })),
);

/** Migrates the home's database through `throughId` (all migrations by default). */
export const migrateHome = (home: TestHome, throughId?: number) =>
  runMigrations(throughId === undefined ? {} : { toMigrationInclusive: throughId }).pipe(
    Effect.asVoid,
    Effect.provide(NodeSqliteClient.layer({ filename: home.dbPath })),
  );

/** Runs `run` on a raw handle in WAL mode, the way the server opens the database. */
export const withDatabase = <A>(
  home: TestHome,
  run: (database: NodeSqlite.DatabaseSync) => A,
): A => {
  const database = new NodeSqlite.DatabaseSync(home.dbPath);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    return run(database);
  } finally {
    database.close();
  }
};

/** Adds a few V2 events and auth and scheduling rows the manifest describes. */
export const seedRows = (home: TestHome, prefix: string, count: number) =>
  withDatabase(home, (database) => {
    const insertEvent = database.prepare(
      "INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json) VALUES (?, 'thread-1', 'probe', '2026-10-30T00:00:00.000Z', '{}')",
    );
    for (let index = 0; index < count; index++) insertEvent.run(`${prefix}-${index}`);
  });

export const eventIds = (path: string): ReadonlyArray<string> => {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT event_id FROM orchestration_v2_events ORDER BY sequence")
      .all()
      .map((row) => String(row.event_id));
  } finally {
    database.close();
  }
};

export const migrationIds = (path: string): ReadonlyArray<number> => {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id")
      .all()
      .map((row) => Number(row.migration_id));
  } finally {
    database.close();
  }
};

export const readBytes = (path: string) =>
  NodeFS.existsSync(path) ? NodeFS.readFileSync(path) : null;

export const writeStateFile = (home: TestHome, name: string, contents: string) =>
  NodeFS.writeFileSync(NodePath.join(home.stateDir, name), contents);

export const readStateFile = (home: TestHome, name: string) =>
  NodeFS.readFileSync(NodePath.join(home.stateDir, name), "utf8");

/** ServerConfig for the home, as a packaged build sees it (no dev URL). */
export const homeConfigLayer = (home: TestHome) =>
  ServerConfig.layerTest(home.baseDir, home.baseDir).pipe(Layer.provide(NodeServices.layer));
