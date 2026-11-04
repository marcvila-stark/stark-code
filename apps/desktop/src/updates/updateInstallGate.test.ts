// @effect-diagnostics nodeBuiltinImport:off - The drafts handed to the backup are real files in a temporary state directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { MaintenanceBlocker, MaintenanceStatus } from "@starkfuture/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopInstallPreflight from "./DesktopInstallPreflight.ts";
import {
  installBlockersFromMaintenance,
  layer as layerInstallGate,
  readinessFromPreflightError,
} from "./updateInstallGate.ts";
import * as UpdateSeams from "./updateSeams.ts";

const status = (
  requestId: string,
  blockers: ReadonlyArray<MaintenanceBlocker>,
): MaintenanceStatus => ({
  requestId: blockers.length === 0 ? requestId : null,
  state: blockers.length === 0 ? "closed" : "open",
  ready: blockers.length === 0,
  blockers,
  leaseExpiresAtUnixMs: blockers.length === 0 ? 30_000 : null,
  recoveryHold: null,
});

const blocker = (kind: MaintenanceBlocker["kind"], id: string): MaintenanceBlocker => ({
  kind,
  id,
  threadId: null,
});

describe("installBlockersFromMaintenance", () => {
  it("lists each kind of server work once, with a count", () => {
    assert.deepStrictEqual(
      installBlockersFromMaintenance([
        blocker("run", "run-1"),
        blocker("provider-work", "thread-1"),
        blocker("pending-request", "request-1"),
        blocker("effect", "effect-1"),
      ]),
      [
        { kind: "active-task", message: "An agent task is running.", count: 2 },
        { kind: "pending-approval", message: "A task is waiting for your answer.", count: 1 },
        { kind: "backend-busy", message: "A Stark server is finishing work.", count: 1 },
      ],
    );
  });
});

describe("readinessFromPreflightError", () => {
  it("turns busy backends into blockers and failures after the drain into recovery wording", () => {
    const busy = readinessFromPreflightError(
      new DesktopInstallPreflight.InstallPreflightBusyError({
        blockers: [{ backendId: "primary", blocker: blocker("scheduled-run", "run-2") }],
      }),
    );
    assert.deepStrictEqual(busy, {
      _tag: "Blocked",
      blockers: [{ kind: "active-task", message: "A scheduled task is starting.", count: 1 }],
    });

    const full = readinessFromPreflightError(
      new DesktopInstallPreflight.InstallPreflightBackupSpaceError({ cause: null }),
    );
    assert.deepStrictEqual(full, {
      _tag: "Failed",
      kind: "disk-full",
      message:
        "There is not enough free disk space to back up your data, so the update did not install. Your tasks were restarted.",
    });

    const unanswered = readinessFromPreflightError(
      new DesktopInstallPreflight.InstallPreflightFailedError({
        step: "prepare",
        outcome: { type: "refused-before-stop" },
        cause: null,
      }),
    );
    assert.deepStrictEqual(unanswered, {
      _tag: "Blocked",
      blockers: [UpdateSeams.MAINTENANCE_GATE_UNAVAILABLE],
    });
  });
});

interface Recorded {
  readonly gateRequests: Array<string>;
  readonly runs: Array<DesktopInstallPreflight.InstallPreflightInput>;
  readonly draftsSeen: Array<string | null>;
  aborts: number;
}

