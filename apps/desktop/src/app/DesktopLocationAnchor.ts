// @effect-diagnostics nodeBuiltinImport:off - Read synchronously before the Effect runtime builds the desktop environment; written durably with fsync.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  bakedRehearsalOf,
  readBakedUpdatePolicy,
  type BakedRehearsalPolicy,
} from "../updates/updateFeedPolicy.ts";

/**
 * Where this app's data lives across launches (PLAN-002 §3.4).
 *
 * The updater relaunches the app through ShipIt without the environment it
 * was started with, so a Stark home or desktop data directory chosen with
 * `STARK_CODE_HOME` or `STARK_CODE_DESKTOP_DATA_DIR` would be lost after an
 * update and the app would open the default (often empty) location. The
 * anchor, `~/Library/Application Support/stark-code-locations.json`, records
 * the locations in use; an install handoff marks it, and the relaunch after
 * that handoff takes its locations when the environment names none.
 *
 * A mock rehearsal build with a baked profile always uses
 * `<profile>/home` and `<profile>/app-data` and never reads or writes the
 * anchor, so neither a launch with the wrong environment nor the updater's
 * relaunch can reach the live install.
 */

const DESKTOP_LOCATION_ANCHOR_FILE = "stark-code-locations.json";

export class DesktopLocationAnchorWriteError extends Schema.TaggedError<DesktopLocationAnchorWriteError>()(
  "DesktopLocationAnchorWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write the data location anchor at ${this.path}.`;
  }
}

const DesktopLocationAnchorHandoff = Schema.Struct({
  fromVersion: Schema.String,
  toVersion: Schema.String,
  at: Schema.String,
});

export const DesktopLocationAnchorRecord = Schema.Struct({
  version: Schema.Literal(1),
  /** `STARK_CODE_HOME` in use; null for the default home. */
  starkHome: Schema.NullOr(Schema.String),
  /** `STARK_CODE_DESKTOP_DATA_DIR` in use; null for the platform default. */
  desktopDataDirectory: Schema.NullOr(Schema.String),
  /** The app version that last booted on these locations. */
  lastVersion: Schema.String,
  /** Set when an update was handed to the installer; cleared by the next good boot. */
  handoff: Schema.NullOr(DesktopLocationAnchorHandoff),
});
export type DesktopLocationAnchorRecord = typeof DesktopLocationAnchorRecord.Type;

const decodeAnchor = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopLocationAnchorRecord));
const encodeAnchor = Schema.encodeSync(Schema.fromJsonString(DesktopLocationAnchorRecord));

export type DesktopLocationSource =
  /** A mock rehearsal build's baked profile. */
  | "rehearsal-profile"
  /** `STARK_CODE_HOME` or `STARK_CODE_DESKTOP_DATA_DIR` was set. */
  | "environment"
  /** The relaunch after an install handoff, without the environment. */
  | "anchor-handoff"
  | "default";

export interface DesktopLocations {
  readonly starkHome: Option.Option<string>;
  readonly desktopDataDirectory: Option.Option<string>;
  readonly source: DesktopLocationSource;
}

const nonEmpty = (value: string | undefined): Option.Option<string> => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

/** `<profile>/home` and `<profile>/app-data`, the rehearsal's own data. */
function rehearsalProfileLocations(profile: string): {
  readonly starkHome: string;
  readonly desktopDataDirectory: string;
} {
  return {
    starkHome: NodePath.join(profile, "home"),
    desktopDataDirectory: NodePath.join(profile, "app-data"),
  };
}

/**
 * Picks the data locations for this launch: a baked rehearsal profile first,
 * then the environment, then the anchor when this is the relaunch after an
 * install handoff, then the defaults.
 */
export function resolveDesktopLocations(input: {
  readonly env: { readonly starkHome?: string; readonly desktopDataDirectory?: string };
  readonly anchor: DesktopLocationAnchorRecord | null;
  readonly rehearsalProfile: string | null;
}): DesktopLocations {
  if (input.rehearsalProfile !== null) {
    const profile = rehearsalProfileLocations(input.rehearsalProfile);
    return {
      starkHome: Option.some(profile.starkHome),
      desktopDataDirectory: Option.some(profile.desktopDataDirectory),
      source: "rehearsal-profile",
    };
  }
  const starkHome = nonEmpty(input.env.starkHome);
  const desktopDataDirectory = nonEmpty(input.env.desktopDataDirectory);
  if (Option.isSome(starkHome) || Option.isSome(desktopDataDirectory)) {
    return { starkHome, desktopDataDirectory, source: "environment" };
  }
  if (input.anchor !== null && input.anchor.handoff !== null) {
    return {
      starkHome: nonEmpty(input.anchor.starkHome ?? undefined),
      desktopDataDirectory: nonEmpty(input.anchor.desktopDataDirectory ?? undefined),
      source: "anchor-handoff",
    };
  }
  return { starkHome: Option.none(), desktopDataDirectory: Option.none(), source: "default" };
}

