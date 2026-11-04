import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  DesktopUpdateChannelSchema,
  FAILED_UPDATE_FILE,
  FailedUpdate,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateDisabledReason,
  type DesktopUpdateInstallBlocker,
  type DesktopUpdateRestartAck,
  type DesktopUpdateState,
} from "@starkfuture/contracts";
import { errorTag } from "@starkfuture/shared/observability";
import { compareSemverVersions } from "@starkfuture/shared/semver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import * as RestartPreservation from "./restartPreservation.ts";
import {
  DesktopEnabledUpdateChannels,
  resolveDefaultDesktopUpdateChannel,
} from "./updateChannels.ts";
import * as UpdateArtifactVerification from "./updateArtifactVerification.ts";
import * as UpdateFeedGate from "./updateFeedGate.ts";
import * as UpdateInstallGate from "./updateInstallGate.ts";
import * as DesktopInstallPreflight from "./DesktopInstallPreflight.ts";
import * as UpdateLifecycle from "./updateLifecycle.ts";
import {
  classifyDesktopUpdateError,
  createInitialDesktopUpdateState,
  describeDesktopUpdateFailure,
  type DesktopUpdateCheckOrigin,
  type DesktopUpdateFailure,
  type DesktopUpdateFailureContext,
  nextDesktopUpdateDownloadRetryDelay,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDisabled,
  reduceDesktopUpdateStateOnDownloadCancelled,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallBlocked,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnInstallPreparing,
  reduceDesktopUpdateStateOnLateStaged,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnPostpone,
  reduceDesktopUpdateStateOnRestarting,
  reduceDesktopUpdateStateOnSkippedUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
  reduceDesktopUpdateStateOnVerifyFailure,
  reduceDesktopUpdateStateOnVerifyStart,
  resolveNotAppliedInstallVersion,
  shouldSkipFailedUpdate,
  type DesktopFailedUpdate,
} from "./updateMachine.ts";
import * as UpdateSeams from "./updateSeams.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "60 minutes";
const PREPARED_INSTALL_CHECK_WAIT = Duration.seconds(90);
const POSTPONE_DURATION = Duration.hours(24);
/** Checks nobody asked for: they stay quiet and never hide what is already known. */
const BACKGROUND_CHECK_REASONS: ReadonlySet<string> = new Set([
  "startup",
  "poll",
  "channel-change",
]);

type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";
type DownloadOrigin = "manual" | "background" | "retry";

interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Left unvalidated on purpose: a malformed release-notes payload must never
  // fail the decode and block the update state transition. The shape is
  // validated defensively in normalizeDesktopUpdateReleaseNotes.
  releaseNotes: Schema.optional(Schema.Unknown),
  /** electron-updater's cached ZIP, on `update-downloaded`. */
  downloadedFile: Schema.optional(Schema.String),
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
  transferred: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
  bytesPerSecond: Schema.optional(Schema.Number),
});
/** Saved in the runtime folder before an install quits the app, read on the next start. */
export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";
const DesktopUpdateInstallRecord = Schema.fromJsonString(
  Schema.Struct({ fromVersion: Schema.String, targetVersion: Schema.String }),
);
const decodeInstallRecord = Schema.decodeUnknownEffect(DesktopUpdateInstallRecord);
const decodeFailedUpdate = Schema.decodeUnknownEffect(Schema.fromJsonString(FailedUpdate));
const encodeInstallRecord = Schema.encodeEffect(DesktopUpdateInstallRecord);

const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const DEVELOPMENT_BUILD: DesktopUpdateDisabledReason = {
  code: "development-build",
  message: "Automatic updates are off: this is a development build.",
};

const UNSUPPORTED_PLATFORM: DesktopUpdateDisabledReason = {
  code: "unsupported-platform",
  message: "Automatic updates are off: they are only available in the macOS app.",
};

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedError<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedError<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "channel", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedError<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export type DesktopUpdateConfigureError = never;

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    /** True while a check, download, install, or channel change holds the
        updater's single action reservation. */
    readonly isActionActive: Effect.Effect<boolean>;
    /** True only while an install owns the updater action reservation. */
    readonly isInstallActive: Effect.Effect<boolean>;
    /** Current state plus a stream of every later state change. */
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    /** `reason` names the entry point; startup, poll and channel-change checks stay quiet. */
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    /** Stops a running download, or a scheduled retry. The update stays offered. */
    readonly cancelDownload: Effect.Effect<DesktopUpdateActionResult>;
    /**
     * Restart to update, on the user's explicit request. Refused, with
     * `installBlockers` in the state and nothing stopped, unless every backend
     * reports it is safe and every window saved its drafts.
     */
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
    /** "Later": keeps the ready update and mutes prompts for a day; false undoes it. */
    readonly setPostponed: (postponed: boolean) => Effect.Effect<DesktopUpdateState>;
    /** A window that must confirm its drafts are saved before a restart. */
    readonly setRestartParticipant: (participantId: number, active: boolean) => Effect.Effect<void>;
    readonly acknowledgeRestart: (
      participantId: number,
      ack: DesktopUpdateRestartAck,
    ) => Effect.Effect<void>;
  }
