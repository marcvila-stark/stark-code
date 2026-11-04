import type {
  DesktopUpdateDisabledReason,
  DesktopUpdateErrorKind,
  DesktopUpdateInstallBlocker,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import type * as ElectronUpdater from "../electron/ElectronUpdater.ts";

/**
 * The services the updater runtime consumes: the feed decision
 * (updateFeedGate.ts, over updateFeedPolicy.ts), the downloaded-artifact
 * check (updateArtifactVerification.ts) and the servers' maintenance gate
 * with the install preflight (updateInstallGate.ts, over
 * DesktopInstallPreflight.ts). Tests replace each one.
 */

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export type DesktopUpdateFeedDecision =
  | { readonly _tag: "Enabled"; readonly feed: ElectronUpdater.ElectronUpdaterFeedUrl }
  | { readonly _tag: "Disabled"; readonly reason: DesktopUpdateDisabledReason };

/** Decides whether this build may update, and from which Stark-owned feed. */
export class DesktopUpdateFeedGate extends Context.Service<
  DesktopUpdateFeedGate,
  { readonly resolve: Effect.Effect<DesktopUpdateFeedDecision> }
>()("@starkfuture/desktop/updates/updateSeams/DesktopUpdateFeedGate") {}

// ---------------------------------------------------------------------------
// Downloaded artifact check
// ---------------------------------------------------------------------------

export type DesktopUpdateArtifactVerdict =
  | { readonly _tag: "Verified" }
  | {
      readonly _tag: "Rejected";
      readonly kind: Extract<DesktopUpdateErrorKind, "signature" | "invalid-artifact">;
      readonly detail: string;
    };

/**
 * Checks a finished download before it is offered for a restart, and again
 * before the restart: its code signature against Stark Future's identity,
 * its bundle ID, version and baked update policy.
 */
export class DesktopUpdateArtifactVerifier extends Context.Service<
  DesktopUpdateArtifactVerifier,
  {
    readonly verify: (input: {
      readonly version: string;
      /** electron-updater's cached ZIP (`downloadedFile`); null when it did not say. */
      readonly downloadedFile: string | null;
    }) => Effect.Effect<DesktopUpdateArtifactVerdict>;
  }
>()("@starkfuture/desktop/updates/updateSeams/DesktopUpdateArtifactVerifier") {}

// ---------------------------------------------------------------------------
// Restart preconditions on the servers
// ---------------------------------------------------------------------------

export type DesktopInstallReadiness =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Blocked"; readonly blockers: ReadonlyArray<DesktopUpdateInstallBlocker> }
  /** The preparation failed; whatever it stopped was restarted. */
  | {
      readonly _tag: "Failed";
      readonly kind: DesktopUpdateErrorKind;
      readonly message: string;
    };

/**
 * Asks every managed backend whether a restart would interrupt anything. A
 * `Ready` answer holds new work until `release` or the backends stop.
 */
export class DesktopInstallGate extends Context.Service<
  DesktopInstallGate,
  {
    readonly prepare: (requestId: string) => Effect.Effect<DesktopInstallReadiness>;
    /**
     * After every window saved its drafts and before the installer runs:
     * drain admitted work, stop the backends, lock the data and back it up
     * with the windows' drafts and stash. The uploads the saved drafts
     * reference must survive the next start's attachment cleanup.
     */
    readonly quiesce: (input: {
      readonly requestId: string;
      readonly version: string;
      readonly referencedAttachmentIds: ReadonlyArray<string>;
      /** A window's saved composer drafts and prompt stash, as stored; null when none sent them. */
      readonly draftsJson: string | null;
      readonly stashJson: string | null;
    }) => Effect.Effect<DesktopInstallReadiness>;
    /** Undoes `prepare` or `quiesce`: restarts what was stopped and reopens the gates. */
    readonly release: (requestId: string) => Effect.Effect<void>;
  }
>()("@starkfuture/desktop/updates/updateSeams/DesktopInstallGate") {}

export const MAINTENANCE_GATE_UNAVAILABLE: DesktopUpdateInstallBlocker = {
  kind: "maintenance-unavailable",
  message: "Stark Code can't yet confirm that no task or approval would be interrupted.",
};

// ---------------------------------------------------------------------------
// Connectivity evidence
// ---------------------------------------------------------------------------

/**
 * Whether this machine has a network connection, or null when unknown. A
 * failed request is reported as "offline" only when this says false.
 */
export class DesktopUpdateConnectivity extends Context.Service<
  DesktopUpdateConnectivity,
  { readonly isOnline: Effect.Effect<boolean | null> }
>()("@starkfuture/desktop/updates/updateSeams/DesktopUpdateConnectivity") {}

export const layerConnectivity = Layer.succeed(DesktopUpdateConnectivity, {
  isOnline: Effect.sync(() => {
    try {
      return Electron.net.isOnline();
    } catch {
      return null;
    }
  }),
});
