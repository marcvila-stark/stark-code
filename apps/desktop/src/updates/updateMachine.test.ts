import { describe, expect, it } from "vite-plus/test";

import * as Cause from "effect/Cause";

import { StarkUpdateFeedInvalidError } from "./updateFeedPolicy.ts";
import {
  classifyDesktopUpdateError,
  createInitialDesktopUpdateState,
  describeDesktopUpdateFailure,
  nextDesktopUpdateDownloadRetryDelay,
  reduceDesktopUpdateStateOnDisabled,
  reduceDesktopUpdateStateOnDownloadCancelled,
  reduceDesktopUpdateStateOnInstallBlocked,
  reduceDesktopUpdateStateOnInstallPreparing,
  reduceDesktopUpdateStateOnPostpone,
  reduceDesktopUpdateStateOnVerifyFailure,
  reduceDesktopUpdateStateOnVerifyStart,
  summarizeDesktopUpdateInstallBlockers,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnSkippedUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
  resolveNotAppliedInstallVersion,
  shouldSkipFailedUpdate,
} from "./updateMachine.ts";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

const NETWORK_DOWN = { kind: "unreachable", message: "Couldn't reach the update server." } as const;
const enabledState = (
  overrides: Partial<ReturnType<typeof createInitialDesktopUpdateState>> = {},
) => ({
  ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
  enabled: true,
  status: "idle" as const,
  ...overrides,
});

