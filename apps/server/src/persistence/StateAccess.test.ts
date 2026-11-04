// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as MaintenanceIntent from "../maintenance/MaintenanceIntent.ts";
import {
  eventIds,
  homeConfigLayer,
  makeTestHome,
  migrateHome,
  readBytes,
  seedRows,
  type TestHome,
} from "../testUtils/stateFixtures.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import * as StateAccess from "./StateAccess.ts";
import * as StateBackup from "./StateBackup.ts";
import * as StateFiles from "./StateFiles.ts";
import * as StateRestore from "./StateRestore.ts";

const readEvents = (home: TestHome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly event_id: string }>`
      SELECT event_id FROM orchestration_v2_events ORDER BY sequence
    `;
  }).pipe(
    Effect.provide(
      SqlitePersistence.layerConfig.pipe(
        Layer.provide(homeConfigLayer(home)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

/** What `stark-code auth pairing create` and `stark-code pair` do. */
const mintPairingLink = (home: TestHome) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* auth.createPairingLink({ subject: "one-time-token" });
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(homeConfigLayer(home)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

const exitCodeOf = (error: unknown) =>
  typeof error === "object" && error !== null && Runtime.errorExitCode in error
    ? (error as { readonly [Runtime.errorExitCode]: number })[Runtime.errorExitCode]
    : undefined;

const intent = (phase: "preparing" | "backup" | "handoff" | "restoring") => ({
  version: 1 as const,
  requestId: `update-${phase}`,
  phase,
  // A pid that is not this process; the lock, not the pid, proves it is gone.
  ownerPid: 1,
  fromVersion: "0.0.46-alpha.1",
  toVersion: "0.0.46-alpha.2",
  backupId: null,
  updatedAt: "2026-10-30T00:00:00.000Z",
});

describe("StateAccess", () => {
  it.effect("CLI auth and pair write nothing while an update holds the state", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      seedRows(home, "row", 2);
      const before = readBytes(home.dbPath);
      yield* StateAccess.acquireMaintenanceLock(home.stateDir, "exclusive");

      const authError = yield* Effect.flip(mintPairingLink(home));
      assert.strictEqual(authError._tag, "StateMaintenanceInProgressError");
      assert.strictEqual(exitCodeOf(authError), SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS);
      assert.strictEqual(authError.message, "Stark Code is updating; try again in a moment.");
      const openError = yield* Effect.flip(readEvents(home));
      assert.strictEqual(openError._tag, "StateMaintenanceInProgressError");
      assert.deepStrictEqual(readBytes(home.dbPath), before);
      assert.isFalse(NodeFS.existsSync(`${home.dbPath}-wal`));
    }).pipe(Effect.scoped),
  );

  it.effect("a server opening an empty home during an update creates nothing", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* StateAccess.acquireMaintenanceLock(home.stateDir, "exclusive");
      const error = yield* Effect.flip(readEvents(home));
      assert.strictEqual(error._tag, "StateMaintenanceInProgressError");
      assert.isFalse(NodeFS.existsSync(home.dbPath));
    }).pipe(Effect.scoped),
  );

  it.effect("ordinary openers share the state and keep the update out", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      seedRows(home, "row", 1);
      // A server and a CLI process open the same home at once.
      yield* StateAccess.acquireMaintenanceLock(home.stateDir, "shared");
      assert.lengthOf(yield* readEvents(home), 1);
      assert.isString((yield* mintPairingLink(home)).credential);
      const error = yield* Effect.flip(
        Effect.scoped(StateAccess.acquireMaintenanceLock(home.stateDir, "exclusive")),
      );
      assert.strictEqual(
        error._tag === "StateMaintenanceInProgressError" && error.holder,
        "in-use",
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each(["preparing", "backup", "handoff"] as const)(
    "an owner that died while %s leaves the original state usable",
    (phase) =>
      Effect.gen(function* () {
        const home = yield* makeTestHome;
        yield* migrateHome(home);
        seedRows(home, "row", 3);
        yield* MaintenanceIntent.write(home.stateDir, intent(phase));
        // A backup the owner never finished publishing.
        NodeFS.mkdirSync(NodePath.join(home.backupsDir, "unfinished.staging"), { recursive: true });
        const before = readBytes(home.dbPath);

        assert.lengthOf(yield* readEvents(home), 3);
        assert.isFalse(NodeFS.existsSync(MaintenanceIntent.intentPath(home.stateDir)));
        assert.isFalse(NodeFS.existsSync(NodePath.join(home.backupsDir, "unfinished.staging")));
        assert.isNotNull(before);
      }).pipe(Effect.scoped),
  );

  it.effect("an owner that died mid-restore is finished or undone before the next open", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      seedRows(home, "backed-up", 2);
      const backup = yield* StateBackup.create({
        baseDir: home.baseDir,
        stateDir: home.stateDir,
        dbPath: home.dbPath,
        reason: "manual",
        appVersion: "0.0.46-alpha.1",
      });
      seedRows(home, "newer", 2);
      yield* MaintenanceIntent.write(home.stateDir, intent("restoring"));
      // Dies after moving the live files aside, before publishing.
      let renames = 0;
      yield* Effect.flip(
        StateRestore.restore({
          baseDir: home.baseDir,
          stateDir: home.stateDir,
          attachmentsDir: home.attachmentsDir,
          backupId: backup.id,
          runningVersion: "0.0.46-alpha.2",
        }).pipe(
          Effect.provideService(StateFiles.StateFileOps, {
            ...StateFiles.nodeStateFileOperations,
            rename: (from, to) => {
              if (renames++ === 3) throw new Error("crash");
              StateFiles.nodeStateFileOperations.rename(from, to);
            },
          }),
        ),
      );
      assert.isTrue(NodeFS.existsSync(StateRestore.journalPath(home.baseDir)));

      const events = (yield* readEvents(home)).map((row) => row.event_id);
      assert.isTrue(
        events.join() === "backed-up-0,backed-up-1" ||
          events.join() === "backed-up-0,backed-up-1,newer-0,newer-1",
      );
      assert.isFalse(NodeFS.existsSync(StateRestore.journalPath(home.baseDir)));
      assert.isFalse(NodeFS.existsSync(MaintenanceIntent.intentPath(home.stateDir)));
      assert.deepStrictEqual(eventIds(home.dbPath), events);
    }).pipe(Effect.scoped),
  );
});
