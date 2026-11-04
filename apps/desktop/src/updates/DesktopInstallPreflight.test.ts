import type {
  MaintenanceIntent,
  MaintenanceStatus,
  StateBackupManifest,
} from "@starkfuture/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { BackendStopOutcome } from "../backend/DesktopBackendManager.ts";
import * as DesktopInstallPreflight from "./DesktopInstallPreflight.ts";

class InstallRecordWriteError extends Schema.TaggedError<InstallRecordWriteError>()(
  "InstallRecordWriteError",
  {},
) {}

const manifest: StateBackupManifest = {
  format: "stark-state-backup/1",
  id: "backup-1",
  reason: "pre-install",
  createdAt: "2026-10-30T00:00:00.000Z",
  app: { version: "0.0.46", commit: null, arch: "arm64", platform: "darwin" },
  targetVersion: "0.0.47",
  lastRunningVersion: "0.0.46",
  schema: { history: [[1, "Init"]], historyHash: "history", recordedMaxId: 1, binaryMaxId: 1 },
  events: { maxSequence: 0, chainHash: "chain" },
  sqlite: { version: "3.53.4", pageSize: 4096, pageCount: 1, integrity: "ok" },
  counts: { threads: 0, messages: 0, projects: 0, scheduledTasks: 0 },
  formats: { settings: 1, drafts: 9, stash: "prompt-stash:v2" },
  files: [],
  excluded: [],
  baseDir: "/home/.stark-code",
  stateDir: "/home/.stark-code/userdata",
};

const backup: DesktopInstallPreflight.StateBackupCreated = {
  id: "backup-1",
  path: "/home/.stark-code/backups/backup-1",
  manifest,
};

const ready = (requestId: string): MaintenanceStatus => ({
  requestId,
  state: "closed",
  ready: true,
  blockers: [],
  leaseExpiresAtUnixMs: 30_000,
  recoveryHold: null,
});

interface FakeOptions {
  readonly backends?: ReadonlyArray<string>;
  readonly status?: (backendId: string, requestId: string) => MaintenanceStatus;
  readonly silent?: ReadonlyArray<string>;
  readonly stop?: (backendId: string) => Effect.Effect<BackendStopOutcome>;
  readonly lock?: "held" | "busy";
  readonly backup?: Effect.Effect<
    DesktopInstallPreflight.StateBackupCreated,
    DesktopInstallPreflight.StateBackupSpaceError | DesktopInstallPreflight.StateBackupFailedError
  >;
}

/** Ports that record every side effect, in order, as a short step name. */
function makeFake(options: FakeOptions = {}) {
  const steps: Array<string> = [];
  const intents: Array<MaintenanceIntent> = [];
  const backupRequests: Array<DesktopInstallPreflight.StateBackupRequest> = [];
  const record = (step: string) => Effect.sync(() => void steps.push(step));
  const ports = DesktopInstallPreflight.InstallPreflightPorts.of({
    backends: Effect.succeed(options.backends ?? ["primary"]),
    requestGate: (input) =>
      Effect.gen(function* () {
        yield* record(input.action === "prepare" ? `prepare:${input.mode}` : input.action);
        if (input.action === "release") return [];
        const silent = input.backendIds.filter((id) => options.silent?.includes(id) === true);
        if (input.action === "prepare" && silent.length > 0) {
          return yield* new DesktopInstallPreflight.MaintenanceGateUnavailableError({
            backendIds: silent,
          });
        }
        return input.backendIds.map((backendId) => ({
          backendId,
          status: options.status?.(backendId, input.requestId) ?? ready(input.requestId),
        }));
      }),
    writeIntent: (intent) =>
      Effect.sync(() => {
        intents.push(intent);
        steps.push(`intent:${intent.phase}`);
      }),
    clearIntent: record("clear-intent"),
    stopBackend: (backendId) =>
      record(`stop:${backendId}`).pipe(
        Effect.andThen(
          options.stop?.(backendId) ?? Effect.succeed({ exited: true, forced: false }),
        ),
      ),
    startBackend: (backendId) => record(`start:${backendId}`),
    acquireLock:
      options.lock === "busy"
        ? record("lock").pipe(
            Effect.andThen(
              Effect.fail(
                new DesktopInstallPreflight.MaintenanceLockBusyError({ stateDir: "/state" }),
              ),
            ),
          )
        : record("lock").pipe(Effect.as({ release: record("unlock") })),
    createBackup: (request) =>
      Effect.sync(() => void backupRequests.push(request)).pipe(
        Effect.andThen(record("backup")),
        Effect.andThen(options.backup ?? Effect.succeed(backup)),
      ),
  });
  const layer = DesktopInstallPreflight.layer.pipe(
    Layer.provide(Layer.succeed(DesktopInstallPreflight.InstallPreflightPorts, ports)),
  );
  const input = (
    overrides: Partial<DesktopInstallPreflight.InstallPreflightInput> = {},
  ): DesktopInstallPreflight.InstallPreflightInput => ({
    requestId: "update-1",
    mode: "probe",
    fromVersion: "0.0.46",
    toVersion: "0.0.47",
    draftsFile: "/tmp/drafts.json",
    stashFile: null,
    attachmentIds: ["attachment-1"],
    writeInstallRecord: (created) => record(`record:${created.id}`),
    ...overrides,
  });
  return { steps, intents, backupRequests, layer, input };
}

