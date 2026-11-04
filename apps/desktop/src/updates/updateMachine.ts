import type {
  DesktopRuntimeInfo,
  DesktopUpdateChannel,
  DesktopUpdateDisabledReason,
  DesktopUpdateDownloadProgress,
  DesktopUpdateErrorKind,
  DesktopUpdateInstallBlocker,
  DesktopUpdateReleaseNote,
  DesktopUpdateState,
  FailedUpdateReason,
} from "@starkfuture/contracts";
import * as Cause from "effect/Cause";

/** A classified updater failure and the sentence every entry point shows for it. */
export interface DesktopUpdateFailure {
  readonly kind: DesktopUpdateErrorKind;
  readonly message: string;
}

/** Who asked for a check: the user (shows progress and failures) or a poller (stays quiet). */
export type DesktopUpdateCheckOrigin = "manual" | "background";

type OptionalStateKey =
  | "disabledReason"
  | "errorKind"
  | "lastCheckError"
  | "downloadProgress"
  | "downloadRetry"
  | "postponedUntil"
  | "installBlockers"
  | "stagedVersion"
  | "skippedVersion";

function withoutKeys(
  state: DesktopUpdateState,
  keys: ReadonlyArray<OptionalStateKey>,
): DesktopUpdateState {
  const next = { ...state };
  for (const key of keys) delete next[key];
  return next;
}

const TRANSIENT_FAILURE_KEYS: ReadonlyArray<OptionalStateKey> = [
  "errorKind",
  "downloadProgress",
  "downloadRetry",
  "installBlockers",
];