>()("@starkfuture/desktop/updates/DesktopUpdates") {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function redactMessage(message: string): string {
  // Updater HTTP errors append response bodies and headers after the first line.
  return (message.split(/[\r\n]/, 1)[0] ?? "")
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted credential]")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*$/gi,
      "[redacted header]",
    )
    .replace(
      /\b[\w-]*(?:token|password|secret|credential|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[redacted credential]",
    )
    .slice(0, 512);
}

function summarizeCause(cause: unknown, depth: number): string {
  if (depth >= 3) return "[truncated cause]";
  if (Cause.isCause(cause)) {
    return cause.reasons
      .slice(0, 3)
      .map((reason) =>
        reason._tag === "Fail"
          ? summarizeCause(reason.error, depth + 1)
          : reason._tag === "Die"
            ? summarizeCause(reason.defect, depth + 1)
            : "Interrupted",
      )
      .join("; ");
  }
  if (typeof cause === "string") return redactMessage(cause);
  if (typeof cause !== "object" || cause === null) return errorTag(cause);

  const error = cause as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly cause?: unknown;
  };
  const code =
    typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
      ? ` [${error.code}]`
      : "";
  const message = typeof error.message === "string" ? `: ${redactMessage(error.message)}` : "";
  const nested =
    error.cause === undefined ? "" : `; caused by ${summarizeCause(error.cause, depth + 1)}`;
  return `${errorTag(cause)}${code}${message}${nested}`;
}

