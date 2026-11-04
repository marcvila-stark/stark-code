import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

/**
 * The native Squirrel.Mac updater (electron's `autoUpdater`) that
 * electron-updater's MacUpdater feeds. MacUpdater serves the downloaded ZIP
 * to it from a loopback proxy; Squirrel then fetches it, checks its code
 * signature and stages it.
 */
export interface NativeMacUpdater {
  readonly getFeedURL: () => string;
  /** Adds a listener and returns the function that removes it. */
  readonly onUpdateDownloaded: (listener: () => void) => () => void;
  readonly onError: (listener: (error: unknown) => void) => () => void;
  readonly checkForUpdates: () => void;
  readonly quitAndInstall: () => void;
}

export type DesktopUpdateCommitOutcome =
  /** The installer accepted the update and the app is quitting to install it. */
  | { readonly _tag: "Committed" }
  /** The installer reported an error, such as a rejected signature. */
  | { readonly _tag: "Failed"; readonly cause: unknown }
  /** The installer neither accepted nor rejected the update in time. */
  | { readonly _tag: "TimedOut" }
  /** The request was refused before the installer was asked. */
  | { readonly _tag: "Refused"; readonly reason: string }
  /** The caller withdrew the request while it waited, for example to recover. */
  | { readonly _tag: "Withdrawn" };

const DESKTOP_UPDATE_COMMIT_TIMEOUT = Duration.seconds(60);

/**
 * True only for MacUpdater's own handoff: plain HTTP on 127.0.0.1 with an
 * explicit port and no credentials in the URL. Anything else means the native
 * updater would fetch from somewhere Stark Code did not choose.
 */
export function isLoopbackInstallerHandoff(feedUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    url.username === "" &&
    url.password === ""
  );
}

/**
 * Hands a downloaded update to the native installer and quits to install it,
 * one approved request ("generation") at a time.
 *
 * MacUpdater.quitAndInstall() is never called: it registers a listener that
 * quits whenever Squirrel finishes, with no way to withdraw it. Here each
 * request owns its listener. A request that timed out or failed is withdrawn
 * before the caller recovers, so a completion that arrives later, or twice,
 * never quits the app. Squirrel still keeps such an update and installs it on
 * the next ordinary quit; `onLateStaged` reports that.
 */