const runPreflight = (fake: ReturnType<typeof makeFake>, input = fake.input()) =>
  Effect.gen(function* () {
    const preflight = yield* DesktopInstallPreflight.DesktopInstallPreflight;
    return yield* preflight.run(input);
  }).pipe(Effect.provide(fake.layer));

/** What every failure after the backends stopped must do, in this order. */
const restoredAfterDrain = (options: { readonly locked: boolean }) => [
  ...(options.locked ? ["unlock"] : []),
  "clear-intent",
  "start:primary",
  "release",
];

describe("DesktopInstallPreflight", () => {
  it.effect("prepares, records the intent, stops, locks, backs up, records and hands off", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const handle = yield* runPreflight(fake, fake.input({ mode: "drain" }));

      assert.deepEqual(fake.steps, [
        "prepare:drain",
        "intent:preparing",
        "stop:primary",
        "lock",
        "intent:backup",
        "backup",
        "record:backup-1",
        "intent:handoff",
      ]);
      assert.deepEqual(
        fake.intents.map((intent) => [intent.phase, intent.backupId]),
        [
          ["preparing", null],
          ["backup", null],
          ["handoff", "backup-1"],
        ],
      );
      for (const intent of fake.intents) {
        assert.equal(intent.requestId, "update-1");
        assert.equal(intent.ownerPid, process.pid);
        assert.equal(intent.fromVersion, "0.0.46");
        assert.equal(intent.toVersion, "0.0.47");
      }
      assert.deepEqual(fake.backupRequests, [
        {
          requestId: "update-1",
          appVersion: "0.0.46",
          targetVersion: "0.0.47",
          draftsFile: "/tmp/drafts.json",
          stashFile: null,
          attachmentIds: ["attachment-1"],
        },
      ]);
      assert.equal(handle.backup.id, "backup-1");
      // The lock stays held for the install; nothing was undone.
      assert.notInclude(fake.steps, "unlock");
      assert.notInclude(fake.steps, "release");
    }),
  );

  it.effect("abort after the handoff undoes everything once", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const handle = yield* runPreflight(fake);
      const before = fake.steps.length;

      assert.deepEqual(yield* handle.abort, { type: "failed-after-drain", backupId: "backup-1" });
      assert.deepEqual(fake.steps.slice(before), restoredAfterDrain({ locked: true }));

      yield* handle.abort;
      assert.equal(fake.steps.length, before + restoredAfterDrain({ locked: true }).length);
    }),
  );

  it.effect("refuses before stopping anything when a backend is not ready", () =>
    Effect.gen(function* () {
      const fake = makeFake({
        backends: ["primary", "wsl:default"],
        status: (backendId, requestId) =>
          backendId === "wsl:default"
            ? {
                ...ready(requestId),
                state: "open",
                ready: false,
                blockers: [{ kind: "run", id: "run-1", threadId: "thread-1" }],
              }
            : ready(requestId),
      });
      const error = yield* runPreflight(fake).pipe(Effect.flip);

      assert.equal(error._tag, "InstallPreflightBusyError");
      assert.deepEqual(error.outcome, { type: "refused-before-stop" });
      if (error._tag !== "InstallPreflightBusyError") return;
      assert.deepEqual(error.blockers, [
        {
          backendId: "wsl:default",
          blocker: { kind: "run", id: "run-1", threadId: "thread-1" },
        },
      ]);
      assert.deepEqual(fake.steps, ["prepare:probe", "release"]);
      assert.deepEqual(fake.intents, []);
    }),
  );

  it.effect("refuses before stopping anything when a backend does not answer", () =>
    Effect.gen(function* () {
      const fake = makeFake({ backends: ["primary", "wsl:default"], silent: ["wsl:default"] });
      const error = yield* runPreflight(fake).pipe(Effect.flip);

      assert.equal(error._tag, "InstallPreflightFailedError");
      assert.deepEqual(error.outcome, { type: "refused-before-stop" });
      assert.deepEqual(fake.steps, ["prepare:probe", "release"]);
    }),
  );

  it.effect("continues once a backend that needed SIGKILL has exited", () =>
    Effect.gen(function* () {
      const fake = makeFake({ stop: () => Effect.succeed({ exited: true, forced: true }) });
      const handle = yield* runPreflight(fake);

      assert.equal(handle.backup.id, "backup-1");
      assert.include(fake.steps, "lock");
      assert.notInclude(fake.steps, "start:primary");
    }),
  );

  it.effect("restores the backends when one does not exit even after SIGKILL", () =>
    Effect.gen(function* () {
      const fake = makeFake({ stop: () => Effect.succeed({ exited: false, forced: true }) });
      const error = yield* runPreflight(fake).pipe(Effect.flip);

      assert.equal(error._tag, "InstallPreflightFailedError");
      assert.deepEqual(error.outcome, { type: "failed-after-drain", backupId: null });
      assert.deepEqual(fake.steps, [
        "prepare:probe",
        "intent:preparing",
        "stop:primary",
        ...restoredAfterDrain({ locked: false }),
      ]);
    }),
  );

  it.effect("restores the backends when the CLI holds the data (lock busy)", () =>
    Effect.gen(function* () {
      const fake = makeFake({ lock: "busy" });
      const error = yield* runPreflight(fake).pipe(Effect.flip);

      assert.equal(error._tag, "InstallPreflightDataInUseError");
      assert.deepEqual(error.outcome, { type: "failed-after-drain", backupId: null });
      assert.deepEqual(fake.steps, [
        "prepare:probe",
        "intent:preparing",
        "stop:primary",
        "lock",
        ...restoredAfterDrain({ locked: false }),
      ]);
    }),
  );

  it.effect("restores the backends when the backup fails", () =>
    Effect.gen(function* () {
      const fake = makeFake({
        backup: Effect.fail(
          new DesktopInstallPreflight.StateBackupFailedError({
            errorTag: "StateBackupIntegrityError",
            exitCode: 1,
          }),
        ),
      });
      const error = yield* runPreflight(fake).pipe(Effect.flip);

      assert.equal(error._tag, "InstallPreflightFailedError");
      if (error._tag !== "InstallPreflightFailedError") return;
      assert.equal(error.step, "backup");
      assert.deepEqual(error.outcome, { type: "failed-after-drain", backupId: null });
      assert.deepEqual(fake.steps.slice(-5), ["backup", ...restoredAfterDrain({ locked: true })]);
    }),
  );

  it.effect("restores the backends when the disk is full", () =>
    Effect.gen(function* () {
      const fake = makeFake({
        backup: Effect.fail(new DesktopInstallPreflight.StateBackupSpaceError()),
      });
      const error = yield* runPreflight(fake).pipe(Effect.flip);

      assert.equal(error._tag, "InstallPreflightBackupSpaceError");
      assert.deepEqual(error.outcome, { type: "failed-after-drain", backupId: null });
      assert.deepEqual(fake.steps.slice(-5), ["backup", ...restoredAfterDrain({ locked: true })]);
    }),
  );

  it.effect("names the kept backup when the install record fails after it", () =>
    Effect.gen(function* () {
      const fake = makeFake();
      const error = yield* runPreflight(
        fake,
        fake.input({ writeInstallRecord: () => Effect.fail(new InstallRecordWriteError()) }),
      ).pipe(Effect.flip);

      assert.equal(error._tag, "InstallPreflightFailedError");
      assert.deepEqual(error.outcome, { type: "failed-after-drain", backupId: "backup-1" });
      assert.deepEqual(fake.steps.slice(-4), restoredAfterDrain({ locked: true }));
    }),
  );

  it.effect("renews the gates every 10 seconds until the backends exit", () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const exited = yield* Deferred.make<void>();
      const fake = makeFake({
        stop: () =>
          Deferred.succeed(stopping, undefined).pipe(
            Effect.andThen(Deferred.await(exited)),
            Effect.as({ exited: true, forced: false }),
          ),
      });
      const renewals = () => fake.steps.filter((step) => step === "renew").length;

      const run = yield* runPreflight(fake).pipe(Effect.forkChild);
      yield* Deferred.await(stopping);
      yield* TestClock.adjust(Duration.seconds(10));
      assert.equal(renewals(), 1);
      yield* TestClock.adjust(Duration.seconds(10));
      assert.equal(renewals(), 2);

      yield* Deferred.succeed(exited, undefined);
      yield* Fiber.join(run);
      yield* TestClock.adjust(Duration.minutes(1));
      assert.equal(renewals(), 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cancelling while the backends stop undoes everything", () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const fake = makeFake({
        stop: () => Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Effect.never)),
      });

      const run = yield* runPreflight(fake).pipe(Effect.forkChild);
      yield* Deferred.await(stopping);
      yield* Fiber.interrupt(run);
      const exit = yield* Fiber.await(run);

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.deepEqual(fake.steps, [
        "prepare:probe",
        "intent:preparing",
        "stop:primary",
        ...restoredAfterDrain({ locked: false }),
      ]);
    }),
  );

  it("runs the bundled CLI's backup create admitted by the intent", () => {
    const invocation = DesktopInstallPreflight.backupCreateInvocation(
      {
        executablePath: "/Applications/Stark Code.app/Contents/MacOS/Stark Code",
        entryPath: "/app.asar/apps/server/dist/bin.mjs",
        cwd: "/app",
        starkHome: "/home/.stark-code",
      },
      {
        requestId: "update-1",
        appVersion: "0.0.46",
        targetVersion: "0.0.47",
        draftsFile: "/tmp/drafts.json",
        stashFile: "/tmp/stash.json",
        attachmentIds: ["a-1", "a-2"],
      },
    );

    assert.equal(invocation.command, "/Applications/Stark Code.app/Contents/MacOS/Stark Code");
    assert.deepEqual(invocation.args, [
      "/app.asar/apps/server/dist/bin.mjs",
      "backup",
      "create",
      "--reason",
      "pre-install",
      "--intent",
      "update-1",
      "--app-version",
      "0.0.46",
      "--target-version",
      "0.0.47",
      "--drafts",
      "/tmp/drafts.json",
      "--drafts-format",
      "9",
      "--stash",
      "/tmp/stash.json",
      "--stash-format",
      "prompt-stash:v2",
      "--attachment",
      "a-1",
      "--attachment",
      "a-2",
      "--json",
    ]);
    assert.deepEqual(invocation.env, {
      ELECTRON_RUN_AS_NODE: "1",
      STARK_CODE_HOME: "/home/.stark-code",
    });
  });
});
