// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

/**
 * `vp test` runs on the host Node, whose SQLite differs from the one the
 * packaged app ships (Electron's Node). This file runs the operations backup,
 * restore and the maintenance lock depend on inside the bundled Electron, as
 * Node (`ELECTRON_RUN_AS_NODE`), and checks their results here.
 */
const electronPath = (() => {
  try {
    const require = NodeModule.createRequire(
      NodePath.resolve(import.meta.dirname, "../../../desktop/package.json"),
    );
    const resolved: unknown = require("electron");
    return typeof resolved === "string" && NodeFS.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
})();

const probe = String.raw`
const { DatabaseSync, backup } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[1];
const dbPath = path.join(dir, "statev2.sqlite");
const writer = new DatabaseSync(dbPath);
writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE events (id TEXT)");
const insert = writer.prepare("INSERT INTO events VALUES (?)");
for (let i = 0; i < 5; i++) insert.run("committed-" + i);
const open = new DatabaseSync(dbPath);
open.exec("BEGIN IMMEDIATE");
open.prepare("INSERT INTO events VALUES ('uncommitted')").run();
const mainBefore = fs.readFileSync(dbPath);
const walBefore = fs.statSync(dbPath + "-wal").size;

const vacuumPath = path.join(dir, "vacuum.sqlite");
const reader = new DatabaseSync(dbPath, { readOnly: true });
reader.prepare("VACUUM INTO ?").run(vacuumPath);
reader.close();
const copy = new DatabaseSync(vacuumPath, { readOnly: true });
const vacuumRows = copy.prepare("SELECT id FROM events ORDER BY rowid").all().map((row) => row.id);
const integrity = copy.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
const journalMode = copy.prepare("PRAGMA journal_mode").get().journal_mode;
copy.close();

const lockPath = path.join(dir, "maintenance-owner.sqlite");
const shared = new DatabaseSync(lockPath);
shared.exec("PRAGMA busy_timeout = 0; BEGIN");
shared.prepare("SELECT count(*) FROM sqlite_master").get();
const exclusive = new DatabaseSync(lockPath);
exclusive.exec("PRAGMA busy_timeout = 0");
let exclusiveRefused = false;
try { exclusive.exec("BEGIN EXCLUSIVE"); } catch (error) { exclusiveRefused = error.errcode === 5; }
shared.exec("COMMIT");
exclusive.exec("BEGIN EXCLUSIVE");
let sharedRefused = false;
try {
  shared.exec("BEGIN");
  shared.prepare("SELECT count(*) FROM sqlite_master").get();
} catch (error) { sharedRefused = error.errcode === 5; }

(async () => {
  const backupPath = path.join(dir, "backup.sqlite");
  const source = new DatabaseSync(dbPath, { readOnly: true });
  await backup(source, backupPath);
  source.close();
  const restored = new DatabaseSync(backupPath, { readOnly: true });
  const backupRows = restored.prepare("SELECT count(*) AS count FROM events").get().count;
  restored.close();
  open.exec("ROLLBACK");
  process.stdout.write(JSON.stringify({
    node: process.version,
    sqlite: process.versions.sqlite,
    vacuumRows,
    integrity,
    journalMode,
    mainUnchanged: Buffer.compare(mainBefore, fs.readFileSync(dbPath)) === 0,
    walUnchanged: walBefore === fs.statSync(dbPath + "-wal").size,
    exclusiveRefused,
    sharedRefused,
    backupRows,
  }));
})();
`;

describe("state backup on the bundled Electron Node", () => {
  it.skipIf(electronPath === null)(
    "snapshots, checks and locks the way StateBackup and StateAccess rely on (skipped when Electron is not installed)",
    () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-bundled-node-"));
      try {
        const output = NodeChildProcess.execFileSync(electronPath!, ["-e", probe, dir], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          encoding: "utf8",
          timeout: 30_000,
        });
        const result = JSON.parse(output);
        // Record what ran, so a bumped Electron shows up in the test log.
        expect(result.node).toMatch(/^v\d+\./);
        expect(result.sqlite).toMatch(/^3\./);
        expect(result.vacuumRows).toEqual([
          "committed-0",
          "committed-1",
          "committed-2",
          "committed-3",
          "committed-4",
        ]);
        expect(result.integrity).toEqual(["ok"]);
        expect(result.journalMode).not.toBe("wal");
        expect(result.mainUnchanged).toBe(true);
        expect(result.walUnchanged).toBe(true);
        expect(result.exclusiveRefused).toBe(true);
        expect(result.sharedRefused).toBe(true);
        expect(result.backupRows).toBe(5);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
