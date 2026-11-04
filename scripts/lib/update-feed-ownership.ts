/**
 * Who may serve Stark Code updates: the rules both the desktop build and the
 * packaged app apply.
 *
 * The build bakes one policy into the app (`starkcodeUpdate` in the packaged
 * package.json, plus `kind` in Resources/app-update.yml) and verifies the
 * packaged app-update.yml and signature with these functions. At runtime
 * apps/desktop/src/updates/updateFeedPolicy.ts applies the same functions
 * before the updater is given a feed, so the build and the app cannot
 * disagree about what a valid feed is.
 */
import { BRAND } from "@starkfuture/shared/branding";
import { fromYaml } from "@starkfuture/shared/schemaYaml";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The checked-in answer to "who owns updates": stark.brand.json. */
export interface UpdateOwnership {
  readonly bundleId: string;
  /** The Apple Developer Team that must sign every build on a Stark feed. */
  readonly appleTeamId: string | null;
  /** HTTPS origins that may host a feed. Empty until hosting is approved. */
  readonly updateFeedOrigins: ReadonlyArray<string>;
  /** Channels a feed may serve. */
  readonly updateChannels: ReadonlyArray<string>;
}

const brandTeamId: string | null = BRAND.appleTeamId;
const brandOrigins: ReadonlyArray<string> = BRAND.updateFeedOrigins;
const brandChannels: ReadonlyArray<string> = BRAND.updateChannels;

export const STARK_UPDATE_OWNERSHIP: UpdateOwnership = {
  bundleId: BRAND.bundleId,
  appleTeamId: brandTeamId,
  updateFeedOrigins: brandOrigins,
  updateChannels: brandChannels,
};

const DESKTOP_UPDATE_FEED_KINDS = ["none", "stark", "mock"] as const;
export type DesktopUpdateFeedKind = (typeof DESKTOP_UPDATE_FEED_KINDS)[number];
const DesktopUpdateFeedKindSchema = Schema.Literals(DESKTOP_UPDATE_FEED_KINDS);

/** The package.json key the build writes the baked policy under. */
export const BAKED_UPDATE_POLICY_KEY = "starkcodeUpdate";

/**
 * Faults a mock rehearsal build can carry. `migration-fail` makes the next
 * database open fail one migration step, after its pre-migrate backup.
 */
export const DESKTOP_REHEARSAL_FAULTS = ["migration-fail"] as const;
export type DesktopRehearsalFault = (typeof DESKTOP_REHEARSAL_FAULTS)[number];

/**
 * A mock rehearsal build's own data: `<profile>/home` is its Stark home and
 * `<profile>/app-data` its desktop data directory, whatever the environment
 * says, so the updater's relaunch (which drops the environment) never lands
 * on the live install.
 */
export const BakedRehearsalPolicy = Schema.Struct({
  profile: Schema.NullOr(Schema.String),
  fault: Schema.NullOr(Schema.Literals(DESKTOP_REHEARSAL_FAULTS)),
});
export type BakedRehearsalPolicy = typeof BakedRehearsalPolicy.Type;

export const BakedUpdatePolicy = Schema.Struct({
  kind: DesktopUpdateFeedKindSchema,
  url: Schema.NullOr(Schema.String),
  channels: Schema.Array(Schema.String),
  appleTeamId: Schema.NullOr(Schema.String),
  /** Mock builds only; absent or null everywhere else. */
  rehearsal: Schema.optionalKey(Schema.NullOr(BakedRehearsalPolicy)),
});
export type BakedUpdatePolicy = typeof BakedUpdatePolicy.Type;

/** The rehearsal a baked policy carries, or null. */
export function bakedRehearsalOf(policy: BakedUpdatePolicy): BakedRehearsalPolicy | null {
  return policy.rehearsal ?? null;
}

