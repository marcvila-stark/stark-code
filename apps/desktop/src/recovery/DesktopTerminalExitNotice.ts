// @effect-diagnostics nodeBuiltinImport:off - Reads the server's small state file synchronously, like DesktopDataRecovery.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { LAST_RUNNING_VERSION_FILE, LastRunningVersion } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopDataRecovery from "./DesktopDataRecovery.ts";

/**
 * A backend that exits with a data-protection code (79–83) cannot be fixed by
 * restarting it, so the supervisor stops it and the app explains why, in the
 * outcome wording of DesktopDataRecovery.ts, and quits.
 */

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-recovery");

export interface DataRecoveryNotice {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

const decodeLastRunningVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(LastRunningVersion),
);

/** The last version that reached activation on this data, or null when unknown. */
function readLastRunningVersion(stateDir: string): string | null {
  try {
    const text = NodeFS.readFileSync(NodePath.join(stateDir, LAST_RUNNING_VERSION_FILE), "utf8");
    return Option.match(decodeLastRunningVersion(text), {
      onNone: () => null,
      onSome: (record) => record.version,
    });
  } catch {
    return null;
  }
}

export interface DataRecoveryNotice {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

/** The dialog for a backend that exited with a data-protection code; null for any other code. */
export function terminalExitNotice(input: {
  readonly exitCode: number;
  readonly runningVersion: string;
  readonly lastRunningVersion: string | null;
}): DataRecoveryNotice | null {
  const state = DesktopDataRecovery.recoveryStateForExitCode(input.exitCode, input.runningVersion);
  if (state === null) return null;
  const message = DesktopDataRecovery.recoveryMessage(state, {
    lastRunningVersion: input.lastRunningVersion,
  });
  switch (state.type) {
    case "schema-newer":
    case "schema-divergent":
      return {
        title: "Stark Code can't open this data",
        message,
        detail: "Stark Code will quit. Your data was not opened for writing.",
      };
    case "migration-failed":
    case "migration-failed-after-preview-reconciliation":
      return {
        title: "Stark Code couldn't update your data",
        message,
        detail:
          "A backup from just before is kept. Reinstall the version you used before to keep working; Stark Code will quit.",
      };
    case "backup-failed":
      return {
        title: "Stark Code couldn't back up your data",
        message,
        detail: "Stark Code will quit.",
      };
    default:
      return {
        title: "Stark Code is busy with this data",
        message,
        detail: "Stark Code will quit.",
      };
  }
}

/**
 * Shown when the primary backend exits with a code in 79–83: restarting it
 * cannot change the outcome, so the app explains why and quits.
 */
export const showTerminalExitNotice = Effect.fn("desktop.recovery.showTerminalExitNotice")(
  function* (input: {
    readonly exitCode: number;
    readonly runningVersion: string;
    readonly stateDir: string | null;
  }) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronApp = yield* ElectronApp.ElectronApp;
    const notice = terminalExitNotice({
      exitCode: input.exitCode,
      runningVersion: input.runningVersion,
      lastRunningVersion: input.stateDir === null ? null : readLastRunningVersion(input.stateDir),
    });
    if (notice === null) return;
    yield* logWarning("a backend refused to open the data", { exitCode: input.exitCode });
    yield* dialog
      .showMessageBox({
        type: "error",
        title: notice.title,
        message: notice.message,
        detail: notice.detail,
        buttons: ["Quit Stark Code"],
        defaultId: 0,
      })
      .pipe(Effect.ignore);
    yield* electronApp.quit;
  },
);
