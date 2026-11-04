import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type DesktopUpdateDisabledReason,
  type DesktopUpdateRestartPrepareRequest,
  type DesktopUpdateState,
  FAILED_UPDATE_FILE,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as RestartPreservation from "./restartPreservation.ts";
import * as UpdateLifecycle from "./updateLifecycle.ts";
import { DesktopEnabledUpdateChannels } from "./updateChannels.ts";
import { validateStarkUpdateFeed } from "./updateFeedPolicy.ts";
import * as UpdateSeams from "./updateSeams.ts";

/** Shared DesktopUpdates test harness: a fully stubbed updater layer whose
    electron-updater events are driven by hand via `emit`, with a fake native
    installer and fakes for every seam. Used by DesktopUpdates.test.ts. */

export const flushCallbacks = Effect.yieldNow;

/** The feed the harness's enabled feed gate hands to electron-updater: a validated mock feed. */
export const HARNESS_FEED: ElectronUpdater.ElectronUpdaterFeedUrl = (() => {
  const url = "http://127.0.0.1:4141/";
  const validated = validateStarkUpdateFeed(
    `provider: generic\nurl: ${url}\nchannel: latest\nupdaterCacheDirName: starkcode-updater\nkind: mock\n`,
    { kind: "mock", url, channels: ["latest"], appleTeamId: null },
  );
  if (!validated.ok) throw new Error(`harness feed is invalid: ${validated.problem}`);
  return validated.feed;
})();

export interface UpdatesHarnessOptions {
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly beforeSetUpdateChannel?: Effect.Effect<void>;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly downloadUpdate?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterDownloadUpdateError>;
  readonly stopBackend?: Effect.Effect<void>;
  readonly startBackend?: Effect.Effect<void>;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  /** Contents of the install record a previous run left behind. */
  readonly installRecord?: string | undefined;
  /** `failed-update.json` in the state directory at start. */
  readonly failedUpdate?: string | undefined;
  /** The feed gate's answer; enabled with `HARNESS_FEED` by default. */
  readonly feedDisabled?: DesktopUpdateDisabledReason;
  readonly verify?: Effect.Effect<UpdateSeams.DesktopUpdateArtifactVerdict>;
  readonly installGate?: (requestId: string) => Effect.Effect<UpdateSeams.DesktopInstallReadiness>;
  readonly quiesce?: Effect.Effect<UpdateSeams.DesktopInstallReadiness>;
  readonly preserve?: (
    request: DesktopUpdateRestartPrepareRequest,
  ) => Effect.Effect<RestartPreservation.DesktopRestartPreservationResult>;
  readonly isOnline?: boolean | null;
  /** Channels the updater offers; both by default, so channel switching can be exercised. */
  readonly availableChannels?: ReadonlyArray<"latest" | "nightly">;
  /**
   * What the native installer does when asked to stage: accept at once
   * (default), report an error, or say nothing until the test calls
   * `nativeStage` or `nativeFail`.
   */
  readonly nativeInstaller?: "stage" | "error" | "silent";
  readonly nativeError?: unknown;
  readonly nativeFeedUrl?: string;
  /** Called when the updater asks the native installer to stage. */
  readonly onNativeStage?: () => void;
}