/** A rehearsal profile is an absolute POSIX directory with no dot segments. */
export function isValidRehearsalProfile(profile: string): boolean {
  return (
    profile.startsWith("/") &&
    profile.length > 1 &&
    !profile.includes("\\") &&
    !profile.split("/").some((segment) => segment === "." || segment === "..")
  );
}

const decodeBakedUpdatePolicy = Schema.decodeUnknownOption(BakedUpdatePolicy, {
  onExcessProperty: "error",
});
const decodeJsonRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Reads the baked policy from the packaged package.json. A package without one
 * (any build from before update ownership existed) is `none`. Unreadable JSON
 * or a malformed policy is `invalid`, never a feed.
 */
export function readBakedUpdatePolicy(
  packageJson: string | undefined,
): { readonly ok: true; readonly policy: BakedUpdatePolicy } | { readonly ok: false } {
  const none: BakedUpdatePolicy = { kind: "none", url: null, channels: [], appleTeamId: null };
  if (packageJson === undefined) return { ok: false };
  const record = Option.getOrUndefined(decodeJsonRecord(packageJson));
  if (record === undefined) return { ok: false };
  const raw = record[BAKED_UPDATE_POLICY_KEY];
  if (raw === undefined) return { ok: true, policy: none };
  const policy = Option.getOrUndefined(decodeBakedUpdatePolicy(raw));
  return policy === undefined ? { ok: false } : { ok: true, policy };
}

// ---------------------------------------------------------------------------
// Feed URLs

export const FEED_URL_PROBLEMS = [
  "not-a-url",
  "not-https",
  "credentials",
  "query-or-fragment",
  "not-a-directory",
  "not-canonical",
  "unsafe-path",
  "loopback",
  "origin-not-allowed",
  "not-loopback",
] as const;
export type FeedUrlProblem = (typeof FEED_URL_PROBLEMS)[number];

export interface FeedLocation {
  readonly href: string;
  readonly origin: string;
  readonly protocol: "https:" | "http:";
  /** The feed directory; every request must stay below it. Starts and ends with `/`. */
  readonly basePath: string;
}

// One URL path segment of a feed directory or a release file. No dot
// segments, no percent-encoding, no separators of any kind.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]*$/u;

export function isSafeUpdatePathSegment(segment: string): boolean {
  return SAFE_PATH_SEGMENT.test(segment);
}
const MOCK_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname.startsWith("127.") ||
    hostname === "0.0.0.0"
  );
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hasSafeDirectoryPath(pathname: string): boolean {
  if (!pathname.startsWith("/") || !pathname.endsWith("/")) return false;
  const segments = pathname.slice(1, -1);
  return segments === "" || segments.split("/").every((segment) => SAFE_PATH_SEGMENT.test(segment));
}

/**
 * Checks a feed URL for its kind. A Stark feed is a canonical `https:`
 * directory URL on an allowlisted origin. A mock feed is exactly
 * `http://localhost:<port>/` or `http://127.0.0.1:<port>/`.
 */
export function checkFeedUrl(
  url: string,
  kind: "stark" | "mock",
  ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
):
  | { readonly ok: true; readonly location: FeedLocation }
  | { readonly ok: false; readonly problem: FeedUrlProblem } {
  const parsed = parseUrl(url);
  if (parsed === undefined) return { ok: false, problem: "not-a-url" };
  if (parsed.username !== "" || parsed.password !== "")
    return { ok: false, problem: "credentials" };
  if (parsed.search !== "" || parsed.hash !== "" || url.includes("?") || url.includes("#")) {
    return { ok: false, problem: "query-or-fragment" };
  }
  if (kind === "mock") {
    if (parsed.protocol !== "http:" || !MOCK_LOOPBACK_HOSTS.has(parsed.hostname)) {
      return { ok: false, problem: "not-loopback" };
    }
    if (parsed.port === "" || parsed.pathname !== "/" || parsed.href !== url) {
      return { ok: false, problem: "not-canonical" };
    }
    return {
      ok: true,
      location: { href: parsed.href, origin: parsed.origin, protocol: "http:", basePath: "/" },
    };
  }
  if (parsed.protocol !== "https:") return { ok: false, problem: "not-https" };
  if (isLoopbackHostname(parsed.hostname)) return { ok: false, problem: "loopback" };
  if (!parsed.pathname.endsWith("/")) return { ok: false, problem: "not-a-directory" };
  if (parsed.href !== url) return { ok: false, problem: "not-canonical" };
  if (!hasSafeDirectoryPath(parsed.pathname)) return { ok: false, problem: "unsafe-path" };
  if (!isAllowlistedOrigin(parsed.origin, ownership)) {
    return { ok: false, problem: "origin-not-allowed" };
  }
  return {
    ok: true,
    location: {
      href: parsed.href,
      origin: parsed.origin,
      protocol: "https:",
      basePath: parsed.pathname,
    },
  };
}

