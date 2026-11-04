import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { CancellationToken, autoUpdater } from "electron-updater";

import {
  DIFFERENTIAL_UPDATE_DOWNLOADS_ENABLED,
  StarkUpdateFeedInvalidError,
  checkUpdateInfo,
  installUpdateRequestGuard,
  isValidatedStarkUpdateFeed,
  type UpdateRequestDecision,
  type ValidatedStarkUpdateFeed,
} from "../updates/updateFeedPolicy.ts";

/**
 * The only feed electron-updater can be given: one returned by
 * `validateStarkUpdateFeed`. `setFeedURL` refuses any other object at runtime.
 */
export type ElectronUpdaterFeedUrl = ValidatedStarkUpdateFeed;

export class ElectronUpdaterUnvalidatedFeedError extends Schema.TaggedError<ElectronUpdaterUnvalidatedFeedError>()(
  "ElectronUpdaterUnvalidatedFeedError",
  {},
) {
  override get message(): string {
    return "Refused an update feed that did not come from validateStarkUpdateFeed.";
  }
}

export class ElectronUpdaterNoFeedError extends Schema.TaggedError<ElectronUpdaterNoFeedError>()(
  "ElectronUpdaterNoFeedError",
  {},
) {
  get code(): string {
    return "ERR_STARK_UPDATE_NO_FEED";
  }

  override get message(): string {
    return "No validated update feed is configured, so the updater sends no requests.";
  }
}

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@starkfuture/desktop/electron/ElectronUpdater") {}

type GuardInput = Parameters<typeof installUpdateRequestGuard>[0];

/** The parts of electron-updater's `AppUpdater` the feed binding touches. */
export interface BindableAutoUpdater {
  setFeedURL(options: { provider: "generic"; url: string; channel: string }): void;
  allowDowngrade: boolean;
  disableDifferentialDownload: boolean;
  readonly httpExecutor?: GuardInput["executor"];
  readonly nativeUpdater?: GuardInput["nativeUpdater"];
  readonly netSession?: GuardInput["session"];
  previousBlockmapBaseUrlOverride?: string | null;
  isUpdateSupported?: (info: unknown) => boolean | Promise<boolean>;
  emit?: (event: string, ...args: Array<unknown>) => boolean;
  /** electron-updater's app adapter; `baseCachePath` decides where downloads are kept. */
  readonly app?: object;
  readonly logger?: {
    readonly info?: (message: string) => void;
    readonly warn?: (message: string) => void;
  } | null;
}

/** The feed an updater was last bound to. Requests are checked against it when they are sent. */
export interface UpdaterFeedBinding {
  feed: ValidatedStarkUpdateFeed | undefined;
  defaultIsUpdateSupported?: BindableAutoUpdater["isUpdateSupported"];
}

/**
 * Hands electron-updater a validated feed and pins everything around it:
 * every request is checked against the feed when it is sent (redirects
 * included), each channel manifest is checked before anything is downloaded
 * from it, block maps never come from another location, and downgrades and
 * differential downloads stay off.
 */
export function bindUpdaterToValidatedFeed(
  updater: BindableAutoUpdater,
  binding: UpdaterFeedBinding,
  feed: ValidatedStarkUpdateFeed,
): void {
  binding.feed = feed;
  const log = (decision: UpdateRequestDecision) => {
    const verdict = decision.refusal === null ? "allowed" : `refused (${decision.refusal})`;
    const line = `[stark-update] ${decision.kind} ${decision.destination}: ${verdict}`;
    if (decision.refusal === null) updater.logger?.info?.(line);
    else updater.logger?.warn?.(line);
  };
  installUpdateRequestGuard({
    executor: updater.httpExecutor,
    nativeUpdater: updater.nativeUpdater,
    session: updater.netSession,
    currentFeed: () => binding.feed,
    onDecision: log,
    onNativeRefused: (error) => {
      updater.emit?.("error", error, error.message);
    },
  });
  if (!("defaultIsUpdateSupported" in binding)) {
    binding.defaultIsUpdateSupported = updater.isUpdateSupported?.bind(updater);
  }
  updater.isUpdateSupported = (info: unknown) => {
    const problem =
      binding.feed === undefined ? "not-an-object" : checkUpdateInfo(info, binding.feed);
    if (problem !== null) throw new StarkUpdateFeedInvalidError({ problem });
    return binding.defaultIsUpdateSupported?.(info) ?? true;
  };
  updater.previousBlockmapBaseUrlOverride = null;
  if (feed.cacheBasePath !== null && updater.app !== undefined) {
    // Read once, when the first download creates the cache, so this runs before any check.
    Object.defineProperty(updater.app, "baseCachePath", {
      value: feed.cacheBasePath,
      configurable: true,
    });
  }
  updater.setFeedURL({ provider: "generic", url: feed.url, channel: feed.channel });
  updater.allowDowngrade = false;
  if (!DIFFERENTIAL_UPDATE_DOWNLOADS_ENABLED) updater.disableDifferentialDownload = true;
}

