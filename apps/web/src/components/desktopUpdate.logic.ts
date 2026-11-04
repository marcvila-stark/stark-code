import type { DesktopUpdateActionResult, DesktopUpdateState } from "@starkfuture/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/**
 * Release notes come only from the update feed's metadata, shown as plain
 * text. No release page is linked or loaded.
 */
export function getDesktopUpdateReleaseUrl(_version: string | null): string | null {
  return null;
}

export function getDesktopUpdateReleaseHistoryUrl(): string | null {
  return null;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

const BUSY_STATUSES: ReadonlySet<DesktopUpdateState["status"]> = new Set([
  "checking",
  "downloading",
  "verifying",
  "preparing",
  "restarting",
]);

/** True while the updater is busy and the update button has nothing to start. */
export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state !== null && BUSY_STATUSES.has(state.status);
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but Stark Code is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but Stark Code is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but Stark Code is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

// ---------------------------------------------------------------------------
// One presentation for every entry point: About, the sidebar pill, the
// command palette, the app menu's result and the toasts.
// ---------------------------------------------------------------------------

export type DesktopUpdateIntent =
  | "check"
  | "download"
  | "cancel"
  | "install"
  | "postpone"
  | "resume-reminders";

export interface DesktopUpdateActionSpec {
  readonly intent: DesktopUpdateIntent;
  readonly label: string;
}

export interface DesktopUpdatePresentation {
  readonly tone: "muted" | "neutral" | "progress" | "info" | "ready" | "warning" | "error";
  readonly headline: string;
  readonly detail: string | null;
  readonly primary: DesktopUpdateActionSpec | null;
  readonly secondary: DesktopUpdateActionSpec | null;
}

export interface DesktopUpdateFormatOptions {
  /** Epoch milliseconds, for postponement. */
  readonly now?: number;
  /** Formats an ISO time as the user's short clock time. */
  readonly formatTime?: (iso: string) => string;
}

function defaultFormatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatMegabytes(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return megabytes < 1 ? "<1" : String(Math.round(megabytes));
}

/** "45% · 38 of 84 MB", or "45%" when the feed reports no sizes. */
export function formatDesktopUpdateProgress(state: DesktopUpdateState): string | null {
  if (state.downloadPercent === null) return null;
  const percent = `${Math.floor(state.downloadPercent)}%`;
  const progress = state.downloadProgress;
  if (!progress || progress.totalBytes <= 0) return percent;
  return `${percent} · ${formatMegabytes(progress.transferredBytes)} of ${formatMegabytes(progress.totalBytes)} MB`;
}

function isDesktopUpdatePostponed(state: DesktopUpdateState, now: number): boolean {
  if (state.postponedUntil === undefined) return false;
  const until = Date.parse(state.postponedUntil);
  return Number.isFinite(until) && until > now;
}

const CHECK: DesktopUpdateActionSpec = { intent: "check", label: "Check for updates" };

export function describeDesktopUpdateState(
  state: DesktopUpdateState,
  options: DesktopUpdateFormatOptions = {},
): DesktopUpdatePresentation {
  const formatTime = options.formatTime ?? defaultFormatTime;
  const now = options.now ?? Date.now();
  const version = getDesktopUpdateDownloadedVersion(state) ?? "the update";
  const notAppliedHere =
    state.notAppliedVersion !== undefined &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion;

  switch (state.status) {
    case "disabled":
      return {
        tone: "muted",
        headline: "Updates are off",
        detail: state.disabledReason?.message ?? "This build can't update itself.",
        primary: null,
        secondary: null,
      };
    case "idle":
      return {
        tone: "neutral",
        headline: "Not checked yet",
        detail: state.lastCheckError?.message ?? null,
        primary: CHECK,
        secondary: null,
      };
    case "checking":
      return {
        tone: "progress",
        headline: "Checking for updates…",
        detail: null,
        primary: null,
        secondary: null,
      };
    case "up-to-date": {
      const checked = state.checkedAt ? `Checked at ${formatTime(state.checkedAt)}.` : null;
      const failed = state.lastCheckError
        ? `The last check failed: ${state.lastCheckError.message}`
        : null;
      return {
        tone: "neutral",
        headline: "Up to date",
        detail: [checked, failed].filter((part) => part !== null).join(" ") || null,
        primary: CHECK,
        secondary: null,
      };
    }
    case "error":
      return {
        tone: "error",
        headline: "Couldn't check for updates",
        detail: state.message,
        primary: { intent: "check", label: "Try again" },
        secondary: null,
      };
    case "available": {
      const failed = state.errorContext === "download" || state.errorContext === "install";
      const retry = state.downloadRetry
        ? ` Trying again at ${formatTime(state.downloadRetry.nextAttemptAt)}.`
        : "";
      return {
        tone: failed ? "warning" : "info",
        headline: `Stark Code ${version} is available`,
        detail: failed
          ? `${state.message ?? `Couldn't download ${version}.`}${retry}`
          : notAppliedHere
            ? `${version} didn't install last time.`
            : null,
        primary: { intent: "download", label: failed ? "Try again" : "Download" },
        secondary: state.downloadRetry ? { intent: "cancel", label: "Cancel" } : null,
      };
    }
    case "downloading":
      return {
        tone: "progress",
        headline: `Downloading ${version}`,
        detail: formatDesktopUpdateProgress(state),
        primary: { intent: "cancel", label: "Cancel" },
        secondary: null,
      };
    case "verifying":
      return {
        tone: "progress",
        headline: "Checking the download…",
        detail: `Making sure ${version} is signed by Stark Future.`,
        primary: null,
        secondary: null,
      };
    case "downloaded": {
      const postponed = isDesktopUpdatePostponed(state, now);
      const blocked = (state.installBlockers?.length ?? 0) > 0;
      const failed = state.errorContext === "install";
      const detail =
        blocked || failed
          ? state.message
          : state.stagedVersion !== undefined
            ? `${state.stagedVersion} installs the next time you quit Stark Code.`
            : notAppliedHere
              ? `${version} didn't install last time. Try again.`
              : postponed && state.postponedUntil
                ? `Reminders are paused until ${formatTime(state.postponedUntil)}.`
                : "Restart to update. Your drafts are saved first, and Stark Code won't restart while a task is running or waiting for you.";
      return {
        tone: blocked || failed ? "warning" : "ready",
        headline: `Stark Code ${version} is ready`,
        detail,
        primary: { intent: "install", label: "Restart to update" },
        secondary: postponed
          ? { intent: "resume-reminders", label: "Remind me" }
          : { intent: "postpone", label: "Later" },
      };
    }
    case "preparing":
      return {
        tone: "progress",
        headline: "Saving your work…",
        detail: "Checking that no task or approval would be interrupted.",
        primary: null,
        secondary: null,
      };
    case "restarting":
      return {
        tone: "progress",
        headline: "Restarting to update…",
        detail: null,
        primary: null,
        secondary: null,
      };
  }
}

/** The pill's tooltip: the headline and, below it, the detail. Never "Up to date" unless it is. */
export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  options?: DesktopUpdateFormatOptions,
): string {
  const { headline, detail } = describeDesktopUpdateState(state, options);
  return detail ? `${headline}\n${detail}` : headline;
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Restart Stark Code to install${version ? ` ${version}` : " the update"}?\n\nYour drafts are saved first. Stark Code won't restart while a task is running or waiting for your approval.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled || state.status === "disabled") return false;
  return !BUSY_STATUSES.has(state.status);
}