function isAllowlistedOrigin(origin: string, ownership: UpdateOwnership): boolean {
  return ownership.updateFeedOrigins.some((entry) => {
    const allowed = parseUrl(entry);
    // An allowlist entry is itself held to the Stark feed rules, so a bad
    // edit to stark.brand.json cannot admit plain HTTP or loopback.
    return (
      allowed !== undefined &&
      allowed.protocol === "https:" &&
      !isLoopbackHostname(allowed.hostname) &&
      allowed.origin === entry.replace(/\/$/u, "") &&
      allowed.origin === origin
    );
  });
}

// ---------------------------------------------------------------------------
// Release file URLs inside a manifest

const UPDATE_FILE_URL_PROBLEMS = [
  "empty",
  "absolute",
  "protocol-relative",
  "rooted",
  "backslash",
  "percent-encoded",
  "query-or-fragment",
  "traversal",
  "unsafe-segment",
] as const;
export type UpdateFileUrlProblem = (typeof UPDATE_FILE_URL_PROBLEMS)[number];

/**
 * A manifest names release files relative to its feed directory: plain path
 * segments only. Anything that could resolve outside the feed (a scheme, a
 * host, a rooted path, `..`, encoded separators or dots) is refused.
 */
export function checkUpdateFileUrl(url: string): UpdateFileUrlProblem | null {
  if (url.length === 0) return "empty";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(url)) return "absolute";
  if (url.startsWith("//") || url.startsWith("\\\\")) return "protocol-relative";
  if (url.startsWith("/")) return "rooted";
  if (url.includes("\\")) return "backslash";
  if (url.includes("%")) return "percent-encoded";
  if (url.includes("?") || url.includes("#")) return "query-or-fragment";
  const segments = url.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return "traversal";
  if (!segments.every((segment) => SAFE_PATH_SEGMENT.test(segment))) return "unsafe-segment";
  return null;
}

// ---------------------------------------------------------------------------
// app-update.yml

const APP_UPDATE_YML_KEYS = ["provider", "url", "channel", "updaterCacheDirName", "kind"] as const;

const AppUpdateYmlRecord = fromYaml(Schema.Record(Schema.String, Schema.Unknown));
const decodeAppUpdateYmlRecord = Schema.decodeUnknownOption(AppUpdateYmlRecord);

export const STARK_UPDATE_FEED_PROBLEMS = [
  "feed-not-expected",
  "policy-url-missing",
  "policy-url-invalid",
  "policy-channel-not-enabled",
  "policy-team-not-pinned",
  "policy-rehearsal-invalid",
  "yml-unreadable",
  "yml-unexpected-key",
  "yml-missing-key",
  "provider-not-generic",
  "url-mismatch",
  "channel-mismatch",
  "kind-mismatch",
  "cache-dir-invalid",
] as const;
export type StarkUpdateFeedProblem = (typeof STARK_UPDATE_FEED_PROBLEMS)[number];

/**
 * A feed that passed `validateStarkUpdateFeed`. Only objects created by the
 * validator are accepted by the updater wiring (`isValidatedStarkUpdateFeed`),
 * so no other code path can hand electron-updater a feed.
 */