describe("updateMachine", () => {
  it("clears transient errors when a check starts", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        message: "network",
        errorContext: "check",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("checking");
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
    expect(state.canRetry).toBe(false);
  });

  it("records a check failure without exposing an action", () => {
    const state = reduceDesktopUpdateStateOnCheckFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      NETWORK_DOWN,
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.errorKind).toBe("unreachable");
    expect(state.message).toBe("Couldn't reach the update server.");
    expect(state.canRetry).toBe(true);
  });

  it("preserves an already-downloaded update while checking the feed", () => {
    const downloadedState = {
      ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
      enabled: true,
      status: "downloaded" as const,
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      releaseNotes: [{ version: "1.1.0", items: ["fix: queued update"], totalItems: 1 }],
      omittedReleaseCount: 2,
      downloadPercent: 100,
    };
    const checking = reduceDesktopUpdateStateOnCheckStart(
      downloadedState,
      "2026-03-04T00:00:00.000Z",
    );
    const failed = reduceDesktopUpdateStateOnCheckFailure(
      checking,
      NETWORK_DOWN,
      "2026-03-04T00:00:01.000Z",
    );

    expect(checking.status).toBe("checking");
    expect(checking.downloadedVersion).toBe("1.1.0");
    expect(checking.releaseNotes).toEqual(downloadedState.releaseNotes);
    expect(checking.omittedReleaseCount).toBe(2);
    expect(failed.status).toBe("downloaded");
    expect(failed.downloadedVersion).toBe("1.1.0");
    expect(failed.releaseNotes).toEqual(downloadedState.releaseNotes);
    expect(failed.omittedReleaseCount).toBe(2);
    expect(failed.message).toBeNull();
  });

  it("keeps the installer when the feed still offers its version", () => {
    const releaseNotes = [{ version: "1.1.0", items: ["fix: queued update"], totalItems: 1 }];
    const state = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        releaseNotes,
        omittedReleaseCount: 2,
        downloadPercent: 100,
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("downloaded");
    expect(state.downloadedVersion).toBe("1.1.0");
    expect(state.releaseNotes).toEqual(releaseNotes);
    expect(state.omittedReleaseCount).toBe(2);
    expect(state.downloadPercent).toBe(100);
  });

  it("preserves available version on download failure for retry", () => {
    const state = reduceDesktopUpdateStateOnDownloadFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 43,
      },
      {
        kind: "invalid-artifact",
        message: "The download for 1.1.0 was damaged, so it was deleted.",
      },
    );

    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.errorContext).toBe("download");
    expect(state.canRetry).toBe(true);
  });

  it("transitions to downloaded and then preserves install retry state", () => {
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
      },
      "1.1.0",
    );
    const failedInstall = reduceDesktopUpdateStateOnInstallFailure(downloaded, {
      kind: "install-stalled",
      message: "Couldn't install 1.1.0: the installer didn't respond. Stark Code kept running.",
    });

    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.downloadedVersion).toBe("1.1.0");
    expect(failedInstall.status).toBe("downloaded");
    expect(failedInstall.errorContext).toBe("install");
    expect(failedInstall.canRetry).toBe(true);
  });

  it("preserves a downloaded update when no update is available", () => {
    const releaseNotes = [{ version: "1.1.0", items: ["fix: queued update"], totalItems: 1 }];
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        releaseNotes,
        omittedReleaseCount: 2,
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("downloaded");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.downloadedVersion).toBe("1.1.0");
    expect(state.releaseNotes).toBe(releaseNotes);
    expect(state.omittedReleaseCount).toBe(2);
    expect(state.downloadPercent).toBe(100);
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
    expect(state.canRetry).toBe(true);
  });

  it("clears stale available state when no update is available", () => {
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        releaseNotes: [{ version: "1.1.0", items: ["fix: stale update"], totalItems: 1 }],
        omittedReleaseCount: 2,
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
    expect(state.downloadedVersion).toBeNull();
    expect(state.releaseNotes).toEqual([]);
    expect(state.omittedReleaseCount).toBe(0);
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
  });

  it("tracks available, download start, and progress cleanly", () => {
    const releaseNotes = [
      {
        version: "1.1.0",
        items: ["feat: add update release notes"],
        totalItems: 1,
      },
    ];
    const available = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
      releaseNotes,
      2,
    );
    const downloading = reduceDesktopUpdateStateOnDownloadStart(available);
    const progress = reduceDesktopUpdateStateOnDownloadProgress(downloading, 55.5);

    expect(available.status).toBe("available");
    expect(available.channel).toBe("latest");
    expect(available.releaseNotes).toBe(releaseNotes);
    expect(available.omittedReleaseCount).toBe(2);
    expect(downloading.releaseNotes).toBe(releaseNotes);
    expect(downloading.status).toBe("downloading");
    expect(downloading.downloadPercent).toBe(0);
    expect(progress.downloadPercent).toBe(55.5);
    expect(progress.errorContext).toBeNull();
  });

  it("keeps release notes through a manual check until its result replaces them", () => {
    const available = {
      ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "nightly"),
      enabled: true,
      status: "available" as const,
      availableVersion: "1.1.0-nightly.1",
      releaseNotes: [{ version: "1.1.0-nightly.1", items: ["feat: old note"], totalItems: 1 }],
      omittedReleaseCount: 2,
    };
    const checking = reduceDesktopUpdateStateOnCheckStart(available, "2026-03-04T00:00:00.000Z");
    expect(checking.status).toBe("checking");
    expect(checking.releaseNotes).toEqual(available.releaseNotes);

    const failed = reduceDesktopUpdateStateOnCheckFailure(
      checking,
      NETWORK_DOWN,
      "2026-03-04T00:00:01.000Z",
    );
    expect(failed.status).toBe("available");
    expect(failed.releaseNotes).toEqual(available.releaseNotes);
    expect(failed.lastCheckError?.kind).toBe("unreachable");
    expect(failed.message).toBeNull();
  });

  it("leaves the visible state alone during and after a failed background check", () => {
    const upToDate = enabledState({ status: "up-to-date", checkedAt: "2026-03-04T00:00:00.000Z" });
    const polling = reduceDesktopUpdateStateOnCheckStart(
      upToDate,
      "2026-03-04T01:00:00.000Z",
      "background",
    );
    expect(polling).toBe(upToDate);

    const failed = reduceDesktopUpdateStateOnCheckFailure(
      polling,
      NETWORK_DOWN,
      "2026-03-04T01:00:01.000Z",
      "background",
    );
    expect(failed.status).toBe("up-to-date");
    expect(failed.message).toBeNull();
    expect(failed.lastCheckError).toEqual({ ...NETWORK_DOWN, at: "2026-03-04T01:00:01.000Z" });

    // Nothing was known yet: the first background check shows its failure.
    const first = reduceDesktopUpdateStateOnCheckFailure(
      reduceDesktopUpdateStateOnCheckStart(
        enabledState(),
        "2026-03-04T00:00:00.000Z",
        "background",
      ),
      NETWORK_DOWN,
      "2026-03-04T00:00:01.000Z",
      "background",
    );
    expect(first.status).toBe("error");
  });

  it("names the reason updates are off and drops it from no other state", () => {
    const state = reduceDesktopUpdateStateOnDisabled(enabledState(), {
      code: "development-build",
      message: "Automatic updates are off: this is a development build.",
    });
    expect(state.status).toBe("disabled");
    expect(state.enabled).toBe(false);
    expect(state.disabledReason?.code).toBe("development-build");
  });

  it("verifies a finished download before offering it, and drops a rejected one", () => {
    const verifying = reduceDesktopUpdateStateOnVerifyStart(
      enabledState({ status: "downloading", availableVersion: "1.1.0", downloadPercent: 99 }),
      "1.1.0",
    );
    expect(verifying.status).toBe("verifying");
    expect(verifying.downloadedVersion).toBeNull();

    const rejected = reduceDesktopUpdateStateOnVerifyFailure(verifying, {
      kind: "signature",
      message: "The download for 1.1.0 isn't signed by Stark Future, so it was deleted.",
    });
    expect(rejected.status).toBe("available");
    expect(rejected.downloadedVersion).toBeNull();
    expect(rejected.errorKind).toBe("signature");
    expect(rejected.canRetry).toBe(true);
  });

  it("cancels a download back to the offered update", () => {
    const state = reduceDesktopUpdateStateOnDownloadCancelled(
      enabledState({
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 40,
        downloadProgress: { transferredBytes: 40, totalBytes: 100, bytesPerSecond: 10 },
      }),
    );
    expect(state.status).toBe("available");
    expect(state.downloadPercent).toBeNull();
    expect(state.downloadProgress).toBeUndefined();
  });

  it("keeps the ready update when a restart is blocked and clears the block on the next try", () => {
    const ready = reduceDesktopUpdateStateOnDownloadComplete(
      enabledState({ status: "downloading", availableVersion: "1.1.0" }),
      "1.1.0",
    );
    const blocked = reduceDesktopUpdateStateOnInstallBlocked(
      reduceDesktopUpdateStateOnInstallPreparing(ready),
      [{ kind: "pending-approval", message: "A task needs your approval.", count: 1 }],
    );
    expect(blocked.status).toBe("downloaded");
    expect(blocked.downloadedVersion).toBe("1.1.0");
    expect(blocked.message).toBe(
      "Stark Code can't restart yet: 1 task is waiting for your approval.",
    );
    const retrying = reduceDesktopUpdateStateOnInstallPreparing(blocked);
    expect(retrying.status).toBe("preparing");
    expect(retrying.installBlockers).toBeUndefined();
  });

  it("drops a download the installer rejected as unsigned so it is downloaded again", () => {
    const ready = reduceDesktopUpdateStateOnDownloadComplete(
      enabledState({ status: "downloading", availableVersion: "1.1.0" }),
      "1.1.0",
    );
    const failed = reduceDesktopUpdateStateOnInstallFailure(ready, {
      kind: "signature",
      message: describeDesktopUpdateFailure("signature", "install", "1.1.0"),
    });
    expect(failed.status).toBe("available");
    expect(failed.downloadedVersion).toBeNull();
    expect(failed.errorContext).toBe("install");
  });

  it("postpones only a ready update, and a newer download prompts again", () => {
    expect(reduceDesktopUpdateStateOnPostpone(enabledState(), "2026-03-05T00:00:00.000Z")).toEqual(
      enabledState(),
    );
    const ready = reduceDesktopUpdateStateOnDownloadComplete(
      enabledState({ status: "downloading", availableVersion: "1.1.0" }),
      "1.1.0",
    );
    const postponed = reduceDesktopUpdateStateOnPostpone(ready, "2026-03-05T00:00:00.000Z");
    expect(postponed.postponedUntil).toBe("2026-03-05T00:00:00.000Z");
    expect(reduceDesktopUpdateStateOnPostpone(postponed, null).postponedUntil).toBeUndefined();
    expect(reduceDesktopUpdateStateOnDownloadComplete(postponed, "1.1.0").postponedUntil).toBe(
      "2026-03-05T00:00:00.000Z",
    );
    expect(reduceDesktopUpdateStateOnDownloadComplete(postponed, "1.2.0").postponedUntil).toBe(
      undefined,
    );
  });
});