export class DesktopUpdateLifecycle extends Context.Service<
  DesktopUpdateLifecycle,
  {
    /** Refusal reason when the installer could not be asked right now. */
    readonly preflight: Effect.Effect<Option.Option<string>>;
    readonly commit: (input: {
      /** The install request this commit belongs to; see `withdraw`. */
      readonly requestId: string;
      readonly version: string;
      readonly timeout?: Duration.Input;
    }) => Effect.Effect<DesktopUpdateCommitOutcome>;
    /**
     * Withdraws an install request, whether it is waiting on the installer or
     * has not reached it yet: whatever the installer reports afterwards never
     * quits the app, and a later `commit` for it returns `Withdrawn` at once.
     * Recovery calls this before restarting the backends.
     */
    readonly withdraw: (requestId: string) => Effect.Effect<void>;
    /** Calls `listener` when the installer stages a version after its request was withdrawn. */
    readonly onLateStaged: (
      listener: (version: string) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@starkfuture/desktop/updates/updateLifecycle/DesktopUpdateLifecycle") {}

interface LiveRequest {
  readonly generation: number;
  readonly requestId: string;
  readonly version: string;
  readonly outcome: Deferred.Deferred<DesktopUpdateCommitOutcome>;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = (native: NativeMacUpdater) =>
  Effect.sync(() => {
    let generation = 0;
    let live: LiveRequest | null = null;
    let lastRequestedVersion: string | null = null;
    let stagedVersion: string | null = null;
    let observing = false;
    const withdrawnRequests = new Set<string>();
    const lateListeners = new Set<(version: string) => void>();

    // Registered once, on first use: records what Squirrel staged. It never
    // quits; only a live request's own listener does.
    const ensureObserver = Effect.sync(() => {
      if (observing) return;
      observing = true;
      native.onUpdateDownloaded(() => {
        const version = live?.version ?? lastRequestedVersion;
        if (version === null) return;
        stagedVersion = version;
        if (live === null) {
          for (const listener of lateListeners) listener(version);
        }
      });
    });

    const preflight = Effect.sync(() => {
      let feedUrl: string;
      try {
        feedUrl = native.getFeedURL();
      } catch {
        return Option.some("The installer has no update to install.");
      }
      return isLoopbackInstallerHandoff(feedUrl)
        ? Option.none<string>()
        : Option.some("The installer is not set to install the downloaded update.");
    });

    const commit = Effect.fn("desktop.updates.lifecycle.commit")(function* (input: {
      readonly requestId: string;
      readonly version: string;
      readonly timeout?: Duration.Input;
    }) {
      if (withdrawnRequests.has(input.requestId)) {
        return { _tag: "Withdrawn" } as DesktopUpdateCommitOutcome;
      }
      const refusal = yield* preflight;
      if (Option.isSome(refusal)) {
        return { _tag: "Refused", reason: refusal.value } as DesktopUpdateCommitOutcome;
      }
      yield* ensureObserver;

      generation += 1;
      lastRequestedVersion = input.version;
      const outcome = yield* Deferred.make<DesktopUpdateCommitOutcome>();
      const request: LiveRequest = {
        generation,
        requestId: input.requestId,
        version: input.version,
        outcome,
      };
      const isLive = () => live !== null && live.generation === request.generation;
      const withdraw = () => {
        if (isLive()) live = null;
      };

      // Squirrel already staged this version, for example after an earlier
      // request timed out: this approved request installs it now.
      if (stagedVersion === input.version) {
        native.quitAndInstall();
        return { _tag: "Committed" } as DesktopUpdateCommitOutcome;
      }

      live = request;
      const removeDownloaded = native.onUpdateDownloaded(() => {
        if (!isLive()) return;
        withdraw();
        stagedVersion = request.version;
        native.quitAndInstall();
        Deferred.doneUnsafe(outcome, Effect.succeed({ _tag: "Committed" }));
      });
      const removeError = native.onError((cause) => {
        if (!isLive()) return;
        withdraw();
        Deferred.doneUnsafe(outcome, Effect.succeed({ _tag: "Failed", cause }));
      });

      // A synchronous throw from the native call fails the request like an error event.
      return yield* Effect.sync(() => {
        try {
          native.checkForUpdates();
        } catch (cause) {
          if (isLive()) {
            withdraw();
            Deferred.doneUnsafe(outcome, Effect.succeed({ _tag: "Failed", cause }));
          }
        }
      }).pipe(
        Effect.andThen(
          Deferred.await(outcome).pipe(
            Effect.timeoutOption(input.timeout ?? DESKTOP_UPDATE_COMMIT_TIMEOUT),
          ),
        ),
        Effect.map((result) =>
          Option.getOrElse(result, (): DesktopUpdateCommitOutcome => ({ _tag: "TimedOut" })),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            withdraw();
            removeDownloaded();
            removeError();
          }),
        ),
      );
    });

    const withdraw = (requestId: string) =>
      Effect.sync(() => {
        withdrawnRequests.add(requestId);
        const request = live;
        if (request === null || request.requestId !== requestId) return;
        live = null;
        Deferred.doneUnsafe(request.outcome, Effect.succeed({ _tag: "Withdrawn" }));
      });

    return DesktopUpdateLifecycle.of({
      preflight,
      commit,
      withdraw,
      onLateStaged: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            lateListeners.add(listener);
          }),
          () =>
            Effect.sync(() => {
              lateListeners.delete(listener);
            }),
        ),
    });
  });

const electronNativeMacUpdater: NativeMacUpdater = {
  getFeedURL: () => Electron.autoUpdater.getFeedURL(),
  onUpdateDownloaded: (listener) => {
    Electron.autoUpdater.on("update-downloaded", listener);
    return () => {
      Electron.autoUpdater.removeListener("update-downloaded", listener);
    };
  },
  onError: (listener) => {
    Electron.autoUpdater.on("error", listener);
    return () => {
      Electron.autoUpdater.removeListener("error", listener);
    };
  },
  checkForUpdates: () => Electron.autoUpdater.checkForUpdates(),
  quitAndInstall: () => Electron.autoUpdater.quitAndInstall(),
};

export const layer = Layer.effect(DesktopUpdateLifecycle, make(electronNativeMacUpdater));

export const layerTest = (native: NativeMacUpdater) =>
  Layer.effect(DesktopUpdateLifecycle, make(native));
