/**
 * Browser import - pulling cookies from a browser already installed on the
 * machine into a Stark Code browser profile.
 *
 * Only cookies are imported. They carry the logged-in sessions, which is what
 * makes an imported profile useful; saved passwords are deliberately out of
 * scope because Electron exposes no password store to put them in.
 *
 * Availability is per source and per platform, and the reasons are modelled
 * explicitly: some are a permission the user can grant, one is a limitation
 * no amount of consent works around. The UI needs to tell those apart.
 *
 * @module BrowserImport
 */
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";

/** Bound both discovered site inventories and explicit import selections. */
export const BROWSER_IMPORT_MAX_DOMAINS = 2_000;

const BROWSER_IMPORT_SOURCE_IDS = [
  "chrome",
  "edge",
  "brave",
  "vivaldi",
  "opera",
  "arc",
  "helium",
  "firefox",
  "zen",
  "safari",
] as const;

export const BrowserImportSourceId = Schema.Literals(BROWSER_IMPORT_SOURCE_IDS);
export type BrowserImportSourceId = typeof BrowserImportSourceId.Type;

/**
 * Why a detected source cannot be imported right now.
 *
 * `needsKeychainApproval` and `browserRunning` are recoverable — the user
 * grants access or quits the browser. `unsupportedPlatform` is not: it covers
 * cases like Chrome on Windows, whose App-Bound Encryption is designed to stop
 * exactly this, and which we will not work around.
 */
export const BrowserImportUnavailableReason = Schema.Literals([
  "notInstalled",
  "needsKeychainApproval",
  "keychainItemMissing",
  "needsFullDiskAccess",
  "browserRunning",
  "unsupportedPlatform",
]);
export type BrowserImportUnavailableReason = typeof BrowserImportUnavailableReason.Type;

/**
 * Why an import that was actually attempted failed.
 *
 * A superset of the unavailable reasons: a source can pass the pre-flight
 * check and still fail, most often because the user declined the keychain
 * prompt the read triggers.
 */
export const BrowserImportFailureReason = Schema.Literals([
  ...BrowserImportUnavailableReason.literals,
  /** The operating system's keyring or its bundled reader is unavailable. */
  "keychainUnavailable",
  /** No source registered under the requested id. */
  "unknownSource",
  /** The requested profile directory is not one the source reported. */
  "unknownSourceProfile",
  /** Import is restricted to the personal profile and explicitly selected sites. */
  "unsafeTarget",
  /** Import requires an encrypted packaged runtime and an OS-backed keyring. */
  "storageNotEncrypted",
  /** The target profile's Electron session could not be opened. */
  "sessionUnavailable",
  /**
   * The cookies were written, but the new profile could not be saved to
   * settings, so its partition was cleared again rather than left orphaned.
   */
  "profileNotSaved",
  /**
   * The cookies were written, but the profile count reached its cap while the
   * import ran, so the new profile was not saved and its partition was cleared.
   */
  "profileLimitReached",
  /** Anything else: a corrupt database, a failed decrypt, a vanished file. */
  "readFailed",
]);
export type BrowserImportFailureReason = typeof BrowserImportFailureReason.Type;

/** A profile inside the source browser, e.g. Chromium's "Default" directory. */
export const BrowserImportSourceProfile = Schema.Struct({
  /** Directory name under the source's user-data dir. */
  directory: TrimmedNonEmptyString,
  /** The name the source browser shows for it. */
  name: TrimmedNonEmptyString,
  /**
   * How many cookies the profile holds. Counted without decrypting, so it is
   * cheap; absent when the store could not be read yet (Safari before Full
   * Disk Access is granted).
   */
  cookieCount: Schema.optional(Schema.Int),
  /** Cookie hosts only; no cookie values are read to build the site picker. */
  domains: Schema.optional(Schema.Array(Schema.String)),
  /** True when more exact hosts exist than the bounded inventory can return. */
  domainsTruncated: Schema.optional(Schema.Boolean),
});
export type BrowserImportSourceProfile = typeof BrowserImportSourceProfile.Type;

export const BrowserImportSource = Schema.Struct({
  id: BrowserImportSourceId,
  name: TrimmedNonEmptyString,
  profiles: Schema.Array(BrowserImportSourceProfile),
  /** The OS's HTTPS handler, when it can be identified. Does not choose a profile. */
  isDefault: Schema.optional(Schema.Boolean),
  /** Absent when the source is importable. */
  unavailable: Schema.optional(BrowserImportUnavailableReason),
});
export type BrowserImportSource = typeof BrowserImportSource.Type;

export const BrowserImportInput = Schema.Struct({
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmptyString,
  /** Stark Code profile the cookies are written into. */
  targetProfileId: BrowserProfileId,
  /** Exact cookie hostnames, selected by the person. No wildcard or parent-domain expansion. */
  selectedDomains: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(253))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BROWSER_IMPORT_MAX_DOMAINS),
  ),
  /** Explicit acknowledgement that importing sessions grants account access. */
  consent: Schema.Literal(true),
});
export type BrowserImportInput = typeof BrowserImportInput.Type;

/** IPC payload: the import input plus the environment the partition belongs to. */
export const DesktopPreviewImportCookiesInputSchema = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  ...BrowserImportInput.fields,
});

export const BrowserImportResult = Schema.Struct({
  /** Cookies successfully written into the target partition. */
  imported: Schema.Int,
  /**
   * Cookies read but not written — expired, rejected as malformed, or held
   * under a key we could not use. Surfaced rather than hidden so a
   * mostly-failed import doesn't look like a success.
   */
  skipped: Schema.Int,
  /**
   * The distinct hosts those skipped cookies belonged to, so the user can be
   * told what didn't come over rather than just how many. Capped, since a
   * broken key can skip thousands across many sites.
   */
  skippedDomains: Schema.Array(Schema.String),
});
export type BrowserImportResult = typeof BrowserImportResult.Type;

const BROWSER_IMPORT_UNAVAILABLE_COPY: Readonly<Record<BrowserImportUnavailableReason, string>> = {
  notInstalled: "Not installed on this machine.",
  needsKeychainApproval: "Needs Keychain access to read its cookies.",
  keychainItemMissing:
    "No encryption key in your Keychain — sign in to that browser once, then retry.",
  needsFullDiskAccess:
    "Give Stark Code Full Disk Access in System Settings → Privacy & Security, then retry.",
  browserRunning: "Quit the browser first so its cookie database can be read.",
  unsupportedPlatform: "Importing from this browser isn't possible on this platform.",
};

/** What to tell the user when an attempted import fails. */
export const BROWSER_IMPORT_FAILURE_COPY: Readonly<Record<BrowserImportFailureReason, string>> = {
  ...BROWSER_IMPORT_UNAVAILABLE_COPY,
  keychainUnavailable:
    "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  unknownSource: "That browser is no longer available to import from.",
  unknownSourceProfile: "That browser profile no longer exists.",
  unsafeTarget: "Choose sites and confirm the import into your personal browser profile.",
  storageNotEncrypted:
    "Browser session import requires an encrypted packaged build of Stark Code and an available OS keyring. Imports are disabled in development builds. You can still browse signed out.",
  sessionUnavailable: "The target profile could not be opened.",
  profileNotSaved: "The cookies were imported, but the new profile couldn't be saved. Try again.",
  profileLimitReached:
    "You've reached the profile limit. Delete a profile or import into an existing one.",
  readFailed: "The browser's cookie database could not be read.",
};