const binding: UpdaterFeedBinding = { feed: undefined };
// electron-updater creates its platform updater on first access, so the
// singleton is only touched when a method runs, never at import.
const bindableAutoUpdater = () => autoUpdater as unknown as BindableAutoUpdater;

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronUpdater.of({
  setFeedURL: (feed) =>
    Effect.suspend(() => {
      if (!isValidatedStarkUpdateFeed(feed)) {
        return Effect.die(new ElectronUpdaterUnvalidatedFeedError());
      }
      bindUpdaterToValidatedFeed(bindableAutoUpdater(), binding, feed);
      return Effect.void;
    }),
  setAutoDownload: (value) =>
    Effect.suspend(() => {
      autoUpdater.autoDownload = value;
      return Effect.void;
    }),
  setAutoInstallOnAppQuit: (value) =>
    Effect.suspend(() => {
      autoUpdater.autoInstallOnAppQuit = value;
      return Effect.void;
    }),
  // Only a channel the feed serves is used, and electron-updater's channel
  // setter turns downgrades on, so they are turned off again right after.
  setChannel: (channel) =>
    Effect.suspend(() => {
      autoUpdater.channel =
        binding.feed === undefined || binding.feed.channels.includes(channel)
          ? channel
          : binding.feed.channel;
      autoUpdater.allowDowngrade = false;
      return Effect.void;
    }),
  setAllowPrerelease: (value) =>
    Effect.suspend(() => {
      autoUpdater.allowPrerelease = value;
      return Effect.void;
    }),
  allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
  // Owner decision: never downgrade, whichever channel the user picks.
  setAllowDowngrade: () =>
    Effect.suspend(() => {
      autoUpdater.allowDowngrade = false;
      return Effect.void;
    }),
  setFullChangelog: (value) =>
    Effect.suspend(() => {
      autoUpdater.fullChangelog = value;
      return Effect.void;
    }),
  setDisableDifferentialDownload: (value) =>
    Effect.suspend(() => {
      autoUpdater.disableDifferentialDownload = value || !DIFFERENTIAL_UPDATE_DOWNLOADS_ENABLED;
      return Effect.void;
    }),
  // Without a validated feed electron-updater would read app-update.yml on
  // its own; it is never asked to check or download in that state.
  checkForUpdates: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    if (binding.feed === undefined) {
      return Effect.fail(
        new ElectronUpdaterCheckForUpdatesError({
          channel,
          cause: new ElectronUpdaterNoFeedError(),
        }),
      );
    }
    return Effect.tryPromise({
      try: () => autoUpdater.checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    if (binding.feed === undefined) {
      return Effect.fail(
        new ElectronUpdaterDownloadUpdateError({
          channel,
          cause: new ElectronUpdaterNoFeedError(),
        }),
      );
    }
    // Interrupting this effect (Cancel) cancels electron-updater's token, which
    // aborts the transfer itself instead of only abandoning the wait for it.
    return Effect.tryPromise({
      try: (signal) => {
        const cancellationToken = new CancellationToken();
        if (signal.aborted) cancellationToken.cancel();
        else signal.addEventListener("abort", () => cancellationToken.cancel(), { once: true });
        return autoUpdater.downloadUpdate(cancellationToken);
      },
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: ({ isSilent, isForceRunAfter }) =>
    Effect.suspend(() => {
      const channel = autoUpdater.channel;
      return Effect.try({
        try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    }),
  on: (eventName, listener) => {
    const eventTarget = autoUpdater as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
    };
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return Effect.acquireRelease(
      Effect.sync(() => {
        eventTarget.on(eventName, untypedListener);
      }),
      () =>
        Effect.sync(() => {
          eventTarget.removeListener(eventName, untypedListener);
        }),
    ).pipe(Effect.asVoid);
  },
});

export const layer = Layer.succeed(ElectronUpdater, make);