describe("failed updates", () => {
  const failed = { failedVersion: "1.1.0", reason: "migration-failed" } as const;

  it("skips the version that failed on this data only for a background check", () => {
    const state = enabledState({ status: "up-to-date" });
    expect(shouldSkipFailedUpdate({ state, version: "1.1.0", failed, origin: "background" })).toBe(
      true,
    );
    // The user asked: the failed version is offered again.
    expect(shouldSkipFailedUpdate({ state, version: "1.1.0", failed, origin: "manual" })).toBe(
      false,
    );
    // Another version is offered as usual.
    expect(shouldSkipFailedUpdate({ state, version: "1.2.0", failed, origin: "background" })).toBe(
      false,
    );
    expect(
      shouldSkipFailedUpdate({ state, version: "1.1.0", failed: null, origin: "background" }),
    ).toBe(false);
    // Once the user took it up, a later poll does not hide it again.
    expect(
      shouldSkipFailedUpdate({
        state: enabledState({ status: "downloaded", downloadedVersion: "1.1.0" }),
        version: "1.1.0",
        failed,
        origin: "background",
      }),
    ).toBe(false);
  });

  it("reports a skipped version without offering it, until something replaces it", () => {
    const skipped = reduceDesktopUpdateStateOnSkippedUpdate(
      enabledState(),
      "1.1.0",
      "2026-10-31T00:00:00.000Z",
    );
    expect(skipped).toMatchObject({
      status: "up-to-date",
      availableVersion: null,
      downloadedVersion: null,
      skippedVersion: "1.1.0",
    });
    expect(
      reduceDesktopUpdateStateOnUpdateAvailable(skipped, "1.1.0", "2026-10-31T01:00:00.000Z")
        .skippedVersion,
    ).toBeUndefined();
    expect(
      reduceDesktopUpdateStateOnNoUpdate(skipped, "2026-10-31T01:00:00.000Z").skippedVersion,
    ).toBeUndefined();
  });
});