export function createInitialDesktopUpdateState(
  currentVersion: string,
  runtimeInfo: DesktopRuntimeInfo,
  channel: DesktopUpdateChannel,
): DesktopUpdateState {
  return {
    enabled: false,
    status: "disabled",
    channel,
    currentVersion,
    hostArch: runtimeInfo.hostArch,
    appArch: runtimeInfo.appArch,
    runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
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
}

/** Updates are off for this run. The reason replaces any claim about being up to date. */
export function reduceDesktopUpdateStateOnDisabled(
  state: DesktopUpdateState,
  reason: DesktopUpdateDisabledReason,
): DesktopUpdateState {
  return {
    ...state,
    enabled: false,
    status: "disabled",
    disabledReason: reason,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

/**
 * A background check never changes what the user sees once something is
 * known: an available or downloaded update and "up to date" stay put while
 * the poll runs. Only a first check from `idle` shows `checking`.
 */
export function reduceDesktopUpdateStateOnCheckStart(
  state: DesktopUpdateState,
  checkedAt: string,
  origin: DesktopUpdateCheckOrigin = "manual",
): DesktopUpdateState {
  if (origin === "background" && state.status !== "idle") {
    return state;
  }
  const hasDownloadedUpdate = state.downloadedVersion !== null;
  return {
    ...withoutKeys(state, ["errorKind", "installBlockers"]),
    status: "checking",
    checkedAt,
    message: null,
    downloadPercent: hasDownloadedUpdate ? 100 : null,
    errorContext: null,
    canRetry: false,
  };
}

/**
 * A failed check keeps a known update. A manual check with nothing known
 * becomes an error the user can retry; a background one only records
 * `lastCheckError` unless nothing had been checked yet. Background updater
 * `error` events use the background rule too.
 */
export function reduceDesktopUpdateStateOnCheckFailure(
  state: DesktopUpdateState,
  failure: DesktopUpdateFailure,
  checkedAt: string,
  origin: DesktopUpdateCheckOrigin = "manual",
): DesktopUpdateState {
  const lastCheckError = { kind: failure.kind, message: failure.message, at: checkedAt };
  if (state.downloadedVersion !== null) {
    return {
      ...state,
      status: "downloaded",
      message: null,
      checkedAt,
      downloadPercent: 100,
      errorContext: null,
      canRetry: true,
      lastCheckError,
    };
  }
  if (state.availableVersion !== null) {
    return {
      ...state,
      status: "available",
      message: null,
      checkedAt,
      downloadPercent: null,
      errorContext: null,
      canRetry: true,
      lastCheckError,
    };
  }
  if (origin === "background" && state.status !== "checking" && state.status !== "idle") {
    return { ...state, lastCheckError };
  }

  return {
    ...state,
    status: "error",
    message: failure.message,
    checkedAt,
    downloadPercent: null,
    errorContext: "check",
    errorKind: failure.kind,
    canRetry: true,
    lastCheckError,
  };
}

export function reduceDesktopUpdateStateOnUpdateAvailable(
  state: DesktopUpdateState,
  version: string,
  checkedAt: string,
  releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote> = [],
  omittedReleaseCount = 0,
): DesktopUpdateState {
  const isDownloadedVersion = state.downloadedVersion === version;
  const preserveReleaseNotes = isDownloadedVersion && releaseNotes.length === 0;
  const base = withoutKeys(state, [
    "errorKind",
    "lastCheckError",
    "downloadProgress",
    "downloadRetry",
    "skippedVersion",
    ...(isDownloadedVersion ? [] : (["postponedUntil", "installBlockers"] as const)),
  ]);
  return {
    ...base,
    status: isDownloadedVersion ? "downloaded" : "available",
    availableVersion: version,
    downloadedVersion: isDownloadedVersion ? version : null,
    releaseNotes: preserveReleaseNotes ? state.releaseNotes : releaseNotes,
    omittedReleaseCount: preserveReleaseNotes ? state.omittedReleaseCount : omittedReleaseCount,
    downloadPercent: isDownloadedVersion ? 100 : null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: isDownloadedVersion,
  };
}

export function reduceDesktopUpdateStateOnNoUpdate(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  if (state.downloadedVersion !== null) {
    return {
      ...withoutKeys(state, ["errorKind", "lastCheckError"]),
      status: "downloaded",
      availableVersion: state.downloadedVersion,
      downloadPercent: 100,
      checkedAt,
      message: null,
      errorContext: null,
      canRetry: true,
    };
  }

  return {
    ...withoutKeys(state, [
      ...TRANSIENT_FAILURE_KEYS,
      "lastCheckError",
      "postponedUntil",
      "skippedVersion",
    ]),
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

/**
 * A background check found the version that failed on this data and did not
 * offer it: nothing is downloaded, and `skippedVersion` says what was passed over.
 */
export function reduceDesktopUpdateStateOnSkippedUpdate(
  state: DesktopUpdateState,
  version: string,
  checkedAt: string,
): DesktopUpdateState {
  return { ...reduceDesktopUpdateStateOnNoUpdate(state, checkedAt), skippedVersion: version };
}

/** An update that failed on this data (`failed-update.json`, written by the server). */
export interface DesktopFailedUpdate {
  readonly failedVersion: string;
  readonly reason: FailedUpdateReason;
}

/**
 * Whether a check's offer of `version` is passed over: it is the version that
 * failed on this data, the check was a background one, and the user has not
 * already taken that version up in this run. A check the user starts offers it.
 */
export function shouldSkipFailedUpdate(input: {
  readonly state: DesktopUpdateState;
  readonly version: string;
  readonly failed: DesktopFailedUpdate | null;
  readonly origin: DesktopUpdateCheckOrigin;
}): boolean {
  return (
    input.failed !== null &&
    input.version === input.failed.failedVersion &&
    input.origin === "background" &&
    input.state.availableVersion !== input.version &&
    input.state.downloadedVersion !== input.version
  );
}

export function reduceDesktopUpdateStateOnDownloadStart(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return {
    ...withoutKeys(state, TRANSIENT_FAILURE_KEYS),
    status: "downloading",
    downloadPercent: 0,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

/**
 * A failed download keeps the offered version so it can be retried.
 * `retry` is the automatic attempt already scheduled, if any.
 */
export function reduceDesktopUpdateStateOnDownloadFailure(
  state: DesktopUpdateState,
  failure: DesktopUpdateFailure,
  retry?: { readonly attempt: number; readonly nextAttemptAt: string },
): DesktopUpdateState {
  const hasVersion = state.availableVersion !== null;
  return {
    ...withoutKeys(state, ["downloadProgress", "downloadRetry"]),
    status: hasVersion ? "available" : "error",
    message: failure.message,
    downloadPercent: null,
    errorContext: "download",
    errorKind: failure.kind,
    canRetry: hasVersion,
    ...(retry ? { downloadRetry: retry } : {}),
  };
}

/** The user stopped the download. The update is still offered. */
export function reduceDesktopUpdateStateOnDownloadCancelled(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return {
    ...withoutKeys(state, TRANSIENT_FAILURE_KEYS),
    status: state.availableVersion !== null ? "available" : "idle",
    downloadedVersion: null,
    downloadPercent: null,
    message: null,
    errorContext: null,
    canRetry: state.availableVersion !== null,
  };
}

export function reduceDesktopUpdateStateOnDownloadProgress(
  state: DesktopUpdateState,
  percent: number,
  progress?: DesktopUpdateDownloadProgress,
): DesktopUpdateState {
  return {
    ...withoutKeys(state, ["downloadProgress", "errorKind", "downloadRetry"]),
    status: "downloading",
    downloadPercent: percent,
    message: null,
    errorContext: null,
    canRetry: false,
    ...(progress ? { downloadProgress: progress } : {}),
  };
}

/** The download finished; it is checked before it is offered for a restart. */
export function reduceDesktopUpdateStateOnVerifyStart(
  state: DesktopUpdateState,
  version: string,
): DesktopUpdateState {
  return {
    ...withoutKeys(state, TRANSIENT_FAILURE_KEYS),
    status: "verifying",
    availableVersion: version,
    downloadedVersion: null,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

/** The download failed its check and was discarded; it has to be downloaded again. */
export function reduceDesktopUpdateStateOnVerifyFailure(
  state: DesktopUpdateState,
  failure: DesktopUpdateFailure,
): DesktopUpdateState {
  return {
    ...withoutKeys(state, TRANSIENT_FAILURE_KEYS),
    status: "available",
    downloadedVersion: null,
    downloadPercent: null,
    message: failure.message,
    errorContext: "download",
    errorKind: failure.kind,
    canRetry: true,
  };
}

/** Ready to restart. A newer version than the one postponed prompts again. */
export function reduceDesktopUpdateStateOnDownloadComplete(
  state: DesktopUpdateState,
  version: string,
): DesktopUpdateState {
  const isNewVersion = state.downloadedVersion !== version;
  return {
    ...withoutKeys(state, [
      ...TRANSIENT_FAILURE_KEYS,
      ...(isNewVersion ? (["postponedUntil"] as const) : []),
    ]),
    status: "downloaded",
    availableVersion: version,
    downloadedVersion: version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: true,
  };
}

/** "Later" keeps the ready update and mutes prompts; `null` undoes it. */
export function reduceDesktopUpdateStateOnPostpone(
  state: DesktopUpdateState,
  postponedUntil: string | null,
): DesktopUpdateState {
  if (postponedUntil === null) return withoutKeys(state, ["postponedUntil"]);
  if (state.downloadedVersion === null) return state;
  return { ...state, postponedUntil };
}

/** The user asked to restart: preconditions are checked and drafts saved. */
export function reduceDesktopUpdateStateOnInstallPreparing(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return {
    ...withoutKeys(state, ["installBlockers", "errorKind", "postponedUntil"]),
    status: "preparing",
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

/** Something must finish first. Nothing was stopped; the update stays ready. */
export function reduceDesktopUpdateStateOnInstallBlocked(
  state: DesktopUpdateState,
  blockers: ReadonlyArray<DesktopUpdateInstallBlocker>,
): DesktopUpdateState {
  return {
    ...withoutKeys(state, ["errorKind"]),
    status: "downloaded",
    installBlockers: blockers,
    message: summarizeDesktopUpdateInstallBlockers(blockers),
    errorContext: null,
    canRetry: true,
  };
}

/** The backends are stopping and the installer is taking over. */
export function reduceDesktopUpdateStateOnRestarting(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return { ...state, status: "restarting", message: null, errorContext: null, canRetry: false };
}

export function reduceDesktopUpdateStateOnInstallFailure(
  state: DesktopUpdateState,
  failure: DesktopUpdateFailure,
): DesktopUpdateState {
  // A signature the installer rejected will not pass on a retry of the same
  // download: drop it so the next attempt downloads again.
  if (failure.kind === "signature" || failure.kind === "invalid-artifact") {
    return {
      ...withoutKeys(state, ["installBlockers"]),
      status: "available",
      downloadedVersion: null,
      downloadPercent: null,
      message: failure.message,
      errorContext: "install",
      errorKind: failure.kind,
      canRetry: state.availableVersion !== null,
    };
  }
  return {
    ...withoutKeys(state, ["installBlockers"]),
    status: "downloaded",
    message: failure.message,
    errorContext: "install",
    errorKind: failure.kind,
    canRetry: true,
  };
}

/** The installer accepted the update after Stark Code gave up waiting. It installs on the next quit. */
export function reduceDesktopUpdateStateOnLateStaged(
  state: DesktopUpdateState,
  version: string,
): DesktopUpdateState {
  return { ...state, stagedVersion: version };
}

/** The install this app handed to the OS installer, saved right before it quits. */
export interface DesktopUpdateInstallRecord {
  readonly fromVersion: string;
  readonly targetVersion: string;
}

/**
 * Read on the next start: the version an install did not apply, because the
 * app came back on the version it installed from. Null when the install
 * applied, or when the app now runs some other version.
 */
export function resolveNotAppliedInstallVersion(
  record: DesktopUpdateInstallRecord,
  appVersion: string,
): string | null {
  return record.fromVersion === appVersion && record.targetVersion !== appVersion
    ? record.targetVersion
    : null;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

const FEED_INVALID_CODES = new Set([
  // Our own refusals: a manifest naming files outside the feed, and a request
  // or redirect leaving it. Neither gets better by trying again.
  "ERR_STARK_UPDATE_FEED_INVALID",
  "ERR_STARK_UPDATE_REQUEST_REFUSED",
  "ERR_UPDATER_INVALID_UPDATE_INFO",
  "ERR_UPDATER_INVALID_VERSION",
  "ERR_UPDATER_ZIP_FILE_NOT_FOUND",
  "ERR_UPDATER_NO_FILES_PROVIDED",
  "ERR_UPDATER_INVALID_RELEASE_FEED",
  "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
]);

const FEED_UNAVAILABLE_CODES = new Set([
  "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
  "ERR_UPDATER_ASSET_NOT_FOUND",
]);

interface CauseFacts {
  readonly codes: Set<string>;
  readonly messages: string[];
  readonly statusCodes: number[];
}

function collectCauseFacts(cause: unknown, facts: CauseFacts, depth: number): void {
  if (depth > 6 || cause === null || cause === undefined) return;
  if (Cause.isCause(cause)) {
    for (const reason of cause.reasons.slice(0, 4)) {
      if (reason._tag === "Fail") collectCauseFacts(reason.error, facts, depth + 1);
      else if (reason._tag === "Die") collectCauseFacts(reason.defect, facts, depth + 1);
    }
    return;
  }
  if (typeof cause === "string") {
    facts.messages.push(cause);
    return;
  }
  if (typeof cause !== "object") return;
  try {
    const error = cause as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly statusCode?: unknown;
      readonly cause?: unknown;
      readonly name?: unknown;
    };
    if (typeof error.code === "string") facts.codes.add(error.code);
    if (typeof error.statusCode === "number") facts.statusCodes.push(error.statusCode);
    if (typeof error.message === "string") facts.messages.push(error.message.slice(0, 2048));
    if (typeof error.name === "string" && error.name === "YAMLException") {
      facts.codes.add("ERR_UPDATER_INVALID_UPDATE_INFO");
    }
    if (error.cause !== cause) collectCauseFacts(error.cause, facts, depth + 1);
  } catch {
    // An unreadable error carries no facts.
  }
}

/**
 * Sorts an updater failure into what the user can act on. A failed
 * connection is `unreachable`; it becomes `offline` only when `isOnline`
 * says this machine has no network, since a broken feed host or a stopped
 * server fails the same way.
 */
export function classifyDesktopUpdateError(
  cause: unknown,
  isOnline: boolean | null,
): DesktopUpdateErrorKind {
  const facts: CauseFacts = { codes: new Set(), messages: [], statusCodes: [] };
  collectCauseFacts(cause, facts, 0);
  const text = facts.messages.join("\n");
  const has = (set: ReadonlySet<string>) => [...facts.codes].some((code) => set.has(code));

  if (facts.codes.has("ENOSPC") || /\bENOSPC\b|no space left on device/i.test(text)) {
    return "disk-full";
  }
  if (
    facts.codes.has("ERR_CHECKSUM_MISMATCH") ||
    /sha512 checksum mismatch|checksum mismatch/i.test(text)
  ) {
    return "invalid-artifact";
  }
  if (/code signature|did not pass validation|code requirement|not signed/i.test(text)) {
    return "signature";
  }
  if (has(FEED_INVALID_CODES)) return "feed-invalid";
  if (
    has(FEED_UNAVAILABLE_CODES) ||
    facts.statusCodes.some((status) => status >= 400) ||
    [...facts.codes].some((code) => /^HTTP_ERROR_\d{3}$/.test(code))
  ) {
    return "feed-unavailable";
  }
  const isNetwork =
    has(NETWORK_ERROR_CODES) ||
    [...facts.codes].some((code) => code.startsWith("ERR_NETWORK")) ||
    /net::ERR_[A-Z_]+/.test(text);
  if (isNetwork) return isOnline === false ? "offline" : "unreachable";
  if (isOnline === false) return "offline";
  return "unknown";
}

export type DesktopUpdateFailureContext = "check" | "download" | "install";

/** The one sentence every entry point shows for a failure. Never includes raw causes. */
export function describeDesktopUpdateFailure(
  kind: DesktopUpdateErrorKind,
  context: DesktopUpdateFailureContext,
  version: string | null,
): string {
  const target = version ?? "the update";
  if (context === "check") {
    switch (kind) {
      case "offline":
        return "You're offline. Stark Code checks again when you're back online.";
      case "unreachable":
        return "Couldn't reach the update server.";
      case "feed-unavailable":
        return "The update server returned an error.";
      case "feed-invalid":
        return "The update server returned an invalid release.";
      case "disk-full":
        return "Not enough disk space to check for updates.";
      default:
        return "Couldn't check for updates.";
    }
  }
  if (context === "download") {
    switch (kind) {
      case "offline":
        return `Download of ${target} stopped: you're offline.`;
      case "unreachable":
        return `Couldn't reach the update server to download ${target}.`;
      case "feed-unavailable":
        return `The update server returned an error while downloading ${target}.`;
      case "feed-invalid":
        return `The update server returned an invalid release for ${target}.`;
      case "invalid-artifact":
        return `The download for ${target} was damaged, so it was deleted.`;
      case "signature":
        return `The download for ${target} isn't signed by Stark Future, so it was deleted.`;
      case "disk-full":
        return `Not enough disk space to download ${target}.`;
      default:
        return `Couldn't download ${target}.`;
    }
  }
  switch (kind) {
    case "signature":
    case "invalid-artifact":
      return `Couldn't install ${target}: the installer rejected its signature. Nothing was installed.`;
    case "install-stalled":
      return `Couldn't install ${target}: the installer didn't respond. Stark Code kept running.`;
    case "disk-full":
      return `Not enough disk space to install ${target}. Stark Code kept running.`;
    default:
      return `Couldn't install ${target}. Stark Code kept running.`;
  }
}

/** Delays before automatic download retries, in order. */
const DESKTOP_UPDATE_DOWNLOAD_RETRY_DELAYS_MS: ReadonlyArray<number> = [30_000, 120_000, 600_000];

/**
 * How long to wait before retrying a failed download on its own, or null to
 * stop. A full disk or a bad signature needs the user; a damaged download is
 * retried once; network and server failures back off three times.
 */
export function nextDesktopUpdateDownloadRetryDelay(
  kind: DesktopUpdateErrorKind,
  attempt: number,
): number | null {
  switch (kind) {
    case "disk-full":
    case "signature":
    case "feed-invalid":
    case "install-stalled":
      return null;
    case "invalid-artifact":
      return attempt === 0 ? (DESKTOP_UPDATE_DOWNLOAD_RETRY_DELAYS_MS[0] ?? null) : null;
    default:
      return DESKTOP_UPDATE_DOWNLOAD_RETRY_DELAYS_MS[attempt] ?? null;
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function describeBlocker(blocker: DesktopUpdateInstallBlocker): string {
  const count = blocker.count ?? 1;
  switch (blocker.kind) {
    case "active-task":
      return `${count} ${plural(count, "task is", "tasks are")} running`;
    case "pending-approval":
      return `${count} ${plural(count, "task is", "tasks are")} waiting for your approval`;
    case "send-in-progress":
      return `${plural(count, "a message is", `${count} messages are`)} still sending`;
    case "upload-in-progress":
      return `${plural(count, "a file is", `${count} files are`)} still uploading`;
    case "image-encoding":
      return `${plural(count, "an image is", `${count} images are`)} still being saved`;
    case "backend-busy":
      return "a Stark server is still busy";
    case "maintenance-unavailable":
      return "it can't yet confirm that no task or approval would be interrupted";
    case "unsaved-draft":
      return `${plural(count, "a draft", `${count} drafts`)} couldn't be saved`;
    case "storage-failed":
      return "drafts couldn't be written to disk";
    case "window-unresponsive":
      return `${plural(count, "a window", `${count} windows`)} didn't confirm ${plural(count, "its", "their")} drafts were saved`;
  }
}

/**
 * One sentence for every entry point, e.g. "Stark Code can't restart yet:
 * 2 tasks are running and 1 task is waiting for your approval."
 */
export function summarizeDesktopUpdateInstallBlockers(
  blockers: ReadonlyArray<DesktopUpdateInstallBlocker>,
): string {
  if (blockers.length === 0) return "Stark Code can't restart yet.";
  const parts = [...new Set(blockers.map(describeBlocker))];
  const joined =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Stark Code can't restart yet: ${joined}.`;
}