export function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let electronQuitAndInstallCount = 0;
  let nativeInstallCount = 0;
  let downloadCount = 0;
  let allowDowngrade = false;
  let fullChangelog = false;
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];
  const installSteps: string[] = [];
  const preserveRequests: DesktopUpdateRestartPrepareRequest[] = [];
  const verifyRequests: Array<{
    readonly version: string;
    readonly downloadedFile: string | null;
  }> = [];
  const quiesceRequests: Array<{
    readonly requestId: string;
    readonly version: string;
    readonly referencedAttachmentIds: ReadonlyArray<string>;
  }> = [];
  const nativeDownloaded = new Set<() => void>();
  const nativeErrors = new Set<(error: unknown) => void>();

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  const nativeStage = () => {
    for (const listener of nativeDownloaded) listener();
  };
  const nativeFail = (error: unknown) => {
    for (const listener of nativeErrors) listener(error);
  };

  const layerUpdater = Layer.succeed(ElectronUpdater.ElectronUpdater, {
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedUrls.push(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    // electron-updater's channel setter turns downgrades on.
    setChannel: () =>
      Effect.sync(() => {
        allowDowngrade = true;
      }),
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: (value) =>
      Effect.sync(() => {
        fullChangelog = value;
      }),
    setDisableDifferentialDownload: () => options.setDisableDifferentialDownload ?? Effect.void,
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: Effect.sync(() => {
      downloadCount += 1;
    }).pipe(Effect.andThen(options.downloadUpdate ?? Effect.void)),
    // MacUpdater.quitAndInstall: the updater must never call it.
    quitAndInstall: () =>
      Effect.sync(() => {
        electronQuitAndInstallCount += 1;
        installSteps.push("electronUpdater.quitAndInstall");
      }),
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
        }),
        () =>
          Effect.sync(() => {
            removeListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronUpdater.ElectronUpdater["Service"]);

  const layerWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeedNone,
    currentMainOrFirst: Effect.succeedNone,
    focusedMainOrFirst: Effect.succeedNone,
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.sync(() => {
      installSteps.push("destroyAll");
    }),
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    start: Effect.sync(() => {
      installSteps.push("startBackend");
    }).pipe(Effect.andThen(options.startBackend ?? Effect.void)),
    stop: () =>
      Effect.sync(() => {
        installSteps.push("stopBackend");
      }).pipe(Effect.andThen(options.stopBackend ?? Effect.void)),
    currentConfig: Effect.succeedNone,
    snapshot: Effect.succeed({
      desiredRunning: false,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(true),
  };
  const layerBackend = DesktopBackendPool.layerTest([stubBackendInstance]);

  const configEnv = {
    // The settings layer writes here; the OS temp folder keeps it out of shared /tmp.
    STARK_CODE_HOME: `${NodeOS.tmpdir()}/stark-desktop-updates-test-${process.pid}`,
    ...options.env,
  };

  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `${NodeOS.tmpdir()}/stark-desktop-updates-home-${process.pid}`,
    platform: options.platform ?? "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(configEnv))));

  let testSettings: DesktopAppSettings.DesktopSettings = {
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  };
  const setUpdateChannelError = options.setUpdateChannelError;
  const layerSettings =
    setUpdateChannelError || options.beforeSetUpdateChannel
      ? Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
          get: Effect.sync(() => testSettings),
          load: Effect.sync(() => testSettings),
          setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
          setServerExposureMode: () => Effect.die("unexpected server exposure update"),
          setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
          setUpdateChannel: (channel) =>
            setUpdateChannelError
              ? Effect.fail(setUpdateChannelError)
              : (options.beforeSetUpdateChannel ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const changed = testSettings.updateChannel !== channel;
                      testSettings = {
                        ...testSettings,
                        updateChannel: channel,
                        updateChannelConfiguredByUser: true,
                      };
                      return { settings: testSettings, changed };
                    }),
                  ),
                ),
          setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
          setWslDistro: () => Effect.die("unexpected WSL distro change"),
          setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
          setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
          applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
          applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
        } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
      : DesktopAppSettings.layer;

  // Tracks the restart markers and install records installs leave, so
  // installs stay free of real disk I/O that would outrun the tests' settle loops.
  const updateRestartMarkers = new Set<string>();
  // Contents of the install record, by path once an install writes one.
  const installRecords = new Map<string, string>();
  let previousInstallRecord = options.installRecord;
  const isInstallRecord = (path: string) =>
    path.endsWith(DesktopUpdates.DESKTOP_UPDATE_INSTALL_RECORD_FILE);
  let failedUpdate = options.failedUpdate;
  const isFailedUpdate = (path: string) => path.endsWith(FAILED_UPDATE_FILE);
  const layerFileSystem = FileSystem.layerNoop({
    readFileString: (path) => {
      const installRecord = isInstallRecord(path)
        ? (installRecords.get(path) ?? previousInstallRecord)
        : isFailedUpdate(path)
          ? failedUpdate
          : undefined;
      if (installRecord !== undefined) return Effect.succeed(installRecord);
      return Effect.fail(
        PlatformError.systemError({
          module: "FileSystem",
          method: "readFileString",
          _tag: "NotFound",
          pathOrDescriptor: path,
        }),
      );
    },
    makeDirectory: () => Effect.void,
    writeFileString: (path, data) =>
      Effect.sync(() => {
        if (isInstallRecord(path)) installRecords.set(path, data);
        else updateRestartMarkers.add(path);
      }),
    remove: (path) =>
      Effect.sync(() => {
        updateRestartMarkers.delete(path);
        installRecords.delete(path);
        if (isInstallRecord(path)) previousInstallRecord = undefined;
        if (isFailedUpdate(path)) failedUpdate = undefined;
      }),
  });

  const layerSeams = Layer.mergeAll(
    Layer.succeed(UpdateSeams.DesktopUpdateFeedGate, {
      resolve: Effect.succeed<UpdateSeams.DesktopUpdateFeedDecision>(
        options.feedDisabled
          ? { _tag: "Disabled", reason: options.feedDisabled }
          : { _tag: "Enabled", feed: HARNESS_FEED },
      ),
    }),
    Layer.succeed(UpdateSeams.DesktopUpdateArtifactVerifier, {
      verify: (input) =>
        Effect.sync(() => {
          verifyRequests.push(input);
        }).pipe(Effect.andThen(options.verify ?? Effect.succeed({ _tag: "Verified" as const }))),
    }),
    Layer.succeed(UpdateSeams.DesktopInstallGate, {
      prepare: (requestId) =>
        Effect.sync(() => {
          installSteps.push("prepare");
        }).pipe(
          Effect.andThen(
            options.installGate?.(requestId) ??
              Effect.succeed<UpdateSeams.DesktopInstallReadiness>({ _tag: "Ready" }),
          ),
        ),
      quiesce: (input) =>
        Effect.sync(() => {
          installSteps.push("quiesce");
          quiesceRequests.push(input);
        }).pipe(
          Effect.andThen(
            options.quiesce ??
              Effect.succeed<UpdateSeams.DesktopInstallReadiness>({ _tag: "Ready" }),
          ),
        ),
      release: () =>
        Effect.sync(() => {
          installSteps.push("releaseGate");
        }),
    }),
    Layer.succeed(UpdateSeams.DesktopUpdateConnectivity, {
      isOnline: Effect.succeed(options.isOnline === undefined ? true : options.isOnline),
    }),
    Layer.succeed(RestartPreservation.DesktopRestartPreservation, {
      setParticipant: () => Effect.void,
      acknowledge: () => Effect.void,
      preserve: (request) =>
        Effect.sync(() => {
          installSteps.push("preserve");
          preserveRequests.push(request);
        }).pipe(
          Effect.andThen(
            options.preserve?.(request) ??
              Effect.succeed<RestartPreservation.DesktopRestartPreservationResult>({
                _tag: "Saved",
                referencedAttachmentIds: ["draft-upload"],
                draftsJson: null,
                stashJson: null,
              }),
          ),
        ),
      release: () =>
        Effect.sync(() => {
          installSteps.push("releasePreservation");
        }),
    }),
    UpdateLifecycle.layerTest({
      getFeedURL: () => options.nativeFeedUrl ?? "http://127.0.0.1:53111",
      onUpdateDownloaded: (listener) => {
        nativeDownloaded.add(listener);
        return () => {
          nativeDownloaded.delete(listener);
        };
      },
      onError: (listener) => {
        nativeErrors.add(listener);
        return () => {
          nativeErrors.delete(listener);
        };
      },
      checkForUpdates: () => {
        installSteps.push("nativeStage");
        options.onNativeStage?.();
        const mode = options.nativeInstaller ?? "stage";
        if (mode === "stage") nativeStage();
        else if (mode === "error") nativeFail(options.nativeError ?? new Error("installer failed"));
      },
      quitAndInstall: () => {
        nativeInstallCount += 1;
        installSteps.push("nativeInstall");
      },
    }),
  );

  const layer = DesktopUpdates.layerWithServices.pipe(
    Layer.provide(
      Layer.succeed(
        DesktopEnabledUpdateChannels,
        options.availableChannels ?? (["latest", "nightly"] as const),
      ),
    ),
    Layer.provide(layerFileSystem),
    Layer.provide(layerSeams),
    Layer.provideMerge(layerUpdater),
    Layer.provideMerge(layerWindow),
    Layer.provideMerge(layerBackend),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(DesktopConfig.layerTest(configEnv)),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    checkCount: () => checkCount,
    /** Installs the native installer was told to run: each one quits the app. */
    quitAndInstalls: () => nativeInstallCount,
    /** Calls to MacUpdater.quitAndInstall, which must stay zero. */
    electronQuitAndInstalls: () => electronQuitAndInstallCount,
    installSteps,
    preserveRequests,
    quiesceRequests,
    /** What each artifact check was asked to verify. */
    verifyRequests,
    updateRestartMarkers,
    installRecords,
    /** The record the test started with, until the app removes it. */
    previousInstallRecord: () => previousInstallRecord,
    /** `failed-update.json`, until the app removes it. */
    failedUpdate: () => failedUpdate,
    downloadCount: () => downloadCount,
    allowDowngrade: () => allowDowngrade,
    feedUrls: (): ElectronUpdater.ElectronUpdaterFeedUrl[] => feedUrls,
    fullChangelog: () => fullChangelog,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    emit: (eventName: string, payload?: unknown) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(payload);
      }
    },
    /** The native installer accepted the update (Squirrel `update-downloaded`). */
    nativeStage,
    /** The native installer reported an error. */
    nativeFail,
  };
}
