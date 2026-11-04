// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { FAILED_UPDATE_FILE, RESTORED_DRAFTS_FILE } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  eventIds,
  makeTestHome,
  migrateHome,
  readBytes,
  readStateFile,
  seedRows,
  type TestHome,
  writeStateFile,
} from "../testUtils/stateFixtures.ts";
import * as StateBackup from "./StateBackup.ts";
import * as StateFiles from "./StateFiles.ts";
import * as StateRestore from "./StateRestore.ts";

const BACKUP_VERSION = "0.0.46-alpha.1";
const RUNNING_VERSION = "0.0.46-alpha.2";

/** A home backed up at "before", then changed after the backup. */
const prepareHome = Effect.gen(function* () {
  const home = yield* makeTestHome;
  yield* migrateHome(home);
  seedRows(home, "before", 3);
  writeStateFile(home, "settings.json", '{"generation":"backup"}');
  writeStateFile(home, "environment-id", "environment-1");
  const draftsPath = NodePath.join(home.baseDir, "drafts-export.json");
  NodeFS.writeFileSync(draftsPath, '{"draft":"from the backup"}');
  const backup = yield* StateBackup.create({
    baseDir: home.baseDir,
    stateDir: home.stateDir,
    dbPath: home.dbPath,
    reason: "pre-install",
    appVersion: BACKUP_VERSION,
    drafts: { path: draftsPath, format: 9 },
  });
  seedRows(home, "after", 2);
  writeStateFile(home, "settings.json", '{"generation":"newer"}');
  writeStateFile(home, "keybindings.json", "[]");
  return { home, backup };
});

const restoreInput = (home: TestHome, backupId: string) => ({
  baseDir: home.baseDir,
  stateDir: home.stateDir,
  attachmentsDir: home.attachmentsDir,
  backupId,
  runningVersion: RUNNING_VERSION,
});

const liveFiles = (home: TestHome) => ({
  database: readBytes(home.dbPath),
  settings: readBytes(NodePath.join(home.stateDir, "settings.json")),
  keybindings: readBytes(NodePath.join(home.stateDir, "keybindings.json")),
  environment: readBytes(NodePath.join(home.stateDir, "environment-id")),
});

const displacedDirs = (home: TestHome) =>
  StateFiles.listDirectory(home.backupsDir).filter((entry) => entry.includes("-displaced-"));

const editManifest = (backupPath: string, edit: (manifest: Record<string, any>) => void) => {
  const path = NodePath.join(backupPath, "manifest.json");
  const manifest = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  edit(manifest);
  NodeFS.writeFileSync(path, JSON.stringify(manifest));
};

const failedUpdate = (home: TestHome) => {
  const path = NodePath.join(home.stateDir, FAILED_UPDATE_FILE);
  return NodeFS.existsSync(path) ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : null;
};