describe("classifyDesktopUpdateError", () => {
  const withCode = (code: string, message = code) => Object.assign(new Error(message), { code });

  it.each([
    ["ENOTFOUND", true, "unreachable"],
    ["ECONNREFUSED", true, "unreachable"],
    ["ECONNRESET", null, "unreachable"],
    ["ETIMEDOUT", true, "unreachable"],
    ["ENOTFOUND", false, "offline"],
    ["ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", true, "feed-unavailable"],
    ["HTTP_ERROR_503", true, "feed-unavailable"],
    ["ERR_UPDATER_INVALID_UPDATE_INFO", true, "feed-invalid"],
    ["ERR_UPDATER_INVALID_VERSION", true, "feed-invalid"],
    ["ERR_UPDATER_ZIP_FILE_NOT_FOUND", true, "feed-invalid"],
    ["ERR_STARK_UPDATE_FEED_INVALID", true, "feed-invalid"],
    ["ERR_STARK_UPDATE_REQUEST_REFUSED", true, "feed-invalid"],
    ["ERR_CHECKSUM_MISMATCH", true, "invalid-artifact"],
    ["ENOSPC", true, "disk-full"],
    ["ESOMETHINGELSE", true, "unknown"],
  ] as const)("%s with online=%s is %s", (code, isOnline, kind) => {
    expect(classifyDesktopUpdateError(withCode(code), isOnline)).toBe(kind);
  });

  it("reads codes through tagged-error causes and Effect causes", () => {
    const nested = { _tag: "ElectronUpdaterCheckForUpdatesError", cause: withCode("ENOTFOUND") };
    expect(classifyDesktopUpdateError(Cause.fail(nested), true)).toBe("unreachable");
    // A hostile manifest refused by isUpdateSupported, as electron-updater rethrows it.
    const hostile = {
      _tag: "ElectronUpdaterCheckForUpdatesError",
      cause: new StarkUpdateFeedInvalidError({ problem: "file-url" }),
    };
    expect(classifyDesktopUpdateError(Cause.fail(hostile), true)).toBe("feed-invalid");
    expect(classifyDesktopUpdateError(Cause.die(withCode("ENOSPC")), true)).toBe("disk-full");
  });

  it("reads HTTP status codes, Chromium network errors and Squirrel signature errors", () => {
    expect(
      classifyDesktopUpdateError(Object.assign(new Error("Not Found"), { statusCode: 404 }), true),
    ).toBe("feed-unavailable");
    expect(classifyDesktopUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED"), null)).toBe(
      "unreachable",
    );
    expect(
      classifyDesktopUpdateError(
        new Error(
          "Code signature at URL file:///x did not pass validation: code failed to satisfy specified code requirement(s)",
        ),
        true,
      ),
    ).toBe("signature");
    expect(classifyDesktopUpdateError({ name: "YAMLException", message: "bad" }, true)).toBe(
      "feed-invalid",
    );
  });

  it("never claims offline without evidence", () => {
    expect(classifyDesktopUpdateError(new Error("something odd"), null)).toBe("unknown");
    expect(classifyDesktopUpdateError(new Error("something odd"), false)).toBe("offline");
  });
});

