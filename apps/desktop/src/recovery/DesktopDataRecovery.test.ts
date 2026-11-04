import {
  SERVER_EXIT_CODE_BACKUP_FAILED,
  SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS,
  SERVER_EXIT_CODE_MIGRATION_FAILED,
  SERVER_EXIT_CODE_SCHEMA_DIVERGENT,
  SERVER_EXIT_CODE_SCHEMA_NEWER,
  SERVER_EXIT_CODE_STATE_DIR_OWNED,
} from "@starkfuture/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopDataRecovery from "./DesktopDataRecovery.ts";

const target: DesktopDataRecovery.ServerCliTarget = {
  executablePath: "/Applications/Stark Code.app/Contents/MacOS/Stark Code",
  entryPath: "/app.asar/apps/server/dist/bin.mjs",
  cwd: "/app",
  starkHome: "/home/.stark-code",
};

/** A spawner whose one child prints `stdout` and exits with `exitCode`. */
const layerCli = (stdout: string, exitCode: number, spawned: Array<ChildProcess.Command> = []) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawned.push(command);
        const out = Stream.encodeText(Stream.make(stdout));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(321),
          stdout: out,
          stderr: Stream.empty,
          all: out,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

describe("DesktopDataRecovery", () => {
  it("maps each data-protection exit code to its recovery state", () => {
    assert.deepEqual(
      DesktopDataRecovery.recoveryStateForExitCode(SERVER_EXIT_CODE_SCHEMA_NEWER, "0.0.46"),
      {
        type: "schema-newer",
        runningVersion: "0.0.46",
      },
    );
    assert.deepEqual(
      DesktopDataRecovery.recoveryStateForExitCode(SERVER_EXIT_CODE_SCHEMA_DIVERGENT, "0.0.46"),
      { type: "schema-divergent", runningVersion: "0.0.46" },
    );
    assert.deepEqual(
      DesktopDataRecovery.recoveryStateForExitCode(SERVER_EXIT_CODE_BACKUP_FAILED, "0.0.47"),
      { type: "backup-failed", runningVersion: "0.0.47" },
    );
    assert.deepEqual(
      DesktopDataRecovery.recoveryStateForExitCode(SERVER_EXIT_CODE_MIGRATION_FAILED, "0.0.47"),
      { type: "migration-failed", targetVersion: "0.0.47" },
    );
    assert.deepEqual(
      DesktopDataRecovery.recoveryStateForExitCode(
        SERVER_EXIT_CODE_MAINTENANCE_IN_PROGRESS,
        "0.0.47",
      ),
      { type: "maintenance-in-progress" },
    );
    for (const code of [0, 1, SERVER_EXIT_CODE_STATE_DIR_OWNED, 84]) {
      assert.isNull(DesktopDataRecovery.recoveryStateForExitCode(code, "0.0.47"));
    }
  });

  it("words each outcome without claiming what did not happen", () => {
    const message = DesktopDataRecovery.recoveryMessage;
    assert.equal(
      message(
        { type: "refused-before-stop" },
        { reason: "Agents are still working, so the update did not start." },
      ),
      "Agents are still working, so the update did not start. Nothing was stopped.",
    );
    assert.equal(
      message({ type: "failed-after-drain", backupId: "backup-1" }),
      "The update did not install. Your tasks were restarted; a backup from just before is kept.",
    );
    // No backup was taken, so none is promised.
    assert.equal(
      message({ type: "failed-after-drain", backupId: null }),
      "The update did not install. Your tasks were restarted.",
    );
    assert.equal(
      message({ type: "migration-failed", targetVersion: "0.0.47" }),
      "0.0.47 stopped before changing your data.",
    );
    const reconciled = message({
      type: "migration-failed-after-preview-reconciliation",
      targetVersion: "0.0.47",
    });
    assert.include(reconciled, "renumbered the database history a preview build left behind");
    assert.notInclude(reconciled, "before changing your data");
    assert.equal(
      message({ type: "restored", backupAppVersion: "0.0.46", displacedPath: "/b/displaced" }),
      "Restored from the 0.0.46 backup; replaced data is in /b/displaced; background work is paused until you resume.",
    );
    assert.equal(
      message({ type: "schema-newer", runningVersion: "0.0.46" }, { lastRunningVersion: "0.0.47" }),
      "This data was last used by Stark Code 0.0.47, which is newer than 0.0.46. Install 0.0.47 again to open it. Nothing was changed.",
    );
    assert.include(
      message({ type: "schema-newer", runningVersion: "0.0.46" }),
      "a newer version of Stark Code than 0.0.46",
    );
    assert.include(
      message(
        { type: "schema-divergent", runningVersion: "0.0.46" },
        { lastRunningVersion: "0.0.45-preview" },
      ),
      "Install 0.0.45-preview again",
    );
    assert.include(
      message({ type: "backup-failed", runningVersion: "0.0.47" }),
      "0.0.47 could not back up your data",
    );
    const states: ReadonlyArray<DesktopDataRecovery.DataRecoveryState> = [
      { type: "refused-before-stop" },
      { type: "failed-after-drain", backupId: null },
      { type: "migration-failed", targetVersion: "0.0.47" },
      { type: "migration-failed-after-preview-reconciliation", targetVersion: "0.0.47" },
      { type: "schema-newer", runningVersion: "0.0.46" },
      { type: "schema-divergent", runningVersion: "0.0.46" },
      { type: "restored", backupAppVersion: "0.0.46", displacedPath: "/b" },
      { type: "backup-failed", runningVersion: "0.0.47" },
      { type: "maintenance-in-progress" },
    ];
    for (const state of states) {
      assert.notInclude(message(state), "Up to date");
    }
    // Only outcomes that never opened the data for writing say nothing changed.
    for (const state of states.filter(
      (candidate) => candidate.type !== "schema-newer" && candidate.type !== "schema-divergent",
    )) {
      assert.notInclude(message(state), "Nothing was changed");
    }
  });

  it.effect("writes the restore request durably and takes it once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "stark-restore-" });

      assert.isTrue(Option.isNone(yield* DesktopDataRecovery.takeRestoreRequest(stateDir)));

      yield* DesktopDataRecovery.writeRestoreRequest(stateDir, "backup-1");
      const path = DesktopDataRecovery.restoreRequestPath(stateDir);
      assert.isTrue(yield* fileSystem.exists(path));
      // Only the request itself is left: the temporary file was renamed over it.
      assert.deepEqual(yield* fileSystem.readDirectory(stateDir), ["restore-request.json"]);

      const taken = Option.getOrThrow(yield* DesktopDataRecovery.takeRestoreRequest(stateDir));
      assert.equal(taken.version, 1);
      assert.equal(taken.backupId, "backup-1");
      assert.isString(taken.requestedAt);
      assert.isFalse(yield* fileSystem.exists(path));
      assert.isTrue(Option.isNone(yield* DesktopDataRecovery.takeRestoreRequest(stateDir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drops an unreadable restore request instead of blocking every launch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "stark-restore-" });
      const path = DesktopDataRecovery.restoreRequestPath(stateDir);
      yield* fileSystem.writeFileString(path, "{not json");

      assert.isTrue(Option.isNone(yield* DesktopDataRecovery.takeRestoreRequest(stateDir)));
      assert.isFalse(yield* fileSystem.exists(path));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("builds the restore invocation main runs before any backend starts", () => {
    const invocation = DesktopDataRecovery.backupRestoreInvocation(target, {
      backupId: "backup-1",
      appVersion: "0.0.46",
      currentDraftsFile: "/tmp/drafts.json",
      currentStashFile: "/tmp/stash.json",
    });
    assert.equal(invocation.name, "backup restore");
    assert.equal(invocation.command, target.executablePath);
    assert.equal(invocation.cwd, "/app");
    assert.deepEqual(invocation.args, [
      "/app.asar/apps/server/dist/bin.mjs",
      "backup",
      "restore",
      "backup-1",
      "--app-version",
      "0.0.46",
      "--current-drafts",
      "/tmp/drafts.json",
      "--current-stash",
      "/tmp/stash.json",
      "--json",
    ]);
    assert.deepEqual(invocation.env, {
      ELECTRON_RUN_AS_NODE: "1",
      STARK_CODE_HOME: "/home/.stark-code",
    });
    assert.deepEqual(
      DesktopDataRecovery.backupRestoreInvocation(target, {
        backupId: "backup-1",
        appVersion: "0.0.46",
        dryRun: true,
      }).args.slice(1),
      ["backup", "restore", "backup-1", "--dry-run", "--app-version", "0.0.46", "--json"],
    );
  });

  it.effect("reads the restore result from the last JSON line", () =>
    Effect.gen(function* () {
      const spawned: Array<ChildProcess.Command> = [];
      const result = yield* DesktopDataRecovery.runBackupRestore(target, {
        backupId: "backup-1",
        appVersion: "0.0.46",
      }).pipe(
        Effect.provide(
          layerCli(
            [
              "restoring...",
              '{"ok":true,"dryRun":false,"backupId":"backup-1","backupAppVersion":"0.0.45","restorable":true,"incompatibility":null,"displacedPath":"/home/.stark-code/backups/backup-1-displaced-1"}',
              "",
            ].join("\n"),
            0,
            spawned,
          ),
        ),
      );

      assert.deepEqual(result, {
        dryRun: false,
        backupId: "backup-1",
        backupAppVersion: "0.0.45",
        restorable: true,
        incompatibility: null,
        displacedPath: "/home/.stark-code/backups/backup-1-displaced-1",
      });
      const [command] = spawned;
      assert.isDefined(command);
      if (command?._tag !== "StandardCommand") return;
      assert.equal(command.options.extendEnv, true);
      assert.deepEqual(command.options.env, {
        ELECTRON_RUN_AS_NODE: "1",
        STARK_CODE_HOME: "/home/.stark-code",
      });
    }),
  );

  it.effect("fails with the CLI's error tag, never its free text", () =>
    Effect.gen(function* () {
      const error = yield* DesktopDataRecovery.runBackupRestore(target, {
        backupId: "backup-1",
        appVersion: "0.0.46",
      }).pipe(
        Effect.provide(
          layerCli(
            '{"ok":false,"error":"StateRestoreIncompatibleError","message":"secret detail"}\n',
            1,
          ),
        ),
        Effect.flip,
      );

      assert.equal(error._tag, "BackupRestoreError");
      if (error._tag !== "BackupRestoreError") return;
      assert.equal(error.errorTag, "StateRestoreIncompatibleError");
      assert.equal(error.exitCode, 1);
      assert.notInclude(error.message, "secret detail");
    }),
  );
});
