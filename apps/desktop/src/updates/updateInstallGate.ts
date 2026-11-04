import {
  MAINTENANCE_RENEW_INTERVAL_MS,
  type DesktopUpdateErrorKind,
  type DesktopUpdateInstallBlocker,
  type MaintenanceBlocker,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLocationAnchor from "../app/DesktopLocationAnchor.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopDataRecovery from "../recovery/DesktopDataRecovery.ts";
import * as DesktopInstallPreflight from "./DesktopInstallPreflight.ts";
import * as UpdateSeams from "./updateSeams.ts";

/**
 * The updater's restart preconditions on the servers, over the maintenance
 * gate and the install preflight (PLAN-002 §2.2, §2.4 steps 1 and 4):
 *
 * - `prepare` probes every backend's gate. A busy backend reopens at once and
 *   its blockers come back; nothing is stopped. When every backend is idle the
 *   gates stay closed for this request and their leases are renewed.
 * - `quiesce` runs the preflight with the windows' drafts and stash: the gates
 *   are prepared again, the backends stop and must exit, the data is locked
 *   and backed up, and the location anchor records the handoff.
 * - `release` undoes whichever of the two happened: the preflight's abort
 *   restarts the backends, clears the intent and drops the lock.
 *
 * There is no way past a blocker: no "restart anyway".
 */

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-updater");

const BLOCKER_WORDING: Record<
  MaintenanceBlocker["kind"],
  { readonly kind: DesktopUpdateInstallBlocker["kind"]; readonly message: string }
> = {
  run: { kind: "active-task", message: "An agent task is running." },
  "pending-request": { kind: "pending-approval", message: "A task is waiting for your answer." },
  "provider-work": { kind: "active-task", message: "An agent is still working." },
  effect: { kind: "backend-busy", message: "A Stark server is finishing work." },
  "scheduled-run": { kind: "active-task", message: "A scheduled task is starting." },
  admission: { kind: "backend-busy", message: "A Stark server is accepting new work." },
};

/** The server's blockers as the restart dialog lists them, one entry per kind with a count. */
export function installBlockersFromMaintenance(
  blockers: ReadonlyArray<MaintenanceBlocker>,
): ReadonlyArray<DesktopUpdateInstallBlocker> {
  const byKind = new Map<DesktopUpdateInstallBlocker["kind"], DesktopUpdateInstallBlocker>();
  for (const blocker of blockers) {
    const wording = BLOCKER_WORDING[blocker.kind];
    const existing = byKind.get(wording.kind);
    byKind.set(
      wording.kind,
      existing === undefined
        ? { kind: wording.kind, message: wording.message, count: 1 }
        : { ...existing, count: (existing.count ?? 1) + 1 },
    );
  }
  return blockers.length === 0 ? [UpdateSeams.MAINTENANCE_GATE_UNAVAILABLE] : [...byKind.values()];
}

/** What a failed preflight tells the updater: blockers, or a failure with its recovery wording. */
export function readinessFromPreflightError(
  error: DesktopInstallPreflight.InstallPreflightError,
): UpdateSeams.DesktopInstallReadiness {
  switch (error._tag) {
    case "InstallPreflightBusyError":
      return {
        _tag: "Blocked",
        blockers: installBlockersFromMaintenance(error.blockers.map((entry) => entry.blocker)),
      };
    case "InstallPreflightFailedError":
      if (error.step === "prepare") {
        return { _tag: "Blocked", blockers: [UpdateSeams.MAINTENANCE_GATE_UNAVAILABLE] };
      }
      break;
    default:
      break;
  }
  const kind: DesktopUpdateErrorKind =
    error._tag === "InstallPreflightBackupSpaceError" ? "disk-full" : "unknown";
  return {
    _tag: "Failed",
    kind,
    message: DesktopDataRecovery.recoveryMessage(error.outcome, { reason: error.message }),
  };
}

interface HeldRequest {
  renewal: Fiber.Fiber<unknown, unknown> | null;
  handle: DesktopInstallPreflight.InstallPreflightHandle | null;
}

const make = Effect.gen(function* () {
  const preflight = yield* DesktopInstallPreflight.DesktopInstallPreflight;
  const ports = yield* DesktopInstallPreflight.InstallPreflightPorts;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const scope = yield* Effect.scope;
  const { path } = environment;
  const held = new Map<string, HeldRequest>();

  const stopRenewal = (requestId: string) =>
    Effect.suspend(() => {
      const entry = held.get(requestId);
      const renewal = entry?.renewal ?? null;
      if (entry !== undefined) entry.renewal = null;
      return renewal === null ? Effect.void : Fiber.interrupt(renewal).pipe(Effect.asVoid);
    });

  const releaseGates = (requestId: string) =>
    ports.backends.pipe(
      Effect.flatMap((backendIds) =>
        ports.requestGate({ backendIds, requestId, action: "release" }),
      ),
      Effect.catchTags({
        MaintenanceGateUnavailableError: (error) =>
          logWarning("could not release a maintenance gate", {
            backendIds: error.backendIds.join(","),
          }),
      }),
      Effect.asVoid,
    );

  const prepare = Effect.fn("desktop.updates.installGate.prepare")(function* (requestId: string) {
    const backendIds = yield* ports.backends;
    const statuses = yield* ports
      .requestGate({ backendIds, requestId, action: "prepare", mode: "probe" })
      .pipe(Effect.option);
    if (statuses._tag === "None") {
      yield* releaseGates(requestId);
      return {
        _tag: "Blocked",
        blockers: [UpdateSeams.MAINTENANCE_GATE_UNAVAILABLE],
      } satisfies UpdateSeams.DesktopInstallReadiness;
    }
    if (statuses.value.some((entry) => !entry.status.ready)) {
      // Busy backends reopened on their own; idle ones closed for this request.
      yield* releaseGates(requestId);
      return {
        _tag: "Blocked",
        blockers: installBlockersFromMaintenance(
          statuses.value.flatMap((entry) => entry.status.blockers),
        ),
      } satisfies UpdateSeams.DesktopInstallReadiness;
    }
    // Every gate stays closed while the windows save their drafts.
    const renewal = yield* Effect.sleep(Duration.millis(MAINTENANCE_RENEW_INTERVAL_MS)).pipe(
      Effect.andThen(
        ports.requestGate({ backendIds, requestId, action: "renew" }).pipe(Effect.ignore),
      ),
      Effect.forever,
      Effect.forkIn(scope),
    );
    held.set(requestId, { renewal, handle: null });
    return { _tag: "Ready" } satisfies UpdateSeams.DesktopInstallReadiness;
  });

  const writeHandoffAnchor = (fromVersion: string, toVersion: string) =>
    Effect.gen(function* () {
      const anchorPath = environment.locationAnchorPath ?? null;
      if (anchorPath === null) return;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.try({
        try: () =>
          DesktopLocationAnchor.writeDesktopLocationAnchor(
            anchorPath,
            DesktopLocationAnchor.currentDesktopLocationAnchor({
              env: process.env,
              appVersion: fromVersion,
              handoff: { fromVersion, toVersion, at },
            }),
          ),
        catch: (cause) =>
          new DesktopLocationAnchor.DesktopLocationAnchorWriteError({ path: anchorPath, cause }),
      });
    });

  const writeRestartFile = (requestId: string, name: string, contents: string | null) =>
    contents === null
      ? Effect.succeed<string | null>(null)
      : Effect.try({
          try: () => {
            const file = path.join(
              environment.stateDir,
              "update-restart",
              `${name}-${requestId}.json`,
            );
            DesktopDataRecovery.writeFileDurably(file, contents);
            return file as string | null;
          },
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));

  const removeRestartFiles = (files: ReadonlyArray<string | null>) =>
    Effect.forEach(
      files,
      (file) =>
        file === null
          ? Effect.void
          : Effect.try(() => DesktopDataRecovery.removeFileDurably(file)).pipe(Effect.ignore),
      { discard: true },
    );

  const quiesce = Effect.fn("desktop.updates.installGate.quiesce")(function* (input: {
    readonly requestId: string;
    readonly version: string;
    readonly referencedAttachmentIds: ReadonlyArray<string>;
    readonly draftsJson: string | null;
    readonly stashJson: string | null;
  }) {
    // The preflight prepares the gates again and renews them itself.
    yield* stopRenewal(input.requestId);
    const draftsFile = yield* writeRestartFile(input.requestId, "drafts", input.draftsJson);
    const stashFile = yield* writeRestartFile(input.requestId, "stash", input.stashJson);
    const result = yield* preflight
      .run({
        requestId: input.requestId,
        mode: "probe",
        fromVersion: environment.appVersion,
        toVersion: input.version,
        draftsFile,
        stashFile,
        attachmentIds: input.referencedAttachmentIds,
        writeInstallRecord: () => writeHandoffAnchor(environment.appVersion, input.version),
      })
      .pipe(Effect.result, Effect.ensuring(removeRestartFiles([draftsFile, stashFile])));
    if (result._tag === "Failure") {
      held.delete(input.requestId);
      yield* logWarning("the update restart preparation did not finish", {
        error: result.failure._tag,
      });
      return readinessFromPreflightError(result.failure);
    }
    held.set(input.requestId, { renewal: null, handle: result.success });
    return { _tag: "Ready" } satisfies UpdateSeams.DesktopInstallReadiness;
  });

  const release = Effect.fn("desktop.updates.installGate.release")(function* (requestId: string) {
    yield* stopRenewal(requestId);
    const handle = held.get(requestId)?.handle ?? null;
    held.delete(requestId);
    if (handle !== null) {
      yield* handle.abort;
      return;
    }
    yield* releaseGates(requestId);
  });

  return UpdateSeams.DesktopInstallGate.of({ prepare, quiesce, release });
});

/** Needs the install preflight and its ports, and the desktop environment. */
export const layer = Layer.effect(UpdateSeams.DesktopInstallGate, make);
