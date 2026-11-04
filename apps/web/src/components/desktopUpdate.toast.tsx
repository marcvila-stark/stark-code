import type { DesktopBridge, DesktopUpdateState } from "@starkfuture/contracts";

import { getDesktopUpdateDownloadedVersion } from "./desktopUpdate.logic";
import { type RunDesktopUpdateIntentOptions, runDesktopUpdateIntent } from "./desktopUpdateActions";
import { toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

export async function openDesktopUpdateReleaseNotes(
  shell: DesktopUpdateShell | undefined,
  releaseUrl: string,
): Promise<void> {
  try {
    if (shell && (await shell.openExternal(releaseUrl))) return;
  } catch {
    // Surface rejected IPC calls through the same user-visible fallback.
  }
  toastManager.add({ type: "error", title: "Unable to open release notes" });
}

/**
 * The once-per-version prompt when an update is ready. "Restart to update"
 * runs the same checked restart as every other entry point; "Later" keeps the
 * update and mutes the prompt for a day.
 */
export function showDesktopUpdateReadyToast(
  state: DesktopUpdateState,
  run: (
    intent: "install" | "postpone",
    options: RunDesktopUpdateIntentOptions,
  ) => Promise<boolean> = runDesktopUpdateIntent,
): void {
  const version = getDesktopUpdateDownloadedVersion(state);
  const later = () => {
    toastManager.close(id);
    void run("postpone", {});
  };
  const id = toastManager.add({
    type: "success",
    title: version ? `Stark Code ${version} is ready` : "An update is ready",
    description: (
      <>
        Restart to update. Your drafts are saved first, and Stark Code won't restart while a task is
        running.
        <button
          className="ml-2 inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
          onClick={later}
          type="button"
        >
          Later
        </button>
      </>
    ),
    timeout: 0,
    actionProps: {
      children: "Restart to update",
      onClick: () => {
        toastManager.close(id);
        void run("install", { state });
      },
    },
  });
}