export interface DesktopUpdateToast {
  readonly type: "success" | "info" | "warning" | "error";
  readonly title: string;
  readonly description: string | null;
}

/**
 * What a user-started action reports, shared by every entry point. Background
 * work never toasts; a manual check always says what it found.
 */
export function describeDesktopUpdateActionOutcome(
  intent: "check",
  result: { readonly checked: boolean; readonly state: DesktopUpdateState },
): DesktopUpdateToast | null;
export function describeDesktopUpdateActionOutcome(
  intent: Exclude<DesktopUpdateIntent, "check">,
  result: DesktopUpdateActionResult,
): DesktopUpdateToast | null;
export function describeDesktopUpdateActionOutcome(
  intent: DesktopUpdateIntent,
  result:
    | { readonly checked: boolean; readonly state: DesktopUpdateState }
    | DesktopUpdateActionResult,
): DesktopUpdateToast | null {
  const { state } = result;
  const version = getDesktopUpdateDownloadedVersion(state);
  switch (intent) {
    case "check": {
      if (state.status === "disabled") {
        return {
          type: "info",
          title: "Updates are off",
          description: state.disabledReason?.message ?? "This build can't update itself.",
        };
      }
      if (!("checked" in result) || !result.checked) return null;
      if (state.status === "error") {
        return { type: "error", title: "Couldn't check for updates", description: state.message };
      }
      if (state.lastCheckError && state.lastCheckError.at === state.checkedAt) {
        return {
          type: "error",
          title: "Couldn't check for updates",
          description: state.lastCheckError.message,
        };
      }
      if (state.status === "up-to-date") {
        return {
          type: "success",
          title: "You're up to date",
          description: `Stark Code ${state.currentVersion} is the newest version.`,
        };
      }
      if (state.status === "available" || state.status === "downloading") {
        return {
          type: "info",
          title: `Stark Code ${version ?? "update"} is available`,
          description: "It downloads in the background.",
        };
      }
      return null;
    }
    case "download":
      if (!("accepted" in result) || !result.accepted || result.completed) return null;
      return state.errorContext === "download"
        ? { type: "error", title: "Couldn't download the update", description: state.message }
        : null;
    case "install":
      if (!("accepted" in result)) return null;
      if ((state.installBlockers?.length ?? 0) > 0) {
        return {
          type: "warning",
          title: "Stark Code can't restart yet",
          description: state.message,
        };
      }
      return state.errorContext === "install"
        ? { type: "error", title: "Couldn't install the update", description: state.message }
        : null;
    default:
      return null;
  }
}

