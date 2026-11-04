import type { MaintenanceRecoveryHold } from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLocationAnchor from "../app/DesktopLocationAnchor.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import type * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopInstallPreflight from "../updates/DesktopInstallPreflight.ts";
import * as DesktopDataRecovery from "./DesktopDataRecovery.ts";
import type { DataRecoveryNotice } from "./DesktopTerminalExitNotice.ts";

/**
 * What desktop main does about data recovery around a launch: run the
 * restore a relaunch asked for before any backend starts, and offer Resume
 * while a restore's recovery hold keeps background work paused. A backend
 * that refuses to open the data is explained by DesktopTerminalExitNotice.ts.
 */

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-recovery");

const serverCliTarget = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopDataRecovery.ServerCliTarget => ({
  executablePath: process.execPath,
  entryPath: environment.backendEntryPath,
  cwd: environment.backendCwd,
  starkHome: environment.baseDir,
});

/**
 * Runs the restore the user chose before relaunching, before any backend
 * starts. The bundled CLI takes the maintenance lock itself. Desktop settings
 * are read again afterwards, since the restore may have replaced them.
 */
export const runPendingRestore = Effect.fn("desktop.recovery.runPendingRestore")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const request = yield* DesktopDataRecovery.takeRestoreRequest(environment.stateDir).pipe(
    Effect.catchTags({
      RestoreRequestError: (error) =>
        logWarning("could not read the restore request", { operation: error.operation }).pipe(
          Effect.as(Option.none<DesktopDataRecovery.RestoreRequest>()),
        ),
    }),
  );
  if (Option.isNone(request)) return;
  const restored = yield* DesktopDataRecovery.runBackupRestore(serverCliTarget(environment), {
    backupId: request.value.backupId,
    appVersion: environment.appVersion,
  }).pipe(Effect.result);
  if (restored._tag === "Failure") {
    yield* logWarning("the requested restore did not run", { error: restored.failure._tag });
    yield* dialog.showErrorBox(
      "The backup could not be restored",
      "Stark Code kept your current data and starts with it. You can try again with `stark-code backup restore` while Stark Code is closed.",
    );
    return;
  }
  yield* logInfo("restored a backup before starting", {
    backupId: restored.success.backupId,
    backupAppVersion: restored.success.backupAppVersion,
  });
  yield* desktopSettings.load.pipe(Effect.asVoid);
});

/** The Resume notice for a restore's recovery hold. */
export function recoveryHoldNotice(hold: MaintenanceRecoveryHold): DataRecoveryNotice {
  return {
    title: "Background work is paused",
    message: DesktopDataRecovery.recoveryMessage({
      type: "restored",
      backupAppVersion: hold.backupAppVersion,
      displacedPath: hold.displacedPath,
    }),
    detail:
      "Scheduled tasks, webhooks and continuations stay paused, across restarts, until you resume them.",
  };
}

const PRIMARY_READY_WAIT = Duration.minutes(5);

/**
 * After the primary backend is ready: records the locations of this good
 * boot in the anchor (clearing a handoff), and while a recovery hold is in
 * place offers Resume, which ends it on the server.
 */
export const afterPrimaryReady = Effect.fn("desktop.recovery.afterPrimaryReady")(function* (
  primary: DesktopBackendManager.DesktopBackendInstance,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const ports = yield* DesktopInstallPreflight.InstallPreflightPorts;
  if (!(yield* primary.waitForReady(PRIMARY_READY_WAIT))) return;

  const anchorPath = environment.locationAnchorPath ?? null;
  if (anchorPath !== null) {
    yield* Effect.try(() =>
      DesktopLocationAnchor.writeDesktopLocationAnchor(
        anchorPath,
        DesktopLocationAnchor.currentDesktopLocationAnchor({
          env: process.env,
          appVersion: environment.appVersion,
          handoff: null,
        }),
      ),
    ).pipe(Effect.catch(() => logWarning("could not record the data locations of this launch")));
  }

  const backendIds = [`${primary.id}`];
  const stamp = DateTime.toEpochMillis(yield* DateTime.now);
  const statuses = yield* ports
    .requestGate({ backendIds, requestId: `recovery-status-${stamp}`, action: "status" })
    .pipe(Effect.option);
  const hold = Option.isSome(statuses) ? (statuses.value[0]?.status.recoveryHold ?? null) : null;
  if (hold === null) return;
  const notice = recoveryHoldNotice(hold);
  const answer = yield* dialog
    .showMessageBox({
      type: "info",
      title: notice.title,
      message: notice.message,
      detail: notice.detail,
      buttons: ["Resume", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    .pipe(Effect.option);
  if (Option.isNone(answer) || answer.value.response !== 0) return;
  yield* ports
    .requestGate({ backendIds, requestId: `recovery-resume-${stamp}`, action: "resumeRecovery" })
    .pipe(
      Effect.tap(() => logInfo("resumed background work after a restore")),
      Effect.catchTags({
        MaintenanceGateUnavailableError: () =>
          dialog.showErrorBox(
            "Background work is still paused",
            "Stark Code couldn't reach its server to resume. Restart Stark Code to try again, or run `stark-code backup resume` while it is closed.",
          ),
      }),
    );
});
