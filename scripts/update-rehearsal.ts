#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off - Maintainer rehearsal orchestration in plain Node; it shells out to the build, codesign and git.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import Plist from "plist";

import { parseUpdateManifest, serializeUpdateManifest } from "./lib/update-manifest.ts";
import * as Seams from "./lib/update-release-seams.ts";

/**
 * Packaged N → N+1 update rehearsal (PLAN-002 R1/R2). It builds two
 * development-signed versions with the mock feed and a baked rehearsal
 * profile, turns N+1 into a local feed, guards the live install, and records
 * the evidence. Every step prints exactly what it runs; `--dry-run` prints
 * without running. Builds, codesign and lsof need the sandbox off and are run
 * by the orchestrator; clicking through the update is a person or a CDP
 * driver, so `plan` prints those steps instead of performing them.
 *
 * Evidence from this script is "packaged (local mock feed,
 * development-signed)". It never proves Stark hosting, Developer ID
 * signing or a second Mac.
 */

const DEFAULT_N_VERSION = "0.0.46-alpha.1";
const DEFAULT_N1_VERSION = "0.0.46-alpha.2";
const DEFAULT_PORT = 3123;
const DEFAULT_CDP_PORT = 9333;
const EVIDENCE_LABEL = "packaged (local mock feed, development-signed)";
const APP_NAME = "Stark Code (Alpha).app";
const APP_EXECUTABLE = "Stark Code (Alpha)";
const STAGE_PREFIX = "starkcode-desktop-mac-stage-";
export const DEFAULT_MARKER = {
  file: "apps/web/src/components/settings/SettingsPanels.tsx",
  anchor: "<span>Version</span>",
  replacement: "<span>Version (update rehearsal N+1)</span>",
};

/**
 * Publishing variables a build must never see during a rehearsal: they are
 * how electron-builder derives an implicit (possibly upstream) feed.
 */
const SCRUBBED_BUILD_ENV = [
  /^GH_TOKEN$/,
  /^GITHUB_TOKEN$/,
  /^GITLAB_TOKEN$/,
  /^KEYGEN_TOKEN$/,
  /^BITBUCKET_TOKEN$/,
  /^TRAVIS_REPO_SLUG$/,
  /^APPVEYOR_REPO_NAME$/,
  /^CIRCLE_PROJECT_/,
  /^STARK_CODE_DESKTOP_UPDATE_REPOSITORY$/,
  /^STARK_CODE_DESKTOP_UPDATE_URL$/,
  /^STARK_CODE_DESKTOP_MOCK_UPDATES$/,
  /^STARK_CODE_DESKTOP_REHEARSAL_/,
];

export type Variant = "n" | "n1" | "n1-fault-migration";
const VARIANTS: ReadonlyArray<Variant> = ["n", "n1", "n1-fault-migration"];
const isVariant = (value: string): value is Variant =>
  (VARIANTS as ReadonlyArray<string>).includes(value);

export interface RehearsalConfig {
  readonly runId: string;
  readonly repo: string;
  /** Scratch root for the profile, the installed app and the evidence. */
  readonly root: string;
  readonly homeDir: string;
  readonly identity: string | null;
  readonly nVersion: string;
  readonly n1Version: string;
  readonly port: number;
  readonly cdpPort: number;
  readonly arch: "arm64" | "x64";
  /**
   * `rehearsal` (R1): a fresh profile baked under the root. `existing` (R2):
   * the real profile of an isolated macOS account, no baked profile.
   */
  readonly profile: "rehearsal" | "existing";
  /** R2 only: home directory of the isolated macOS account whose data is upgraded. */
  readonly accountHome: string | null;
  /** R2 only: the command runs inside that isolated account. */
  readonly isolatedAccount: boolean;
}

export interface RehearsalPaths {
  readonly profileDir: string;
  readonly starkHome: string;
  readonly desktopDataDir: string;
  readonly applications: string;
  readonly installedApp: string;
  readonly evidence: string;
  readonly releaseRoot: string;
  readonly feeds: string;
  readonly requestLog: string;
  readonly liveHome: string;
  readonly liveProfile: string;
  readonly scratchBranch: string;
  readonly buildDir: (variant: Variant) => string;
}

export function rehearsalPaths(config: RehearsalConfig): RehearsalPaths {
  const profileDir = NodePath.join(config.root, "profile");
  const releaseRoot = NodePath.join(config.repo, "release-mock", `rehearsal-${config.runId}`);
  return {
    profileDir,
    starkHome:
      config.profile === "rehearsal"
        ? NodePath.join(profileDir, "home")
        : NodePath.join(config.accountHome ?? config.homeDir, ".stark-code"),
    desktopDataDir:
      config.profile === "rehearsal"
        ? NodePath.join(profileDir, "app-data")
        : NodePath.join(config.accountHome ?? config.homeDir, "Library", "Application Support"),
    applications: NodePath.join(config.root, "Applications"),
    installedApp:
      config.profile === "rehearsal"
        ? NodePath.join(config.root, "Applications", APP_NAME)
        : NodePath.join("/Applications", APP_NAME),
    evidence: NodePath.join(config.root, "evidence"),
    releaseRoot,
    feeds: NodePath.join(releaseRoot, "feeds"),
    requestLog: NodePath.join(config.root, "evidence", "mock-requests.jsonl"),
    liveHome: NodePath.join(config.homeDir, ".stark-code"),
    liveProfile: NodePath.join(config.homeDir, "Library", "Application Support", "stark-code-v2"),
    scratchBranch: `rehearsal/n1-${config.runId}`,
    buildDir: (variant) => NodePath.join(releaseRoot, variant),
  };
}

const isInside = (child: string, parent: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * The rehearsal must never run against the live install: the root may not be
 * the live home, sit inside it, contain it, or live in the repository.
 */
function assertSafeRehearsalRoot(config: RehearsalConfig): void {
  const root = NodePath.resolve(config.root);
  const liveHome = NodePath.join(config.homeDir, ".stark-code");
  const liveProfile = NodePath.join(config.homeDir, "Library", "Application Support");
  if (isInside(root, liveHome) || isInside(liveHome, root)) {
    throw new Error(
      `Refusing rehearsal root ${root}: it overlaps the live Stark home ${liveHome}.`,
    );
  }
  if (isInside(root, liveProfile) || isInside(liveProfile, root)) {
    throw new Error(`Refusing rehearsal root ${root}: it overlaps ${liveProfile}.`);
  }
  if (isInside(root, NodePath.resolve(config.repo))) {
    throw new Error(`Refusing rehearsal root ${root}: profiles stay outside the repository.`);
  }
  if (root === config.homeDir || root === "/") {
    throw new Error(`Refusing rehearsal root ${root}.`);
  }
}

function assertIdentity(identity: string | null): string {
  if (identity === null || !/^[0-9a-f]{40}$/i.test(identity)) {
    throw new Error(
      "Pass --identity <40-character SHA-1> of the Apple Development certificate, from `security find-identity -v -p codesigning` run outside the sandbox.",
    );
  }
  return identity.toUpperCase();
}

export function scrubBuildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SCRUBBED_BUILD_ENV.some((pattern) => pattern.test(key))) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

// ---------------------------------------------------------------------------
// Commands

export interface PlannedCommand {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly argv: ReadonlyArray<string>;
}

