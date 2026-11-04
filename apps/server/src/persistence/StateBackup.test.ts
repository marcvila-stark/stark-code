// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  eventIds,
  makeTestHome,
  migrateHome,
  readBytes,
  seedRows,
  type TestHome,
  writeStateFile,
} from "../testUtils/stateFixtures.ts";
import * as StateBackup from "./StateBackup.ts";
import * as StateFiles from "./StateFiles.ts";

const backupInput = (home: TestHome) => ({
  baseDir: home.baseDir,
  stateDir: home.stateDir,
  dbPath: home.dbPath,
  reason: "manual" as const,
  appVersion: "0.0.46-alpha.1",
});

const withOps = (overrides: Partial<StateFiles.StateFileOperations>) =>
  Effect.provideService(StateFiles.StateFileOps, {
    ...StateFiles.nodeStateFileOperations,
    ...overrides,
  });

// A read-only open may leave an empty -wal behind; an empty WAL holds nothing.
const liveSnapshot = (home: TestHome) => ({
  main: readBytes(home.dbPath),
  wal: readBytes(`${home.dbPath}-wal`) ?? Buffer.alloc(0),
});

const publishedBackups = (home: TestHome) =>
  StateFiles.listDirectory(home.backupsDir).filter((entry) => !entry.startsWith("."));