const makeGate = (input: {
  readonly stateDir: string;
  readonly busy?: ReadonlyArray<MaintenanceBlocker>;
  readonly runFails?: DesktopInstallPreflight.InstallPreflightError;
}) => {
  const recorded: Recorded = { gateRequests: [], runs: [], draftsSeen: [], aborts: 0 };
  const ports = DesktopInstallPreflight.InstallPreflightPorts.of({
    backends: Effect.succeed(["primary"]),
    requestGate: (request) =>
      Effect.sync(() => {
        recorded.gateRequests.push(`${request.action}:${request.mode ?? ""}`);
        return request.action === "release"
          ? []
          : [{ backendId: "primary", status: status(request.requestId, input.busy ?? []) }];
      }),
    writeIntent: () => Effect.die("unexpected intent"),
    clearIntent: Effect.die("unexpected intent"),
    stopBackend: () => Effect.die("unexpected stop"),
    startBackend: () => Effect.die("unexpected start"),
    acquireLock: Effect.die("unexpected lock"),
    createBackup: () => Effect.die("unexpected backup"),
  });
  const preflight = DesktopInstallPreflight.DesktopInstallPreflight.of({
    run: (run) =>
      Effect.gen(function* () {
        recorded.runs.push(run);
        recorded.draftsSeen.push(
          run.draftsFile === null ? null : NodeFS.readFileSync(run.draftsFile, "utf8"),
        );
        if (input.runFails !== undefined) return yield* Effect.fail(input.runFails);
        return {
          requestId: run.requestId,
          backup: { id: "backup-1", path: "/backups/backup-1", manifest: null as never },
          lock: { release: Effect.void },
          abort: Effect.sync(() => {
            recorded.aborts += 1;
            return { type: "failed-after-drain" as const, backupId: "backup-1" };
          }),
        };
      }),
  });
  const layer = layerInstallGate.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopInstallPreflight.InstallPreflightPorts, ports),
        Layer.succeed(DesktopInstallPreflight.DesktopInstallPreflight, preflight),
        Layer.effect(
          DesktopEnvironment.DesktopEnvironment,
          Effect.gen(function* () {
            const path = yield* Path.Path;
            return DesktopEnvironment.DesktopEnvironment.of({
              path,
              stateDir: input.stateDir,
              appVersion: "0.0.46-alpha.1",
              locationAnchorPath: null,
            } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
          }),
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  return { recorded, layer };
};

const withStateDir = <A, E>(use: (stateDir: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-install-gate-"))),
    use,
    (stateDir) => Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true, force: true })),
  );

describe("DesktopInstallGate over the maintenance gate and the preflight", () => {
  it.effect("refuses on busy servers, stops nothing and reopens every gate", () =>
    withStateDir((stateDir) => {
      const { recorded, layer } = makeGate({ stateDir, busy: [blocker("pending-request", "r")] });
      return Effect.gen(function* () {
        const gate = yield* UpdateSeams.DesktopInstallGate;
        const readiness = yield* gate.prepare("update-restart-1");
        assert.deepStrictEqual(readiness, {
          _tag: "Blocked",
          blockers: [
            { kind: "pending-approval", message: "A task is waiting for your answer.", count: 1 },
          ],
        });
        assert.deepStrictEqual(recorded.gateRequests, ["prepare:probe", "release:"]);
        assert.lengthOf(recorded.runs, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("backs up the windows' drafts through the preflight and aborts it on release", () =>
    withStateDir((stateDir) => {
      const { recorded, layer } = makeGate({ stateDir });
      return Effect.gen(function* () {
        const gate = yield* UpdateSeams.DesktopInstallGate;
        assert.deepStrictEqual(yield* gate.prepare("update-restart-1"), { _tag: "Ready" });
        const quiesced = yield* gate.quiesce({
          requestId: "update-restart-1",
          version: "0.0.46-alpha.2",
          referencedAttachmentIds: ["upload-1"],
          draftsJson: '{"version":9,"state":{}}',
          stashJson: null,
        });
        assert.deepStrictEqual(quiesced, { _tag: "Ready" });
        const run = recorded.runs[0]!;
        assert.strictEqual(run.mode, "probe");
        assert.strictEqual(run.fromVersion, "0.0.46-alpha.1");
        assert.strictEqual(run.toVersion, "0.0.46-alpha.2");
        assert.deepStrictEqual(run.attachmentIds, ["upload-1"]);
        assert.isNull(run.stashFile);
        assert.deepStrictEqual(recorded.draftsSeen, ['{"version":9,"state":{}}']);
        // The copy handed to the backup is removed afterwards.
        assert.isFalse(NodeFS.existsSync(run.draftsFile!));

        yield* gate.release("update-restart-1");
        assert.strictEqual(recorded.aborts, 1);
        assert.notInclude(recorded.gateRequests, "release:");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reports a preflight failure with the outcome's wording", () =>
    withStateDir((stateDir) => {
      const { layer } = makeGate({
        stateDir,
        runFails: new DesktopInstallPreflight.InstallPreflightFailedError({
          step: "backup",
          outcome: { type: "failed-after-drain", backupId: null },
          cause: null,
        }),
      });
      return Effect.gen(function* () {
        const gate = yield* UpdateSeams.DesktopInstallGate;
        yield* gate.prepare("update-restart-2");
        const quiesced = yield* gate.quiesce({
          requestId: "update-restart-2",
          version: "0.0.46-alpha.2",
          referencedAttachmentIds: [],
          draftsJson: null,
          stashJson: null,
        });
        assert.deepStrictEqual(quiesced, {
          _tag: "Failed",
          kind: "unknown",
          message:
            "The update could not finish preparing, so it did not install. Your tasks were restarted.",
        });
      }).pipe(Effect.provide(layer));
    }),
  );
});
