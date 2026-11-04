import type { DesktopBridge, DesktopUpdateState } from "@starkfuture/contracts";

import { ensureLocalApi } from "../localApi";
import {
  type DesktopUpdateIntent,
  type DesktopUpdateToast,
  describeDesktopUpdateActionOutcome,
  getDesktopUpdateInstallConfirmationMessage,
} from "./desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

type DesktopUpdateBridge = Pick<
  DesktopBridge,
  | "checkForUpdate"
  | "downloadUpdate"
  | "installUpdate"
  | "cancelUpdateDownload"
  | "setUpdatePostponed"
>;

export type DesktopUpdateNotifier = (toast: DesktopUpdateToast) => void;

const showToast: DesktopUpdateNotifier = (toast) => {
  toastManager.add(
    stackedThreadToast({
      type: toast.type,
      title: toast.title,
      ...(toast.description ? { description: toast.description } : {}),
    }),
  );
};

const FAILURE_TITLES: Record<DesktopUpdateIntent, string> = {
  check: "Couldn't check for updates",
  download: "Couldn't download the update",
  cancel: "Couldn't cancel the download",
  install: "Couldn't restart to update",
  postpone: "Couldn't postpone the update",
  "resume-reminders": "Couldn't turn update reminders back on",
};

export interface RunDesktopUpdateIntentOptions {
  /** The state the user acted on; names the version in the restart confirmation. */
  readonly state?: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion"> | null;
  /** Ask before restarting. The sidebar's update-everything run confirmed already. */
  readonly confirm?: boolean;
  readonly notify?: DesktopUpdateNotifier;
  readonly bridge?: DesktopUpdateBridge | undefined;
}

/**
 * Runs one user-chosen update action and reports its outcome the same way
 * from every entry point: About, the sidebar button, the command palette and
 * the ready prompt. Resolves true when the action did what it was asked:
 * a check ran, a download finished, a restart is under way.
 */
export async function runDesktopUpdateIntent(
  intent: DesktopUpdateIntent,
  options: RunDesktopUpdateIntentOptions = {},
): Promise<boolean> {
  const bridge =
    options.bridge ?? (typeof window === "undefined" ? undefined : window.desktopBridge);
  const notify = options.notify ?? showToast;
  if (!bridge) return false;
  try {
    switch (intent) {
      case "check": {
        const result = await bridge.checkForUpdate();
        const toast = describeDesktopUpdateActionOutcome("check", result);
        if (toast) notify(toast);
        return result.checked;
      }
      case "download": {
        const result = await bridge.downloadUpdate();
        const toast = describeDesktopUpdateActionOutcome("download", result);
        if (toast) notify(toast);
        return result.completed;
      }
      case "cancel": {
        if (!bridge.cancelUpdateDownload) return false;
        return (await bridge.cancelUpdateDownload()).accepted;
      }
      case "install": {
        if (options.confirm !== false) {
          const confirmed = await ensureLocalApi().dialogs.confirm(
            getDesktopUpdateInstallConfirmationMessage(
              options.state ?? { availableVersion: null, downloadedVersion: null },
            ),
          );
          if (!confirmed) return false;
        }
        const result = await bridge.installUpdate();
        const toast = describeDesktopUpdateActionOutcome("install", result);
        if (toast) notify(toast);
        return result.accepted && toast === null;
      }
      case "postpone":
      case "resume-reminders": {
        if (!bridge.setUpdatePostponed) return false;
        await bridge.setUpdatePostponed(intent === "postpone");
        return true;
      }
    }
  } catch (error) {
    notify({
      type: "error",
      title: FAILURE_TITLES[intent],
      description: error instanceof Error ? error.message : "An unexpected error occurred.",
    });
    return false;
  }
}