/** Log a bounded cause summary without stacks, response payloads, or request credentials. */
export function describeUpdateErrorCause(cause: unknown): string {
  try {
    return summarizeCause(cause, 0).slice(0, 1024);
  } catch {
    return "UnknownError";
  }
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function isArm64HostRunningIntelBuild(
  runtimeInfo: DesktopEnvironment.DesktopEnvironment["Service"]["runtimeInfo"],
): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const feedGate = yield* UpdateSeams.DesktopUpdateFeedGate;
  const installGate = yield* UpdateSeams.DesktopInstallGate;
  const artifactVerifier = yield* UpdateSeams.DesktopUpdateArtifactVerifier;
  const connectivity = yield* UpdateSeams.DesktopUpdateConnectivity;
  const preservation = yield* RestartPreservation.DesktopRestartPreservation;
  const lifecycle = yield* UpdateLifecycle.DesktopUpdateLifecycle;
  const availableChannels = yield* DesktopEnabledUpdateChannels;
  /**
   * The channel the updater uses: the saved one when it is enabled, otherwise
   * `latest`, so a Nightly choice saved by an older build never strands it.
   */
  const effectiveUpdateChannel = (channel: DesktopUpdateChannel): DesktopUpdateChannel =>
    availableChannels.includes(channel) ? channel : "latest";

  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
  const disabledReasonRef = yield* Ref.make(Option.none<DesktopUpdateDisabledReason>());
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const notAppliedVersionRef = yield* Ref.make(Option.none<string>());
  /** The update that failed on this data, which background checks do not offer. */
  const failedUpdateRef = yield* Ref.make(Option.none<DesktopFailedUpdate>());
  /** Who asked for the check whose results arrive next. */
  const checkOriginRef = yield* Ref.make<DesktopUpdateCheckOrigin>("background");
  /** The configure scope: background downloads and retries live and die with it. */
  const backgroundScopeRef = yield* Ref.make(Option.none<Scope.Scope>());
  const downloadTransferRef = yield* Ref.make(
    Option.none<Fiber.Fiber<void, ElectronUpdater.ElectronUpdaterDownloadUpdateError>>(),
  );
  const downloadRetryFiberRef = yield* Ref.make(Option.none<Fiber.Fiber<unknown, unknown>>());
  const downloadAttemptRef = yield* Ref.make(0);
  /** A download the user cancelled; its late completion is not offered. */
  const cancelledDownloadVersionRef = yield* Ref.make(Option.none<string>());
  /** The cached ZIP of each downloaded version, which the restart checks again. */
  const downloadedFileRef = yield* Ref.make(new Map<string, string>());
  const installRequestRef = yield* Ref.make(Option.none<string>());
  const installRequestCounter = yield* Ref.make(0);
  const updateStateRef = yield* Ref.make<DesktopUpdateState>({
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      effectiveUpdateChannel(environment.defaultDesktopSettings.updateChannel),
    ),
    availableChannels,
  });

  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  // Makes ref writes + publishes atomic against subscribe, so a snapshot
  // never overlaps with the first change a subscriber receives.
  const stateMutex = yield* Semaphore.make(1);

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    stateMutex
      .withPermits(1)(
        Ref.set(updateStateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      )
      .pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const classifyFailure = (
    cause: unknown,
    context: DesktopUpdateFailureContext,
    version: string | null,
  ): Effect.Effect<DesktopUpdateFailure> =>
    connectivity.isOnline.pipe(
      Effect.map((isOnline) => {
        const kind = classifyDesktopUpdateError(cause, isOnline);
        return { kind, message: describeDesktopUpdateFailure(kind, context, version) };
      }),
    );

  // Runtime facts first, so a development build never blames the feed.
  const resolveFeedDecision: Effect.Effect<UpdateSeams.DesktopUpdateFeedDecision> = Effect.suspend(
    () => {
      if (environment.isDevelopment || !environment.isPackaged) {
        return Effect.succeed({ _tag: "Disabled", reason: DEVELOPMENT_BUILD } as const);
      }
      if (environment.platform !== "darwin") {
        return Effect.succeed({ _tag: "Disabled", reason: UNSUPPORTED_PLATFORM } as const);
      }
      return feedGate.resolve;
    },
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const known = yield* Ref.get(disabledReasonRef);
    if (Option.isSome(known)) return known;
    if (yield* Ref.get(updaterConfiguredRef)) return Option.none<DesktopUpdateDisabledReason>();
    const decision = yield* resolveFeedDecision;
    return decision._tag === "Disabled"
      ? Option.some(decision.reason)
      : Option.none<DesktopUpdateDisabledReason>();
  });

  const activeUpdateAction = Ref.get(activeUpdateActionRef);

  const tryStartUpdateAction = (action: UpdateAction): Effect.Effect<boolean> =>
    Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) ? [false, activeAction] : [true, Option.some(action)],
    );

  const tryStartChannelChange = Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction)
      ? [activeAction, activeAction]
      : [Option.none<UpdateAction>(), Option.some<UpdateAction>("channel")],
  );

  const finishUpdateAction = (action: UpdateAction): Effect.Effect<void> =>
    Ref.modify(activeUpdateActionRef, (activeAction) => {
      const finished = Option.isSome(activeAction) && activeAction.value === action;
      return [finished, finished ? Option.none() : activeAction] as const;
    }).pipe(
      Effect.flatMap((finished) =>
        finished ? PubSub.publish(finishedUpdateActions, action).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    // electron-updater's channel setter turns allowDowngrade on; Stark Code
    // never installs an older version, so it is switched off after it.
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(false);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: false,
      fullChangelog: allowsPrerelease,
    });
  });

  const interruptDownloadRetry = Ref.getAndSet(downloadRetryFiberRef, Option.none()).pipe(
    Effect.flatMap(
      Option.match({ onNone: () => Effect.void, onSome: (fiber) => Fiber.interrupt(fiber) }),
    ),
  );

  const forkInBackground = <A, E>(effect: Effect.Effect<A, E>) =>
    Ref.get(backgroundScopeRef).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<Fiber.Fiber<A, E>>()),
          onSome: (scope) => effect.pipe(Effect.forkIn(scope), Effect.asSome),
        }),
      ),
    );

  const handleDownloadFailure = Effect.fn("desktop.updates.handleDownloadFailure")(function* (
    cause: unknown,
    logged: { readonly errorTag: string; readonly message: string },
  ) {
    const version = (yield* Ref.get(updateStateRef)).availableVersion;
    const failure = yield* classifyFailure(cause, "download", version);
    const attempt = yield* Ref.get(downloadAttemptRef);
    const delay = nextDesktopUpdateDownloadRetryDelay(failure.kind, attempt);
    let retry: { attempt: number; nextAttemptAt: string } | undefined;
    if (delay !== null) {
      const fiber = yield* forkInBackground(
        Effect.sleep(Duration.millis(delay)).pipe(
          Effect.andThen(Ref.set(downloadRetryFiberRef, Option.none())),
          Effect.andThen(Effect.suspend(() => downloadAvailableUpdate("retry"))),
        ),
      );
      if (Option.isSome(fiber)) {
        yield* Ref.set(downloadAttemptRef, attempt + 1);
        yield* Ref.set(
          downloadRetryFiberRef,
          fiber as Option.Option<Fiber.Fiber<unknown, unknown>>,
        );
        const now = yield* DateTime.now;
        retry = {
          attempt: attempt + 1,
          nextAttemptAt: DateTime.formatIso(DateTime.addDuration(now, Duration.millis(delay))),
        };
      }
    }
    yield* updateState((current) =>
      reduceDesktopUpdateStateOnDownloadFailure(current, failure, retry),
    );
    yield* logUpdaterError(logged.message, {
      errorTag: logged.errorTag,
      cause: describeUpdateErrorCause(cause),
      errorKind: failure.kind,
      retryAttempt: retry?.attempt ?? null,
    });
    return { accepted: true, completed: false };
  });

  const downloadAvailableUpdate = (
    origin: DownloadOrigin,
  ): Effect.Effect<{ accepted: boolean; completed: boolean }> =>
    Effect.gen(function* () {
      const state = yield* Ref.get(updateStateRef);
      if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
        return { accepted: false, completed: false };
      }

      if (!(yield* tryStartUpdateAction("download"))) {
        return { accepted: false, completed: false };
      }

      return yield* Effect.gen(function* () {
        if (origin !== "retry") yield* interruptDownloadRetry;
        if (origin === "manual") {
          yield* Ref.set(downloadAttemptRef, 0);
          yield* Ref.set(cancelledDownloadVersionRef, Option.none());
        }
        yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
        yield* electronUpdater.setDisableDifferentialDownload(
          isArm64HostRunningIntelBuild(environment.runtimeInfo),
        );
        yield* logUpdaterInfo("downloading update", { origin });
        const transfer = yield* electronUpdater.downloadUpdate.pipe(Effect.forkChild);
        yield* Ref.set(downloadTransferRef, Option.some(transfer));
        const exit = yield* Fiber.await(transfer).pipe(
          Effect.ensuring(Ref.set(downloadTransferRef, Option.none())),
        );
        if (Exit.isSuccess(exit)) {
          yield* Ref.set(downloadAttemptRef, 0);
          return { accepted: true, completed: true };
        }
        // Cancelled by the user: cancelDownload already set the state.
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return { accepted: true, completed: false };
        }
        const error = Cause.findErrorOption(exit.cause);
        return yield* Option.match(error, {
          onSome: (updaterError) =>
            handleDownloadFailure(updaterError.cause, {
              errorTag: updaterError._tag,
              message: updaterError.message,
            }),
          onNone: () => Effect.failCause(exit.cause as Cause.Cause<never>),
        });
      }).pipe(
        Effect.onInterrupt(() =>
          updateState((current) => (current.status === "downloading" ? state : current)).pipe(
            Effect.asVoid,
          ),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
          return handleDownloadFailure(cause, { errorTag: error._tag, message: error.message });
        }),
        Effect.ensuring(finishUpdateAction("download")),
      );
    }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  // Downloads in the background after a check finds an update, unless the
  // user cancelled that version's download.
  const startBackgroundDownload = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (state.status !== "available" || state.availableVersion === null) return;
    // A scheduled retry keeps its backoff.
    if (state.downloadRetry !== undefined) return;
    const cancelled = yield* Ref.get(cancelledDownloadVersionRef);
    if (Option.isSome(cancelled) && cancelled.value === state.availableVersion) return;
    yield* forkInBackground(downloadAvailableUpdate("background"));
  });

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (
    reason: string,
    actionReservation: "acquire" | "held" = "acquire",
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;
    const origin: DesktopUpdateCheckOrigin = BACKGROUND_CHECK_REASONS.has(reason)
      ? "background"
      : "manual";

    const state = yield* Ref.get(updateStateRef);
    if (
      state.status === "downloading" ||
      state.status === "verifying" ||
      state.status === "preparing" ||
      state.status === "restarting"
    ) {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (actionReservation === "acquire" && !(yield* tryStartUpdateAction("check"))) return false;

    const check = Effect.gen(function* () {
      yield* Ref.set(checkOriginRef, origin);
      const checkedAt = yield* currentIsoTimestamp;
      yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt, origin));
      yield* logUpdaterInfo("checking for updates", { reason, origin });

      return yield* electronUpdater.checkForUpdates.pipe(
        Effect.as(true),
        Effect.catchTags({
          ElectronUpdaterCheckForUpdatesError: Effect.fn(
            "desktop.updates.handleCheckForUpdatesFailure",
          )(function* (error) {
            const failedAt = yield* currentIsoTimestamp;
            const failure = yield* classifyFailure(error.cause, "check", null);
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnCheckFailure(current, failure, failedAt, origin),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause: describeUpdateErrorCause(error.cause),
              channel: error.channel,
              errorKind: failure.kind,
            });
            return true;
          }),
        }),
      );
    });

    const checked =
      actionReservation === "held"
        ? yield* check
        : yield* check.pipe(
            Effect.onInterrupt(() => setState(state)),
            Effect.ensuring(finishUpdateAction("check")),
          );
    if (checked && actionReservation === "acquire") yield* startBackgroundDownload;
    return checked;
  });

  // Tells the primary backend that the coming stop is an update restart, so it
  // keeps its managed tunnel for the backend the updated app starts. Best
  // effort: without the marker the backend only re-provisions its tunnel.
  const updateRestartMarkerDir = environment.path.join(environment.baseDir, "runtime");
  const updateRestartMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_RESTART_MARKER_FILE,
  );
  const writeUpdateRestartMarker = fileSystem
    .makeDirectory(updateRestartMarkerDir, { recursive: true })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(updateRestartMarkerPath, "")),
      Effect.catch((error) =>
        logUpdaterWarning("Could not write the update restart marker.", { errorTag: error._tag }),
      ),
    );

  // A failed or interrupted install brings no updated backend, so a later
  // quit must release the tunnel.
  const removeUpdateRestartMarker = fileSystem
    .remove(updateRestartMarkerPath, { force: true })
    .pipe(Effect.ignore);

  // Records the version an install hands to the OS installer, so the next
  // start can tell whether it applied. Best effort, like the restart marker.
  const installRecordPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  );
  const writeInstallRecord = (targetVersion: string) =>
    encodeInstallRecord({ fromVersion: environment.appVersion, targetVersion }).pipe(
      Effect.flatMap((text) => fileSystem.writeFileString(installRecordPath, text)),
      Effect.catch((error) =>
        logUpdaterWarning("Could not record the update install.", { errorTag: error._tag }),
      ),
    );
  const removeInstallRecord = fileSystem
    .remove(installRecordPath, { force: true })
    .pipe(Effect.ignore);

  // Reads the record of the last install. Returns the version it did not
  // apply, when the app came back on the version it installed from. That
  // record stays through later starts, until the version changes or a new
  // install replaces it, so no restart forgets the failed version.
  const readNotAppliedInstallVersion = fileSystem.readFileString(installRecordPath).pipe(
    Effect.flatMap(decodeInstallRecord),
    Effect.option,
    Effect.map((record) =>
      Option.flatMap(record, (value) =>
        Option.fromNullishOr(resolveNotAppliedInstallVersion(value, environment.appVersion)),
      ),
    ),
    Effect.tap((notAppliedVersion) =>
      Option.isNone(notAppliedVersion) ? removeInstallRecord : Effect.void,
    ),
  );

  // Written by the server when an update's migration fails or a restore rolls
  // one back. A record this app is already newer than is obsolete.
  const failedUpdatePath = environment.path.join(environment.stateDir, FAILED_UPDATE_FILE);
  const forgetFailedUpdate = Ref.set(failedUpdateRef, Option.none()).pipe(
    Effect.andThen(fileSystem.remove(failedUpdatePath, { force: true })),
    Effect.ignore,
  );
  const readFailedUpdate = fileSystem.readFileString(failedUpdatePath).pipe(
    Effect.flatMap(decodeFailedUpdate),
    Effect.option,
    Effect.flatMap((record) =>
      Option.isSome(record) &&
      compareSemverVersions(environment.appVersion, record.value.failedVersion) > 0
        ? forgetFailedUpdate.pipe(Effect.as(Option.none<DesktopFailedUpdate>()))
        : Effect.succeed(Option.map(record, (value): DesktopFailedUpdate => value)),
    ),
  );

  const baseUpdateState = (channel: DesktopUpdateChannel) =>
    Effect.gen(function* () {
      const notAppliedVersion = yield* Ref.get(notAppliedVersionRef);
      const disabledReason = yield* Ref.get(disabledReasonRef);
      const base: DesktopUpdateState = {
        ...createInitialDesktopUpdateState(
          environment.appVersion,
          environment.runtimeInfo,
          effectiveUpdateChannel(channel),
        ),
        availableChannels,
        ...Option.match(notAppliedVersion, {
          onNone: () => ({}),
          onSome: (version) => ({ notAppliedVersion: version }),
        }),
      };
      return Option.match(disabledReason, {
        onNone: (): DesktopUpdateState => ({ ...base, enabled: true, status: "idle" }),
        onSome: (reason) => reduceDesktopUpdateStateOnDisabled(base, reason),
      });
    });

  /** Lets go of everything an install request holds before the backends stop. */
  const releaseInstallRequest = Effect.gen(function* () {
    const requestId = yield* Ref.getAndSet(installRequestRef, Option.none());
    if (Option.isNone(requestId)) return;
    yield* lifecycle.withdraw(requestId.value);
    yield* installGate.release(requestId.value);
    yield* preservation.release(requestId.value);
  });

  const resetInstallAction = Effect.all(
    [
      releaseInstallRequest,
      updateState((current) =>
        current.status === "preparing" || current.status === "restarting"
          ? { ...current, status: "downloaded" }
          : current,
      ),
      finishUpdateAction("install"),
      Ref.set(desktopState.quitting, false),
      removeUpdateRestartMarker,
      removeInstallRecord,
    ],
    { discard: true },
  );

  const recoverFailedInstall = Effect.fn("desktop.updates.recoverFailedInstall")(function* (
    failure: DesktopUpdateFailure,
  ) {
    const ownsRecovery = yield* Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) && activeAction.value === "install"
        ? ([true, Option.some<UpdateAction>("install-recovery")] as const)
        : ([false, activeAction] as const),
    );
    if (!ownsRecovery) return;

    // Withdraw the installer request first: once the backends restart, a late
    // completion from the installer must not quit the app.
    yield* releaseInstallRequest;
    yield* Ref.set(desktopState.quitting, false);
    yield* removeUpdateRestartMarker;
    yield* removeInstallRecord;
    yield* Effect.gen(function* () {
      const instances = yield* pool.list;
      const restartExit = yield* Effect.forEach(instances, (instance) => instance.start, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.exit);
      yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, failure));
      if (Exit.isFailure(restartExit)) {
        yield* logUpdaterError("Desktop update install recovery could not restart every backend.");
      }
    }).pipe(
      Effect.catchCause(() =>
        logUpdaterError("Desktop update install recovery failed unexpectedly."),
      ),
      Effect.ensuring(finishUpdateAction("install-recovery")),
    );
  });

  /** A restart request that stopped before anything was stopped. */
  const abortInstall = Effect.fn("desktop.updates.abortInstall")(function* (
    outcome:
      | { readonly _tag: "Blocked"; readonly blockers: ReadonlyArray<DesktopUpdateInstallBlocker> }
      | { readonly _tag: "Failed"; readonly failure: DesktopUpdateFailure },
  ) {
    yield* releaseInstallRequest;
    yield* removeUpdateRestartMarker;
    yield* updateState((current) =>
      outcome._tag === "Blocked"
        ? reduceDesktopUpdateStateOnInstallBlocked(current, outcome.blockers)
        : reduceDesktopUpdateStateOnInstallFailure(current, outcome.failure),
    );
    yield* finishUpdateAction("install");
    yield* logUpdaterInfo("update restart did not start", {
      outcome: outcome._tag,
      blockers: outcome._tag === "Blocked" ? outcome.blockers.map((blocker) => blocker.kind) : null,
      errorKind: outcome._tag === "Failed" ? outcome.failure.kind : null,
    });
    return { accepted: outcome._tag === "Failed", completed: false, failed: true };
  });

  const installDownloadedUpdate = (expectedVersion?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const actionCompletions = yield* PubSub.subscribe(finishedUpdateActions);
        let admission: "admitted" | "refused" | "wait-for-check" = "wait-for-check";
        while (admission === "wait-for-check") {
          admission = yield* stateMutex.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* Ref.get(updateStateRef);
              const activeAction = yield* Ref.get(activeUpdateActionRef);
              const hasExpectedDownload =
                state.downloadedVersion !== null &&
                (expectedVersion === undefined || state.downloadedVersion === expectedVersion);
              if (
                (yield* Ref.get(desktopState.quitting)) ||
                !(yield* Ref.get(updaterConfiguredRef)) ||
                !hasExpectedDownload
              ) {
                return "refused" as const;
              }
              if (Option.isSome(activeAction)) {
                return activeAction.value === "check" && expectedVersion !== undefined
                  ? ("wait-for-check" as const)
                  : ("refused" as const);
              }
              const hasInstallableDownload =
                state.status === "downloaded" ||
                (state.status === "error" &&
                  (state.errorContext === null || state.errorContext === "install"));
              if (!hasInstallableDownload) return "refused" as const;
              return (yield* tryStartUpdateAction("install"))
                ? ("admitted" as const)
                : ("refused" as const);
            }),
          );
          if (admission === "wait-for-check") {
            const finishedAction = yield* PubSub.take(actionCompletions).pipe(
              Effect.timeoutOption(PREPARED_INSTALL_CHECK_WAIT),
            );
            if (Option.isNone(finishedAction)) {
              admission = "refused";
            }
          }
        }
        if (admission === "refused") {
          return { accepted: false, completed: false, failed: false };
        }

        const requestId = `update-restart-${yield* Ref.updateAndGet(installRequestCounter, (n) => n + 1)}`;
        yield* Ref.set(installRequestRef, Option.some(requestId));

        return yield* Effect.gen(function* () {
          const admitted = yield* updateState(reduceDesktopUpdateStateOnInstallPreparing);
          const version = admitted.downloadedVersion ?? admitted.availableVersion ?? "";
          yield* logUpdaterInfo("preparing update restart", { version });

          // 1. The download still passes its check; its bytes may have changed.
          const verdict = yield* artifactVerifier.verify({
            version,
            downloadedFile: (yield* Ref.get(downloadedFileRef)).get(version) ?? null,
          });
          if (verdict._tag === "Rejected") {
            yield* logUpdaterWarning("downloaded update failed its check at restart", {
              version,
              errorKind: verdict.kind,
              detail: verdict.detail,
            });
            return yield* abortInstall({
              _tag: "Failed",
              failure: {
                kind: verdict.kind,
                message: describeDesktopUpdateFailure(verdict.kind, "download", version),
              },
            });
          }
          // 2. Every backend: nothing running, nothing waiting for the user.
          const readiness = yield* installGate.prepare(requestId);
          if (readiness._tag === "Blocked") {
            return yield* abortInstall({ _tag: "Blocked", blockers: readiness.blockers });
          }
          // 3. Every window: drafts and stash saved, nothing uploading or sending.
          const preserved = yield* preservation.preserve({ requestId, version });
          if (preserved._tag === "Failed") {
            return yield* abortInstall({ _tag: "Blocked", blockers: preserved.blockers });
          }
          // 4. The servers drained their work and backed up, keeping the drafts' uploads.
          // They stop here, so the primary learns first that this stop is an update
          // restart and keeps its managed tunnel.
          yield* writeUpdateRestartMarker;
          const quiesced = yield* installGate.quiesce({
            requestId,
            version,
            referencedAttachmentIds: preserved.referencedAttachmentIds,
            draftsJson: preserved.draftsJson,
            stashJson: preserved.stashJson,
          });
          if (quiesced._tag === "Blocked") {
            return yield* abortInstall({ _tag: "Blocked", blockers: quiesced.blockers });
          }
          if (quiesced._tag === "Failed") {
            return yield* abortInstall({
              _tag: "Failed",
              failure: { kind: quiesced.kind, message: quiesced.message },
            });
          }
          // 5. The installer is set to install the download we verified.
          const refusal = yield* lifecycle.preflight;
          if (Option.isSome(refusal)) {
            yield* logUpdaterWarning("installer refused the update restart", {
              reason: refusal.value,
            });
            return yield* abortInstall({
              _tag: "Failed",
              failure: {
                kind: "unknown",
                message: describeDesktopUpdateFailure("unknown", "install", version),
              },
            });
          }

          yield* Ref.set(desktopState.quitting, true);
          yield* updateState(reduceDesktopUpdateStateOnRestarting);
          yield* writeInstallRecord(version);
          // Stop every backend in the pool, not just the primary. With
          // parallel WSL + Windows backends, leaving the WSL instance up
          // means the quit exits before the pool's scope cascade has a
          // chance to run its stop finalizer, so the WSL child gets
          // hard-killed by the OS instead of receiving SIGTERM + grace.
          const instances = yield* pool.list;
          yield* Effect.forEach(
            instances,
            (instance) => instance.stop({ timeout: Duration.seconds(5) }),
            { concurrency: "unbounded" },
          );

          const outcome = yield* lifecycle.commit({ requestId, version });
          switch (outcome._tag) {
            case "Committed":
              return { accepted: true, completed: false, failed: false };
            case "Withdrawn":
              return { accepted: true, completed: false, failed: true };
            case "TimedOut": {
              yield* recoverFailedInstall({
                kind: "install-stalled",
                message: describeDesktopUpdateFailure("install-stalled", "install", version),
              });
              yield* logUpdaterError("the installer did not respond; resumed the backends", {
                version,
              });
              return { accepted: true, completed: false, failed: true };
            }
            case "Refused":
            case "Failed": {
              const cause = outcome._tag === "Failed" ? outcome.cause : outcome.reason;
              const failure = yield* classifyFailure(cause, "install", version);
              yield* recoverFailedInstall(failure);
              yield* logUpdaterError("the installer rejected the update", {
                cause: describeUpdateErrorCause(cause),
                errorKind: failure.kind,
              });
              return { accepted: true, completed: false, failed: true };
            }
          }
        }).pipe(
          Effect.onInterrupt(() => resetInstallAction),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
              const { downloadedVersion } = yield* Ref.get(updateStateRef);
              yield* recoverFailedInstall({
                kind: "unknown",
                message: describeDesktopUpdateFailure("unknown", "install", downloadedVersion),
              });
              yield* logUpdaterError(error.message, {
                errorTag: error._tag,
                cause: describeUpdateErrorCause(error.cause),
                action: error.action,
              });
              return { accepted: true, completed: false, failed: true };
            }),
          ),
        );
      }),
    ).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const installWithExpectedVersion = Effect.fn("desktop.updates.install")(function* (
    expectedVersion?: string,
  ) {
    if (yield* Ref.get(desktopState.quitting)) {
      return {
        accepted: false,
        completed: false,
        failed: false,
        state: yield* Ref.get(updateStateRef),
      };
    }
    const result = yield* installDownloadedUpdate(expectedVersion);
    return {
      accepted: result.accepted,
      completed: result.completed,
      failed: result.failed,
      state: yield* Ref.get(updateStateRef),
    };
  });

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (resolveDefaultDesktopUpdateChannel(info.version) !== state.channel) {
            yield* logUpdaterInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          const failed = Option.getOrNull(yield* Ref.get(failedUpdateRef));
          if (
            shouldSkipFailedUpdate({
              state,
              version: info.version,
              failed,
              origin: yield* Ref.get(checkOriginRef),
            })
          ) {
            yield* setState(
              reduceDesktopUpdateStateOnSkippedUpdate(state, info.version, checkedAt),
            );
            yield* logUpdaterInfo("not offering an update that failed on this data", {
              version: info.version,
              reason: failed?.reason ?? null,
            });
            return;
          }
          if (failed !== null && compareSemverVersions(info.version, failed.failedVersion) > 0) {
            yield* forgetFailedUpdate;
          }
          const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
            info.releaseNotes,
            info.version,
            state.channel,
          );
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(
              state,
              info.version,
              checkedAt,
              releaseNotes,
              omittedReleaseCount,
            ),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", {
            version: info.version,
            releaseNoteGroups: releaseNotes.length,
            omittedReleaseCount,
          });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    const state = yield* Ref.get(updateStateRef);
    yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* activeUpdateAction;
    const error = new DesktopUpdaterReportedError({
      operation: Option.match(activeAction, {
        onNone: () => "background" as const,
        onSome: (action) => (action === "install-recovery" ? "install" : action),
      }),
      cause,
    });
    if (Option.isSome(activeAction) && activeAction.value === "install") {
      const { downloadedVersion } = yield* Ref.get(updateStateRef);
      yield* recoverFailedInstall(yield* classifyFailure(cause, "install", downloadedVersion));
      yield* logUpdaterError(error.message, {
        errorTag: error._tag,
        cause: describeUpdateErrorCause(error.cause),
        operation: error.operation,
      });
      return;
    }

    if (Option.isNone(activeAction)) {
      const failedAt = yield* currentIsoTimestamp;
      const failure = yield* classifyFailure(cause, "check", null);
      yield* updateState((current) =>
        reduceDesktopUpdateStateOnCheckFailure(current, failure, failedAt, "background"),
      );
    }

    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      cause: describeUpdateErrorCause(error.cause),
      operation: error.operation,
    });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const state = yield* Ref.get(updateStateRef);
          // A cancelled transfer may still report progress; only a running download shows it.
          if (state.status !== "downloading") return;
          const percent = Math.floor(progress.percent);
          if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
            const bytes =
              progress.transferred !== undefined && progress.total !== undefined
                ? {
                    transferredBytes: progress.transferred,
                    totalBytes: progress.total,
                    bytesPerSecond: progress.bytesPerSecond ?? 0,
                  }
                : undefined;
            yield* setState(
              reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent, bytes),
            );
          }
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          const cancelled = yield* Ref.get(cancelledDownloadVersionRef);
          if (Option.isSome(cancelled) && cancelled.value === info.version) {
            yield* logUpdaterInfo("ignoring a download the user cancelled", {
              version: info.version,
            });
            return;
          }
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnVerifyStart(current, info.version),
          );
          const downloadedFile = info.downloadedFile ?? null;
          yield* Ref.update(downloadedFileRef, (files) => {
            const next = new Map(files);
            if (downloadedFile === null) next.delete(info.version);
            else next.set(info.version, downloadedFile);
            return next;
          });
          const verdict = yield* artifactVerifier.verify({
            version: info.version,
            downloadedFile,
          });
          if (verdict._tag === "Rejected") {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnVerifyFailure(current, {
                kind: verdict.kind,
                message: describeDesktopUpdateFailure(verdict.kind, "download", info.version),
              }),
            );
            yield* logUpdaterWarning("downloaded update failed verification", {
              version: info.version,
              errorKind: verdict.kind,
              detail: verdict.detail,
            });
            return;
          }
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadComplete(current, info.version),
          );
          yield* logUpdaterInfo("update downloaded and verified", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  const cancelDownload = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (state.status !== "downloading" && state.downloadRetry === undefined) {
      return { accepted: false, completed: false, state };
    }
    if (state.availableVersion !== null) {
      yield* Ref.set(cancelledDownloadVersionRef, Option.some(state.availableVersion));
    }
    yield* interruptDownloadRetry;
    yield* Ref.set(downloadAttemptRef, 0);
    const transfer = yield* Ref.get(downloadTransferRef);
    if (Option.isSome(transfer)) yield* Fiber.interrupt(transfer.value);
    const next = yield* updateState(reduceDesktopUpdateStateOnDownloadCancelled);
    yield* logUpdaterInfo("update download cancelled", { version: state.availableVersion });
    return { accepted: true, completed: false, state: next };
  }).pipe(Effect.withSpan("desktop.updates.cancelDownload"));

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    isActionActive: activeUpdateAction.pipe(Effect.map(Option.isSome)),
    isInstallActive: activeUpdateAction.pipe(
      Effect.map((action) => Option.isSome(action) && action.value === "install"),
    ),
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(stateChanges);
        const latest = yield* Ref.get(updateStateRef);
        return { latest, changes: Stream.fromSubscription(subscription) };
      }),
    ),
    emitState,
    disabledReason: resolveDisabledReason.pipe(Effect.map(Option.map((reason) => reason.message))),
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };
      yield* Ref.set(backgroundScopeRef, Option.some(yield* Effect.scope));

      const notAppliedVersion = yield* readNotAppliedInstallVersion;
      yield* Ref.set(notAppliedVersionRef, notAppliedVersion);
      yield* Ref.set(failedUpdateRef, yield* readFailedUpdate);
      if (Option.isSome(notAppliedVersion)) {
        yield* logUpdaterWarning("the last update install did not apply", {
          version: environment.appVersion,
          targetVersion: notAppliedVersion.value,
        });
      }

      const settings = yield* desktopSettings.get;
      const decision = yield* resolveFeedDecision;
      if (decision._tag === "Disabled") {
        yield* Ref.set(disabledReasonRef, Option.some(decision.reason));
        yield* setState(yield* baseUpdateState(settings.updateChannel));
        yield* logUpdaterInfo("automatic updates are off", { reason: decision.reason.code });
        return;
      }

      yield* electronUpdater.setFeedURL(decision.feed);
      yield* setState(yield* baseUpdateState(settings.updateChannel));
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(effectiveUpdateChannel(settings.updateChannel));
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });
      yield* lifecycle.onLateStaged((version) => {
        runEffect(
          updateState((current) => reduceDesktopUpdateStateOnLateStaged(current, version)).pipe(
            Effect.andThen(
              logUpdaterWarning("the installer staged an update after Stark Code resumed", {
                version,
              }),
            ),
          ),
        );
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* tryStartChannelChange;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value === "install-recovery" ? "install" : activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      return yield* Effect.gen(function* () {
        const state = yield* Ref.get(updateStateRef);
        // A channel this build's feed does not serve is never selected.
        if (nextChannel === state.channel || !availableChannels.includes(nextChannel)) {
          return state;
        }

        yield* desktopSettings
          .setUpdateChannel(nextChannel)
          .pipe(
            Effect.mapError(
              (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
            ),
          );

        yield* setState(yield* baseUpdateState(nextChannel));

        if (!(yield* Ref.get(updaterConfiguredRef))) {
          return yield* Ref.get(updateStateRef);
        }

        yield* applyAutoUpdaterChannel(nextChannel);
        yield* checkForUpdates("channel-change", "held");
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("channel")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate("manual");
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    cancelDownload,
    install: installWithExpectedVersion().pipe(
      Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
    ),
    installPrepared: (expectedVersion) => installWithExpectedVersion(expectedVersion),
    setPostponed: Effect.fn("desktop.updates.setPostponed")(function* (postponed: boolean) {
      const now = yield* DateTime.now;
      const until = postponed
        ? DateTime.formatIso(DateTime.addDuration(now, POSTPONE_DURATION))
        : null;
      return yield* updateState((current) => reduceDesktopUpdateStateOnPostpone(current, until));
    }),
    setRestartParticipant: preservation.setParticipant,
    acknowledgeRestart: preservation.acknowledge,
  });
});

/** The updater with explicit seams; tests and the integration supply each one. */
export const layerWithServices = Layer.effect(DesktopUpdates, make);

// The preflight's ports (DesktopInstallPreflight.layerLivePorts) come from the
// app: the recovery notice talks to the same maintenance channel.
const layerInstallGate = UpdateInstallGate.layer.pipe(Layer.provide(DesktopInstallPreflight.layer));

const layerFeedChecks = UpdateArtifactVerification.layer.pipe(
  Layer.provideMerge(UpdateFeedGate.layer),
);

export const layer = layerWithServices.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerFeedChecks,
      layerInstallGate,
      UpdateSeams.layerConnectivity,
      UpdateLifecycle.layer,
      RestartPreservation.layer,
    ),
  ),
);
