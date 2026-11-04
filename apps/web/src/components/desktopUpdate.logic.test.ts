import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@starkfuture/contracts";

import {
  canCheckForUpdate,
  describeDesktopUpdateActionOutcome,
  describeDesktopUpdatePaletteAction,
  describeDesktopUpdateState,
  formatDesktopUpdateProgress,
  getDesktopUpdateReadyPromptVersion,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("says when the same version did not apply before", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      notAppliedVersion: "1.1.0",
    };
    expect(getDesktopUpdateButtonTooltip(state)).toBe(
      "Stark Code 1.1.0 is ready\n1.1.0 didn't install last time. Try again.",
    );
    expect(
      getDesktopUpdateButtonTooltip({
        ...state,
        availableVersion: "1.2.0",
        downloadedVersion: "1.2.0",
      }),
    ).toContain("Stark Code 1.2.0 is ready");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("keeps install action available after a background updater error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "background updater error",
      errorContext: null,
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("has no action for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("builds the stable release URL for a downloaded version", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30")).toBeNull();
  });

  it("builds the nightly release URL without dropping its version suffix", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30-nightly.20260728.931")).toBeNull();
  });

  it("omits the release URL when the updater does not report a version", () => {
    expect(getDesktopUpdateReleaseUrl(null)).toBeNull();
    expect(getDesktopUpdateReleaseUrl("  ")).toBeNull();
  });

  it("builds the release history URL", () => {
    expect(getDesktopUpdateReleaseHistoryUrl()).toBeNull();
  });

  it("toasts only for actionable updater errors", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: null },
      }),
    ).toBe(false);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(false);
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
  });

  it("changes the warning copy when a native build update is ready to download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("Download the available update");
  });

  it("includes the downloaded version in the install confirmation copy", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.1",
      }),
    ).toContain("Restart Stark Code to install 1.1.1?");
  });

  it("falls back to generic install confirmation copy when no version is available", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toContain("Restart Stark Code to install the update?");
  });

  it("promises nothing is interrupted, because a busy app refuses to restart", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(
      "Restart Stark Code to install 1.1.0?\n\nYour drafts are saved first. Stark Code won't restart while a task is running or waiting for your approval.",
    );
  });
});

describe("canCheckForUpdate", () => {
  it("returns false for null state", () => {
    expect(canCheckForUpdate(null)).toBe(false);
  });

  it("returns false when updates are disabled", () => {
    expect(canCheckForUpdate({ ...baseState, enabled: false, status: "disabled" })).toBe(false);
  });

  it("returns false while checking", () => {
    expect(canCheckForUpdate({ ...baseState, status: "checking" })).toBe(false);
  });

  it("returns false while downloading", () => {
    expect(canCheckForUpdate({ ...baseState, status: "downloading", downloadPercent: 50 })).toBe(
      false,
    );
  });

  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });

  it("returns true when idle", () => {
    expect(canCheckForUpdate({ ...baseState, status: "idle" })).toBe(true);
  });

  it("returns true when up-to-date", () => {
    expect(canCheckForUpdate({ ...baseState, status: "up-to-date" })).toBe(true);
  });

  it("returns true when an update is available", () => {
    expect(
      canCheckForUpdate({ ...baseState, status: "available", availableVersion: "1.1.0" }),
    ).toBe(true);
  });

  it("returns true on error so the user can retry", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "error",
        errorContext: "check",
        message: "network",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("says 'Up to date' only after a successful check", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "idle" })).toBe("Not checked yet");
    expect(
      getDesktopUpdateButtonTooltip(
        { ...baseState, status: "up-to-date", checkedAt: "2026-10-30T14:02:00.000Z" },
        { formatTime: () => "14:02" },
      ),
    ).toBe("Up to date\nChecked at 14:02.");
    expect(
      getDesktopUpdateButtonTooltip({
        ...baseState,
        enabled: false,
        status: "disabled",
        disabledReason: {
          code: "development-build",
          message: "Automatic updates are off: this is a development build.",
        },
      }),
    ).toBe("Updates are off\nAutomatic updates are off: this is a development build.");
  });
});

const formatTime = (iso: string) => iso.slice(11, 16);