describe("StateRestore", () => {
  it.effect("records the update a restore rolled back from, and only a rollback", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      seedRows(home, "before", 1);
      const backup = yield* StateBackup.create({
        baseDir: home.baseDir,
        stateDir: home.stateDir,
        dbPath: home.dbPath,
        reason: "pre-install",
        appVersion: BACKUP_VERSION,
        targetVersion: RUNNING_VERSION,
      });

      // Restored by the version the update came from: the update is rolled back.
      yield* StateRestore.restore({
        ...restoreInput(home, backup.id),
        runningVersion: BACKUP_VERSION,
      });
      assert.deepInclude(failedUpdate(home), {
        failedVersion: RUNNING_VERSION,
        reason: "restored",
        fromVersion: BACKUP_VERSION,
      });

      // Restored by the update itself: nothing was rolled back.
      NodeFS.rmSync(NodePath.join(home.stateDir, FAILED_UPDATE_FILE));
      yield* StateRestore.restore(restoreInput(home, backup.id));
      assert.isNull(failedUpdate(home));
    }),
  );

  it.effect("restores the complete selected state and keeps everything it replaced", () =>
    Effect.gen(function* () {
      const { home, backup } = yield* prepareHome;
      const before = liveFiles(home);

      const result = yield* StateRestore.restore(restoreInput(home, backup.id));
      assert.strictEqual(result.outcome, "restored");
      assert.deepStrictEqual(eventIds(home.dbPath), ["before-0", "before-1", "before-2"]);
      assert.strictEqual(readStateFile(home, "settings.json"), '{"generation":"backup"}');
      assert.strictEqual(readStateFile(home, "environment-id"), "environment-1");
      // A state file the backup did not have is replaced too: it moves aside.
      assert.isFalse(NodeFS.existsSync(NodePath.join(home.stateDir, "keybindings.json")));
      assert.strictEqual(readStateFile(home, RESTORED_DRAFTS_FILE), '{"draft":"from the backup"}');

      // Both states are kept: the displaced set is byte-identical to what was live.
      const displaced = result.displacedPath;
      assert.deepStrictEqual(
        readBytes(NodePath.join(displaced, "statev2.sqlite")),
        before.database,
      );
      assert.deepStrictEqual(readBytes(NodePath.join(displaced, "settings.json")), before.settings);
      assert.deepStrictEqual(
        readBytes(NodePath.join(displaced, "keybindings.json")),
        before.keybindings,
      );
      assert.deepStrictEqual(eventIds(NodePath.join(displaced, "statev2.sqlite")).length, 5);

      const hold = JSON.parse(readStateFile(home, "recovery-hold.json"));
      assert.strictEqual(hold.backupId, backup.id);
      assert.strictEqual(hold.backupAppVersion, BACKUP_VERSION);
      assert.strictEqual(hold.displacedPath, displaced);
      assert.isFalse(NodeFS.existsSync(StateRestore.journalPath(home.baseDir)));
      // The backup itself is untouched and still verifies.
      yield* StateBackup.verify(backup.path);
      // Displaced sets are not backups, so retention never sees them.
      assert.lengthOf(yield* StateBackup.list(home.baseDir), 1);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    [
      "a newer app version",
      "app-version",
      (manifest: Record<string, any>) => {
        manifest.app.version = "0.0.47";
      },
    ],
    [
      "a history this build does not have",
      "schema",
      (manifest: Record<string, any>) => {
        manifest.schema.history = [...manifest.schema.history, [999, "FromANewerBuild"]];
      },
    ],
    [
      "a newer drafts format",
      "format",
      (manifest: Record<string, any>) => {
        manifest.formats.drafts = 10;
      },
    ],
  ] as const)("refuses %s before changing anything", ([, reason, edit]) =>
    Effect.gen(function* () {
      const { home, backup } = yield* prepareHome;
      editManifest(backup.path, edit);
      const before = liveFiles(home);
      const error = yield* Effect.flip(StateRestore.restore(restoreInput(home, backup.id)));
      assert.strictEqual(error._tag, "StateRestoreIncompatibleError");
      assert.strictEqual(error._tag === "StateRestoreIncompatibleError" && error.reason, reason);
      assert.deepStrictEqual(liveFiles(home), before);
      assert.deepStrictEqual(displacedDirs(home), []);
      assert.isFalse(NodeFS.existsSync(NodePath.join(home.stateDir, "recovery-hold.json")));
    }).pipe(Effect.scoped),
  );

  it.effect("converges after a crash at every rename and journal boundary", () =>
    Effect.gen(function* () {
      // Count the renames a whole restore makes.
      let renames = 0;
      {
        const { home, backup } = yield* prepareHome;
        yield* StateRestore.restore(restoreInput(home, backup.id)).pipe(
          Effect.provideService(StateFiles.StateFileOps, {
            ...StateFiles.nodeStateFileOperations,
            rename: (from, to) => {
              renames += 1;
              StateFiles.nodeStateFileOperations.rename(from, to);
            },
          }),
        );
      }
      assert.isAbove(renames, 5);

      for (let crashAt = 0; crashAt < renames; crashAt++) {
        const { home, backup } = yield* prepareHome;
        const before = liveFiles(home);
        let calls = 0;
        const crashed = yield* Effect.flip(
          StateRestore.restore(restoreInput(home, backup.id)).pipe(
            Effect.provideService(StateFiles.StateFileOps, {
              ...StateFiles.nodeStateFileOperations,
              rename: (from, to) => {
                if (calls++ === crashAt) throw new Error("crash");
                StateFiles.nodeStateFileOperations.rename(from, to);
              },
            }),
          ),
        );
        assert.strictEqual(crashed._tag, "StateRestoreError", `crash at rename ${crashAt}`);

        // The next start settles it, whichever side of the commit point it was.
        const recovered = yield* StateRestore.recoverInterrupted(home.baseDir);
        const outcome = Option.match(recovered, {
          onNone: () => "untouched" as const,
          onSome: (value) => value.outcome,
        });
        assert.isFalse(NodeFS.existsSync(StateRestore.journalPath(home.baseDir)));
        if (outcome === "restored") {
          assert.deepStrictEqual(eventIds(home.dbPath), ["before-0", "before-1", "before-2"]);
          assert.strictEqual(readStateFile(home, "settings.json"), '{"generation":"backup"}');
          const [displaced] = displacedDirs(home);
          assert.deepStrictEqual(
            readBytes(NodePath.join(home.backupsDir, displaced!, "statev2.sqlite")),
            before.database,
            `crash at rename ${crashAt}`,
          );
          assert.isTrue(NodeFS.existsSync(NodePath.join(home.stateDir, "recovery-hold.json")));
        } else {
          assert.deepStrictEqual(liveFiles(home), before, `crash at rename ${crashAt}`);
          assert.isFalse(NodeFS.existsSync(NodePath.join(home.stateDir, "recovery-hold.json")));
        }
        // The live database opens and reads either way.
        assert.isAtLeast(eventIds(home.dbPath).length, 3);
      }
    }).pipe(Effect.scoped),
  );
});