export interface ValidatedStarkUpdateFeed {
  readonly provider: "generic";
  readonly url: string;
  readonly channel: string;
  readonly kind: "stark" | "mock";
  readonly channels: ReadonlyArray<string>;
  readonly appleTeamId: string | null;
  readonly location: FeedLocation;
  /**
   * Where electron-updater keeps its downloads instead of the platform cache
   * (`~/Library/Caches/<updaterCacheDirName>`, shared with every install of
   * the app): `<profile>/caches` for a rehearsal build with a baked profile,
   * null for every other build. Squirrel.Mac's own caches
   * (`~/Library/Caches/<bundle id>` and `<bundle id>.ShipIt`) cannot be moved.
   */
  readonly cacheBasePath: string | null;
}

const validatedFeeds = new WeakSet<object>();

export function isValidatedStarkUpdateFeed(value: unknown): value is ValidatedStarkUpdateFeed {
  return typeof value === "object" && value !== null && validatedFeeds.has(value);
}

export type StarkUpdateFeedValidation =
  | { readonly ok: true; readonly feed: ValidatedStarkUpdateFeed }
  | {
      readonly ok: false;
      readonly problem: StarkUpdateFeedProblem;
      readonly urlProblem?: FeedUrlProblem;
    };

/**
 * Checks a baked policy against the checked-in ownership, without the
 * packaged app-update.yml. The build uses it before staging.
 */
export type BakedUpdatePolicyCheck =
  | { readonly ok: true; readonly location: FeedLocation }
  | {
      readonly ok: false;
      readonly problem: StarkUpdateFeedProblem;
      readonly urlProblem?: FeedUrlProblem;
    };

export function checkBakedUpdatePolicy(
  policy: BakedUpdatePolicy,
  ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
): BakedUpdatePolicyCheck {
  if (policy.kind === "none") return { ok: false, problem: "feed-not-expected" };
  if (policy.url === null) return { ok: false, problem: "policy-url-missing" };
  const url = checkFeedUrl(policy.url, policy.kind, ownership);
  if (!url.ok) return { ok: false, problem: "policy-url-invalid", urlProblem: url.problem };
  if (
    policy.channels.length === 0 ||
    !policy.channels.every((channel) => ownership.updateChannels.includes(channel))
  ) {
    return { ok: false, problem: "policy-channel-not-enabled" };
  }
  if (
    policy.kind === "stark" &&
    (ownership.appleTeamId === null || policy.appleTeamId !== ownership.appleTeamId)
  ) {
    return { ok: false, problem: "policy-team-not-pinned" };
  }
  const rehearsal = bakedRehearsalOf(policy);
  if (
    rehearsal !== null &&
    (policy.kind !== "mock" ||
      (rehearsal.profile !== null && !isValidRehearsalProfile(rehearsal.profile)))
  ) {
    return { ok: false, problem: "policy-rehearsal-invalid" };
  }
  return { ok: true, location: url.location };
}

/**
 * Validates the packaged app-update.yml against the baked policy: provider
 * `generic` only, the exact baked URL (an allowlisted HTTPS origin, or
 * loopback for a mock build), an allowlisted channel and the baked kind.
 * Every other key, provider or host is refused.
 */