const shellQuote = (value: string) =>
  /^[A-Za-z0-9_./:=@+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

function renderCommand(command: PlannedCommand): string {
  const env = Object.entries(command.env).map(([key, value]) => `${key}=${shellQuote(value)}`);
  return `(cd ${shellQuote(command.cwd)} && ${[...env, ...command.argv.map(shellQuote)].join(" ")})`;
}

export function buildCommand(config: RehearsalConfig, variant: Variant): PlannedCommand {
  const identity = assertIdentity(config.identity);
  const paths = rehearsalPaths(config);
  return {
    cwd: config.repo,
    env: {
      ...Seams.rehearsalBuildEnv({
        profileDir: config.profile === "rehearsal" ? paths.profileDir : null,
        fault: variant === "n1-fault-migration" ? Seams.REHEARSAL_MIGRATION_FAULT : null,
      }),
      STARK_CODE_MACOS_SIGNING_MODE: "development",
      CSC_NAME: identity,
    },
    argv: [
      "node",
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--arch",
      config.arch,
      "--signed",
      "--build-version",
      variant === "n" ? config.nVersion : config.n1Version,
      "--mock-update-server-port",
      String(config.port),
      "--output-dir",
      NodePath.relative(config.repo, paths.buildDir(variant)),
    ],
  };
}

function serveCommand(config: RehearsalConfig, feed: string): PlannedCommand {
  const paths = rehearsalPaths(config);
  return {
    cwd: config.repo,
    env: {
      STARK_CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: String(config.port),
      STARK_CODE_DESKTOP_MOCK_UPDATE_SERVER_ROOT: NodePath.join(paths.feeds, feed),
      STARK_CODE_DESKTOP_MOCK_UPDATE_REQUEST_LOG: paths.requestLog,
      STARK_CODE_DESKTOP_MOCK_UPDATE_CANARY_PORT: String(config.port + 1),
      STARK_CODE_DESKTOP_MOCK_UPDATE_FAULTS_FILE: NodePath.join(paths.evidence, "faults.json"),
    },
    argv: ["node", "scripts/mock-update-server.ts"],
  };
}

export function launchCommand(config: RehearsalConfig): PlannedCommand {
  const paths = rehearsalPaths(config);
  return {
    cwd: config.root,
    // R2 launches the installed app on the account's own data, as a user would.
    env:
      config.profile === "rehearsal"
        ? { STARK_CODE_HOME: paths.starkHome, STARK_CODE_DESKTOP_DATA_DIR: paths.desktopDataDir }
        : {},
    argv: [
      NodePath.join(paths.installedApp, "Contents", "MacOS", APP_EXECUTABLE),
      `--remote-debugging-port=${config.cdpPort}`,
    ],
  };
}

/** Shared folder R2 uses to hand the DMG and the standalone inventory script to the isolated account. */
const R2_SHARED_DIR = "/Users/Shared/stark-update-rehearsal";

/**
 * Where inventory commands run. R1 runs them from the repository; R2 runs
 * them inside the isolated account from a copy of the standalone script and
 * keeps that account's evidence in its own home.
 */
function inventoryTool(config: RehearsalConfig) {
  const paths = rehearsalPaths(config);
  return config.profile === "rehearsal"
    ? { cwd: config.repo, script: "scripts/release-inventory.ts", evidence: paths.evidence }
    : {
        cwd: config.accountHome ?? config.homeDir,
        script: NodePath.join(R2_SHARED_DIR, "release-inventory.ts"),
        evidence: NodePath.join(config.accountHome ?? config.homeDir, "stark-r2-evidence"),
      };
}

function inventoryCommand(
  config: RehearsalConfig,
  label: "before" | "after" | "after-restart",
): PlannedCommand {
  const paths = rehearsalPaths(config);
  const tool = inventoryTool(config);
  return {
    cwd: tool.cwd,
    env: {},
    argv: [
      "node",
      tool.script,
      "capture",
      "--home",
      paths.starkHome,
      "--desktop-data",
      paths.desktopDataDir,
      "--renderer-storage",
      NodePath.join(tool.evidence, `renderer-${label}.json`),
      ...(label === "before"
        ? []
        : ["--baseline", NodePath.join(tool.evidence, "inventory-before.json")]),
      "--label",
      label,
      "--distinctive",
      `UPD-${config.runId}-[A-Za-z0-9_-]+`,
      "--out",
      NodePath.join(tool.evidence, `inventory-${label}.json`),
    ],
  };
}

function compareCommand(config: RehearsalConfig, after: "after" | "after-restart"): PlannedCommand {
  const tool = inventoryTool(config);
  return {
    cwd: tool.cwd,
    env: {},
    argv: [
      "node",
      tool.script,
      "compare",
      NodePath.join(tool.evidence, "inventory-before.json"),
      NodePath.join(tool.evidence, `inventory-${after}.json`),
      "--out",
      NodePath.join(tool.evidence, `compare-${after}.json`),
    ],
  };
}

const self = (
  config: RehearsalConfig,
  step: string,
  extra: ReadonlyArray<string> = [],
): PlannedCommand => ({
  cwd: config.repo,
  env: {},
  argv: [
    "node",
    "scripts/update-rehearsal.ts",
    step,
    ...extra,
    "--run-id",
    config.runId,
    "--root",
    config.root,
    ...(config.identity === null ? [] : ["--identity", config.identity]),
    "--n-version",
    config.nVersion,
    "--n1-version",
    config.n1Version,
    "--port",
    String(config.port),
    ...(config.profile === "existing"
      ? ["--profile", "existing", "--account-home", config.accountHome ?? ""]
      : []),
    ...(config.isolatedAccount ? ["--isolated-account"] : []),
  ],
});

function rendererCommand(
  config: RehearsalConfig,
  label: "before" | "after" | "after-restart",
): PlannedCommand {
  const tool = inventoryTool(config);
  return {
    cwd: tool.cwd,
    env: {},
    argv: [
      "node",
      tool.script,
      "renderer",
      "--cdp",
      `http://127.0.0.1:${config.cdpPort}`,
      "--out",
      NodePath.join(tool.evidence, `renderer-${label}.json`),
    ],
  };
}

function installedVersionCommand(config: RehearsalConfig): PlannedCommand {
  return {
    cwd: config.root,
    env: {},
    argv: [
      "plutil",
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      NodePath.join(rehearsalPaths(config).installedApp, "Contents", "Info.plist"),
    ],
  };
}

export interface PlanEntry {
  readonly id: string;
  readonly who: "orchestrator" | "person or CDP driver" | "owner, in the isolated account";
  readonly what: string;
  readonly command: PlannedCommand | null;
}

const QUIT =
  "Quit the app by the PID captured when it was launched (never by name), and wait until it exits.";

/**
 * R2: the owner upgrades an existing profile in an isolated macOS account
 * (S7), with production identity constants and no baked rehearsal profile.
 * Builds and the feed run in the developer's account; localhost is shared by
 * every account on the Mac, so the isolated account reaches the same feed.
 */
function existingProfilePlan(config: RehearsalConfig): ReadonlyArray<PlanEntry> {
  const paths = rehearsalPaths(config);
  const tool = inventoryTool(config);
  const sandboxOff = "orchestrator" as const;
  const owner = "owner, in the isolated account" as const;
  const dmg = NodePath.join(
    paths.buildDir("n"),
    `Stark-Code-${config.nVersion}-${config.arch}.dmg`,
  );
  const ownerLaunch: PlannedCommand = {
    cwd: tool.cwd,
    env: {},
    argv: [
      NodePath.join("/Applications", APP_NAME, "Contents", "MacOS", APP_EXECUTABLE),
      `--remote-debugging-port=${config.cdpPort}`,
    ],
  };
  return [
    {
      id: "build-n",
      who: sandboxOff,
      what: `Build N = ${config.nVersion} without a baked profile.`,
      command: self(config, "build", ["n"]),
    },
    {
      id: "prepare-n1",
      who: "orchestrator",
      what: "Create the N+1 scratch commit.",
      command: self(config, "prepare-n1"),
    },
    {
      id: "build-n1",
      who: sandboxOff,
      what: `Build N+1 = ${config.n1Version}.`,
      command: self(config, "build", ["n1"]),
    },
    {
      id: "cleanup-n1",
      who: "orchestrator",
      what: "Delete the scratch branch.",
      command: self(config, "cleanup-n1"),
    },
    {
      id: "verify-builds",
      who: sandboxOff,
      what: "Verify both builds, including N+1 against N's designated requirement.",
      command: self(config, "verify", ["n", "n1"]),
    },
    { id: "feed", who: "orchestrator", what: "Generate the feeds.", command: self(config, "feed") },
    {
      id: "share",
      who: "orchestrator",
      what: `Hand N's DMG and the standalone inventory script to the isolated account through ${R2_SHARED_DIR}.`,
      command: {
        cwd: config.repo,
        env: {},
        argv: [
          "sh",
          "-c",
          `mkdir -p ${shellQuote(R2_SHARED_DIR)} && cp ${shellQuote(dmg)} scripts/release-inventory.ts ${shellQuote(R2_SHARED_DIR)}/`,
        ],
      },
    },
    {
      id: "serve-feed",
      who: sandboxOff,
      what: "Start the mock feed in the developer account and keep its PID.",
      command: serveCommand(config, "feed"),
    },
    {
      id: "r2a-baseline",
      who: owner,
      what: `Install the current alpha (0.0.45) from its DMG. Create a saved environment, import a preview session, set provider homes, and create chats tagged UPD-${config.runId}-T1…T4 with a draft, a pasted image and a pending approval.`,
      command: null,
    },
    {
      id: "r2a-install-n",
      who: owner,
      what: `Install N from ${NodePath.join(R2_SHARED_DIR, NodePath.basename(dmg))} over 0.0.45 (a manual DMG upgrade). Open it, check the data, quit.`,
      command: null,
    },
    {
      id: "r2a-launch-n",
      who: owner,
      what: "Launch N from Terminal with a DevTools port and keep its PID.",
      command: ownerLaunch,
    },
    {
      id: "r2a-renderer-before",
      who: owner,
      what: "Save drafts and the stash.",
      command: rendererCommand(config, "before"),
    },
    { id: "r2a-quit-n", who: owner, what: QUIT, command: null },
    {
      id: "r2a-inventory-before",
      who: owner,
      what: "Capture the before inventory of this account's data.",
      command: inventoryCommand(config, "before"),
    },
    {
      id: "r2a-upgrade",
      who: owner,
      what: `Open N from the Dock or Finder, check for updates, download ${config.n1Version}, choose Restart to update.`,
      command: null,
    },
    {
      id: "r2a-observe",
      who: owner,
      what: "About shows N+1 and the marker. No Keychain password prompt (a prompt means identity broke). The saved environment connects without signing in; the preview session is still signed in; provider homes are unchanged; chats, draft and attachment are there. Decline the approval.",
      command: null,
    },
    {
      id: "r2a-relaunch",
      who: owner,
      what: "Quit by PID, relaunch from Terminal with DevTools.",
      command: ownerLaunch,
    },
    {
      id: "r2a-renderer-after",
      who: owner,
      what: "Save drafts and the stash.",
      command: rendererCommand(config, "after"),
    },
    { id: "r2a-quit-n1", who: owner, what: QUIT, command: null },
    {
      id: "r2a-inventory-after",
      who: owner,
      what: "Capture the after inventory.",
      command: inventoryCommand(config, "after"),
    },
    {
      id: "r2a-compare",
      who: owner,
      what: "The verdict must be pass.",
      command: compareCommand(config, "after"),
    },
    {
      id: "r2b",
      who: owner,
      what: "Repeat with N launched from Terminal with a custom STARK_CODE_HOME and STARK_CODE_DESKTOP_DATA_DIR (fresh copies of the data). After the updater relaunches N+1 without that environment, the app must still use the custom paths; capture both inventories with --home <custom home> --desktop-data <custom data dir>.",
      command: null,
    },
    {
      id: "cleanup",
      who: owner,
      what: "Decide what to do with leftover Keychain items and the isolated account.",
      command: null,
    },
    {
      id: "record",
      who: "orchestrator",
      what: `Copy ${tool.evidence} back and write the run record.`,
      command: self(config, "record"),
    },
  ];
}

/** The full R1 sequence (or R2 with --profile existing), in order, with the exact commands. */
export function rehearsalPlan(config: RehearsalConfig): ReadonlyArray<PlanEntry> {
  if (config.profile === "existing") return existingProfilePlan(config);
  const paths = rehearsalPaths(config);
  const sandboxOff = "orchestrator" as const;
  const driver = "person or CDP driver" as const;
  return [
    {
      id: "guard-before",
      who: sandboxOff,
      what: "Stat the live install and record which processes hold it.",
      command: self(config, "guard", ["before"]),
    },
    {
      id: "build-n",
      who: sandboxOff,
      what: `Build N = ${config.nVersion} from the current commit (development-signed, mock feed, baked profile).`,
      command: self(config, "build", ["n"]),
    },
    {
      id: "prepare-n1",
      who: "orchestrator",
      what: `Create the never-pushed scratch commit on ${paths.scratchBranch} with the visible N+1 marker.`,
      command: self(config, "prepare-n1"),
    },
    {
      id: "build-n1",
      who: sandboxOff,
      what: `Build N+1 = ${config.n1Version} from the scratch commit.`,
      command: self(config, "build", ["n1"]),
    },
    {
      id: "build-n1-fault",
      who: sandboxOff,
      what: `Build the mock-only N+1 variant with the ${Seams.REHEARSAL_MIGRATION_FAULT} fault (U2).`,
      command: self(config, "build", ["n1-fault-migration"]),
    },
    {
      id: "cleanup-n1",
      who: "orchestrator",
      what: "Return to the original commit and delete the scratch branch.",
      command: self(config, "cleanup-n1"),
    },
    {
      id: "verify-builds",
      who: sandboxOff,
      what: "Check proofs, packaged app-update.yml, baked policy, signatures, and that N+1 satisfies N's designated requirement.",
      command: self(config, "verify", ["n", "n1", "n1-fault-migration"]),
    },
    {
      id: "feed",
      who: "orchestrator",
      what: "Generate the feeds: feed, feed-corrupt, feed-older and feed-fault-migration.",
      command: self(config, "feed"),
    },
    {
      id: "install-n",
      who: sandboxOff,
      what: `Extract N into ${paths.applications}.`,
      command: self(config, "install-n"),
    },
    {
      id: "serve-feed",
      who: sandboxOff,
      what: "Start the mock feed in the background and keep its PID. Rows switch faults by editing faults.json.",
      command: serveCommand(config, "feed"),
    },
    {
      id: "launch-n",
      who: sandboxOff,
      what: "Launch N on the rehearsal profile with a DevTools port; keep its PID.",
      command: launchCommand(config),
    },
    {
      id: "fixture",
      who: driver,
      what: `Create the PLAN-001 §4.4 fixture with tokens UPD-${config.runId}-T1…T4 (chats, pasted image, drafts, stash, settings, projects, providers, modes, scheduled tasks). Decline, never approve, the pending approval.`,
      command: null,
    },
    {
      id: "renderer-before",
      who: "orchestrator",
      what: "Save the renderer's drafts and stash while N runs.",
      command: rendererCommand(config, "before"),
    },
    { id: "quit-n", who: driver, what: QUIT, command: null },
    {
      id: "inventory-before",
      who: "orchestrator",
      what: "Capture the before inventory.",
      command: inventoryCommand(config, "before"),
    },
    { id: "relaunch-n", who: sandboxOff, what: "Launch N again.", command: launchCommand(config) },
    {
      id: "upgrade",
      who: driver,
      what: `Check for updates, download ${config.n1Version}, choose Restart to update. The updater relaunches the app itself, without this environment, on the baked profile. Hot reload or swapping the bundle does not count.`,
      command: null,
    },
    {
      id: "installed-version",
      who: "orchestrator",
      what: `The installed bundle must now report ${config.n1Version}.`,
      command: installedVersionCommand(config),
    },
    {
      id: "observe",
      who: driver,
      what: "About shows N+1 and the marker; no Keychain prompt. Then quit the relaunched app by its PID (from ps, matched to the installed app path and confirmed) and relaunch it with the launch command so DevTools is available.",
      command: launchCommand(config),
    },
    {
      id: "open-data",
      who: driver,
      what: "Open the chats and the attachment, restore the draft, check settings, providers and permission modes, continue a conversation if authentication permits.",
      command: null,
    },
    {
      id: "renderer-after",
      who: "orchestrator",
      what: "Save the renderer's drafts and stash.",
      command: rendererCommand(config, "after"),
    },
    { id: "quit-n1", who: driver, what: QUIT, command: null },
    {
      id: "inventory-after",
      who: "orchestrator",
      what: "Capture the after inventory against the baseline.",
      command: inventoryCommand(config, "after"),
    },
    {
      id: "compare",
      who: "orchestrator",
      what: "Compare before and after (add --allow-new-runs only for a conversation continued on purpose). The verdict must be pass.",
      command: compareCommand(config, "after"),
    },
    {
      id: "restart",
      who: sandboxOff,
      what: "Launch N+1 once more; confirm no task or approval replays.",
      command: launchCommand(config),
    },
    {
      id: "renderer-after-restart",
      who: "orchestrator",
      what: "Save the renderer's drafts and stash.",
      command: rendererCommand(config, "after-restart"),
    },
    { id: "quit-again", who: driver, what: QUIT, command: null },
    {
      id: "inventory-after-restart",
      who: "orchestrator",
      what: "Capture after the second restart.",
      command: inventoryCommand(config, "after-restart"),
    },
    {
      id: "compare-restart",
      who: "orchestrator",
      what: "Compare before and after the second restart.",
      command: compareCommand(config, "after-restart"),
    },
    {
      id: "guard-after",
      who: sandboxOff,
      what: "Stat the live install again and compare with guard-before.",
      command: self(config, "guard", ["after"]),
    },
    {
      id: "record",
      who: "orchestrator",
      what: "Write the run record that binds commits, hashes, signatures, inventories and logs.",
      command: self(config, "record"),
    },
  ];
}

export interface FailureRow {
  readonly row: string;
  readonly feed: string;
  readonly faults: ReadonlyArray<{ readonly path: string; readonly mode: string }>;
  readonly expect: string;
}

/**
 * PLAN-002 R1 failure rows the mock feed can drive. Each starts from a fresh
 * copy of the N profile; the feed root and faults.json select the fault.
 */
export const FAILURE_ROWS: ReadonlyArray<FailureRow> = [
  {
    row: "4 interrupted download",
    feed: "feed",
    faults: [{ path: "*.zip", mode: "truncate-once" }],
    expect: "the download fails once, a retry completes it once",
  },
  {
    row: "5a feed unavailable",
    feed: "feed",
    faults: [{ path: "latest-mac.yml", mode: "http-503" }],
    expect: "couldn't reach the update server; the known state is kept",
  },
  {
    row: "5b feed missing",
    feed: "feed",
    faults: [{ path: "latest-mac.yml", mode: "not-found" }],
    expect: "unavailable-feed error kind; known state kept",
  },
  {
    row: "5c malformed feed",
    feed: "feed",
    faults: [{ path: "latest-mac.yml", mode: "malformed-yaml" }],
    expect: "invalid feed; known state kept",
  },
  {
    row: "5d server down",
    feed: "feed",
    faults: [],
    expect: "stop the mock server: reachability error, never 'offline' unless the Mac is offline",
  },
  {
    row: "6a hostile absolute URL",
    feed: "feed",
    faults: [{ path: "latest-mac.yml", mode: "hostile-absolute-url" }],
    expect: "feed-invalid before any download; 0 canary hits",
  },
  {
    row: "6b hostile protocol-relative URL",
    feed: "feed",
    faults: [{ path: "latest-mac.yml", mode: "hostile-protocol-relative-url" }],
    expect: "feed-invalid; 0 canary hits",
  },
  {
    row: "6c hostile traversal",
    feed: "feed",
    faults: [{ path: "latest-mac.yml", mode: "hostile-traversal-url" }],
    expect:
      "feed-invalid; 0 outside-base-path requests (meaningful only when the baked feed URL has a path)",
  },
  {
    row: "6d hostile legacy path",
    feed: "feed",
    faults: [{ path: "latest-mac.yml", mode: "hostile-legacy-path" }],
    expect: "feed-invalid; 0 canary hits",
  },
  {
    row: "7a redirect to a foreign host",
    feed: "feed",
    faults: [{ path: "*.zip", mode: "redirect-to-foreign-host" }],
    expect: "blocked in the boundary log; 0 canary hits",
  },
  {
    row: "7b redirect to another loopback port",
    feed: "feed",
    faults: [{ path: "*.zip", mode: "redirect-to-loopback" }],
    expect:
      "blocked; 0 canary hits (an HTTP-downgrade redirect needs an HTTPS feed and is covered by U1's boundary tests)",
  },
  {
    row: "7c manifest redirect",
    feed: "feed",
    faults: [{ path: "latest-mac.yml", mode: "redirect-to-foreign-host" }],
    expect: "blocked; 0 canary hits",
  },
  {
    row: "8a corrupt artifact",
    feed: "feed-corrupt",
    faults: [],
    expect: "invalid-artifact; cache deleted; nothing stopped",
  },
  {
    row: "8b wrong digest",
    feed: "feed",
    faults: [{ path: "latest-mac.yml", mode: "wrong-sha512" }],
    expect: "invalid-artifact; nothing stopped",
  },
  { row: "9 older feed", feed: "feed-older", faults: [], expect: "no update offered" },
  {
    row: "11 migration failure",
    feed: "feed-fault-migration",
    faults: [],
    expect:
      "N+1 exits with the terminal code and the right copy; reinstall N from its DMG; restore displaces current data; the recovery hold survives two boots; Resume dispatches each item once",
  },
  {
    row: "progress and cancel",
    feed: "feed",
    faults: [{ path: "*.zip", mode: "slow" }],
    expect: "byte progress moves; cancel or Later leaves N running",
  },
];

export function formatPlan(config: RehearsalConfig): string {
  const paths = rehearsalPaths(config);
  const lines = [
    `Update rehearsal ${config.runId}: N ${config.nVersion} → N+1 ${config.n1Version}`,
    `Evidence label: ${EVIDENCE_LABEL}`,
    `Root: ${config.root}`,
    "Run orchestrator steps outside the sandbox: they write under the root, call codesign, lsof and git, and build.",
    "",
  ];
  rehearsalPlan(config).forEach((entry, index) => {
    lines.push(`${String(index + 1).padStart(2)}. [${entry.id}] ${entry.who}: ${entry.what}`);
    if (entry.command !== null) lines.push(`    ${renderCommand(entry.command)}`);
  });
  if (config.profile === "existing") return lines.join("\n");
  lines.push(
    "",
    `Failure rows (each from a fresh copy of the N profile; write faults to ${NodePath.join(paths.evidence, "faults.json")}, restart the feed for a different root):`,
  );
  for (const row of FAILURE_ROWS) {
    lines.push(
      `  ${row.row}: root feeds/${row.feed}; faults ${JSON.stringify({ faults: row.faults })}; expect ${row.expect}`,
    );
  }
  lines.push(
    "  10 wrong identity, 12 backup-enospc, 13 commit-stall: need builds this script does not make yet (see docs/operations/update-rehearsal.md).",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Live-install guard

export interface GuardEntry {
  readonly path: string;
  readonly exists: boolean;
  readonly size: number | null;
  readonly mtimeMs: number | null;
  readonly ino: number | null;
}

export interface GuardHolder {
  readonly pid: number;
  readonly command: string;
  readonly path: string;
  readonly rehearsal: boolean;
}

export interface GuardSnapshot {
  readonly phase: "before" | "after";
  readonly takenAt: string;
  readonly entries: ReadonlyArray<GuardEntry>;
  readonly holders: ReadonlyArray<GuardHolder>;
  readonly holdersChecked: boolean;
  /** What `lsof -F pcn` printed at check time; null when no live file existed. */
  readonly lsof: string | null;
}

function liveGuardPaths(paths: RehearsalPaths): ReadonlyArray<string> {
  const userdata = NodePath.join(paths.liveHome, "userdata");
  return [
    ...[
      "statev2.sqlite",
      "statev2.sqlite-wal",
      "statev2.sqlite-shm",
      "settings.json",
      "desktop-settings.json",
      "client-settings.json",
      "server-runtime.json",
    ].map((name) => NodePath.join(userdata, name)),
    paths.liveProfile,
    NodePath.join(paths.liveProfile, "Local Storage", "leveldb"),
  ];
}

/** Parses `lsof -F pcn` output into (pid, command, file) triples. */
export function parseLsofHolders(
  output: string,
): ReadonlyArray<{ pid: number; command: string; path: string }> {
  const holders: Array<{ pid: number; command: string; path: string }> = [];
  let pid = 0;
  let command = "";
  for (const line of output.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") pid = Number(value);
    else if (field === "c") command = value;
    else if (field === "n" && pid > 0) holders.push({ pid, command, path: value });
  }
  return holders;
}

export interface GuardVerdict {
  readonly status: "unchanged" | "changed-not-by-rehearsal" | "violated" | "unverified";
  readonly changed: ReadonlyArray<string>;
  readonly rehearsalHolders: ReadonlyArray<GuardHolder>;
  /**
   * Every process that held a live file at each check, so a change can be
   * traced to a foreign opener (`rehearsal: false`) or a rehearsal leak.
   */
  readonly holders: {
    readonly before: ReadonlyArray<GuardHolder>;
    readonly after: ReadonlyArray<GuardHolder>;
  };
  readonly lsof: { readonly before: string | null; readonly after: string | null };
}

/**
 * The live install passes when no rehearsal process ever held one of its
 * files. Changes made while the developer's own app ran are reported, not
 * failed, because that app writes its database constantly.
 */
export function compareGuard(before: GuardSnapshot, after: GuardSnapshot): GuardVerdict {
  const rehearsalHolders = [...before.holders, ...after.holders].filter(
    (holder) => holder.rehearsal,
  );
  const changed = before.entries
    .filter((entry) => {
      const next = after.entries.find((candidate) => candidate.path === entry.path);
      return JSON.stringify(entry) !== JSON.stringify({ ...next, path: entry.path });
    })
    .map((entry) => entry.path);
  const evidence = {
    changed,
    rehearsalHolders,
    holders: { before: before.holders, after: after.holders },
    lsof: { before: before.lsof ?? null, after: after.lsof ?? null },
  };
  if (rehearsalHolders.length > 0) return { status: "violated", ...evidence };
  if (!before.holdersChecked || !after.holdersChecked) {
    return { status: "unverified", ...evidence };
  }
  return {
    status: changed.length === 0 ? "unchanged" : "changed-not-by-rehearsal",
    ...evidence,
  };
}

/** One line per live file a process held when the guard checked. */
export function describeGuardHolders(snapshot: GuardSnapshot): string {
  const label = `guard-${snapshot.phase}`;
  if (!snapshot.holdersChecked) return `${label}: holders could not be checked (lsof failed)`;
  if (snapshot.holders.length === 0) return `${label}: no process held a live file`;
  return snapshot.holders
    .map(
      (holder) =>
        `${label}: pid ${holder.pid} (${holder.rehearsal ? "REHEARSAL" : "not the rehearsal"}) held ${holder.path}: ${holder.command}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Feed generation

/** Marks a manifest as a mock feed so only the mock server will serve it. */
export function stampMockManifest(raw: string, overrideVersion?: string): string {
  const manifest = parseUpdateManifest(raw, "latest-mac.yml", "macOS");
  return serializeUpdateManifest(
    {
      ...manifest,
      ...(overrideVersion === undefined ? {} : { version: overrideVersion }),
      extras: { ...manifest.extras, [Seams.MANIFEST_FEED_KIND_KEY]: "mock" },
    },
    { platformLabel: "macOS" },
  );
}

const sha512Base64 = async (filePath: string) => {
  const hash = NodeCrypto.createHash("sha512");
  for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("base64");
};
const sha256Hex = async (filePath: string) => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

export interface FeedSpec {
  readonly name: string;
  readonly from: Variant;
  readonly corrupt: boolean;
  readonly version?: string;
}

export const FEEDS: ReadonlyArray<FeedSpec> = [
  { name: "feed", from: "n1", corrupt: false },
  { name: "feed-corrupt", from: "n1", corrupt: true },
  { name: "feed-older", from: "n1", corrupt: false, version: "0.0.45" },
  { name: "feed-fault-migration", from: "n1-fault-migration", corrupt: false },
];

/**
 * Builds one feed directory from a build's latest-mac.yml, ZIP and blockmap.
 * The ZIP must match the manifest digest before it is copied; the corrupt
 * feed then flips bytes in its copy (an APFS clone) so the digest no longer
 * matches.
 */
export async function generateFeed(paths: RehearsalPaths, spec: FeedSpec): Promise<string> {
  const source = paths.buildDir(spec.from);
  const manifestRaw = await NodeFSP.readFile(NodePath.join(source, "latest-mac.yml"), "utf8");
  const manifest = parseUpdateManifest(
    manifestRaw,
    NodePath.join(source, "latest-mac.yml"),
    "macOS",
  );
  const target = NodePath.join(paths.feeds, spec.name);
  await NodeFSP.rm(target, { recursive: true, force: true });
  await NodeFSP.mkdir(target, { recursive: true });
  for (const file of manifest.files) {
    Seams.assertSafeManifestFileUrl(file.url);
    const from = NodePath.join(source, file.url);
    if ((await sha512Base64(from)) !== file.sha512) {
      throw new Error(`${from} does not match its manifest digest; rebuild ${spec.from}.`);
    }
    await NodeFSP.copyFile(
      from,
      NodePath.join(target, file.url),
      NodeFS.constants.COPYFILE_FICLONE,
    );
    await NodeFSP.copyFile(
      `${from}.blockmap`,
      NodePath.join(target, `${file.url}.blockmap`),
      NodeFS.constants.COPYFILE_FICLONE,
    ).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    });
    if (spec.corrupt) {
      const handle = await NodeFSP.open(NodePath.join(target, file.url), "r+");
      try {
        const { size } = await handle.stat();
        const offset = Math.floor(size / 2);
        const byte = Buffer.alloc(1);
        await handle.read(byte, 0, 1, offset);
        byte[0] = (byte[0] ?? 0) ^ 0xff;
        await handle.write(byte, 0, 1, offset);
      } finally {
        await handle.close();
      }
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(target, "latest-mac.yml"),
    stampMockManifest(manifestRaw, spec.version),
  );
  return target;
}

// ---------------------------------------------------------------------------
// Runner

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Runner = (
  command: PlannedCommand,
  options?: { readonly stream?: boolean },
) => Promise<RunResult>;

const nodeRunner: Runner = (command, options = {}) =>
  new Promise((resolve) => {
    const [file, ...args] = command.argv;
    const child = NodeChildProcess.spawn(file ?? "", args, {
      cwd: command.cwd,
      env: { ...scrubBuildEnv(process.env), ...command.env },
      stdio: options.stream ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ exitCode: 127, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

const run = async (runner: Runner, argv: ReadonlyArray<string>, cwd: string) => {
  const result = await runner({ cwd, env: {}, argv });
  return result;
};

async function writeJson(filePath: string, value: unknown) {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function takeGuardSnapshot(
  config: RehearsalConfig,
  phase: "before" | "after",
  runner: Runner,
  now: () => Date = () => new Date(),
): Promise<GuardSnapshot> {
  const paths = rehearsalPaths(config);
  const targets = liveGuardPaths(paths);
  const entries: GuardEntry[] = [];
  for (const target of targets) {
    try {
      const stat = await NodeFSP.stat(target);
      entries.push({
        path: target,
        exists: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
      });
    } catch {
      entries.push({ path: target, exists: false, size: null, mtimeMs: null, ino: null });
    }
  }
  const existing = entries.filter((entry) => entry.exists).map((entry) => entry.path);
  let holders: GuardHolder[] = [];
  let holdersChecked = false;
  let lsofOutput: string | null = null;
  if (existing.length > 0) {
    const lsof = await run(runner, ["lsof", "-F", "pcn", "--", ...existing], config.root);
    lsofOutput = lsof.stdout + lsof.stderr;
    // lsof exits 1 when nobody holds the files; anything else is a failed check.
    // A sandboxed or unprivileged lsof also exits 1 with no output, so that
    // only counts as "nobody holds them" when lsof did not complain.
    holdersChecked =
      lsof.exitCode === 0 ||
      (lsof.exitCode === 1 &&
        lsof.stdout.trim() === "" &&
        !/not permitted|denied|can't|cannot/i.test(lsof.stderr));
    for (const holder of parseLsofHolders(lsof.stdout)) {
      const ps = await run(runner, ["ps", "-o", "command=", "-p", String(holder.pid)], config.root);
      const commandLine = ps.stdout.trim();
      holders.push({
        ...holder,
        command: commandLine || holder.command,
        rehearsal: commandLine.includes(config.root) || commandLine.includes(paths.releaseRoot),
      });
    }
  } else {
    holdersChecked = true;
  }
  return {
    phase,
    takenAt: now().toISOString(),
    entries,
    holders,
    holdersChecked,
    lsof: lsofOutput,
  };
}

// ---------------------------------------------------------------------------
// Build verification

export interface BuildVerification {
  readonly variant: Variant;
  readonly ok: boolean;
  readonly problems: ReadonlyArray<string>;
  readonly version: string | null;
  readonly commit: string | null;
  readonly artifacts: ReadonlyArray<{ readonly file: string; readonly sha256: string }>;
  readonly teamIdentifier: string | null;
  readonly designatedRequirement: string | null;
  readonly appUpdateYml: string | null;
  readonly bakedPolicy: Seams.BakedUpdatePolicy | null;
}

/**
 * Checks one build before it is installed or served: it must be a
 * development-signed mock build of the expected version whose packaged
 * app-update.yml names the loopback feed, and whose baked policy carries the
 * rehearsal profile (and the fault, for the fault variant).
 */
export async function verifyBuild(
  config: RehearsalConfig,
  variant: Variant,
  deps: {
    readonly runner: Runner;
    readonly readBakedPolicy: (appPath: string) => Seams.BakedUpdatePolicy | undefined;
  },
): Promise<BuildVerification> {
  const paths = rehearsalPaths(config);
  const dir = paths.buildDir(variant);
  const problems: string[] = [];
  const expectedVersion = variant === "n" ? config.nVersion : config.n1Version;
  let proof: Record<string, unknown> = {};
  try {
    proof = JSON.parse(
      await NodeFSP.readFile(NodePath.join(dir, "release-proof.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    problems.push(`no release-proof.json in ${dir}`);
  }
  const feed = (proof["feed"] ?? null) as Record<string, unknown> | null;
  const mac = (proof["mac"] ?? {}) as Record<string, unknown>;
  if (proof["version"] !== expectedVersion)
    problems.push(`proof version ${String(proof["version"])}, expected ${expectedVersion}`);
  if (feed?.["kind"] !== "mock")
    problems.push(`proof feed kind ${String(feed?.["kind"])}, expected mock`);
  if (mac["signingMode"] !== "development")
    problems.push(`signing mode ${String(mac["signingMode"])}, expected development`);
  if (mac["distributable"] !== false)
    problems.push("a rehearsal build must never be distributable");

  const artifacts: Array<{ file: string; sha256: string }> = [];
  const zip = (Array.isArray(proof["artifacts"]) ? proof["artifacts"] : [])
    .map((artifact) => (artifact as Record<string, unknown>)["file"])
    .find(
      (file): file is string => typeof file === "string" && file.endsWith(`-${config.arch}.zip`),
    );
  for (const entry of (await NodeFSP.readdir(dir).catch(() => [])).toSorted()) {
    if (/\.(dmg|zip|blockmap|yml)$/.test(entry)) {
      artifacts.push({ file: entry, sha256: await sha256Hex(NodePath.join(dir, entry)) });
    }
  }

  let teamIdentifier: string | null = null;
  let designatedRequirement: string | null = null;
  let appUpdateYml: string | null = null;
  let bakedPolicy: Seams.BakedUpdatePolicy | null = null;
  if (zip === undefined) {
    problems.push(`no ${config.arch} ZIP in the proof`);
  } else {
    const extractDir = NodePath.join(config.root, "extracted", variant);
    await NodeFSP.rm(extractDir, { recursive: true, force: true });
    await NodeFSP.mkdir(extractDir, { recursive: true });
    const extracted = await run(
      deps.runner,
      ["ditto", "-x", "-k", NodePath.join(dir, zip), extractDir],
      config.root,
    );
    const appPath = NodePath.join(extractDir, APP_NAME);
    if (extracted.exitCode !== 0) {
      problems.push(`ditto could not extract ${zip}`);
    } else {
      try {
        const info = Plist.parse(
          await NodeFSP.readFile(NodePath.join(appPath, "Contents", "Info.plist"), "utf8"),
        ) as Record<string, unknown>;
        if (info["CFBundleShortVersionString"] !== expectedVersion) {
          problems.push(
            `app version ${String(info["CFBundleShortVersionString"])}, expected ${expectedVersion}`,
          );
        }
        if (info["CFBundleIdentifier"] !== Seams.pinnedBundleId()) {
          problems.push(
            `bundle id ${String(info["CFBundleIdentifier"])}, expected ${Seams.pinnedBundleId()}`,
          );
        }
      } catch {
        problems.push("Info.plist unreadable");
      }
      appUpdateYml = await NodeFSP.readFile(
        NodePath.join(appPath, "Contents", "Resources", "app-update.yml"),
        "utf8",
      ).catch(() => null);
      const feedUrl = appUpdateYml?.match(/^url:\s*'?(.+?)'?\s*$/m)?.[1];
      if (feedUrl === undefined) {
        problems.push("the app has no app-update.yml feed URL");
      } else {
        const url = new URL(feedUrl);
        if (
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          url.port !== String(config.port)
        ) {
          problems.push(
            `packaged feed ${feedUrl} is not the loopback mock feed on port ${config.port}`,
          );
        }
      }
      try {
        bakedPolicy = deps.readBakedPolicy(appPath) ?? null;
      } catch (cause) {
        problems.push(`baked policy unreadable: ${String(cause)}`);
      }
      const expectedFault =
        variant === "n1-fault-migration" ? Seams.REHEARSAL_MIGRATION_FAULT : null;
      if (bakedPolicy === null) {
        problems.push("the app carries no baked update policy (U0 not integrated?)");
      } else {
        if (bakedPolicy.kind !== "mock")
          problems.push(`baked policy kind ${bakedPolicy.kind}, expected mock`);
        const expectedProfile = config.profile === "rehearsal" ? paths.profileDir : null;
        if ((bakedPolicy.rehearsal?.profile ?? null) !== expectedProfile) {
          problems.push(
            `baked rehearsal profile ${String(bakedPolicy.rehearsal?.profile)}, expected ${String(expectedProfile)}`,
          );
        }
        if ((bakedPolicy.rehearsal?.fault ?? null) !== expectedFault) {
          problems.push(
            `baked fault ${String(bakedPolicy.rehearsal?.fault)}, expected ${String(expectedFault)}`,
          );
        }
      }
      const verify = await run(
        deps.runner,
        ["codesign", "--verify", "--deep", "--strict", "--verbose=2", appPath],
        config.root,
      );
      if (verify.exitCode !== 0) problems.push("codesign --verify failed");
      const display = await run(
        deps.runner,
        ["codesign", "-d", "--verbose=2", "-r-", appPath],
        config.root,
      );
      const details = `${display.stdout}\n${display.stderr}`;
      teamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
      designatedRequirement = details.match(/designated => (.+)$/m)?.[1]?.trim() ?? null;
      if (teamIdentifier === null || teamIdentifier === "not set")
        problems.push("the app has no TeamIdentifier (ad-hoc builds can never update)");
      if (!/Authority=Apple Development/.test(details))
        problems.push("the app is not signed by an Apple Development certificate");
    }
  }
  return {
    variant,
    ok: problems.length === 0,
    problems,
    version: typeof proof["version"] === "string" ? proof["version"] : null,
    commit: typeof proof["commit"] === "string" ? proof["commit"] : null,
    artifacts,
    teamIdentifier,
    designatedRequirement,
    appUpdateYml,
    bakedPolicy,
  };
}

// ---------------------------------------------------------------------------
// Steps

export interface StepContext {
  readonly config: RehearsalConfig;
  readonly dryRun: boolean;
  readonly runner: Runner;
  readonly log: (line: string) => void;
  readonly now: () => Date;
  readonly readBakedPolicy: (appPath: string) => Seams.BakedUpdatePolicy | undefined;
  readonly tmpDir: string;
}

interface ScratchRecord {
  readonly base: string;
  readonly originalRef: string;
  readonly scratch: string;
}

async function readScratch(config: RehearsalConfig): Promise<ScratchRecord | undefined> {
  try {
    return JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(rehearsalPaths(config).evidence, "scratch.json"),
        "utf8",
      ),
    ) as ScratchRecord;
  } catch {
    return undefined;
  }
}

async function listStages(tmpDir: string) {
  return new Set(
    (await NodeFSP.readdir(tmpDir).catch(() => [])).filter((entry) =>
      entry.startsWith(STAGE_PREFIX),
    ),
  );
}

export async function stepBuild(context: StepContext, variant: Variant) {
  const command = buildCommand(context.config, variant);
  context.log(renderCommand(command));
  if (context.dryRun) return 0;
  // N comes from the base commit and N+1 from the scratch commit; building
  // either from the other would make the rehearsal prove nothing.
  const scratch = await readScratch(context.config);
  const head = await git(context, ["rev-parse", "HEAD"]);
  if (variant === "n" ? head === scratch?.scratch : head !== scratch?.scratch) {
    throw new Error(
      variant === "n"
        ? "HEAD is the N+1 scratch commit; run cleanup-n1 before building N."
        : "HEAD is not the N+1 scratch commit; run prepare-n1 first.",
    );
  }
  const stagesBefore = await listStages(context.tmpDir);
  const result = await context.runner(command, { stream: true });
  // A crashed build can leave its ~600 MB stage behind; remove only stages
  // that appeared during this build.
  for (const stage of await listStages(context.tmpDir)) {
    if (!stagesBefore.has(stage)) {
      context.log(`Removing leftover build stage ${stage}`);
      await NodeFSP.rm(NodePath.join(context.tmpDir, stage), { recursive: true, force: true });
    }
  }
  return result.exitCode;
}

async function git(context: StepContext, args: ReadonlyArray<string>) {
  const result = await run(
    context.runner,
    ["git", "-C", context.config.repo, ...args],
    context.config.repo,
  );
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export async function stepPrepareN1(context: StepContext, marker: typeof DEFAULT_MARKER) {
  const paths = rehearsalPaths(context.config);
  const evidenceFile = NodePath.join(paths.evidence, "scratch.json");
  context.log(
    `git -C ${context.config.repo} switch -c ${paths.scratchBranch}; mark ${marker.file}; git commit (never pushed)`,
  );
  if (context.dryRun) return 0;
  if ((await git(context, ["status", "--porcelain"])) !== "") {
    throw new Error("The worktree has uncommitted changes; N+1 must come from a clean commit.");
  }
  const base = await git(context, ["rev-parse", "HEAD"]);
  const originalRef = await git(context, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const markerPath = NodePath.join(context.config.repo, marker.file);
  const source = await NodeFSP.readFile(markerPath, "utf8");
  if (source.split(marker.anchor).length !== 2) {
    throw new Error(
      `The N+1 marker anchor '${marker.anchor}' must appear exactly once in ${marker.file}; pass --marker-file/--marker-anchor.`,
    );
  }
  await git(context, ["switch", "-c", paths.scratchBranch]);
  await NodeFSP.writeFile(markerPath, source.replace(marker.anchor, marker.replacement));
  await git(context, ["add", marker.file]);
  await git(context, [
    "commit",
    "-q",
    "-m",
    `test: update rehearsal ${context.config.runId} N+1 marker (never pushed)`,
  ]);
  const scratch = await git(context, ["rev-parse", "HEAD"]);
  await writeJson(evidenceFile, {
    base,
    originalRef,
    scratch,
    branch: paths.scratchBranch,
    marker,
  });
  context.log(`Scratch commit ${scratch} on ${paths.scratchBranch} (base ${base}).`);
  return 0;
}

export async function stepCleanupN1(context: StepContext) {
  const paths = rehearsalPaths(context.config);
  const scratch = await readScratch(context.config);
  if (scratch === undefined)
    throw new Error("No scratch.json; prepare-n1 has not run for this run id.");
  const target = scratch.originalRef === "HEAD" ? scratch.base : scratch.originalRef;
  context.log(
    `git -C ${context.config.repo} switch ${target === scratch.base ? "--detach " : ""}${target}; git branch -D ${paths.scratchBranch}`,
  );
  if (context.dryRun) return 0;
  const head = await git(context, ["rev-parse", "HEAD"]);
  if (head !== scratch.scratch) {
    throw new Error(`HEAD is ${head}, not the scratch commit ${scratch.scratch}; resolve by hand.`);
  }
  await git(context, target === scratch.base ? ["switch", "--detach", target] : ["switch", target]);
  await git(context, ["branch", "-D", paths.scratchBranch]);
  return 0;
}

async function stepVerify(context: StepContext, variants: ReadonlyArray<Variant>) {
  const paths = rehearsalPaths(context.config);
  context.log(`verify ${variants.join(", ")} → ${paths.evidence}/verify-*.json`);
  if (context.dryRun) return 0;
  let failed = false;
  const results = new Map<Variant, BuildVerification>();
  for (const variant of variants) {
    const result = await verifyBuild(context.config, variant, {
      runner: context.runner,
      readBakedPolicy: context.readBakedPolicy,
    });
    results.set(variant, result);
    await writeJson(NodePath.join(paths.evidence, `verify-${variant}.json`), result);
    context.log(
      `${result.ok ? "PASS" : "FAIL"} ${variant}${result.problems.length ? `: ${result.problems.join("; ")}` : ""}`,
    );
    failed ||= !result.ok;
  }
  // Squirrel accepts N+1 only if it satisfies the running N's designated
  // requirement. Checking that here catches a signing mismatch before anyone
  // clicks Restart.
  const requirement = results.get("n")?.designatedRequirement;
  for (const variant of variants.filter((candidate) => candidate !== "n")) {
    if (requirement == null) break;
    const appPath = NodePath.join(context.config.root, "extracted", variant, APP_NAME);
    const check = await run(
      context.runner,
      ["codesign", "--verify", "--deep", "--strict", "-R", `=${requirement}`, appPath],
      context.config.root,
    );
    context.log(
      `${check.exitCode === 0 ? "PASS" : "FAIL"} ${variant} satisfies N's designated requirement`,
    );
    failed ||= check.exitCode !== 0;
  }
  return failed ? 1 : 0;
}

async function stepFeed(context: StepContext) {
  const paths = rehearsalPaths(context.config);
  for (const spec of FEEDS) {
    context.log(
      `feed ${spec.name} ← ${spec.from}${spec.corrupt ? " (one byte flipped)" : ""}${spec.version ? ` (manifest version ${spec.version})` : ""}`,
    );
  }
  if (context.dryRun) return 0;
  for (const spec of FEEDS) {
    try {
      await NodeFSP.access(NodePath.join(paths.buildDir(spec.from), "latest-mac.yml"));
    } catch {
      context.log(`skip ${spec.name}: ${spec.from} was not built`);
      continue;
    }
    context.log(`wrote ${await generateFeed(paths, spec)}`);
  }
  await writeJson(NodePath.join(paths.evidence, "faults.json"), { faults: [] });
  return 0;
}

async function stepInstallN(context: StepContext) {
  const paths = rehearsalPaths(context.config);
  const proof = JSON.parse(
    await NodeFSP.readFile(NodePath.join(paths.buildDir("n"), "release-proof.json"), "utf8"),
  ) as {
    artifacts: Array<{ file: string }>;
  };
  const zip = proof.artifacts.find((artifact) =>
    artifact.file.endsWith(`-${context.config.arch}.zip`),
  )?.file;
  if (zip === undefined) throw new Error("N has no ZIP to install from.");
  const argv = ["ditto", "-x", "-k", NodePath.join(paths.buildDir("n"), zip), paths.applications];
  context.log(argv.join(" "));
  if (context.dryRun) return 0;
  try {
    await NodeFSP.access(paths.installedApp);
    throw new Error(
      `${paths.installedApp} already exists; remove it first so the rehearsal starts from N.`,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await NodeFSP.mkdir(paths.applications, { recursive: true });
  return (await run(context.runner, argv, context.config.root)).exitCode;
}

async function stepGuard(context: StepContext, phase: "before" | "after") {
  const paths = rehearsalPaths(context.config);
  context.log(
    `stat ${liveGuardPaths(paths).length} live paths; lsof holders → ${paths.evidence}/guard-${phase}.json`,
  );
  if (context.dryRun) return 0;
  const snapshot = await takeGuardSnapshot(context.config, phase, context.runner, context.now);
  await writeJson(NodePath.join(paths.evidence, `guard-${phase}.json`), snapshot);
  context.log(describeGuardHolders(snapshot));
  if (phase === "before") return snapshot.holders.some((holder) => holder.rehearsal) ? 1 : 0;
  const before = JSON.parse(
    await NodeFSP.readFile(NodePath.join(paths.evidence, "guard-before.json"), "utf8"),
  ) as GuardSnapshot;
  const verdict = compareGuard(before, snapshot);
  await writeJson(NodePath.join(paths.evidence, "guard-verdict.json"), verdict);
  context.log(
    `Live install: ${verdict.status}${verdict.changed.length ? ` (changed: ${verdict.changed.join(", ")})` : ""}`,
  );
  return verdict.status === "violated" || verdict.status === "unverified" ? 1 : 0;
}

async function hashIfPresent(filePath: string) {
  try {
    return await sha256Hex(filePath);
  } catch {
    return null;
  }
}

async function stepRecord(context: StepContext) {
  const paths = rehearsalPaths(context.config);
  context.log(`write ${paths.evidence}/run-record.json`);
  if (context.dryRun) return 0;
  const readJson = async (name: string) => {
    try {
      return JSON.parse(
        await NodeFSP.readFile(NodePath.join(paths.evidence, name), "utf8"),
      ) as unknown;
    } catch {
      return null;
    }
  };
  const requestLog = await NodeFSP.readFile(paths.requestLog, "utf8").catch(() => "");
  const requests = requestLog.split("\n").filter((line) => line.trim() !== "");
  const evidenceFiles: Record<string, string | null> = {};
  for (const name of (await NodeFSP.readdir(paths.evidence).catch(() => [])).toSorted()) {
    if (/\.(json|jsonl|png|log)$/.test(name))
      evidenceFiles[name] = await hashIfPresent(NodePath.join(paths.evidence, name));
  }
  await writeJson(NodePath.join(paths.evidence, "run-record.json"), {
    schema: 1,
    label: EVIDENCE_LABEL,
    runId: context.config.runId,
    recordedAt: context.now().toISOString(),
    versions: { n: context.config.nVersion, n1: context.config.n1Version },
    signingIdentitySha1: context.config.identity,
    scratch: await readJson("scratch.json"),
    builds: Object.fromEntries(
      await Promise.all(
        VARIANTS.map(async (variant) => [variant, await readJson(`verify-${variant}.json`)]),
      ),
    ),
    guard: await readJson("guard-verdict.json"),
    compare: {
      after: await readJson("compare-after.json"),
      afterRestart: await readJson("compare-after-restart.json"),
    },
    mockFeed: {
      requests: requests.length,
      canaryHits: requests.filter((line) => line.includes('"server":"canary"')).length,
      outsideBasePath: requests.filter((line) => line.includes('"outcome":"outside-base-path"'))
        .length,
    },
    evidenceFiles,
    notVerified: [
      "Stark-owned HTTPS hosting (S1)",
      "Developer ID signing and notarization (S2)",
      "installation and upgrade on a second Mac",
    ],
  });
  return 0;
}

// ---------------------------------------------------------------------------
// CLI

const usage = `Usage: node scripts/update-rehearsal.ts <step> [options]

Steps:
  plan                       Print every rehearsal command in order (default).
  guard before|after         Stat the live install and record who holds it.
  build n|n1|n1-fault-migration
                             Build one version (sandbox off; needs --identity).
  prepare-n1 | cleanup-n1    Create or remove the never-pushed N+1 scratch commit.
  verify [variant…]          Check proofs, packaged feed, baked policy and signatures.
  feed                       Generate feed, feed-corrupt, feed-older, feed-fault-migration.
  install-n                  Extract N into <root>/Applications.
  record                     Write evidence/run-record.json.

Options:
  --run-id <id>              Default: a timestamp. Use the same id for every step.
  --root <dir>               Default: ~/.stark-code-update-rehearsal/<run-id>.
  --identity <sha1>          Apple Development certificate SHA-1.
  --n-version, --n1-version  Default ${DEFAULT_N_VERSION} and ${DEFAULT_N1_VERSION}.
  --port <port>              Mock feed port baked into both builds (default ${DEFAULT_PORT}).
  --cdp-port <port>          DevTools port for the fixture driver (default ${DEFAULT_CDP_PORT}).
  --arch arm64|x64           Default arm64.
  --marker-file, --marker-anchor, --marker-text
                             The visible N+1 change (default: the About version label).
  --dry-run                  Print what the step would do without doing it.`;

export function resolveConfig(
  values: Record<string, string | boolean | undefined>,
  defaults: { readonly repo: string; readonly homeDir: string; readonly now: () => Date },
): RehearsalConfig {
  const runId =
    typeof values["run-id"] === "string"
      ? values["run-id"]
      : defaults.now().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid run id '${runId}'.`);
  const root = NodePath.resolve(
    typeof values["root"] === "string"
      ? values["root"]
      : NodePath.join(defaults.homeDir, ".stark-code-update-rehearsal", runId),
  );
  const port = Number(values["port"] ?? DEFAULT_PORT);
  const cdpPort = Number(values["cdp-port"] ?? DEFAULT_CDP_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65534)
    throw new Error("--port must be 1024–65534.");
  const arch = values["arch"] ?? "arm64";
  if (arch !== "arm64" && arch !== "x64") throw new Error("--arch must be arm64 or x64.");
  const profile = values["profile"] ?? "rehearsal";
  if (profile !== "rehearsal" && profile !== "existing") {
    throw new Error("--profile must be rehearsal or existing.");
  }
  // R2 upgrades the real ~/.stark-code of a disposable macOS account the
  // owner created for it (S7), never the developer's own.
  const accountHome =
    typeof values["account-home"] === "string" ? NodePath.resolve(values["account-home"]) : null;
  const isolatedAccount = values["isolated-account"] === true;
  if (profile === "existing") {
    if (accountHome === null) {
      throw new Error("--profile existing needs --account-home <home of the isolated R2 account>.");
    }
    if (accountHome === defaults.homeDir && !isolatedAccount) {
      throw new Error(
        "--account-home is this account's own home. Run R2 steps that touch data inside the isolated account and pass --isolated-account there.",
      );
    }
  }
  const config: RehearsalConfig = {
    runId,
    repo: defaults.repo,
    root,
    homeDir: defaults.homeDir,
    identity: typeof values["identity"] === "string" ? values["identity"] : null,
    nVersion: typeof values["n-version"] === "string" ? values["n-version"] : DEFAULT_N_VERSION,
    n1Version: typeof values["n1-version"] === "string" ? values["n1-version"] : DEFAULT_N1_VERSION,
    port,
    cdpPort,
    arch,
    profile,
    accountHome,
    isolatedAccount,
  };
  assertSafeRehearsalRoot(config);
  if (config.nVersion === config.n1Version) throw new Error("N and N+1 need different versions.");
  if (/-(pr|preview)\./.test(config.nVersion) || /-(pr|preview)\./.test(config.n1Version)) {
    throw new Error("Preview and PR versions get no update feed; use an -alpha.N version.");
  }
  return config;
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [step = "plan", ...rest] = argv;
  const { values, positionals } = NodeUtil.parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "run-id": { type: "string" },
      root: { type: "string" },
      identity: { type: "string" },
      "n-version": { type: "string" },
      "n1-version": { type: "string" },
      port: { type: "string" },
      "cdp-port": { type: "string" },
      arch: { type: "string" },
      "marker-file": { type: "string" },
      "marker-anchor": { type: "string" },
      "marker-text": { type: "string" },
      profile: { type: "string" },
      "isolated-account": { type: "boolean", default: false },
      "account-home": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const repo = NodePath.resolve(import.meta.dirname, "..");
  const config = resolveConfig(values, { repo, homeDir: NodeOS.homedir(), now: () => new Date() });
  const context: StepContext = {
    config,
    dryRun: values["dry-run"],
    runner: nodeRunner,
    log: (line) => console.log(line),
    now: () => new Date(),
    readBakedPolicy: (appPath) =>
      Seams.parseBakedUpdatePolicy(Seams.readPackagedAppPackageJson(appPath)),
    tmpDir: NodeOS.tmpdir(),
  };
  switch (step) {
    case "plan":
      console.log(formatPlan(config));
      return 0;
    case "guard":
      if (positionals[0] !== "before" && positionals[0] !== "after") break;
      return stepGuard(context, positionals[0]);
    case "build": {
      const variant = positionals[0];
      if (variant === undefined || !isVariant(variant)) break;
      return stepBuild(context, variant);
    }
    case "prepare-n1":
      return stepPrepareN1(context, {
        file: values["marker-file"] ?? DEFAULT_MARKER.file,
        anchor: values["marker-anchor"] ?? DEFAULT_MARKER.anchor,
        replacement: values["marker-text"] ?? DEFAULT_MARKER.replacement,
      });
    case "cleanup-n1":
      return stepCleanupN1(context);
    case "verify": {
      const requested = positionals.length > 0 ? positionals : ["n", "n1"];
      if (!requested.every(isVariant)) break;
      return stepVerify(context, requested.filter(isVariant));
    }
    case "feed":
      return stepFeed(context);
    case "install-n":
      return stepInstallN(context);
    case "record":
      return stepRecord(context);
    default:
      break;
  }
  console.error(usage);
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : cause);
      process.exitCode = 1;
    },
  );
}