describe("describeDesktopUpdateState", () => {
  it.each([
    [
      "disabled without a reason",
      { enabled: false, status: "disabled" },
      "Updates are off",
      "This build can't update itself.",
      null,
    ],
    ["idle", { status: "idle" }, "Not checked yet", null, "Check for updates"],
    ["checking", { status: "checking" }, "Checking for updates…", null, null],
    [
      "a failed check",
      {
        status: "error",
        errorContext: "check",
        errorKind: "unreachable",
        message: "Couldn't reach the update server.",
      },
      "Couldn't check for updates",
      "Couldn't reach the update server.",
      "Try again",
    ],
    [
      "verifying",
      { status: "verifying", availableVersion: "1.1.0" },
      "Checking the download…",
      "Making sure 1.1.0 is signed by Stark Future.",
      null,
    ],
    [
      "preparing",
      { status: "preparing", downloadedVersion: "1.1.0" },
      "Saving your work…",
      "Checking that no task or approval would be interrupted.",
      null,
    ],
    ["restarting", { status: "restarting" }, "Restarting to update…", null, null],
  ] as const)("%s", (_name, overrides, headline, detail, primary) => {
    const presentation = describeDesktopUpdateState({ ...baseState, ...overrides }, { formatTime });
    expect(presentation.headline).toBe(headline);
    expect(presentation.detail).toBe(detail);
    expect(presentation.primary?.label ?? null).toBe(primary);
  });

  it("shows byte progress and offers Cancel while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 45.4,
      downloadProgress: {
        transferredBytes: 38_000_000,
        totalBytes: 84_000_000,
        bytesPerSecond: 5_000_000,
      },
    };
    expect(formatDesktopUpdateProgress(state)).toBe("45% · 38 of 84 MB");
    const presentation = describeDesktopUpdateState(state);
    expect(presentation.headline).toBe("Downloading 1.1.0");
    expect(presentation.primary).toEqual({ intent: "cancel", label: "Cancel" });
  });

  it("names a failed download and when it retries", () => {
    const presentation = describeDesktopUpdateState(
      {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        errorContext: "download",
        errorKind: "unreachable",
        message: "Couldn't reach the update server to download 1.1.0.",
        downloadRetry: { attempt: 1, nextAttemptAt: "2026-10-30T14:05:00.000Z" },
      },
      { formatTime },
    );
    expect(presentation.detail).toBe(
      "Couldn't reach the update server to download 1.1.0. Trying again at 14:05.",
    );
    expect(presentation.primary).toEqual({ intent: "download", label: "Try again" });
    expect(presentation.secondary).toEqual({ intent: "cancel", label: "Cancel" });
  });

  it("offers Restart and Later when ready, and the way back from Later", () => {
    const ready: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };
    const presentation = describeDesktopUpdateState(ready);
    expect(presentation.headline).toBe("Stark Code 1.1.0 is ready");
    expect(presentation.primary).toEqual({ intent: "install", label: "Restart to update" });
    expect(presentation.secondary).toEqual({ intent: "postpone", label: "Later" });

    const postponed = describeDesktopUpdateState(
      { ...ready, postponedUntil: "2026-10-31T14:00:00.000Z" },
      { now: Date.parse("2026-10-30T14:00:00.000Z"), formatTime },
    );
    expect(postponed.detail).toBe("Reminders are paused until 14:00.");
    expect(postponed.primary?.intent).toBe("install");
    expect(postponed.secondary).toEqual({ intent: "resume-reminders", label: "Remind me" });
  });

  it("explains a blocked restart without offering to restart anyway", () => {
    const presentation = describeDesktopUpdateState({
      ...baseState,
      status: "downloaded",
      downloadedVersion: "1.1.0",
      installBlockers: [{ kind: "active-task", message: "A task is running.", count: 1 }],
      message: "Stark Code can't restart yet: 1 task is running.",
    });
    expect(presentation.tone).toBe("warning");
    expect(presentation.detail).toBe("Stark Code can't restart yet: 1 task is running.");
    expect(presentation.primary).toEqual({ intent: "install", label: "Restart to update" });
    expect(JSON.stringify(presentation)).not.toMatch(/anyway/i);
  });

  it("says when a late-staged update installs", () => {
    expect(
      describeDesktopUpdateState({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        stagedVersion: "1.1.0",
      }).detail,
    ).toBe("1.1.0 installs the next time you quit Stark Code.");
  });
});