export function validateStarkUpdateFeed(
  appUpdateYml: string,
  policy: BakedUpdatePolicy,
  ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
): StarkUpdateFeedValidation {
  const checked = checkBakedUpdatePolicy(policy, ownership);
  if (!checked.ok) return checked;
  const kind = policy.kind;
  if (kind === "none" || policy.url === null) return { ok: false, problem: "feed-not-expected" };
  const yml = Option.getOrUndefined(decodeAppUpdateYmlRecord(appUpdateYml));
  if (yml === undefined || Array.isArray(yml)) return { ok: false, problem: "yml-unreadable" };
  const allowedKeys: ReadonlyArray<string> = APP_UPDATE_YML_KEYS;
  if (Object.keys(yml).some((key) => !allowedKeys.includes(key))) {
    return { ok: false, problem: "yml-unexpected-key" };
  }
  const { provider, url, channel, kind: ymlKind, updaterCacheDirName } = yml;
  if (
    typeof provider !== "string" ||
    typeof url !== "string" ||
    typeof channel !== "string" ||
    typeof ymlKind !== "string" ||
    typeof updaterCacheDirName !== "string"
  ) {
    return { ok: false, problem: "yml-missing-key" };
  }
  if (provider !== "generic") return { ok: false, problem: "provider-not-generic" };
  if (url !== policy.url) return { ok: false, problem: "url-mismatch" };
  if (!policy.channels.includes(channel)) return { ok: false, problem: "channel-mismatch" };
  if (ymlKind !== kind) return { ok: false, problem: "kind-mismatch" };
  if (!SAFE_PATH_SEGMENT.test(updaterCacheDirName)) {
    return { ok: false, problem: "cache-dir-invalid" };
  }
  const profile = bakedRehearsalOf(policy)?.profile ?? null;
  const feed: ValidatedStarkUpdateFeed = Object.freeze({
    provider: "generic" as const,
    url: checked.location.href,
    channel,
    kind,
    channels: Object.freeze([...policy.channels]),
    appleTeamId: policy.appleTeamId,
    location: Object.freeze({ ...checked.location }),
    cacheBasePath: profile === null ? null : `${profile.replace(/\/+$/, "")}/caches`,
  });
  validatedFeeds.add(feed);
  return { ok: true, feed };
}

/**
 * Top-level channel-manifest key naming the feed kind it was made for. A mock
 * build writes `starkFeedKind: mock`; the mock server serves only manifests
 * that say so, a mock app follows only those, and a Stark app and the release
 * publisher refuse them.
 */
export const UPDATE_MANIFEST_FEED_KIND_KEY = "starkFeedKind";

/** The channel manifest electron-updater requests on macOS: `<channel>-mac.yml`. */
export function macChannelFileName(channel: string): string {
  return `${channel}-mac.yml`;
}

// ---------------------------------------------------------------------------
// The app's own signature

export interface DesignatedRequirement {
  /** The requirement text after `designated =>`, or undefined when there is none. */
  readonly text: string | undefined;
  readonly identifier: string | undefined;
  readonly teamId: string | undefined;
  readonly anchor: "apple-generic" | "apple" | "cdhash" | "certificate" | "none";
  /** True when the requirement has a top-level `or`, so its clauses are alternatives. */
  readonly hasAlternatives: boolean;
}

/** Parses `codesign -d -r-` output (stdout and stderr together). */
export function parseDesignatedRequirement(output: string): DesignatedRequirement {
  const line = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replace(/^#\s*/u, ""))
    .find((entry) => entry.startsWith("designated =>"));
  const text = line?.slice("designated =>".length).trim() || undefined;
  if (text === undefined) {
    return {
      text: undefined,
      identifier: undefined,
      teamId: undefined,
      anchor: "none",
      hasAlternatives: false,
    };
  }
  const identifier = /\bidentifier\s+(?:"([^"]+)"|([A-Za-z0-9.-]+))/u.exec(text);
  const team =
    /certificate\s+leaf\[subject\.OU\]\s*=\s*(?:"([A-Z0-9]{10})"|([A-Z0-9]{10})\b)/u.exec(text);
  const anchor = /\banchor apple generic\b/u.test(text)
    ? "apple-generic"
    : /\banchor apple\b/u.test(text)
      ? "apple"
      : /^cdhash\b/u.test(text)
        ? "cdhash"
        : /\bcertificate\b/u.test(text)
          ? "certificate"
          : "none";
  // Parenthesised groups (Developer ID's "this field or that field") do not
  // weaken the identifier or team clauses; a bare top-level `or` would.
  let topLevel = text;
  while (/\([^()]*\)/u.test(topLevel)) topLevel = topLevel.replace(/\([^()]*\)/gu, " group ");
  return {
    text,
    identifier: identifier?.[1] ?? identifier?.[2],
    teamId: team?.[1] ?? team?.[2],
    anchor,
    hasAlternatives: /\bor\b/u.test(topLevel),
  };
}