describe("describeDesktopUpdateFailure", () => {
  it("never shows raw causes and names the version", () => {
    expect(describeDesktopUpdateFailure("feed-invalid", "check", null)).toBe(
      "The update server returned an invalid release.",
    );
    expect(describeDesktopUpdateFailure("invalid-artifact", "download", "1.2.4")).toBe(
      "The download for 1.2.4 was damaged, so it was deleted.",
    );
    expect(describeDesktopUpdateFailure("install-stalled", "install", "1.2.4")).toBe(
      "Couldn't install 1.2.4: the installer didn't respond. Stark Code kept running.",
    );
  });
});

describe("nextDesktopUpdateDownloadRetryDelay", () => {
  it("backs off three times for network failures and stops for the user's problems", () => {
    expect(
      [0, 1, 2, 3].map((attempt) => nextDesktopUpdateDownloadRetryDelay("unreachable", attempt)),
    ).toEqual([30_000, 120_000, 600_000, null]);
    expect(nextDesktopUpdateDownloadRetryDelay("invalid-artifact", 0)).toBe(30_000);
    expect(nextDesktopUpdateDownloadRetryDelay("invalid-artifact", 1)).toBeNull();
    for (const kind of ["disk-full", "signature", "feed-invalid"] as const) {
      expect(nextDesktopUpdateDownloadRetryDelay(kind, 0)).toBeNull();
    }
  });
});

describe("summarizeDesktopUpdateInstallBlockers", () => {
  it("reads as one sentence with counts", () => {
    expect(
      summarizeDesktopUpdateInstallBlockers([
        { kind: "active-task", message: "", count: 2 },
        { kind: "pending-approval", message: "", count: 1 },
        { kind: "upload-in-progress", message: "", count: 1 },
      ]),
    ).toBe(
      "Stark Code can't restart yet: 2 tasks are running, 1 task is waiting for your approval and a file is still uploading.",
    );
    expect(
      summarizeDesktopUpdateInstallBlockers([{ kind: "maintenance-unavailable", message: "" }]),
    ).toBe(
      "Stark Code can't restart yet: it can't yet confirm that no task or approval would be interrupted.",
    );
  });
});

describe("resolveNotAppliedInstallVersion", () => {
  const record = { fromVersion: "1.2.3", targetVersion: "1.2.4" };

  it("flags the target when the app came back on the version it installed from", () => {
    expect(resolveNotAppliedInstallVersion(record, "1.2.3")).toBe("1.2.4");
  });

  it("stays quiet when the install applied or the app runs another version", () => {
    expect(resolveNotAppliedInstallVersion(record, "1.2.4")).toBeNull();
    expect(resolveNotAppliedInstallVersion(record, "1.2.5")).toBeNull();
  });
});