describe("describeDesktopUpdateActionOutcome", () => {
  it("reports every manual check result, including updates being off", () => {
    expect(
      describeDesktopUpdateActionOutcome("check", {
        checked: false,
        state: {
          ...baseState,
          enabled: false,
          status: "disabled",
          disabledReason: { code: "feed-not-configured", message: "No feed." },
        },
      }),
    ).toEqual({ type: "info", title: "Updates are off", description: "No feed." });
    expect(
      describeDesktopUpdateActionOutcome("check", {
        checked: true,
        state: { ...baseState, status: "up-to-date" },
      }),
    ).toEqual({
      type: "success",
      title: "You're up to date",
      description: "Stark Code 1.0.0 is the newest version.",
    });
    expect(
      describeDesktopUpdateActionOutcome("check", {
        checked: true,
        state: { ...baseState, status: "error", message: "Couldn't reach the update server." },
      })?.type,
    ).toBe("error");
    // A failed check that kept a known update still says it failed.
    expect(
      describeDesktopUpdateActionOutcome("check", {
        checked: true,
        state: {
          ...baseState,
          status: "available",
          availableVersion: "1.1.0",
          checkedAt: "2026-10-30T14:00:00.000Z",
          lastCheckError: {
            kind: "unreachable",
            message: "Couldn't reach the update server.",
            at: "2026-10-30T14:00:00.000Z",
          },
        },
      }),
    ).toEqual({
      type: "error",
      title: "Couldn't check for updates",
      description: "Couldn't reach the update server.",
    });
  });

  it("reports a blocked restart as a warning and a failed install as an error", () => {
    const blocked = {
      ...baseState,
      status: "downloaded" as const,
      downloadedVersion: "1.1.0",
      installBlockers: [{ kind: "pending-approval" as const, message: "", count: 1 }],
      message: "Stark Code can't restart yet: 1 task is waiting for your approval.",
    };
    expect(
      describeDesktopUpdateActionOutcome("install", {
        accepted: false,
        completed: false,
        state: blocked,
      }),
    ).toEqual({
      type: "warning",
      title: "Stark Code can't restart yet",
      description: "Stark Code can't restart yet: 1 task is waiting for your approval.",
    });
    expect(
      describeDesktopUpdateActionOutcome("install", {
        accepted: true,
        completed: false,
        state: {
          ...baseState,
          status: "downloaded",
          downloadedVersion: "1.1.0",
          errorContext: "install",
          message: "Couldn't install 1.1.0. Stark Code kept running.",
        },
      })?.type,
    ).toBe("error");
  });
});

describe("getDesktopUpdateReadyPromptVersion", () => {
  const ready: DesktopUpdateState = {
    ...baseState,
    status: "downloaded",
    availableVersion: "1.1.0",
    downloadedVersion: "1.1.0",
  };
  const now = Date.parse("2026-10-30T14:00:00.000Z");

  it("prompts for a ready update unless postponed, blocked or failed", () => {
    expect(getDesktopUpdateReadyPromptVersion(ready, now)).toBe("1.1.0");
    expect(
      getDesktopUpdateReadyPromptVersion(
        { ...ready, postponedUntil: "2026-10-31T14:00:00.000Z" },
        now,
      ),
    ).toBeNull();
    expect(
      getDesktopUpdateReadyPromptVersion(
        { ...ready, postponedUntil: "2026-10-29T14:00:00.000Z" },
        now,
      ),
    ).toBe("1.1.0");
    expect(
      getDesktopUpdateReadyPromptVersion(
        { ...ready, installBlockers: [{ kind: "active-task", message: "" }] },
        now,
      ),
    ).toBeNull();
    expect(getDesktopUpdateReadyPromptVersion({ ...baseState, status: "available" }, now)).toBe(
      null,
    );
  });
});

describe("describeDesktopUpdatePaletteAction", () => {
  it("offers the next step for the state, and a check that explains when updates are off", () => {
    expect(describeDesktopUpdatePaletteAction(null)).toBeNull();
    expect(
      describeDesktopUpdatePaletteAction({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
      })?.title,
    ).toBe("Restart to update to 1.1.0");
    expect(
      describeDesktopUpdatePaletteAction({
        ...baseState,
        enabled: false,
        status: "disabled",
        disabledReason: { code: "turned-off", message: "Turned off." },
      }),
    ).toEqual({ intent: "check", title: "Check for updates", description: "Turned off." });
  });
});