describe("StateBackup", () => {
  it.effect("copies committed WAL-only rows, leaves out an open transaction, and verifies", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      seedRows(home, "checkpointed", 3);
      // Keep later commits in the WAL only, as a running server would.
      const writer = new NodeSqlite.DatabaseSync(home.dbPath);
      const pending = new NodeSqlite.DatabaseSync(home.dbPath);
      try {
        writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
        const insert = writer.prepare(
          "INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json) VALUES (?, 'thread-1', 'probe', '2026-10-30T00:00:00.000Z', '{}')",
        );
        for (let index = 0; index < 5; index++) insert.run(`wal-only-${index}`);
        pending.exec("BEGIN IMMEDIATE");
        pending
          .prepare(
            "INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json) VALUES ('uncommitted', 'thread-1', 'probe', '2026-10-30T00:00:00.000Z', '{}')",
          )
          .run();
        assert.isAbove(NodeFS.statSync(`${home.dbPath}-wal`).size, 0);

        const result = yield* StateBackup.create(backupInput(home));
        const copied = eventIds(NodePath.join(result.path, StateBackup.DATABASE_FILE));
        assert.deepStrictEqual(copied, [
          "checkpointed-0",
          "checkpointed-1",
          "checkpointed-2",
          ...Array.from({ length: 5 }, (_, index) => `wal-only-${index}`),
        ]);
        assert.isFalse(NodeFS.existsSync(NodePath.join(result.path, "statev2.sqlite-wal")));
        assert.strictEqual(result.manifest.sqlite.integrity, "ok");
        assert.strictEqual(result.manifest.events.maxSequence, 8);
        assert.deepStrictEqual(yield* StateBackup.verify(result.path), result.manifest);
      } finally {
        pending.exec("ROLLBACK");
        pending.close();
        writer.close();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("records schema, files and exclusions, keeps secrets out, and stays private", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      writeStateFile(home, "settings.json", '{"theme":"dark"}');
      writeStateFile(home, "environment-id", "environment-1");
      NodeFS.mkdirSync(NodePath.join(home.stateDir, "secrets"));
      writeStateFile(home, "secrets/server-signing-key.bin", "secret");
      writeStateFile(home, "saved-environments.json", '{"encryptedBearerToken":"x"}');

      const result = yield* StateBackup.create({
        ...backupInput(home),
        targetVersion: "0.0.46-alpha.2",
      });
      const names = result.manifest.files.map((file) => file.name);
      assert.includeMembers(names, [
        "statev2.sqlite",
        "state/settings.json",
        "state/environment-id",
      ]);
      assert.notInclude(names.join(" "), "secret");
      assert.notInclude(names.join(" "), "saved-environments");
      assert.includeMembers([...result.manifest.excluded], ["secrets/", "saved-environments.json"]);
      assert.strictEqual(result.manifest.schema.recordedMaxId, result.manifest.schema.binaryMaxId);
      assert.strictEqual(result.manifest.targetVersion, "0.0.46-alpha.2");
      assert.strictEqual(result.manifest.formats.settings, 1);
      assert.isTrue(result.path.startsWith(home.backupsDir));
      assert.strictEqual(NodeFS.statSync(home.backupsDir).mode & 0o777, 0o700);
      assert.strictEqual(NodeFS.statSync(result.path).mode & 0o777, 0o700);
      for (const file of result.manifest.files) {
        const stat = NodeFS.statSync(NodePath.join(result.path, file.name));
        assert.strictEqual(stat.mode & 0o777, 0o600, file.name);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("takes a fresh backup every time", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      writeStateFile(home, "settings.json", '{"version":"first"}');
      const first = yield* StateBackup.create(backupInput(home));
      writeStateFile(home, "settings.json", '{"version":"second"}');
      const second = yield* StateBackup.create(backupInput(home));
      assert.notStrictEqual(first.id, second.id);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(second.path, "state", "settings.json"), "utf8"),
        '{"version":"second"}',
      );
      assert.lengthOf(yield* StateBackup.list(home.baseDir), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("fails verification on a flipped byte or a truncation", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      seedRows(home, "row", 20);
      const flipped = yield* StateBackup.create(backupInput(home));
      const flippedPath = NodePath.join(flipped.path, StateBackup.DATABASE_FILE);
      const bytes = NodeFS.readFileSync(flippedPath);
      bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 0xff;
      NodeFS.writeFileSync(flippedPath, bytes);
      const flippedError = yield* Effect.flip(StateBackup.verify(flipped.path));
      assert.strictEqual(
        flippedError._tag === "StateBackupVerifyError" && flippedError.reason,
        "hash",
      );

      const truncated = yield* StateBackup.create(backupInput(home));
      const truncatedPath = NodePath.join(truncated.path, StateBackup.DATABASE_FILE);
      NodeFS.truncateSync(truncatedPath, NodeFS.statSync(truncatedPath).size - 4096);
      const truncatedError = yield* Effect.flip(StateBackup.verify(truncated.path));
      assert.strictEqual(
        truncatedError._tag === "StateBackupVerifyError" && truncatedError.reason,
        "size",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses before writing when the disk lacks room", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      seedRows(home, "row", 10);
      const before = liveSnapshot(home);
      const error = yield* Effect.flip(
        StateBackup.create(backupInput(home)).pipe(withOps({ availableBytes: () => 1024 })),
      );
      assert.strictEqual(error._tag, "StateBackupSpaceError");
      assert.deepStrictEqual(publishedBackups(home), []);
      assert.deepStrictEqual(liveSnapshot(home), before);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    ["the snapshot fsync", "snapshot", { fsyncFails: "statev2.sqlite" }],
    ["the manifest write", "manifest", { writeFails: "manifest.json" }],
    ["the publishing rename", "publish", { renameFails: true }],
    ["the staging folder (a file is in the way)", "prepare", { stagingBlocked: true }],
  ] as const)("leaves the live state usable when %s fails", ([, stage, fault]) =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      yield* migrateHome(home);
      seedRows(home, "row", 10);
      const before = liveSnapshot(home);
      const ops: Partial<StateFiles.StateFileOperations> = {
        ...("fsyncFails" in fault
          ? {
              fsync: (path: string) => {
                if (path.endsWith(fault.fsyncFails)) throw new Error("EIO: fsync failed");
                StateFiles.nodeStateFileOperations.fsync(path);
              },
            }
          : {}),
        ...("writeFails" in fault
          ? {
              writeFile: (path: string, data: string | Uint8Array, mode: number) => {
                if (path.endsWith(fault.writeFails)) throw new Error("ENOSPC: no space left");
                StateFiles.nodeStateFileOperations.writeFile(path, data, mode);
              },
            }
          : {}),
        ...("renameFails" in fault
          ? {
              rename: () => {
                throw new Error("EXDEV: rename failed");
              },
            }
          : {}),
        ...("stagingBlocked" in fault
          ? {
              mkdir: (directory: string, mode: number) => {
                if (directory.endsWith(".staging")) {
                  NodeFS.writeFileSync(directory, "in the way");
                }
                StateFiles.nodeStateFileOperations.mkdir(directory, mode);
              },
            }
          : {}),
      };
      const error = yield* Effect.flip(StateBackup.create(backupInput(home)).pipe(withOps(ops)));
      assert.strictEqual(error._tag, "StateBackupError");
      assert.strictEqual(error._tag === "StateBackupError" ? error.stage : null, stage);
      assert.deepStrictEqual(
        publishedBackups(home).filter((entry) => !entry.endsWith(".staging")),
        [],
      );
      assert.deepStrictEqual(liveSnapshot(home), before);
      // The live database still opens and reads.
      assert.lengthOf(eventIds(home.dbPath), 10);
    }).pipe(Effect.scoped),
  );
});
