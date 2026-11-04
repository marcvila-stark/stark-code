// @effect-diagnostics nodeBuiltinImport:off - Plain release tooling that runs before any Effect runtime exists.
import * as NodePath from "node:path";

import { extractFile } from "@electron/asar";

import {
  BAKED_UPDATE_POLICY_KEY,
  STARK_UPDATE_OWNERSHIP,
  UPDATE_MANIFEST_FEED_KIND_KEY,
  bakedRehearsalOf,
  checkUpdateFileUrl,
  designatedRequirementForTeam as ownershipDesignatedRequirement,
  readBakedUpdatePolicy,
  type BakedRehearsalPolicy,
} from "./update-feed-ownership.ts";

/**
 * What the release tooling (publisher, rehearsal) takes from the update
 * ownership rules (scripts/lib/update-feed-ownership.ts, shared with the
 * build and the app) and from the data-protection work, behind one module so
 * the scripts and their tests name a single source.
 */

/**
 * Top-level manifest key that marks a feed's kind. The mock server serves
 * only manifests that say `mock`; the publisher refuses any that do.
 */
export const MANIFEST_FEED_KIND_KEY = UPDATE_MANIFEST_FEED_KIND_KEY;

/**
 * The checked-in allowlist of Stark-owned update origins (stark.brand.json
 * `updateFeedOrigins`). It is empty until hosting (owner switch S1) is
 * approved, which refuses every publish.
 */
export function approvedUpdateFeedOrigins(): ReadonlyArray<string> {
  return STARK_UPDATE_OWNERSHIP.updateFeedOrigins;
}

/** The Apple Team ID every distributed build must carry (stark.brand.json `appleTeamId`). */
export function pinnedAppleTeamId(): string | null {
  const teamId = STARK_UPDATE_OWNERSHIP.appleTeamId;
  return teamId !== null && /^[A-Z0-9]{10}$/.test(teamId) ? teamId : null;
}

/** The bundle identifier every Stark Code build keeps across updates. */
export function pinnedBundleId(): string {
  return STARK_UPDATE_OWNERSHIP.bundleId;
}

/**
 * The code requirement `codesign --verify -R` checks a candidate update
 * against: the same text the app's own update check uses.
 */
export function designatedRequirementForTeam(input: {
  readonly teamId: string;
  readonly bundleId: string;
}): string {
  return ownershipDesignatedRequirement(input);
}

/**
 * Manifest file URLs must stay inside the feed: the build's and the app's
 * rule (no scheme, host, rooted path, `..`, encoding, backslash), and a flat
 * feed directory on top, so every file is a bare name.
 */
export function assertSafeManifestFileUrl(url: string): void {
  const problem = checkUpdateFileUrl(url);
  if (problem !== null || url.includes("/")) {
    throw new Error(
      `Manifest file URL '${url}' is not a bare file name inside the feed (${problem ?? "nested"}).`,
    );
  }
}

/** The policy the build bakes into the packaged package.json as `starkcodeUpdate`. */
export interface BakedUpdatePolicy {
  readonly kind: "none" | "stark" | "mock";
  readonly url: string | null;
  readonly channels: ReadonlyArray<string>;
  readonly appleTeamId: string | null;
  readonly rehearsal: BakedRehearsalPolicy | null;
}

/**
 * Reads the update policy baked into a packaged app's package.json with the
 * app's own decoder. A package without one, or with a malformed one, returns
 * undefined, and every caller treats that as a refusal.
 */
export function parseBakedUpdatePolicy(packageJson: unknown): BakedUpdatePolicy | undefined {
  if (typeof packageJson !== "object" || packageJson === null) return undefined;
  if (!(BAKED_UPDATE_POLICY_KEY in packageJson)) return undefined;
  const read = readBakedUpdatePolicy(JSON.stringify(packageJson));
  if (!read.ok) return undefined;
  const { kind, url, channels, appleTeamId } = read.policy;
  return { kind, url, channels, appleTeamId, rehearsal: bakedRehearsalOf(read.policy) };
}

/** Reads `package.json` out of `<App>.app/Contents/Resources/app.asar`. */
export function readPackagedAppPackageJson(appPath: string): unknown {
  const raw = extractFile(
    NodePath.join(appPath, "Contents", "Resources", "app.asar"),
    "package.json",
  );
  return JSON.parse(raw.toString("utf8"));
}

/**
 * Build environment for a rehearsal build: the mock feed and a profile baked
 * into the app, so the updater's relaunch (which drops the environment) still
 * lands on the rehearsal data. The build bakes the profile as `rehearsal` in
 * `starkcodeUpdate`; the app then uses `<profileDir>/home` as its Stark home
 * and `<profileDir>/app-data` as its desktop data directory
 * (apps/desktop/src/app/DesktopLocationAnchor.ts).
 */
export function rehearsalBuildEnv(input: {
  /** Null for R2, which upgrades an existing profile in an isolated account. */
  readonly profileDir: string | null;
  readonly fault: string | null;
}): Record<string, string> {
  return {
    STARK_CODE_DESKTOP_UPDATE_FEED: "mock",
    ...(input.profileDir === null
      ? {}
      : { STARK_CODE_DESKTOP_REHEARSAL_PROFILE: input.profileDir }),
    ...(input.fault === null ? {} : { STARK_CODE_DESKTOP_REHEARSAL_FAULT: input.fault }),
  };
}

/**
 * The baked fault that makes the server's next database open fail one
 * migration step inside its transaction, after the fresh pre-migrate backup
 * (apps/server/src/persistence/Sqlite.ts). Mock builds only.
 */
export const REHEARSAL_MIGRATION_FAULT = "migration-fail" satisfies BakedRehearsalPolicy["fault"];