/**
 * The code requirement every Stark Code build must satisfy: signed through
 * Apple's CA, as this bundle id, by a certificate issued to this team. Apple
 * Development and Developer ID certificates both carry the team in
 * `subject.OU`, so a development rehearsal and a release are held to the same
 * text. `codesign --verify -R '=<this>'` checks a candidate against it, and
 * `requirementPinsIdentity` accepts it.
 */
export function designatedRequirementForTeam(identity: {
  readonly teamId: string;
  readonly bundleId: string;
}): string {
  if (!/^[A-Z0-9]{10}$/u.test(identity.teamId)) {
    throw new Error(`'${identity.teamId}' is not an Apple Team ID.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(identity.bundleId)) {
    throw new Error(`'${identity.bundleId}' is not a bundle identifier.`);
  }
  return `anchor apple generic and identifier "${identity.bundleId}" and certificate leaf[subject.OU] = "${identity.teamId}"`;
}

/** Whether a designated requirement pins this bundle id and the Apple team. */
export function requirementPinsIdentity(
  requirement: DesignatedRequirement,
  identity: { readonly bundleId: string; readonly teamId: string },
): boolean {
  return (
    requirement.anchor === "apple-generic" &&
    !requirement.hasAlternatives &&
    requirement.identifier === identity.bundleId &&
    requirement.teamId === identity.teamId
  );
}

export interface CodeSignatureSummary {
  readonly signed: boolean;
  readonly adHoc: boolean;
  readonly teamIdentifier: string | undefined;
  readonly requirement: DesignatedRequirement;
}

/** Parses `codesign --display --verbose=2 -r- <app>` (stdout and stderr together). */
export function parseCodeSignatureSummary(output: string): CodeSignatureSummary {
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  const valueOf = (key: string) =>
    lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const team = valueOf("TeamIdentifier");
  const requirement = parseDesignatedRequirement(output);
  const unsigned = /code object is not signed at all/u.test(output);
  return {
    signed: !unsigned && (valueOf("Identifier") !== undefined || requirement.text !== undefined),
    adHoc: valueOf("Signature") === "adhoc" || requirement.anchor === "cdhash",
    teamIdentifier: team && team !== "not set" ? team : undefined,
    requirement,
  };
}

const SIGNATURE_PROBLEMS = [
  "unreadable",
  "unsigned",
  "ad-hoc",
  "team-not-configured",
  "team-mismatch",
  "identifier-mismatch",
  "requirement-not-pinned",
] as const;
export type SignatureProblem = (typeof SIGNATURE_PROBLEMS)[number];

/**
 * Whether this app may follow its feed: signed, not ad hoc (Squirrel could
 * never accept an update for it), by the checked-in team, as this bundle id.
 * A Stark feed also needs a Developer ID requirement that pins the team.
 */
export function checkOwnSignature(
  summary: CodeSignatureSummary,
  kind: "stark" | "mock",
  ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
): SignatureProblem | null {
  if (!summary.signed) return "unsigned";
  if (summary.adHoc) return "ad-hoc";
  if (ownership.appleTeamId === null) return "team-not-configured";
  if (summary.teamIdentifier !== ownership.appleTeamId) return "team-mismatch";
  if (summary.requirement.identifier !== ownership.bundleId) return "identifier-mismatch";
  if (
    kind === "stark" &&
    !requirementPinsIdentity(summary.requirement, {
      bundleId: ownership.bundleId,
      teamId: ownership.appleTeamId,
    })
  ) {
    return "requirement-not-pinned";
  }
  return null;
}