/**
 * The version to prompt "ready to restart" for, or null. Prompts stay quiet
 * while postponed or while a restart is already blocked or under way.
 */
export function getDesktopUpdateReadyPromptVersion(
  state: DesktopUpdateState | null,
  now: number,
): string | null {
  if (!state || state.status !== "downloaded" || state.downloadedVersion === null) return null;
  if (isDesktopUpdatePostponed(state, now)) return null;
  if ((state.installBlockers?.length ?? 0) > 0 || state.errorContext === "install") return null;
  return state.downloadedVersion;
}

/** The command palette's update row for the current state, or null without a desktop updater. */
export function describeDesktopUpdatePaletteAction(state: DesktopUpdateState | null): {
  readonly intent: DesktopUpdateIntent;
  readonly title: string;
  readonly description: string | null;
} | null {
  if (!state) return null;
  const presentation = describeDesktopUpdateState(state);
  const version = getDesktopUpdateDownloadedVersion(state);
  switch (state.status) {
    case "downloaded":
      return {
        intent: "install",
        title: `Restart to update to ${version ?? "the new version"}`,
        description: presentation.detail,
      };
    case "available":
      return {
        intent: "download",
        title: `Download Stark Code ${version ?? "update"}`,
        description: presentation.detail,
      };
    case "downloading":
      return {
        intent: "cancel",
        title: "Cancel update download",
        description: presentation.detail,
      };
    default:
      return {
        intent: "check",
        title: "Check for updates",
        description: state.status === "disabled" ? presentation.detail : presentation.headline,
      };
  }
}
