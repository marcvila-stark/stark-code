import type { DesktopUpdateDisabledReason } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import {
  resolveDesktopUpdateFeed,
  type DesktopUpdateDisabledReason as FeedDisabledReason,
  type DesktopUpdateFeedDecision as FeedDecision,
} from "./updateFeedPolicy.ts";
import * as UpdateSeams from "./updateSeams.ts";

const { logInfo } = DesktopObservability.makeComponentLogger("desktop-updater");

/**
 * Why updates are off, in the words every entry point shows (About, the
 * sidebar, the menu). Each names the reason; none says "Up to date".
 */
export function describeDisabledUpdates(reason: FeedDisabledReason): DesktopUpdateDisabledReason {
  switch (reason) {
    case "unsupported-platform":
      return {
        code: "unsupported-platform",
        message: "Automatic updates are off: they are only available in the macOS app.",
      };
    case "development-build":
      return {
        code: "development-build",
        message: "Automatic updates are off: this is a development build.",
      };
    case "invalid-update-policy":
      return {
        code: "feed-invalid",
        message:
          "Automatic updates are off: this build's update settings can't be read, so it never contacts an update server.",
      };
    case "no-update-feed":
      return {
        code: "feed-not-configured",
        message:
          "Automatic updates are off: this build was made without an update feed. Install new versions from a Stark Future download.",
      };
    case "untrusted-update-feed":
      return {
        code: "feed-invalid",
        message:
          "Automatic updates are off: this build's update feed isn't one Stark Future approved, so it is never contacted.",
      };
    case "disabled-by-environment":
      return {
        code: "turned-off",
        message: "Automatic updates are off: STARK_CODE_DISABLE_AUTO_UPDATE is set.",
      };
    case "not-activated":
      return {
        code: "not-activated",
        message:
          "Automatic updates are off: they aren't switched on for this release yet. Install new versions from a Stark Future download.",
      };
    case "unsigned-build":
      return {
        code: "unsigned-build",
        message:
          "Automatic updates are off: this build isn't signed, so macOS can't verify an update for it.",
      };
    case "untrusted-signature":
      return {
        code: "foreign-signature",
        message:
          "Automatic updates are off: this copy isn't signed by Stark Future, so it can't verify updates.",
      };
  }
}

export function toFeedGateDecision(decision: FeedDecision): UpdateSeams.DesktopUpdateFeedDecision {
  return decision.enabled
    ? { _tag: "Enabled", feed: decision.feed }
    : { _tag: "Disabled", reason: describeDisabledUpdates(decision.reason) };
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const config = yield* DesktopConfig.DesktopConfig.pipe(Effect.orDie);
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { path } = environment;

  // Decided once per launch, after the app is ready: the packaged
  // app-update.yml and baked policy, then the running app's own signature.
  const resolve = yield* Effect.cached(
    resolveDesktopUpdateFeed({
      platform: environment.platform,
      isPackaged: environment.isPackaged,
      disabledByEnv: config.autoUpdateDisabledByEnv,
      activated: config.autoUpdateActivated,
      appUpdateYmlPath: environment.appUpdateYmlPath,
      appPackageJsonPath: path.join(environment.appPath, "package.json"),
      appBundlePath: path.resolve(environment.resourcesPath, "..", ".."),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.tap((decision) =>
        logInfo("update feed decision", {
          enabled: decision.enabled,
          ...(decision.enabled
            ? { kind: decision.feed.kind, channel: decision.feed.channel }
            : { reason: decision.reason, detail: decision.detail }),
        }),
      ),
      Effect.map(toFeedGateDecision),
    ),
  );

  return UpdateSeams.DesktopUpdateFeedGate.of({ resolve });
});

/** Needs the desktop environment and config, a FileSystem and a ChildProcessSpawner. */
export const layer = Layer.effect(UpdateSeams.DesktopUpdateFeedGate, make);