export function desktopLocationAnchorPath(homeDirectory: string): string {
  return NodePath.join(
    homeDirectory,
    "Library",
    "Application Support",
    DESKTOP_LOCATION_ANCHOR_FILE,
  );
}

/** The anchor, or null when it is missing or unreadable (a bad file never blocks a launch). */
export function readDesktopLocationAnchor(path: string): DesktopLocationAnchorRecord | null {
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return Option.getOrNull(decodeAnchor(text));
}

/** Replaces the anchor so a crash leaves the old or the new file. Throws. */
export function writeDesktopLocationAnchor(
  path: string,
  record: DesktopLocationAnchorRecord,
): void {
  const directory = NodePath.dirname(path);
  NodeFS.mkdirSync(directory, { recursive: true });
  const temporary = NodePath.join(
    directory,
    `.${NodePath.basename(path)}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`,
  );
  NodeFS.writeFileSync(temporary, `${encodeAnchor(record)}\n`, { mode: 0o600, flag: "wx" });
  try {
    const fd = NodeFS.openSync(temporary, "r");
    try {
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
    NodeFS.renameSync(temporary, path);
  } catch (cause) {
    NodeFS.rmSync(temporary, { force: true });
    throw cause;
  }
}

/** The rehearsal a packaged app carries in its baked update policy, or null. */
function readBakedRehearsal(appPackageJsonPath: string): BakedRehearsalPolicy | null {
  let text: string;
  try {
    text = NodeFS.readFileSync(appPackageJsonPath, "utf8");
  } catch {
    return null;
  }
  const baked = readBakedUpdatePolicy(text);
  return baked.ok && baked.policy.kind === "mock" ? bakedRehearsalOf(baked.policy) : null;
}

export interface DesktopStartupLocations {
  readonly source: DesktopLocationSource;
  /** Null when this launch neither reads nor writes the anchor (development, rehearsal). */
  readonly anchorPath: string | null;
  readonly rehearsal: BakedRehearsalPolicy | null;
}

/**
 * Resolves this launch's data locations before anything opens them and puts
 * them in `env` (`STARK_CODE_HOME`, `STARK_CODE_DESKTOP_DATA_DIR`) when they
 * come from the rehearsal profile or the anchor, so the desktop config, the
 * backends and the bundled CLI all see the same ones. Development builds
 * keep their environment untouched.
 */
export function applyDesktopStartupLocations(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
}): DesktopStartupLocations {
  if (!input.isPackaged) return { source: "environment", anchorPath: null, rehearsal: null };
  const rehearsal = readBakedRehearsal(NodePath.join(input.appPath, "package.json"));
  const rehearsalProfile = rehearsal?.profile ?? null;
  const anchorPath =
    rehearsalProfile === null ? desktopLocationAnchorPath(input.homeDirectory) : null;
  const locations = resolveDesktopLocations({
    env: {
      ...(input.env.STARK_CODE_HOME === undefined ? {} : { starkHome: input.env.STARK_CODE_HOME }),
      ...(input.env.STARK_CODE_DESKTOP_DATA_DIR === undefined
        ? {}
        : { desktopDataDirectory: input.env.STARK_CODE_DESKTOP_DATA_DIR }),
    },
    anchor: anchorPath === null ? null : readDesktopLocationAnchor(anchorPath),
    rehearsalProfile,
  });
  if (locations.source === "rehearsal-profile" || locations.source === "anchor-handoff") {
    if (Option.isSome(locations.starkHome)) input.env.STARK_CODE_HOME = locations.starkHome.value;
    if (Option.isSome(locations.desktopDataDirectory)) {
      input.env.STARK_CODE_DESKTOP_DATA_DIR = locations.desktopDataDirectory.value;
    }
  }
  return { source: locations.source, anchorPath, rehearsal };
}

/** The anchor for the locations this launch uses, from its environment after startup. */
export function currentDesktopLocationAnchor(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly appVersion: string;
  readonly handoff: DesktopLocationAnchorRecord["handoff"];
}): DesktopLocationAnchorRecord {
  return {
    version: 1,
    starkHome: Option.getOrNull(nonEmpty(input.env.STARK_CODE_HOME)),
    desktopDataDirectory: Option.getOrNull(nonEmpty(input.env.STARK_CODE_DESKTOP_DATA_DIR)),
    lastVersion: input.appVersion,
    handoff: input.handoff,
  };
}
