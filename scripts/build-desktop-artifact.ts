#!/usr/bin/env node
import BRAND from "../stark.brand.json" with { type: "json" };
// @effect-diagnostics nodeBuiltinImport:off - Node's typed junction API avoids Windows symlink privileges while keeping the probe isolated.

import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
// plist is CommonJS; Node cannot load its named exports from an ES module.
import Plist from "plist";

import {
  createPackageWithOptions,
  extractAll,
  getRawHeader,
  statFile,
  type DirectoryRecord,
} from "@electron/asar";

import { fromJsonStringPretty } from "@starkfuture/shared/schemaJson";
import { fromYaml } from "@starkfuture/shared/schemaYaml";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@starkfuture/shared/relayAuth";
import { resolveSpawnCommand } from "@starkfuture/shared/shell";
import { validateStarkWorkbenchRoot } from "@starkfuture/shared/starkWorkbench";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import gnomeCaptureBundle from "../apps/desktop/gnome-extension/bundle.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import { prepareStarkWorkbench } from "./prepare-stark-workbench.mjs";
import { encodePngIcns } from "../apps/desktop/scripts/icns.mjs";
import {
  BRAND_ASSET_PATHS,
  resolveWebAssetBrandForChannel,
  type WebAssetBrand,
} from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import {
  findInlinedExternalPackages,
  selectCliRuntimeExternalDependencies,
} from "./lib/cli-external-packages.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { selectDesktopRuntimeExternalDependencies } from "./lib/desktop-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";
import { replaceUpdateManifestFileDigest, withMockFeedKind } from "./lib/update-manifest.ts";
import {
  BAKED_UPDATE_POLICY_KEY,
  DESKTOP_REHEARSAL_FAULTS,
  FEED_URL_PROBLEMS,
  STARK_UPDATE_FEED_PROBLEMS,
  STARK_UPDATE_OWNERSHIP,
  checkFeedUrl,
  isValidRehearsalProfile,
  parseDesignatedRequirement,
  requirementPinsIdentity,
  validateStarkUpdateFeed,
  type BakedRehearsalPolicy,
  type BakedUpdatePolicy,
  type DesktopRehearsalFault,
  type UpdateOwnership,
} from "./lib/update-feed-ownership.ts";

const isDesktopRehearsalFault = (value: string): value is DesktopRehearsalFault =>
  (DESKTOP_REHEARSAL_FAULTS as ReadonlyArray<string>).includes(value);

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const LINUX_ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512] as const;
const DESKTOP_APP_ID = BRAND.bundleId;
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

class StarkWorkbenchBundlePreparationError extends Schema.TaggedError<StarkWorkbenchBundlePreparationError>()(
  "StarkWorkbenchBundlePreparationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not prepare the bundled Stark Workbench kit.";
  }
}

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;

const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  // pnpm 11 only reads these from pnpm-workspace.yaml (not package.json#pnpm).
  // Without allowBuilds the staged `vp install --prod` fails with
  // ERR_PNPM_IGNORED_BUILDS for packages that have lifecycle scripts.
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  packageExtensions: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        peerDependenciesMeta: Schema.Record(
          Schema.String,
          Schema.Struct({ optional: Schema.Boolean }),
        ),
      }),
    ),
  ),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
type StageWorkspaceConfig = typeof StageWorkspaceConfig.Type;

// electron-webauthn declares TypeScript as a peer only for its typings. pnpm
// auto-installs missing peers, which would ship a compiler inside the app.
const STAGE_PACKAGE_EXTENSIONS = {
  "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
  "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
} as const;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

// Decodes the repo's pnpm-workspace.yaml. A PR CI test calls this too, so a bad
// entry fails the PR instead of the nightly desktop build.
export const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

export function resolveResourceMonitorRustTargets(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): ReadonlyArray<string> {
  if (platform === "mac") {
    if (arch === "universal") {
      return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    }
    return [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
  }
  if (platform === "linux") {
    return [arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"];
  }
  return [arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"];
}

export function resourceMonitorExecutableName(platform: typeof BuildPlatform.Type): string {
  return platform === "win" ? "stark-resource-monitor.exe" : "stark-resource-monitor";
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<number>;
  readonly wslRuntime: Option.Option<string>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

const getDefaultArch = Effect.fn("getDefaultArch")(function* (platform: typeof BuildPlatform.Type) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  return yield* getDefaultBuildArch(platform, config);
});

export class MacPasskeySigningConfigurationResolutionError extends Schema.TaggedError<MacPasskeySigningConfigurationResolutionError>()(
  "MacPasskeySigningConfigurationResolutionError",
  {
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    cause: unknown,
  ): MacPasskeySigningConfigurationError | MacPasskeySigningConfigurationResolutionError {
    return isMacPasskeySigningConfigurationError(cause)
      ? cause
      : new MacPasskeySigningConfigurationResolutionError({ cause });
  }

  override get message(): string {
    return "Failed to resolve macOS passkey signing configuration.";
  }
}

export class KeyringNativePackageMissingError extends Schema.TaggedError<KeyringNativePackageMissingError>()(
  "KeyringNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Keyring native package is missing: ${this.packageName}`;
  }
}

export class ClerkPasskeyNativePackageMissingError extends Schema.TaggedError<ClerkPasskeyNativePackageMissingError>()(
  "ClerkPasskeyNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Clerk passkey native package is missing: ${this.packageName}`;
  }
}

export class UnsupportedHostBuildPlatformError extends Schema.TaggedError<UnsupportedHostBuildPlatformError>()(
  "UnsupportedHostBuildPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported host platform '${this.hostPlatform}'.`;
  }
}

export class UnsupportedDesktopBuildArchitectureError extends Schema.TaggedError<UnsupportedDesktopBuildArchitectureError>()(
  "UnsupportedDesktopBuildArchitectureError",
  {
    platform: BuildPlatform,
    arch: BuildArch,
    supportedArchitectures: Schema.Array(BuildArch),
  },
) {
  override get message(): string {
    return `Unsupported architecture '${this.arch}' for ${this.platform}.`;
  }
}

const InvalidMockUpdateServerPortReason = Schema.Literals([
  "not-numeric",
  "not-integer",
  "out-of-range",
]);

export class InvalidMockUpdateServerPortError extends Schema.TaggedError<InvalidMockUpdateServerPortError>()(
  "InvalidMockUpdateServerPortError",
  {
    reason: InvalidMockUpdateServerPortReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid mock update server port.";
  }

  static fromConfigValue(configuredPort: string, cause: unknown) {
    return new InvalidMockUpdateServerPortError({
      reason: invalidMockUpdateServerPortReason(configuredPort),
      inputLength: configuredPort.length,
      cause,
    });
  }
}

export class BuildCommandFailedError extends Schema.TaggedError<BuildCommandFailedError>()(
  "BuildCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const outputSections = [
      `Command: ${this.command}`,
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);
    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";
    return `Command exited with non-zero exit code (${this.exitCode})${outputSuffix}`;
  }
}

export const LINUX_DESKTOP_BUILD_PREREQUISITES = [
  { id: "cargo", description: "Rust compiler and Cargo", packages: ["cargo", "rustc"] },
  { id: "rust-target", description: "Requested Rust standard library", packages: [] },
  { id: "cc", description: "C/C++ build toolchain", packages: ["build-essential"] },
  { id: "make", description: "Make", packages: ["build-essential"] },
  {
    id: "libsecret",
    description: "libsecret development headers and pkg-config",
    packages: ["libsecret-1-dev", "pkg-config"],
  },
  { id: "imagemagick", description: "ImageMagick", packages: ["imagemagick"] },
] as const;

export class LinuxDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<LinuxDesktopBuildPrerequisitesMissingError>()(
  "LinuxDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTarget: Schema.String,
  },
) {
  override get message(): string {
    const missingRequirements = LINUX_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    );
    const details = missingRequirements
      .map((requirement) =>
        requirement.packages.length > 0
          ? `  - ${requirement.description} (${requirement.packages.join(", ")})`
          : `  - ${requirement.description}`,
      )
      .join("\n");
    const packages = [
      ...new Set(missingRequirements.flatMap((requirement) => requirement.packages)),
    ];
    return [
      "Linux desktop build prerequisites are missing:",
      details,
      "",
      ...(packages.length > 0
        ? ["On Ubuntu/Debian, install them with:", `  sudo apt-get install ${packages.join(" ")}`]
        : []),
      ...(this.missing.includes("rust-target")
        ? ["Add the requested Rust target with:", `  rustup target add ${this.rustTarget}`]
        : []),
      "",
      "For other distributions, see docs/operations/development.md#linux-appimage-prerequisites.",
      "Then rerun `vp run dist:desktop:linux`.",
    ].join("\n");
  }
}

const MAC_DESKTOP_BUILD_PREREQUISITES = [
  { id: "rust", description: "Rust/Cargo and the requested Rust target" },
  { id: "clang", description: "Xcode Command Line Tools (clang)" },
  { id: "make", description: "Xcode Command Line Tools (make)" },
  { id: "sips", description: "macOS image tool (sips)" },
  { id: "lipo", description: "Xcode universal-binary tool (lipo)" },
] as const;

export class MacDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<MacDesktopBuildPrerequisitesMissingError>()(
  "MacDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTargets: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const details = MAC_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    )
      .map((requirement) => `  - ${requirement.description}`)
      .join("\n");
    return [
      "macOS desktop build prerequisites are missing:",
      details,
      "",
      "Install Apple's build tools with:",
      "  xcode-select --install",
      "Install Rust from https://rustup.rs, then add the requested target(s):",
      `  rustup target add ${this.rustTargets.join(" ")}`,
      "",
      "Then rerun the desktop artifact command.",
    ].join("\n");
  }
}

const WINDOWS_DESKTOP_BUILD_PREREQUISITES = [
  { id: "rust", description: "Rust/Cargo and the requested MSVC Rust target" },
  { id: "python", description: "Python 3 for node-gyp" },
  {
    id: "msvc",
    description: "Visual Studio Build Tools with C++, Windows SDK, and Spectre libraries",
  },
  { id: "tar", description: "tar to inspect the bundled WSL runtime archive" },
] as const;

export class WindowsDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<WindowsDesktopBuildPrerequisitesMissingError>()(
  "WindowsDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTarget: Schema.String,
  },
) {
  override get message(): string {
    const details = WINDOWS_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    )
      .map((requirement) => `  - ${requirement.description}`)
      .join("\n");
    return [
      "Windows desktop build prerequisites are missing:",
      details,
      "",
      "Install Rust from https://rustup.rs and add the requested target:",
      `  rustup target add ${this.rustTarget}`,
      "Install Python 3 and the Visual Studio Build Tools components listed in",
      "docs/operations/development.md#windows-installer-prerequisites.",
      "",
      "Then rerun the desktop artifact command.",
    ].join("\n");
  }
}

export class ResourceMonitorBuildOutputMissingError extends Schema.TaggedError<ResourceMonitorBuildOutputMissingError>()(
  "ResourceMonitorBuildOutputMissingError",
  {
    binaryPath: Schema.String,
    rustTarget: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Resource monitor build for ${this.rustTarget} did not produce ${this.binaryPath}.`;
  }
}

const desktopIconPlatformNames = {
  mac: "macOS",
  linux: "Linux",
  win: "Windows",
} satisfies Record<typeof BuildPlatform.Type, string>;

export class LinuxBrowserSecretHostError extends Schema.TaggedError<LinuxBrowserSecretHostError>()(
  "LinuxBrowserSecretHostError",
  { hostPlatform: Schema.String },
) {
  override get message(): string {
    return `Linux desktop builds must run on a Linux host: the browser secret helper links against libsecret and cannot be built on '${this.hostPlatform}'.`;
  }
}

export class MacDictationHostError extends Schema.TaggedError<MacDictationHostError>()(
  "MacDictationHostError",
  { hostPlatform: Schema.String },
) {
  override get message(): string {
    return `macOS desktop builds must run on a Mac with Xcode Command Line Tools to compile dictation; found '${this.hostPlatform}'.`;
  }
}

export class DesktopIconSourceMissingError extends Schema.TaggedError<DesktopIconSourceMissingError>()(
  "DesktopIconSourceMissingError",
  {
    platform: BuildPlatform,
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${desktopIconPlatformNames[this.platform]} icon source is missing at ${this.sourcePath}`;
  }
}

export class DesktopDmgBackgroundSourceMissingError extends Schema.TaggedError<DesktopDmgBackgroundSourceMissingError>()(
  "DesktopDmgBackgroundSourceMissingError",
  {
    channel: Schema.Literals(["latest", "nightly"]),
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${this.channel} DMG background source is missing at ${this.sourcePath}`;
  }
}

export class BundledClientAssetsMissingError extends Schema.TaggedError<BundledClientAssetsMissingError>()(
  "BundledClientAssetsMissingError",
  {
    indexPath: Schema.String,
    missingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const preview = this.missingFiles.slice(0, 6).join(", ");
    const suffix = this.missingFiles.length > 6 ? ` (+${this.missingFiles.length - 6} more)` : "";
    return `Bundled client references missing files in ${this.indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`;
  }
}

export class UnsupportedDesktopBuildPlatformError extends Schema.TaggedError<UnsupportedDesktopBuildPlatformError>()(
  "UnsupportedDesktopBuildPlatformError",
  {
    platform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported platform '${this.platform}'.`;
  }
}

const dependencyResolutionDescriptions = {
  "server-production": "production dependencies",
  "workspace-overrides": "overrides",
  "desktop-runtime": "desktop runtime dependencies",
} as const;
const DependencyResolutionKind = Schema.Literals([
  "server-production",
  "workspace-overrides",
  "desktop-runtime",
]);

export class DesktopBuildDependencyResolutionError extends Schema.TaggedError<DesktopBuildDependencyResolutionError>()(
  "DesktopBuildDependencyResolutionError",
  {
    kind: DependencyResolutionKind,
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve ${dependencyResolutionDescriptions[this.kind]} from ${this.manifestPath}.`;
  }
}

export class MissingServerProductionDependenciesError extends Schema.TaggedError<MissingServerProductionDependenciesError>()(
  "MissingServerProductionDependenciesError",
  {
    manifestPath: Schema.String,
  },
) {
  override get message(): string {
    return `Could not resolve production dependencies from ${this.manifestPath}.`;
  }
}

const DesktopBuildInputArtifact = Schema.Literals([
  "desktop-dist",
  "desktop-resources",
  "server-dist",
  "bundled-server-client",
]);
type DesktopBuildInputArtifact = typeof DesktopBuildInputArtifact.Type;
const desktopBuildInputArtifactNames = {
  "desktop-dist": "desktopDist",
  "desktop-resources": "desktopResources",
  "server-dist": "serverDist",
  "bundled-server-client": "bundled server client",
} satisfies Record<DesktopBuildInputArtifact, string>;

/**
 * Imported by every server module, so it is inlined in any correctly bundled
 * build. Its absence means the bundle went back to externalizing its
 * dependencies, which the sidecar's selected runtime closure does not cover.
 */
const BUNDLE_SELF_CONTAINED_SENTINEL = "effect";

const BUNDLE_SELF_CHECK_TIMEOUT = Duration.seconds(120);
const WINDOWS_PRIMARY_NATIVE_PROBE_TIMEOUT = Duration.seconds(30);

const WINDOWS_PRIMARY_FFF_PROBE_SOURCE = `
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { FileFinder } = await import(pathToFileURL(process.argv[1]).href);
const probeRoot = process.argv[2];
const result = FileFinder.create({
  basePath: probeRoot,
  frecencyDbPath: join(probeRoot, "frecency.mdb"),
  historyDbPath: join(probeRoot, "history.mdb"),
  disableWatch: true,
  disableMmapCache: true,
  disableContentIndexing: true,
});
if (!result.ok) throw new Error(result.error);
result.value.destroy();
`;

export class ExternalizedBundleError extends Schema.TaggedError<ExternalizedBundleError>()(
  "ExternalizedBundleError",
  { sentinel: Schema.String, inlinedPackageCount: Schema.Number },
) {
  override get message(): string {
    return `The server bundle did not inline "${this.sentinel}" (${this.inlinedPackageCount} packages inlined). The bundle is meant to be self-contained apart from the runtime externals; if its dependencies are external again they will be absent from the sidecar, and the backend will fail with ERR_MODULE_NOT_FOUND. Check the deps.alwaysBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class BundleNotSelfContainedError extends Schema.TaggedError<BundleNotSelfContainedError>()(
  "BundleNotSelfContainedError",
  { exitCode: Schema.Number, output: Schema.String },
) {
  override get message(): string {
    return `The packaged server bundle could not load from the isolated, extracted sidecar (exit ${this.exitCode}). Anything it imports that is neither a Node built-in nor in the selected runtime-external closure is unavailable to both backends. Output:
${this.output}`;
  }
}

export class InlinedNativePackageError extends Schema.TaggedError<InlinedNativePackageError>()(
  "InlinedNativePackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that load native binaries: ${this.packages.join(", ")}. A node-gyp-build style loader resolves prebuilds relative to its own file, so inlined into a chunk it finds none and the importer quietly falls back to a slower JS path. Add them to CLI_RUNTIME_EXTERNAL_PREFIXES in scripts/lib/cli-external-packages.ts so they stay external and are staged in the sidecar.`;
  }
}

export class InlinedExternalPackageError extends Schema.TaggedError<InlinedExternalPackageError>()(
  "InlinedExternalPackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that must stay external: ${this.packages.join(", ")}. These are native addons or their loaders; inlined, they resolve prebuilds relative to the bundle and silently lose native acceleration. Check the deps.neverBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class MissingDesktopBuildInputError extends Schema.TaggedError<MissingDesktopBuildInputError>()(
  "MissingDesktopBuildInputError",
  {
    artifact: DesktopBuildInputArtifact,
    artifactPath: Schema.String,
    buildCommand: Schema.Literal("vp run build:desktop"),
  },
) {
  override get message(): string {
    return `Missing ${desktopBuildInputArtifactNames[this.artifact]} at ${this.artifactPath}. Run '${this.buildCommand}' first.`;
  }
}

export class MacProvisioningProfileNotFoundError extends Schema.TaggedError<MacProvisioningProfileNotFoundError>()(
  "MacProvisioningProfileNotFoundError",
  {
    provisioningProfilePath: Schema.String,
  },
) {
  override get message(): string {
    return `macOS provisioning profile not found: ${this.provisioningProfilePath}`;
  }
}

export class DesktopBuildDistDirectoryMissingError extends Schema.TaggedError<DesktopBuildDistDirectoryMissingError>()(
  "DesktopBuildDistDirectoryMissingError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but dist directory was not found at ${this.distPath}`;
  }
}

export class DesktopBuildNoArtifactsProducedError extends Schema.TaggedError<DesktopBuildNoArtifactsProducedError>()(
  "DesktopBuildNoArtifactsProducedError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but no files were produced in ${this.distPath}`;
  }
}

export class WslRuntimeArchiveMissingError extends Schema.TaggedError<WslRuntimeArchiveMissingError>()(
  "WslRuntimeArchiveMissingError",
  {
    archivePath: Schema.String,
  },
) {
  override get message(): string {
    return `WSL runtime archive not found at ${this.archivePath}.`;
  }
}

export class WindowsServerSidecarPackError extends Schema.TaggedError<WindowsServerSidecarPackError>()(
  "WindowsServerSidecarPackError",
  {
    asarPath: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to pack the Windows server sidecar at ${this.asarPath}.`;
  }
}

export class WindowsPrimaryNativeProbeError extends Schema.TaggedError<WindowsPrimaryNativeProbeError>()(
  "WindowsPrimaryNativeProbeError",
  {
    executablePath: Schema.String,
    exitCode: Schema.Number,
    output: Schema.String,
  },
) {
  override get message(): string {
    return `The packaged Windows primary could not load fff from server.asar (exit ${this.exitCode}). Output:\n${this.output}`;
  }
}

const WindowsPackagedPayloadValidationReason = Schema.Literals([
  "packaged-app-missing",
  "sidecar-missing",
  "sidecar-invalid",
  "unpacked-native-missing",
  "resource-monitor-missing",
  "wsl-runtime-missing",
  "wsl-runtime-invalid",
  "file-limit-exceeded",
]);

export class WindowsPackagedPayloadValidationError extends Schema.TaggedError<WindowsPackagedPayloadValidationError>()(
  "WindowsPackagedPayloadValidationError",
  {
    reason: WindowsPackagedPayloadValidationReason,
    packagedAppDir: Schema.String,
    missingFiles: Schema.optionalKey(Schema.Array(Schema.String)),
    fileCount: Schema.optionalKey(Schema.Int),
    fileLimit: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "file-limit-exceeded") {
      return `Windows packaged payload contains ${String(this.fileCount)} files; expected at most ${String(this.fileLimit)}.`;
    }
    if (this.reason === "unpacked-native-missing") {
      return `Windows server sidecar is missing ${String(this.missingFiles?.length ?? 0)} unpacked native files.`;
    }
    if (this.reason === "resource-monitor-missing") {
      return "Windows packaged payload is missing the resource monitor executable.";
    }
    if (this.reason === "wsl-runtime-missing") {
      return "Windows packaged payload is missing the WSL runtime archive or SHA-256 sidecar.";
    }
    if (this.reason === "wsl-runtime-invalid") {
      return "Windows packaged payload contains an invalid WSL runtime archive.";
    }
    if (this.reason === "sidecar-invalid") {
      return "Windows packaged payload contains an invalid server.asar sidecar.";
    }
    if (this.reason === "sidecar-missing") {
      return "Windows packaged payload is missing resources/server.asar.";
    }
    return `Windows packaged application directory was not found at ${this.packagedAppDir}.`;
  }
}

export class LinuxIconResizeError extends Schema.TaggedError<LinuxIconResizeError>()(
  "LinuxIconResizeError",
  {
    operation: Schema.Literal("resize"),
    iconSize: Schema.Int,
    primaryTool: Schema.Literal("magick"),
    fallbackTool: Schema.Literal("convert"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the Linux desktop icon to ${this.iconSize}x${this.iconSize} with \`${this.primaryTool}\` or \`${this.fallbackTool}\`. Install ImageMagick so either tool is available.`;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return `${label} tail:\n${trimmed}`;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

const resolvePythonForNodeGyp = Effect.fn("resolvePythonForNodeGyp")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcess.Platform;
  const env = yield* Config.all({
    configuredPython: Config.String("npm_config_python").pipe(
      Config.orElse(() => Config.String("PYTHON")),
      Config.option,
    ),
    localAppData: Config.String("LOCALAPPDATA").pipe(Config.option),
  });
  const isPython3 = (candidate: string) =>
    spawnAndCollectOutput(
      ChildProcess.make(candidate, [
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)",
      ]),
    ).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );
  const configured = Option.getOrUndefined(env.configuredPython);
  if (configured && (yield* fs.exists(configured)) && (yield* isPython3(configured))) {
    return configured;
  }

  if (hostPlatform === "win32") {
    const localAppData = Option.getOrUndefined(env.localAppData);
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = path.join(localAppData, "Programs", "Python", version, "python.exe");
        if ((yield* fs.exists(candidate)) && (yield* isPython3(candidate))) {
          return candidate;
        }
      }
    }
  }

  const probe = yield* spawnAndCollectOutput(
    ChildProcess.make("python", ["-c", "import sys;print(sys.executable)"]),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (probe.exitCode !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !(yield* fs.exists(executable)) || !(yield* isPython3(executable))) {
    return undefined;
  }

  return executable;
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly updateFeed: DesktopUpdateFeedPlan;
  readonly wslRuntime: string | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly starkcodeCommitHash: string;
  readonly starkcodeWebAuthn?: MacWebAuthnEntitlements;
  /** Read by apps/desktop/src/updates/updateFeedPolicy.ts; see createBakedUpdatePolicy. */
  readonly [BAKED_UPDATE_POLICY_KEY]: BakedUpdatePolicy;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly license: string;
  readonly homepage: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;
export const DESKTOP_ELECTRON_LANGUAGES = ["en-US"] as const;
export const DESKTOP_FILE_EXCLUSIONS = [
  "!apps/desktop/resources/stark-workbench",
  "!apps/desktop/resources/stark-workbench/**/*",
  "!apps/desktop/prod-resources/stark-workbench",
  "!apps/desktop/prod-resources/stark-workbench/**/*",
  // Cursor finds platform assets by walking up from argv[1]. Keep them outside
  // asar so spawning helpers and loading native addons both use real paths.
  "!**/node_modules/@cursor/sdk-*/**/*",
  "!apps/desktop/prod-resources/cursor-sdk",
  "!apps/desktop/prod-resources/cursor-sdk/**/*",
  // Stark Code always passes the user's installed Claude executable to the SDK,
  // so the SDK's optional platform packages (each a ~200MB bundled executable)
  // are dead weight. The trailing dash keeps the SDK's own JS package.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  // Nothing in the packaged app enables source maps or serves them: the web
  // client's maps alone were 50 MB of app.asar that no request ever read.
  "!**/*.map",
  "!**/*.d.cts",
  "!apps/desktop/resources/browser-secret",
  "!apps/desktop/resources/browser-secret/**/*",
  "!apps/desktop/prod-resources/browser-secret",
  "!apps/desktop/prod-resources/browser-secret/**/*",
  "!apps/desktop/prod-resources/dictation",
  "!apps/desktop/prod-resources/dictation/**/*",
  "!apps/desktop/prod-resources/resource-monitor",
  "!apps/desktop/prod-resources/resource-monitor/**/*",
  // Windows stages the server sidecar below prod-resources so electron-builder
  // can copy it using project-relative extraResources matchers. Keep those
  // staging inputs out of app.asar; they are emitted once at resources/.
  "!apps/desktop/prod-resources/windows-server",
  "!apps/desktop/prod-resources/windows-server/**/*",
  "!apps/desktop/prod-resources/wsl-runtime.tar.gz",
  "!apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
  "!apps/desktop/gnome-extension",
  "!apps/desktop/gnome-extension/**/*",
] as const;
// Windows terminal helpers cannot run on macOS and slow signing and notarization.
export const MAC_FILE_EXCLUSIONS = [
  "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
  "!**/node_modules/node-pty/third_party/conpty/**/*",
] as const;
// Linux builds node-pty from source, so every prebuild in the package is for
// another platform (58 MB of it Windows debug symbols).
export const LINUX_FILE_EXCLUSIONS = [
  ...MAC_FILE_EXCLUSIONS,
  "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
] as const;

// node-pty publishes both Darwin prebuilds in one package. Single-architecture
// apps only need the native target; universal apps need both. An omitted arch
// preserves the existing common exclusions for callers that only inspect the
// generic platform config.
export function resolveMacFileExclusions(arch?: typeof BuildArch.Type) {
  if (arch === undefined || arch === "universal") {
    return [...MAC_FILE_EXCLUSIONS];
  }

  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  return [...MAC_FILE_EXCLUSIONS, `!**/node_modules/node-pty/prebuilds/darwin-${unusedArch}/**/*`];
}
// Windows ships the server tree (bundle + node_modules) as a separate
// resources/server.asar sidecar instead of loose files: the NSIS installer
// then extracts a handful of large archives instead of thousands of small
// files, which dominates install (and update) time. The Windows primary runs
// the server from inside server.asar via the asar-aware ELECTRON_RUN_AS_NODE
// runtime. WSL does not use this sidecar: it runs the Linux CLI archive
// embedded as resources/wsl-runtime.tar.gz (see WSL_RUNTIME_ARCHIVE_NAME).
export const WINDOWS_SERVER_ASAR_RESOURCE = "server.asar";
// dlopen/spawn need real files, so native modules, shared libraries, and
// helper executables live in each archive's .unpacked sibling (the standard
// asar redirect convention). Everything else stays packed.
export const WINDOWS_NATIVE_ASAR_UNPACK_GLOB =
  "{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}";
// The server sidecar unpacks .node files separately, keeping only Windows ones.
export const WINDOWS_SERVER_ASAR_UNPACK_GLOBS = [
  "**/*.dll",
  "**/*.exe",
  "**/*.so",
  "**/*.so.*",
  "**/*.dylib",
] as const;
// Mirrors DESKTOP_FILE_EXCLUSIONS for the hand-packed sidecar: the Claude SDK
// platform packages are dead weight (see above), and node_modules/.bin shims
// are never spawned at runtime (and are symlinks on POSIX build hosts, which
// the asar extraction path deliberately does not support).
export const WINDOWS_SERVER_ASAR_IGNORE_GLOBS = [
  "**/node_modules/@cursor/sdk-*",
  "**/node_modules/@cursor/sdk-*/**",
  "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
  "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  "**/node_modules/.bin",
  "**/node_modules/.bin/**",
  "**/*.map",
] as const;

export function resolveWindowsServerAsarIgnoreGlobs(arch: typeof BuildArch.Type) {
  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  const unusedPrebuild = `**/node_modules/node-pty/prebuilds/win32-${unusedArch}`;
  const unusedConpty = `**/node_modules/node-pty/third_party/conpty/*/win10-${unusedArch}`;

  return [
    ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
    unusedPrebuild,
    `${unusedPrebuild}/**`,
    unusedConpty,
    `${unusedConpty}/**`,
  ];
}

export const WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT = 80;
export const WINDOWS_SERVER_RESOURCE_SOURCE_DIR = "apps/desktop/prod-resources/windows-server";
export const WINDOWS_SERVER_EXTRA_RESOURCES = [
  {
    // Copy the archive and its .unpacked sibling from one parent directory.
    // Mapping the .unpacked directory as an independent FileSet silently
    // omitted it from Windows packages even though electron-builder copied
    // the adjacent archive.
    from: WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
    to: ".",
    filter: [WINDOWS_SERVER_ASAR_RESOURCE, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked/**/*`],
  },
] as const;
export const WSL_RUNTIME_ARCHIVE_NAME = "wsl-runtime.tar.gz";
export const WSL_RUNTIME_ARCHIVE_HASH_NAME = `${WSL_RUNTIME_ARCHIVE_NAME}.sha256`;
export const WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${WSL_RUNTIME_ARCHIVE_NAME}`,
  to: WSL_RUNTIME_ARCHIVE_NAME,
} as const;
export const WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${WSL_RUNTIME_ARCHIVE_HASH_NAME}`,
  to: WSL_RUNTIME_ARCHIVE_HASH_NAME,
} as const;

// The WSL runtime is the Linux CLI release archive (stark-<version>-linux-<arch>
// .tar.gz, built by scripts/build-cli-archive.ts) copied in verbatim, so WSL
// runs the exact bytes a Linux user downloads. This one predicate decides both
// whether the archive is staged and whether the packaging config ships it:
// listing an extraResource whose source was never written fails electron-builder.
export const bundlesWslRuntime = (input: {
  readonly platform: typeof BuildPlatform.Type;
  readonly runtimeArchivePath: string | undefined;
}): boolean => input.platform === "win" && input.runtimeArchivePath !== undefined;

export const WSL_RUNTIME_EXTRA_RESOURCES = [
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
] as const;
export const DESKTOP_EXTRA_RESOURCES = [
  { from: "apps/desktop/resources/browser-capture-host.cjs", to: "browser-capture-host.cjs" },
  {
    // electron-builder drops node_modules directly under a resource's `from`.
    // Copy from the parent so the kit's materialized runtime dependencies stay nested.
    from: "apps/desktop/prod-resources",
    to: ".",
    filter: ["stark-workbench/**/*", "stark-workbench/**/.*", "stark-workbench/**/.*/**/*"],
  },
  {
    from: "apps/desktop/prod-resources/cursor-sdk",
    to: "node_modules/@cursor",
  },
  {
    from: "apps/desktop/prod-resources/resource-monitor",
    to: "resource-monitor",
  },
] as const;

export class PackagedStarkWorkbenchMissingError extends Schema.TaggedError<PackagedStarkWorkbenchMissingError>()(
  "PackagedStarkWorkbenchMissingError",
  { stageDistDir: Schema.String },
) {
  override get message(): string {
    return `No packaged Stark Workbench resource was found under ${this.stageDistDir}.`;
  }
}

/** Check the actual payload, not the staging tree that electron-builder filters. */
export const validatePackagedStarkWorkbench = Effect.fn("validatePackagedStarkWorkbench")(
  function* (input: {
    readonly stageDistDir: string;
    readonly platform: typeof BuildPlatform.Type;
    readonly productName: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const roots: string[] = [];
    for (const entry of yield* fs.readDirectory(input.stageDistDir)) {
      if (input.platform === "mac" ? !entry.startsWith("mac") : !entry.endsWith("-unpacked"))
        continue;
      const output = path.join(input.stageDistDir, entry);
      if ((yield* fs.stat(output)).type !== "Directory") continue;
      const resources =
        input.platform === "mac"
          ? path.join(output, `${input.productName}.app`, "Contents", "Resources")
          : path.join(output, "resources");
      roots.push(yield* validateStarkWorkbenchRoot(path.join(resources, "stark-workbench")));
    }
    if (roots.length === 0)
      return yield* new PackagedStarkWorkbenchMissingError({ stageDistDir: input.stageDistDir });
    return roots;
  },
);
export const LINUX_CAPTURE_EXTRA_RESOURCES = [
  {
    from: "apps/desktop/prod-resources/hyprland-capture",
    to: "hyprland-capture",
  },
  {
    from: "apps/desktop/prod-resources/kde-capture",
    to: "kde-capture",
  },
  {
    from: "apps/desktop/gnome-extension",
    to: "gnome-extension",
    filter: gnomeCaptureBundle.files,
  },
] as const;
export const LINUX_BROWSER_SECRET_EXTRA_RESOURCES = [
  { from: "apps/desktop/prod-resources/browser-secret", to: "browser-secret" },
] as const;
export const MAC_DICTATION_EXTRA_RESOURCES = [
  { from: "apps/desktop/prod-resources/dictation", to: "dictation" },
] as const;

export interface MacPasskeySigningConfiguration {
  readonly appId: string;
  readonly teamId: string;
  readonly rpDomains: readonly string[];
  readonly provisioningProfilePath: string;
}

export const InvalidMacPasskeyRpDomainReason = Schema.Literals([
  "empty",
  "scheme-not-allowed",
  "parse-failed",
  "credentials-not-allowed",
  "port-not-allowed",
  "path-not-allowed",
  "query-not-allowed",
  "fragment-not-allowed",
  "hostname-mismatch",
]);
export type InvalidMacPasskeyRpDomainReason = typeof InvalidMacPasskeyRpDomainReason.Type;

export class InvalidMacPasskeyRpDomainError extends Schema.TaggedError<InvalidMacPasskeyRpDomainError>()(
  "InvalidMacPasskeyRpDomainError",
  {
    reason: InvalidMacPasskeyRpDomainReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid passkey RP domain (${this.reason}).`;
  }
}

export class InvalidAppleTeamIdError extends Schema.TaggedError<InvalidAppleTeamIdError>()(
  "InvalidAppleTeamIdError",
  {
    teamId: Schema.String,
  },
) {
  override get message(): string {
    return `STARK_CODE_APPLE_TEAM_ID '${this.teamId}' must be a 10-character Apple Developer Team ID.`;
  }
}

export class MissingMacPasskeyProvisioningProfileError extends Schema.TaggedError<MissingMacPasskeyProvisioningProfileError>()(
  "MissingMacPasskeyProvisioningProfileError",
  {},
) {
  override get message(): string {
    return "STARK_CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.";
  }
}

export class MissingMacPasskeyDomainConfigurationError extends Schema.TaggedError<MissingMacPasskeyDomainConfigurationError>()(
  "MissingMacPasskeyDomainConfigurationError",
  {},
) {
  override get message(): string {
    return "STARK_CODE_CLERK_PUBLISHABLE_KEY or STARK_CODE_CLERK_PASSKEY_RP_DOMAINS is required for signed macOS passkey builds.";
  }
}

export class InvalidMacPasskeyPublishableKeyError extends Schema.TaggedError<InvalidMacPasskeyPublishableKeyError>()(
  "InvalidMacPasskeyPublishableKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "STARK_CODE_CLERK_PUBLISHABLE_KEY is invalid.";
  }
}

export class MissingMacPasskeyRpDomainError extends Schema.TaggedError<MissingMacPasskeyRpDomainError>()(
  "MissingMacPasskeyRpDomainError",
  {},
) {
  override get message(): string {
    return "At least one Clerk passkey RP domain is required.";
  }
}

export const MacPasskeySigningConfigurationError = Schema.Union([
  InvalidMacPasskeyRpDomainError,
  InvalidAppleTeamIdError,
  MissingMacPasskeyProvisioningProfileError,
  MissingMacPasskeyDomainConfigurationError,
  InvalidMacPasskeyPublishableKeyError,
  MissingMacPasskeyRpDomainError,
]);
export type MacPasskeySigningConfigurationError = typeof MacPasskeySigningConfigurationError.Type;
export const isMacPasskeySigningConfigurationError = Schema.is(MacPasskeySigningConfigurationError);

function normalizePasskeyRpDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  const inputLength = value.length;
  if (normalized.length === 0) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "empty", inputLength });
  }
  if (/^[a-z][a-z\d+.-]*:\/\//u.test(normalized)) {
    throw new InvalidMacPasskeyRpDomainError({
      reason: "scheme-not-allowed",
      inputLength,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch (cause) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "parse-failed", inputLength, cause });
  }

  let reason: InvalidMacPasskeyRpDomainReason | undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    reason = "credentials-not-allowed";
  } else if (parsed.port.length > 0) {
    reason = "port-not-allowed";
  } else if (parsed.pathname !== "/") {
    reason = "path-not-allowed";
  } else if (parsed.search.length > 0) {
    reason = "query-not-allowed";
  } else if (parsed.hash.length > 0) {
    reason = "fragment-not-allowed";
  } else if (parsed.host !== normalized) {
    reason = "hostname-mismatch";
  }
  if (reason) {
    throw new InvalidMacPasskeyRpDomainError({ reason, inputLength });
  }

  return parsed.hostname;
}

export function resolveMacPasskeySigningConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): MacPasskeySigningConfiguration {
  const teamId = env.STARK_CODE_APPLE_TEAM_ID?.trim().toUpperCase() ?? "";
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new InvalidAppleTeamIdError({ teamId });
  }

  const provisioningProfilePath = env.STARK_CODE_MACOS_PROVISIONING_PROFILE?.trim() ?? "";
  if (provisioningProfilePath.length === 0) {
    throw new MissingMacPasskeyProvisioningProfileError();
  }

  const configuredRpDomains = env.STARK_CODE_CLERK_PASSKEY_RP_DOMAINS?.trim();
  let rpDomains: readonly string[];
  if (configuredRpDomains) {
    rpDomains = configuredRpDomains.split(",").map(normalizePasskeyRpDomain);
  } else {
    const publishableKey = env.STARK_CODE_CLERK_PUBLISHABLE_KEY?.trim();
    if (!publishableKey) {
      throw new MissingMacPasskeyDomainConfigurationError();
    }
    let hostname: string;
    try {
      hostname = clerkFrontendApiHostnameFromPublishableKey(publishableKey);
    } catch (cause) {
      throw new InvalidMacPasskeyPublishableKeyError({ cause });
    }
    rpDomains = [normalizePasskeyRpDomain(hostname)];
  }

  const uniqueRpDomains = [...new Set(rpDomains)];
  if (uniqueRpDomains.length === 0) {
    throw new MissingMacPasskeyRpDomainError();
  }

  return {
    appId: DESKTOP_APP_ID,
    teamId,
    rpDomains: uniqueRpDomains,
    provisioningProfilePath,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Passkey entitlements for the in-app browser. Each is granted only when the
 * provisioning profile authorizes it: macOS refuses to launch an app that
 * claims a restricted entitlement its embedded profile does not carry.
 */
export interface MacWebAuthnEntitlements {
  /** Keychain group for Electron's Touch ID passkeys. */
  readonly touchIdKeychainAccessGroup: string | undefined;
  /** Apple's managed browser entitlement, which allows passkeys for any site. */
  readonly browserPasskeys: boolean;
}

const BROWSER_PASSKEYS_ENTITLEMENT = "com.apple.developer.web-browser.public-key-credential";

const ProvisioningProfilePlist = Schema.Struct({
  Entitlements: Schema.Struct({
    "keychain-access-groups": Schema.optional(Schema.Array(Schema.String)),
    [BROWSER_PASSKEYS_ENTITLEMENT]: Schema.optional(Schema.Boolean),
  }),
});
const isProvisioningProfilePlist = Schema.is(ProvisioningProfilePlist);

/**
 * Reads the Entitlements dict of the XML plist a provisioning profile wraps in
 * its CMS envelope. Anything unreadable grants nothing.
 */
const readProfileEntitlements = (provisioningProfile: string) => {
  const start = provisioningProfile.indexOf("<?xml");
  const end = provisioningProfile.indexOf("</plist>", start);
  if (start === -1 || end === -1) return undefined;
  try {
    const profile: unknown = Plist.parse(provisioningProfile.slice(start, end + "</plist>".length));
    return isProvisioningProfilePlist(profile) ? profile.Entitlements : undefined;
  } catch {
    return undefined;
  }
};

export function resolveMacWebAuthnEntitlements(
  provisioningProfile: string,
  configuration: Pick<MacPasskeySigningConfiguration, "appId" | "teamId">,
): MacWebAuthnEntitlements {
  const entitlements = readProfileEntitlements(provisioningProfile);
  const keychainAccessGroup = `${configuration.teamId}.${configuration.appId}.webauthn`;
  const keychainGroupAuthorized = (entitlements?.["keychain-access-groups"] ?? []).some((group) =>
    group.endsWith("*")
      ? keychainAccessGroup.startsWith(group.slice(0, -1))
      : group === keychainAccessGroup,
  );
  return {
    touchIdKeychainAccessGroup: keychainGroupAuthorized ? keychainAccessGroup : undefined,
    browserPasskeys: entitlements?.[BROWSER_PASSKEYS_ENTITLEMENT] === true,
  };
}

export function renderMacPasskeyEntitlements(
  configuration: MacPasskeySigningConfiguration,
  webAuthn: MacWebAuthnEntitlements,
): string {
  const associatedDomains = configuration.rpDomains
    .map((domain) => `      <string>webcredentials:${escapeXml(domain)}</string>`)
    .join("\n");
  const keychainAccessGroups = webAuthn.touchIdKeychainAccessGroup
    ? `
    <key>keychain-access-groups</key>
    <array>
      <string>${escapeXml(webAuthn.touchIdKeychainAccessGroup)}</string>
    </array>`
    : "";
  const browserPasskeys = webAuthn.browserPasskeys
    ? `
    <key>${BROWSER_PASSKEYS_ENTITLEMENT}</key>
    <true/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.application-identifier</key>
    <string>${escapeXml(`${configuration.teamId}.${configuration.appId}`)}</string>
    <key>com.apple.developer.team-identifier</key>
    <string>${escapeXml(configuration.teamId)}</string>
    <key>com.apple.developer.associated-domains</key>
    <array>
${associatedDomains}
    </array>${keychainAccessGroups}${browserPasskeys}
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
  </dict>
</plist>
`;
}

/**
 * Hardened-runtime entitlements for signed macOS builds that carry no passkey
 * provisioning profile. Staged with the rest of `apps/desktop/resources`.
 */
export const MAC_ENTITLEMENTS_FILE_NAME = "entitlements.mac.plist";

/**
 * How a macOS build is signed. `unsigned` is the local default. `development`
 * signs with an Apple Development certificate and is never notarized, so two
 * local builds can rehearse an update. `developer-id` signs with Developer ID,
 * notarizes and staples, which is the only mode another Mac opens without an
 * override.
 */
const MacSigningMode = Schema.Literals(["unsigned", "development", "developer-id"]);
export type MacSigningMode = typeof MacSigningMode.Type;
const MacSignedMode = Schema.Literals(["development", "developer-id"]);
export type MacSignedMode = typeof MacSignedMode.Type;
const isMacSignedMode = Schema.is(MacSignedMode);

const MacSigningCredentialSet = Schema.Literals([
  "certificate-file",
  "keychain",
  "api-key",
  "apple-id",
  "keychain-profile",
]);
export type MacSigningCredentialSet = typeof MacSigningCredentialSet.Type;
export type MacSigningIdentitySource = Extract<
  MacSigningCredentialSet,
  "certificate-file" | "keychain"
>;
export type MacNotarizationCredential = Extract<
  MacSigningCredentialSet,
  "api-key" | "apple-id" | "keychain-profile"
>;

// `triggers` are the variables whose presence selects a set; every `required`
// variable must then be present too. electron-builder picks the first set it
// finds in its own order, so the build insists on exactly one.
const MAC_SIGNING_CREDENTIAL_SETS: Record<
  MacSigningCredentialSet,
  {
    readonly label: string;
    readonly required: ReadonlyArray<string>;
    readonly triggers: ReadonlyArray<string>;
  }
> = {
  "certificate-file": {
    label: "certificate file",
    required: ["CSC_LINK", "CSC_KEY_PASSWORD"],
    triggers: ["CSC_LINK", "CSC_KEY_PASSWORD"],
  },
  keychain: { label: "keychain certificate", required: ["CSC_NAME"], triggers: ["CSC_NAME"] },
  "api-key": {
    label: "App Store Connect API key",
    required: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    triggers: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
  },
  // APPLE_TEAM_ID alone does not select this set: it also names the team a
  // Developer ID signature must carry.
  "apple-id": {
    label: "Apple ID",
    required: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    triggers: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"],
  },
  "keychain-profile": {
    label: "notarytool keychain profile",
    required: ["APPLE_KEYCHAIN_PROFILE"],
    triggers: ["APPLE_KEYCHAIN_PROFILE", "APPLE_KEYCHAIN"],
  },
};

const describeMacSigningCredentialSet = (set: MacSigningCredentialSet) =>
  `the ${MAC_SIGNING_CREDENTIAL_SETS[set].label} (${MAC_SIGNING_CREDENTIAL_SETS[set].required.join(", ")})`;

export class InvalidMacSigningModeError extends Schema.TaggedError<InvalidMacSigningModeError>()(
  "InvalidMacSigningModeError",
  {
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  },
) {
  override get message(): string {
    return "STARK_CODE_MACOS_SIGNING_MODE must be `development` or `developer-id`.";
  }
}

export class MacSigningModeRequiresSignedBuildError extends Schema.TaggedError<MacSigningModeRequiresSignedBuildError>()(
  "MacSigningModeRequiresSignedBuildError",
  {},
) {
  override get message(): string {
    return "STARK_CODE_MACOS_SIGNING_MODE only applies to --signed builds. Add --signed, or unset it for an unsigned build.";
  }
}

export class MissingMacSigningIdentityError extends Schema.TaggedError<MissingMacSigningIdentityError>()(
  "MissingMacSigningIdentityError",
  {},
) {
  override get message(): string {
    return "A signed macOS build needs CSC_LINK and CSC_KEY_PASSWORD (a .p12 export of the certificate with its private key), or CSC_NAME (a certificate in the login keychain).";
  }
}

export class MissingMacNotarizationCredentialsError extends Schema.TaggedError<MissingMacNotarizationCredentialsError>()(
  "MissingMacNotarizationCredentialsError",
  {},
) {
  override get message(): string {
    return "A developer-id build is notarized and needs one credential set: APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER; or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID; or APPLE_KEYCHAIN_PROFILE. For a local rehearsal that is never notarized, set STARK_CODE_MACOS_SIGNING_MODE=development.";
  }
}

export class IncompleteMacSigningCredentialsError extends Schema.TaggedError<IncompleteMacSigningCredentialsError>()(
  "IncompleteMacSigningCredentialsError",
  {
    credentialSet: MacSigningCredentialSet,
    missing: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Incomplete ${MAC_SIGNING_CREDENTIAL_SETS[this.credentialSet].label} credentials: also set ${this.missing.join(", ")}.`;
  }
}

export class ConflictingMacSigningCredentialsError extends Schema.TaggedError<ConflictingMacSigningCredentialsError>()(
  "ConflictingMacSigningCredentialsError",
  {
    credentialSets: Schema.Array(MacSigningCredentialSet),
  },
) {
  override get message(): string {
    return `Set exactly one of ${this.credentialSets.map(describeMacSigningCredentialSet).join(" and ")}; unset the others.`;
  }
}

export class InvalidMacSigningIdentityNameError extends Schema.TaggedError<InvalidMacSigningIdentityNameError>()(
  "InvalidMacSigningIdentityNameError",
  {},
) {
  override get message(): string {
    return "CSC_NAME must not start with a certificate type such as `Developer ID Application:`. Use the rest of the certificate name, or its SHA-1.";
  }
}

export class InvalidMacSigningTeamIdError extends Schema.TaggedError<InvalidMacSigningTeamIdError>()(
  "InvalidMacSigningTeamIdError",
  {},
) {
  override get message(): string {
    return "APPLE_TEAM_ID must be a 10-character Apple Developer Team ID.";
  }
}

/**
 * What a macOS build signs with. It holds no credential values: the
 * notarization step reads them from the environment when it runs, so the plan
 * can be logged and recorded in the release proof.
 */
export interface MacSigningPlan {
  readonly mode: MacSigningMode;
  readonly identitySource: MacSigningIdentitySource | undefined;
  /** The `CSC_NAME` qualifier electron-builder matches login keychain identities against. */
  readonly keychainIdentity: string | undefined;
  readonly notarization: MacNotarizationCredential | undefined;
  /** `APPLE_TEAM_ID`, which a Developer ID signature must carry when set. */
  readonly expectedTeamId: string | undefined;
}

// electron-builder (macCodeSign.appleCertificatePrefixes) refuses these as a
// CSC_NAME prefix and skips them when it falls back to a "non-Apple" identity.
const ELECTRON_BUILDER_APPLE_CERTIFICATE_PREFIXES = [
  "Developer ID Application:",
  "Developer ID Installer:",
  "3rd Party Mac Developer Application:",
  "3rd Party Mac Developer Installer:",
] as const;

const selectMacSigningCredentialSet = <S extends MacSigningCredentialSet>(
  candidates: ReadonlyArray<S>,
  isSet: (name: string) => boolean,
) =>
  Effect.gen(function* () {
    const present = candidates.filter((set) =>
      MAC_SIGNING_CREDENTIAL_SETS[set].triggers.some(isSet),
    );
    if (present.length > 1) {
      return yield* new ConflictingMacSigningCredentialsError({ credentialSets: present });
    }
    const [selected] = present;
    if (selected === undefined) return undefined;
    const missing = MAC_SIGNING_CREDENTIAL_SETS[selected].required.filter((name) => !isSet(name));
    if (missing.length > 0) {
      return yield* new IncompleteMacSigningCredentialsError({ credentialSet: selected, missing });
    }
    return selected;
  });

/**
 * Validates macOS signing before anything is built, so a missing or partial
 * credential fails in seconds instead of after packaging. Credentials come only
 * from the process environment and the login keychain; repo `.env` files are
 * not read, because worktree setup links them into every worktree. Errors name
 * variables, never their values.
 */
export const resolveMacSigningPlan = Effect.fn("resolveMacSigningPlan")(function* (input: {
  readonly signed: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}) {
  const read = (name: string) => input.env[name]?.trim() ?? "";
  const isSet = (name: string) => read(name).length > 0;
  const configuredMode = read("STARK_CODE_MACOS_SIGNING_MODE");
  if (!input.signed) {
    if (configuredMode) return yield* new MacSigningModeRequiresSignedBuildError();
    const unsigned: MacSigningPlan = {
      mode: "unsigned",
      identitySource: undefined,
      keychainIdentity: undefined,
      notarization: undefined,
      expectedTeamId: undefined,
    };
    return unsigned;
  }

  const mode = configuredMode || "developer-id";
  if (!isMacSignedMode(mode)) {
    return yield* new InvalidMacSigningModeError({ inputLength: configuredMode.length });
  }

  const identitySource = yield* selectMacSigningCredentialSet(
    ["certificate-file", "keychain"] as const,
    isSet,
  );
  if (identitySource === undefined) return yield* new MissingMacSigningIdentityError();
  const keychainIdentity = identitySource === "keychain" ? read("CSC_NAME") : undefined;
  if (
    keychainIdentity !== undefined &&
    ELECTRON_BUILDER_APPLE_CERTIFICATE_PREFIXES.some((prefix) =>
      keychainIdentity.startsWith(prefix),
    )
  ) {
    return yield* new InvalidMacSigningIdentityNameError();
  }

  if (mode === "development") {
    const development: MacSigningPlan = {
      mode,
      identitySource,
      keychainIdentity,
      notarization: undefined,
      expectedTeamId: undefined,
    };
    return development;
  }

  const notarization = yield* selectMacSigningCredentialSet(
    ["api-key", "apple-id", "keychain-profile"] as const,
    isSet,
  );
  if (notarization === undefined) return yield* new MissingMacNotarizationCredentialsError();
  const teamId = read("APPLE_TEAM_ID").toUpperCase();
  if (teamId && !APPLE_TEAM_ID_PATTERN.test(teamId)) {
    return yield* new InvalidMacSigningTeamIdError();
  }
  const developerId: MacSigningPlan = {
    mode,
    identitySource,
    keychainIdentity,
    notarization,
    expectedTeamId: teamId || undefined,
  };
  return developerId;
});

const MAC_NOTARIZATION_ENV_KEYS = [
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
] as const;
const SIGNING_IDENTITY_ENV_KEYS = ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME"] as const;

/**
 * Drops the credentials a build must not use from the electron-builder
 * environment. electron-builder signs whenever CSC_NAME names a keychain
 * certificate and notarizes whenever an Apple credential set is present,
 * whatever --signed says, so an unsigned build drops all of them and a
 * development build drops the notarization ones.
 */
export function removeUnusedSigningCredentials(
  env: Readonly<Record<string, string | undefined>>,
  input: { readonly signed: boolean; readonly macSigningMode: MacSigningMode | undefined },
): Record<string, string | undefined> {
  const next = { ...env };
  const removed: ReadonlyArray<string> = !input.signed
    ? [...SIGNING_IDENTITY_ENV_KEYS, ...MAC_NOTARIZATION_ENV_KEYS]
    : input.macSigningMode === "development"
      ? MAC_NOTARIZATION_ENV_KEYS
      : [];
  for (const key of removed) delete next[key];
  if (!input.signed) next.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return next;
}

/** A passkey build is opted into by pointing at its provisioning profile. */
export function isMacPasskeySigningRequested(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (env.STARK_CODE_MACOS_PROVISIONING_PROFILE?.trim() ?? "").length > 0;
}

export interface MacSigningIdentity {
  readonly hash: string;
  readonly name: string;
}

/**
 * Lists signing identities the way electron-builder 26 does: the Apple
 * certificate types from `security find-identity -v`, then every
 * `security find-identity -v -p codesigning` line, unnumbered and deduplicated.
 */
export function parseMacSigningIdentities(
  allIdentities: string,
  codesigningIdentities: string,
): ReadonlyArray<string> {
  const appleCertificates = allIdentities
    .trim()
    .split("\n")
    .filter((line) =>
      ELECTRON_BUILDER_APPLE_CERTIFICATE_PREFIXES.some((prefix) => line.includes(prefix)),
    );
  const lines = [...appleCertificates, ...codesigningIdentities.trim().split("\n")]
    .filter(
      (line) =>
        !line.includes("(Missing required extension)") &&
        !line.includes("valid identities found") &&
        !line.includes("iPhone ") &&
        !line.includes("com.apple.idms.appleid.prd."),
    )
    .map((line) => line.slice(line.indexOf(")") + 1).trim())
    .filter((line) => line.length > 0);
  return [...new Set(lines)];
}

function parseMacSigningIdentityLine(line: string): MacSigningIdentity {
  const firstQuote = line.indexOf('"');
  return {
    hash: line.slice(0, firstQuote - 1),
    name: line.slice(firstQuote + 1, line.lastIndexOf('"')),
  };
}

function findMacSigningIdentityOfType(
  identities: ReadonlyArray<string>,
  certificateType: string,
  qualifier: string,
): MacSigningIdentity | undefined {
  const candidates = identities.filter((line) => line.includes(qualifier));
  const typed = candidates.find((line) => line.includes(`${certificateType}:`));
  if (typed !== undefined) return parseMacSigningIdentityLine(typed);
  if (certificateType !== "Developer ID Application") return undefined;
  const nonApple = candidates.find(
    (line) =>
      !line.includes("Mac Developer:") &&
      !ELECTRON_BUILDER_APPLE_CERTIFICATE_PREFIXES.some((prefix) => line.includes(prefix)),
  );
  return nonApple === undefined ? undefined : parseMacSigningIdentityLine(nonApple);
}

/**
 * The identity electron-builder 26 picks for a non-MAS build signed with
 * CSC_NAME (MacTargetHelper.getCertificateTypes and macCodeSign._findIdentity).
 * Its development search order is "Mac Developer" then "Developer ID
 * Application", and an "Apple Development" certificate is only reached through
 * the non-Apple fallback. A CSC_NAME matching both a Developer ID and a
 * development certificate therefore signs a development build with Developer
 * ID, and a Developer ID build falls back to a development certificate when no
 * Developer ID certificate matches.
 */
export function selectMacSigningIdentity(
  identities: ReadonlyArray<string>,
  mode: MacSignedMode,
  qualifier: string,
): MacSigningIdentity | undefined {
  const certificateTypes =
    mode === "development"
      ? ["Mac Developer", "Developer ID Application"]
      : ["Developer ID Application"];
  for (const certificateType of certificateTypes) {
    const identity = findMacSigningIdentityOfType(identities, certificateType, qualifier);
    if (identity !== undefined) return identity;
  }
  return undefined;
}

const MacSigningCertificateKind = Schema.Literals(["developer-id", "development", "other"]);
export type MacSigningCertificateKind = typeof MacSigningCertificateKind.Type;

export function classifyMacSigningCertificate(name: string): MacSigningCertificateKind {
  if (name.startsWith("Developer ID Application:")) return "developer-id";
  if (name.startsWith("Apple Development:") || name.startsWith("Mac Developer:")) {
    return "development";
  }
  return "other";
}

const describeMacSigningCertificateKind = (kind: MacSigningCertificateKind) =>
  kind === "developer-id"
    ? "a Developer ID Application certificate"
    : kind === "development"
      ? "an Apple Development certificate"
      : "a certificate that is neither Developer ID Application nor Apple Development";

export class MacSigningIdentityNotFoundError extends Schema.TaggedError<MacSigningIdentityNotFoundError>()(
  "MacSigningIdentityNotFoundError",
  {},
) {
  override get message(): string {
    return "No valid signing certificate in the login keychain matches CSC_NAME. List them with `security find-identity -v -p codesigning`.";
  }
}

export class MacSigningIdentityMismatchError extends Schema.TaggedError<MacSigningIdentityMismatchError>()(
  "MacSigningIdentityMismatchError",
  {
    mode: MacSignedMode,
    selectedKind: MacSigningCertificateKind,
  },
) {
  override get message(): string {
    return `electron-builder would sign this ${this.mode} build with ${describeMacSigningCertificateKind(this.selectedKind)}. Set CSC_NAME to the SHA-1 of ${describeMacSigningCertificateKind(this.mode)} from \`security find-identity -v -p codesigning\`.`;
  }
}

/** Parsed `codesign --display --verbose=2` output, which codesign writes to stderr. */
export interface MacCodeSignature {
  /** Leaf first, then its issuers. Empty for ad-hoc or missing signatures. */
  readonly authorities: ReadonlyArray<string>;
  readonly teamIdentifier: string | undefined;
  readonly hardenedRuntime: boolean;
  /** A secure timestamp from Apple, which notarization requires. */
  readonly timestamped: boolean;
}

const MAC_HARDENED_RUNTIME_FLAG = 0x10000n;

export function parseMacCodeSignature(output: string): MacCodeSignature {
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  const valueOf = (key: string) =>
    lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const teamIdentifier = valueOf("TeamIdentifier");
  const flags = /^CodeDirectory\b[^\r\n]*\bflags=(0x[\da-f]+)\b/imu.exec(output)?.[1];
  return {
    authorities: lines
      .filter((line) => line.startsWith("Authority="))
      .map((line) => line.slice("Authority=".length)),
    teamIdentifier: teamIdentifier && teamIdentifier !== "not set" ? teamIdentifier : undefined,
    hardenedRuntime: flags !== undefined && (BigInt(flags) & MAC_HARDENED_RUNTIME_FLAG) !== 0n,
    timestamped: valueOf("Timestamp") !== undefined,
  };
}

/** Parsed `spctl --assess --verbose=2` output, which spctl writes to stderr. */
export interface GatekeeperAssessment {
  readonly accepted: boolean;
  readonly source: string | undefined;
}

export const NOTARIZED_DEVELOPER_ID_SOURCE = "Notarized Developer ID";

export function parseGatekeeperAssessment(output: string): GatekeeperAssessment {
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  return {
    accepted: lines.some((line) => line.endsWith(": accepted")),
    source: lines.find((line) => line.startsWith("source="))?.slice("source=".length),
  };
}

export function isGatekeeperNotarized(assessment: GatekeeperAssessment | undefined): boolean {
  return assessment?.accepted === true && assessment.source === NOTARIZED_DEVELOPER_ID_SOURCE;
}

/** `xcrun stapler validate` reports success on stdout and exits 0. */
export function isStaplerValidation(result: {
  readonly exitCode: number;
  readonly stdout: string;
}): boolean {
  return result.exitCode === 0 && result.stdout.includes("The validate action worked!");
}

const NotarySubmission = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
const decodeNotarySubmission = Schema.decodeUnknownOption(Schema.fromJsonString(NotarySubmission));

/** Reads `xcrun notarytool submit --wait --output-format json`. */
export function parseNotarySubmission(output: string): {
  readonly id: string | undefined;
  readonly status: string | undefined;
} {
  const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  const submission = Option.getOrUndefined(decodeNotarySubmission(json));
  return { id: submission?.id, status: submission?.status };
}

const MacReleaseCheck = Schema.Literals([
  "signature-invalid",
  "unexpected-certificate",
  "unexpected-identity",
  "team-mismatch",
  "hardened-runtime-missing",
  "timestamp-missing",
  "not-stapled",
  "gatekeeper-rejected",
  "notarization-rejected",
]);
export type MacReleaseCheck = typeof MacReleaseCheck.Type;

/**
 * The checks a signed app must pass for its mode. A development rehearsal is
 * held to a valid, hardened Apple Development signature only; it is never
 * required to be timestamped, stapled or accepted as Notarized Developer ID.
 */
export function findMacAppVerificationFailures(input: {
  readonly mode: MacSignedMode;
  readonly expectedIdentityName: string | undefined;
  readonly expectedTeamId: string | undefined;
  readonly signatureValid: boolean;
  readonly signature: MacCodeSignature;
  readonly stapled: boolean | undefined;
  readonly gatekeeper: GatekeeperAssessment | undefined;
}): ReadonlyArray<MacReleaseCheck> {
  const failures: MacReleaseCheck[] = [];
  const leaf = input.signature.authorities[0];
  if (!input.signatureValid) failures.push("signature-invalid");
  if (leaf === undefined || classifyMacSigningCertificate(leaf) !== input.mode) {
    failures.push("unexpected-certificate");
  }
  if (input.expectedIdentityName !== undefined && leaf !== input.expectedIdentityName) {
    failures.push("unexpected-identity");
  }
  if (
    input.expectedTeamId !== undefined &&
    input.signature.teamIdentifier !== input.expectedTeamId
  ) {
    failures.push("team-mismatch");
  }
  if (!input.signature.hardenedRuntime) failures.push("hardened-runtime-missing");
  if (input.mode === "developer-id") {
    if (!input.signature.timestamped) failures.push("timestamp-missing");
    if (input.stapled !== true) failures.push("not-stapled");
    if (!isGatekeeperNotarized(input.gatekeeper)) failures.push("gatekeeper-rejected");
  }
  return failures;
}

const describeMacReleaseCheck = (check: MacReleaseCheck, mode: MacSignedMode) => {
  switch (check) {
    case "signature-invalid":
      return "codesign --verify --deep --strict rejects the signature";
    case "unexpected-certificate":
      return `it is not signed with ${describeMacSigningCertificateKind(mode)}`;
    case "unexpected-identity":
      return "it is signed by a different certificate than CSC_NAME selected";
    case "team-mismatch":
      return "its TeamIdentifier is not APPLE_TEAM_ID";
    case "hardened-runtime-missing":
      return "hardened runtime is off";
    case "timestamp-missing":
      return "the signature has no secure timestamp";
    case "not-stapled":
      return "no notarization ticket is stapled";
    case "gatekeeper-rejected":
      return `Gatekeeper does not accept it as ${NOTARIZED_DEVELOPER_ID_SOURCE}`;
    case "notarization-rejected":
      return "Apple's notary service did not accept it";
  }
};

export class MacReleaseVerificationError extends Schema.TaggedError<MacReleaseVerificationError>()(
  "MacReleaseVerificationError",
  {
    artifact: Schema.Literals(["app", "dmg"]),
    mode: MacSignedMode,
    failures: Schema.Array(MacReleaseCheck),
    notarySubmissionId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const details = this.failures.map((check) => describeMacReleaseCheck(check, this.mode));
    const log = this.notarySubmissionId
      ? ` Read Apple's report with \`xcrun notarytool log ${this.notarySubmissionId}\` and the same credentials.`
      : "";
    return `The ${this.mode} ${this.artifact === "app" ? "app" : "DMG"} failed verification: ${details.join("; ")}.${log}`;
  }
}

/** notarytool arguments for the selected credential set, read when the command runs. */
function notarytoolCredentialArguments(
  credential: MacNotarizationCredential,
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> {
  const read = (name: string) => env[name]?.trim() ?? "";
  switch (credential) {
    case "api-key":
      return [
        "--key",
        read("APPLE_API_KEY"),
        "--key-id",
        read("APPLE_API_KEY_ID"),
        "--issuer",
        read("APPLE_API_ISSUER"),
      ];
    case "apple-id":
      return [
        "--apple-id",
        read("APPLE_ID"),
        "--password",
        read("APPLE_APP_SPECIFIC_PASSWORD"),
        "--team-id",
        read("APPLE_TEAM_ID"),
      ];
    case "keychain-profile": {
      const keychain = read("APPLE_KEYCHAIN");
      return [
        "--keychain-profile",
        read("APPLE_KEYCHAIN_PROFILE"),
        ...(keychain ? ["--keychain", keychain] : []),
      ];
    }
  }
}

/** electron-builder's per-architecture output directory for the packaged `.app`. */
export function macPackagedAppDirectoryName(arch: typeof BuildArch.Type): string {
  return arch === "x64" ? "mac" : `mac-${arch}`;
}

export function resolveFffNativeDependencies(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    );
  }

  if (platform === "win") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    );
  }

  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      ["gnu", "musl"].map((libc) => [`@ff-labs/fff-bin-linux-${architecture}-${libc}`, version]),
    ),
  );
}

// macOS and Linux run both processes from one app.asar, so the stage installs
// the union of what each bundle leaves external and nothing else.
export function resolveMergedStageDependencies(input: {
  readonly platform: "mac" | "linux";
  readonly serverDependencies: Record<string, string>;
  readonly desktopDependencies: Record<string, string>;
  readonly arch: typeof BuildArch.Type;
  readonly fffNodeVersion: string;
}) {
  return {
    ...selectCliRuntimeExternalDependencies(input.serverDependencies),
    ...input.desktopDependencies,
    ...resolveFffNativeDependencies(input.platform, input.arch, input.fffNodeVersion),
  };
}

/** Cursor's helper lookup falls through the archive to this real resources tree. */
export const stageCursorSdkPlatformPackages = Effect.fn("stageCursorSdkPlatformPackages")(
  function* (nodeModulesDir: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(destination, { recursive: true });
    const sdkDirectory = path.join(nodeModulesDir, "@cursor/sdk");
    if (!(yield* fs.exists(sdkDirectory))) return;
    // pnpm's isolated layout puts optional packages beside the real SDK directory.
    const cursorDirectory = path.dirname(yield* fs.realPath(sdkDirectory));
    for (const name of yield* fs.readDirectory(cursorDirectory)) {
      if (!name.startsWith("sdk-")) continue;
      const source = yield* fs.realPath(path.join(cursorDirectory, name));
      yield* fs.copy(source, path.join(destination, name));
    }
  },
);

export interface ClerkPasskeyNativeArtifact {
  readonly packageName: string;
  readonly binaryFileName: string;
}

export function resolveClerkPasskeyNativeArtifacts(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-darwin-${architecture}`,
      binaryFileName: `electron-passkeys.darwin-${architecture}.node`,
    }));
  }

  if (platform === "win") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-win32-${architecture}-msvc`,
      binaryFileName: `electron-passkeys.win32-${architecture}-msvc.node`,
    }));
  }

  return [];
}

export function resolveKeyringNativeArtifacts(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return architectures.map((architecture) => ({
      packageName: `@napi-rs/keyring-darwin-${architecture}`,
      binaryFileName: `keyring.darwin-${architecture}.node`,
    }));
  }

  if (platform === "win") {
    return architectures.map((architecture) => ({
      packageName: `@napi-rs/keyring-win32-${architecture}-msvc`,
      binaryFileName: `keyring.win32-${architecture}-msvc.node`,
    }));
  }

  return architectures.map((architecture) => ({
    packageName: `@napi-rs/keyring-linux-${architecture}-gnu`,
    binaryFileName: `keyring.linux-${architecture}-gnu.node`,
  }));
}

/**
 * Same nesting problem as the Clerk passkey binaries: pnpm keeps the platform
 * package under `@napi-rs/keyring`, electron-builder only retains collected
 * top-level dependencies, and the generated loader checks for a sibling
 * `keyring.<platform>.node` before falling back to the package. Staging the
 * binary beside `index.js` lets that first branch win.
 */
const stageKeyringNativeBinaries = Effect.fn("stageKeyringNativeBinaries")(function* (
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@napi-rs", "keyring", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveKeyringNativeArtifacts(platform, arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(`${artifact.packageName}/${artifact.binaryFileName}`),
      catch: (cause) =>
        new KeyringNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform,
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

// pnpm nests the architecture package under @clerk/electron-passkeys, while electron-builder only
// retains collected top-level dependencies. The SDK loader checks beside index.js first, so stage
// the binary there and let electron-builder's native-addon handling unpack it from the ASAR.
const stageClerkPasskeyNativeBinaries = Effect.fn("stageClerkPasskeyNativeBinaries")(function* (
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@clerk", "electron-passkeys", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveClerkPasskeyNativeArtifacts(platform, arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(artifact.packageName),
      catch: (cause) =>
        new ClerkPasskeyNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform,
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

export function createStageWorkspaceConfig(input: {
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}): StageWorkspaceConfig {
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input;
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const hostCpu = arch === "universal" ? ["arm64", "x64"] : [arch];
  // Linux AppImages execute a Linux/glibc Node process that loads
  // Linux-native optional deps at runtime. Keep libc explicit so pnpm
  // includes those optional packages in the staged production install.
  const supportedArchitectures =
    platform === "linux"
      ? {
          os: [hostOs],
          cpu: hostCpu,
          libc: ["glibc"],
        }
      : {
          os: [hostOs],
          cpu: hostCpu,
        };

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    packageExtensions: STAGE_PACKAGE_EXTENSIONS,
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.String("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.String("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.String("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.String("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.String("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.String("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.String("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "STARK_CODE_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.String("STARK_CODE_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "STARK_CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.String("STARK_CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.String("STARK_CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.Boolean("STARK_CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.Boolean("STARK_CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.Boolean("STARK_CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.Boolean("STARK_CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
  mockUpdates: Config.Boolean("STARK_CODE_DESKTOP_MOCK_UPDATES").pipe(Config.withDefault(false)),
  mockUpdateServerPort: Config.String("STARK_CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.option,
  ),
  updateFeed: Config.String("STARK_CODE_DESKTOP_UPDATE_FEED").pipe(Config.option),
  updateUrl: Config.String("STARK_CODE_DESKTOP_UPDATE_URL").pipe(Config.option),
  // Removed: any value is an error that names the variables replacing it.
  updateRepository: Config.String("STARK_CODE_DESKTOP_UPDATE_REPOSITORY").pipe(Config.option),
  // Update rehearsals only (mock feed): the profile and fault baked into the app.
  rehearsalProfile: Config.String("STARK_CODE_DESKTOP_REHEARSAL_PROFILE").pipe(Config.option),
  rehearsalFault: Config.String("STARK_CODE_DESKTOP_REHEARSAL_FAULT").pipe(Config.option),
  // Path to the Linux CLI release archive (stark-<version>-linux-x64.tar.gz) built
  // by the build_linux_cli CI job. The Windows build embeds it verbatim as the
  // WSL runtime.
  wslRuntime: Config.String("STARK_CODE_DESKTOP_WSL_RUNTIME").pipe(Config.option),
});

const MockUpdateServerPortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
const decodeMockUpdateServerPort = Schema.decodeUnknownEffect(MockUpdateServerPortSchema);

function invalidMockUpdateServerPortReason(
  configuredPort: string,
): typeof InvalidMockUpdateServerPortReason.Type {
  const parsed = Number(configuredPort);
  if (!Number.isFinite(parsed)) return "not-numeric";
  if (!Number.isInteger(parsed)) return "not-integer";
  if (parsed < 1 || parsed > 65535) return "out-of-range";
  // This mapper is only called after schema decoding failed. An otherwise
  // valid integer therefore used a representation the decoder did not accept.
  return "not-numeric";
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveMockUpdateServerPort = Effect.fn("resolveMockUpdateServerPort")(function* (
  mockUpdateServerPort: string | undefined,
) {
  const port = mockUpdateServerPort?.trim();
  if (!port) {
    return undefined;
  }

  return yield* decodeMockUpdateServerPort(port);
});

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;
  const hostPlatform = yield* HostProcess.Platform;

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(hostPlatform),
  );

  if (!platform) {
    return yield* new UnsupportedHostBuildPlatformError({ hostPlatform });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const defaultArch = yield* getDefaultArch(platform);
  const arch = mergeOptions(input.arch, env.arch, defaultArch);
  const supportedArchitectures = PLATFORM_CONFIG[platform].archChoices;
  if (!supportedArchitectures.includes(arch)) {
    return yield* new UnsupportedDesktopBuildArchitectureError({
      platform,
      arch,
      supportedArchitectures: [...supportedArchitectures],
    });
  }
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  const mockUpdates = resolveBooleanFlag(input.mockUpdates, env.mockUpdates);
  const configuredMockUpdateServerPort = Option.getOrUndefined(env.mockUpdateServerPort);
  const mockUpdateServerPort =
    Option.getOrUndefined(input.mockUpdateServerPort) ??
    (configuredMockUpdateServerPort === undefined
      ? undefined
      : yield* resolveMockUpdateServerPort(configuredMockUpdateServerPort).pipe(
          Effect.mapError((cause) =>
            InvalidMockUpdateServerPortError.fromConfigValue(configuredMockUpdateServerPort, cause),
          ),
        ));

  const updateFeed = yield* resolveDesktopUpdateFeedPlan({
    mode: Option.getOrUndefined(env.updateFeed),
    url: Option.getOrUndefined(env.updateUrl),
    repository: Option.getOrUndefined(env.updateRepository),
    mockUpdates,
    mockUpdateServerPort,
    signed,
    rehearsalProfile: Option.getOrUndefined(env.rehearsalProfile),
    rehearsalFault: Option.getOrUndefined(env.rehearsalFault),
  });

  // A mock feed build writes only below release-mock/, so it can never land
  // beside release artifacts.
  const mockOutputRoot = path.resolve(repoRoot, "release-mock");
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(
      input.outputDir,
      env.outputDir,
      updateFeed.kind === "mock" ? "release-mock" : "release",
    ),
  );
  if (updateFeed.kind === "mock" && !isPathInside(path, mockOutputRoot, outputDir)) {
    return yield* new DesktopUpdateFeedConfigError({ reason: "mock-output-dir" });
  }

  const wslRuntime =
    Option.getOrUndefined(input.wslRuntime) ?? Option.getOrUndefined(env.wslRuntime);

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    updateFeed,
    wslRuntime,
  } satisfies ResolvedBuildOptions;
});

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: {
    readonly label: string;
    readonly verbose: boolean;
  },
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, options.verbose),
      collectCommandStream(child.stderr, process.stderr, options.verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BuildCommandFailedError({
      command: options.label,
      exitCode,
      ...(stdout.trim() ? { stdoutTail: stdout } : {}),
      ...(stderr.trim() ? { stderrTail: stderr } : {}),
    });
  }
});

const desktopBuildProbeSucceeds = Effect.fn("desktopBuildProbeSucceeds")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  return yield* runCommand(command, { label, verbose: false }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

const rustTargetIsInstalled = Effect.fn("rustTargetIsInstalled")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("rustc", ["--print", "target-libdir", "--target", target]),
  ).pipe(Effect.orElseSucceed(() => null));
  if (result === null || result.exitCode !== 0) return false;

  const targetLibDir = result.stdout.trim();
  if (targetLibDir === "") return false;
  const entries = yield* fs.readDirectory(targetLibDir).pipe(Effect.orElseSucceed(() => []));
  return entries.some((entry) => entry.startsWith("libstd-") && entry.endsWith(".rlib"));
});

export const preflightLinuxDesktopBuild = Effect.fn("preflightLinuxDesktopBuild")(function* (
  arch: typeof BuildArch.Type = "x64",
) {
  const reuseResourceMonitor = yield* Config.Boolean(
    "STARK_CODE_DESKTOP_REUSE_RESOURCE_MONITOR",
  ).pipe(Config.withDefault(false));
  const reuseCaptureHelpers = yield* Config.Boolean(
    "STARK_CODE_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS",
  ).pipe(Config.withDefault(false));
  // Rust is only optional when every Linux Rust artifact comes from a cache.
  const needsRust = !reuseResourceMonitor || !reuseCaptureHelpers;
  const rustTarget = resolveResourceMonitorRustTargets("linux", arch)[0]!;

  const checks = yield* Effect.all(
    {
      cargo: needsRust
        ? desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo")
        : Effect.succeed(true),
      "rust-target": needsRust ? rustTargetIsInstalled(rustTarget) : Effect.succeed(true),
      cc: desktopBuildProbeSucceeds(ChildProcess.make("cc", ["--version"]), "cc"),
      make: desktopBuildProbeSucceeds(ChildProcess.make("make", ["--version"]), "make"),
      libsecret: desktopBuildProbeSucceeds(
        ChildProcess.make("pkg-config", ["--exists", "libsecret-1"]),
        "libsecret",
      ),
      imagemagick: Effect.all([
        desktopBuildProbeSucceeds(ChildProcess.make("magick", ["-version"]), "magick"),
        desktopBuildProbeSucceeds(ChildProcess.make("convert", ["-version"]), "convert"),
      ]).pipe(Effect.map(([magick, convert]) => magick || convert)),
    },
    { concurrency: "unbounded" },
  );
  const missing = LINUX_DESKTOP_BUILD_PREREQUISITES.filter(
    (requirement) => !checks[requirement.id],
  ).map((requirement) => requirement.id);

  if (missing.length > 0) {
    return yield* new LinuxDesktopBuildPrerequisitesMissingError({ missing, rustTarget });
  }
});

export const preflightMacDesktopBuild = Effect.fn("preflightMacDesktopBuild")(function* (
  arch: typeof BuildArch.Type,
) {
  const rustTargets = resolveResourceMonitorRustTargets("mac", arch);
  const reuseResourceMonitor = yield* Config.Boolean(
    "STARK_CODE_DESKTOP_REUSE_RESOURCE_MONITOR",
  ).pipe(Config.withDefault(false));
  const checks = yield* Effect.all(
    {
      rust: reuseResourceMonitor
        ? Effect.succeed(true)
        : Effect.all([
            desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo"),
            Effect.forEach(rustTargets, rustTargetIsInstalled).pipe(
              Effect.map((results) => results.every(Boolean)),
            ),
          ]).pipe(Effect.map(([cargo, targets]) => cargo && targets)),
      clang: desktopBuildProbeSucceeds(ChildProcess.make("clang", ["--version"]), "clang"),
      make: desktopBuildProbeSucceeds(ChildProcess.make("make", ["--version"]), "make"),
      sips: desktopBuildProbeSucceeds(ChildProcess.make("sips", ["--help"]), "sips"),
      lipo:
        arch === "universal"
          ? desktopBuildProbeSucceeds(ChildProcess.make("lipo", ["-version"]), "lipo")
          : Effect.succeed(true),
    },
    { concurrency: "unbounded" },
  );
  const missing = MAC_DESKTOP_BUILD_PREREQUISITES.filter(
    (requirement) => !checks[requirement.id],
  ).map((requirement) => requirement.id);
  if (missing.length > 0) {
    return yield* new MacDesktopBuildPrerequisitesMissingError({ missing, rustTargets });
  }
});

function windowsVswherePrerequisiteScript(arch: typeof BuildArch.Type): string {
  const toolComponents =
    arch === "arm64"
      ? ["Microsoft.VisualStudio.Component.VC.Tools.ARM64"]
      : ["Microsoft.VisualStudio.Component.VC.Tools.x86.x64"];
  const spectreArch = arch === "arm64" ? "arm64" : "x64";
  return [
    "$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'",
    "if (!(Test-Path $vswhere)) { exit 1 }",
    `$install = & $vswhere -latest -products * -requires ${toolComponents.join(" ")} -property installationPath`,
    "if (!$install) { exit 1 }",
    "$kitsRoot = Get-ItemPropertyValue 'HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots' -Name KitsRoot10 -ErrorAction SilentlyContinue",
    "if (!$kitsRoot -or !(Test-Path (Join-Path $kitsRoot 'Lib'))) { exit 1 }",
    "$msvcToolset = Get-ChildItem (Join-Path $install 'VC\\Tools\\MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1",
    "if (!$msvcToolset) { exit 1 }",
    `if (!(Test-Path (Join-Path $msvcToolset.FullName 'lib\\spectre\\${spectreArch}'))) { exit 1 }`,
  ].join("; ");
}

export const preflightWindowsDesktopBuild = Effect.fn("preflightWindowsDesktopBuild")(
  function* (input: { readonly arch: typeof BuildArch.Type; readonly bundlesWslRuntime: boolean }) {
    const rustTarget = resolveResourceMonitorRustTargets("win", input.arch)[0]!;
    const reuseResourceMonitor = yield* Config.Boolean(
      "STARK_CODE_DESKTOP_REUSE_RESOURCE_MONITOR",
    ).pipe(Config.withDefault(false));
    const python = yield* resolvePythonForNodeGyp();
    const checks = yield* Effect.all(
      {
        rust: reuseResourceMonitor
          ? Effect.succeed(true)
          : Effect.all([
              desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo"),
              rustTargetIsInstalled(rustTarget),
            ]).pipe(Effect.map(([cargo, target]) => cargo && target)),
        python: Effect.succeed(python !== undefined),
        msvc: reuseResourceMonitor
          ? Effect.succeed(true)
          : desktopBuildProbeSucceeds(
              ChildProcess.make("powershell.exe", [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                windowsVswherePrerequisiteScript(input.arch),
              ]),
              "Visual Studio Build Tools",
            ),
        tar: input.bundlesWslRuntime
          ? desktopBuildProbeSucceeds(ChildProcess.make("tar.exe", ["--version"]), "tar")
          : Effect.succeed(true),
      },
      { concurrency: "unbounded" },
    );
    const missing = WINDOWS_DESKTOP_BUILD_PREREQUISITES.filter(
      (requirement) => !checks[requirement.id],
    ).map((requirement) => requirement.id);
    if (missing.length > 0) {
      return yield* new WindowsDesktopBuildPrerequisitesMissingError({ missing, rustTarget });
    }
  },
);

/**
 * Every `node_modules` directory that would be visible from `startDir`.
 *
 * The self-containment check is only meaningful in a directory with none of
 * these: Node walks parents when resolving a bare import, so a stray
 * node_modules above the probe would satisfy imports that are missing from the
 * packaged tree and turn the check into a silent pass.
 */
function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(0, end);
}

/**
 * Length of the `\\server\share` prefix, or 0 when the path is not UNC.
 *
 * The share is the highest real directory on a UNC path: `\\server` on its own
 * is not one, so the ancestor walk must stop there.
 */
function uncShareRootLength(value: string): number {
  const isUnc = value.startsWith("\\\\") || value.startsWith("//");
  if (!isUnc) return 0;
  const separator = /[\\/]/;
  const serverEnd = value.slice(2).search(separator);
  if (serverEnd < 0) return value.length;
  const shareStart = 2 + serverEnd + 1;
  const shareEnd = value.slice(shareStart).search(separator);
  return shareEnd < 0 ? value.length : shareStart + shareEnd;
}

export function ancestorNodeModulesPaths(
  startDir: string,
  separator: string,
): ReadonlyArray<string> {
  // Walks with lastIndexOf rather than splitting into segments so UNC roots
  // (\\server\share) and drive roots keep their prefix instead of being
  // rebuilt into a relative path that silently resolves against the build cwd.
  const paths: string[] = [];
  let current = trimTrailingSeparators(startDir);
  // On a UNC path the share itself is the root: \\server is not a directory, so
  // walking past \\server\share would emit paths that cannot exist.
  const uncRootLength = uncShareRootLength(current);
  for (;;) {
    const cut = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
    if (cut < 0 || (uncRootLength > 0 && cut < uncRootLength)) break;
    const parent = cut === 0 ? current.slice(0, 1) : current.slice(0, cut);
    if (parent === current) break;
    paths.push(
      parent.endsWith(separator) ? `${parent}node_modules` : `${parent}${separator}node_modules`,
    );
    if (cut === 0) break;
    current = parent;
  }
  return paths;
}

const NativeMarkerManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeNativeMarkerManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(NativeMarkerManifest),
);

/** Locate a package inside the pnpm store, which is where the real files live. */
const findStorePackageDirectory = Effect.fn("findStorePackageDirectory")(function* (
  repoRoot: string,
  packageName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeDir = path.join(repoRoot, "node_modules/.pnpm");
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* exists(storeDir))) return null;

  const flattened = `${packageName.replace("/", "+")}@`;
  const entries = yield* fs
    .readDirectory(storeDir)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  for (const entry of entries) {
    if (!entry.startsWith(flattened)) continue;
    const candidate = path.join(storeDir, entry, "node_modules", packageName);
    if (yield* exists(candidate)) return candidate;
  }
  return null;
});

/** Whether a package builds or ships a native addon it loads at runtime. */
const hasNativeLoaderMarkers = Effect.fn("hasNativeLoaderMarkers")(function* (packageDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  if (yield* exists(path.join(packageDir, "binding.gyp"))) return true;
  if (yield* exists(path.join(packageDir, "prebuilds"))) return true;

  const manifestPath = path.join(packageDir, "package.json");
  if (!(yield* exists(manifestPath))) return false;
  const source = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => ""));
  if (source === "") return false;
  const manifest = yield* Effect.try(() => decodeNativeMarkerManifest(source)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (manifest === null) return false;
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).some(
    (dependency) => dependency.startsWith("node-gyp-build"),
  );
});

export const copyDirectoryPreservingSymlinks = Effect.fn("copyDirectoryPreservingSymlinks")(
  function* (source: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Effect's Node implementation delegates directory copies to fs.cp, whose
    // default rewrites links into absolute source-tree references. Recreate every
    // in-tree directory link as a junction rooted in the isolated copy so the
    // probe cannot resolve through staging and Windows needs no symlink privilege.
    yield* fs.copy(source, destination);

    const restoreRelativeSymlinks = (
      sourceDirectory: string,
      destinationDirectory: string,
    ): Effect.Effect<void, PlatformError | BundleNotSelfContainedError> =>
      Effect.gen(function* () {
        for (const entry of yield* fs.readDirectory(sourceDirectory)) {
          const sourceEntry = path.join(sourceDirectory, entry);
          const destinationEntry = path.join(destinationDirectory, entry);
          const linkTarget = yield* fs.readLink(sourceEntry).pipe(Effect.option);
          if (Option.isSome(linkTarget)) {
            const absoluteSourceTarget = path.isAbsolute(linkTarget.value)
              ? linkTarget.value
              : path.resolve(path.dirname(sourceEntry), linkTarget.value);
            const sourceRelativeTarget = path.relative(source, absoluteSourceTarget);
            if (
              sourceRelativeTarget === ".." ||
              sourceRelativeTarget.startsWith(`..${path.sep}`) ||
              path.isAbsolute(sourceRelativeTarget)
            ) {
              return yield* new BundleNotSelfContainedError({
                exitCode: -1,
                output: `Refusing to copy symlink ${sourceEntry}: its target ${absoluteSourceTarget} escapes the packaged tree.`,
              });
            }
            const target = path.join(destination, sourceRelativeTarget);
            yield* fs.remove(destinationEntry, { recursive: true, force: true });
            yield* Effect.tryPromise({
              try: () => NodeFSP.symlink(target, destinationEntry, "junction"),
              catch: (cause) =>
                new BundleNotSelfContainedError({
                  exitCode: -1,
                  output: `Could not isolate ${sourceEntry}: ${String(cause)}`,
                }),
            });
          } else {
            const info = yield* fs.stat(sourceEntry);
            if (info.type === "Directory") {
              yield* restoreRelativeSymlinks(sourceEntry, destinationEntry);
            }
          }
        }
      });

    yield* restoreRelativeSymlinks(source, destination);
  },
);

const verifyPackagedBundleIsSelfContained = Effect.fn("verifyPackagedBundleIsSelfContained")(
  function* (input: { readonly asarPath: string; readonly verbose: boolean }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const probeRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "starkcode-bundle-selfcheck-",
    });
    const extractedApp = path.join(probeRoot, "extracted");
    const probeApp = path.join(probeRoot, "app");
    yield* Effect.try({
      try: () => extractAll(input.asarPath, extractedApp),
      catch: (cause) =>
        new BundleNotSelfContainedError({
          exitCode: -1,
          output: `Could not extract ${input.asarPath} for the bundle self-containment check: ${String(cause)}`,
        }),
    });
    // Keep the existing symlink isolation guard even though the sidecar stage
    // is hoisted and should be physical. A future package-manager layout change
    // must not let the probe resolve through the build tree.
    yield* copyDirectoryPreservingSymlinks(extractedApp, probeApp);

    // Guard the guard: if anything above the probe provides a node_modules, a
    // missing dependency would resolve there and the check would pass while the
    // packaged tree is broken.
    for (const candidate of ancestorNodeModulesPaths(probeApp, path.sep)) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return yield* new BundleNotSelfContainedError({
          exitCode: -1,
          output: `Refusing to report success: ${candidate} is visible from the probe directory, so bare imports could resolve outside the packaged tree. Remove or rename it, or point TMPDIR somewhere without one.`,
        });
      }
    }

    const entryPoint = path.join(probeApp, "apps/server/dist/bin.mjs");
    if (!(yield* fs.exists(entryPoint).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new BundleNotSelfContainedError({
        exitCode: -1,
        output: `Expected the server entry at ${entryPoint}.`,
      });
    }

    // --version exercises the eagerly loaded module graph, which is where a
    // missing dependency shows up, without starting a server or touching disk
    // state. It does not cover lazily imported externals: node-pty is checked
    // by the WSL preflight probe at runtime, while ffi-rs, @ff-labs/fff-node
    // and the bun adapters are covered by the shared runtime-external closure
    // and emitted-bundle checks.
    yield* runCommand(
      ChildProcess.make(
        process.execPath,
        // --no-global-search-paths because clearing NODE_PATH is not enough:
        // CommonJS resolution still falls back to $HOME/.node_modules,
        // $HOME/.node_libraries and the install prefix, so a globally installed
        // copy of a missing dependency would quietly satisfy this check.
        ["--no-global-search-paths", entryPoint, "--version"],
        {
          cwd: probeApp,
          stdout: "pipe",
          stderr: "pipe",
          // NODE_PATH would let a createRequire call inside the bundle resolve
          // a missing external from outside the packaged tree, which is the
          // whole thing this is trying to rule out.
          env: { ...process.env, NODE_PATH: "" },
        },
      ),
      {
        label: "server sidecar self-containment check (node bin.mjs --version)",
        verbose: input.verbose,
      },
    ).pipe(
      // Printing a version should be immediate. A regression that blocks (on
      // stdin, a port, a lock) would otherwise hang release CI until the job
      // times out with nothing useful in the log.
      Effect.timeout(BUNDLE_SELF_CHECK_TIMEOUT),
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(
            new BundleNotSelfContainedError({
              exitCode: -1,
              output: `The packaged bundle did not print its version within ${Duration.toSeconds(BUNDLE_SELF_CHECK_TIMEOUT)}s; it is hanging rather than failing to resolve.`,
            }),
          ),
        BuildCommandFailedError: (error) =>
          Effect.fail(
            new BundleNotSelfContainedError({
              exitCode: error.exitCode,
              output: `${error.stderrTail ?? ""}${error.stdoutTail ?? ""}`.trim(),
            }),
          ),
      }),
    );
  },
);

export const stageLinuxCaptureHelper = Effect.fn("stageLinuxCaptureHelper")(function* (input: {
  readonly backend: "kde" | "hyprland";
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [rustTarget] = resolveResourceMonitorRustTargets("linux", input.arch);
  // Release CI restores these binaries from a cache keyed on the crate sources and
  // skips the Rust toolchain on a hit, so the build must be skippable too.
  const reuseHelpers = yield* Config.Boolean("STARK_CODE_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS").pipe(
    Config.withDefault(false),
  );
  const binaryPath = path.join(
    input.repoRoot,
    `native/${input.backend}-snap-shot/target`,
    rustTarget!,
    `release/stark-${input.backend}-snap-shot`,
  );
  if (!reuseHelpers) {
    const spawnCommand = yield* resolveSpawnCommand("cargo", [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      path.join(input.repoRoot, `native/${input.backend}-snap-shot/Cargo.toml`),
      "--target",
      rustTarget!,
    ]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.repoRoot,
        shell: spawnCommand.shell,
      }),
      {
        label: `cargo build ${input.backend} capture helper (${rustTarget})`,
        verbose: input.verbose,
      },
    );
  } else if (!(yield* fs.exists(binaryPath))) {
    return yield* new ResourceMonitorBuildOutputMissingError({
      binaryPath,
      rustTarget: rustTarget!,
      platform: "linux",
      arch: input.arch,
    });
  }
  const destination = path.join(input.stageResourcesDir, `${input.backend}-capture`);
  yield* fs.makeDirectory(destination, { recursive: true });
  const executable = path.join(destination, `stark-${input.backend}-snap-shot`);
  yield* fs.copyFile(binaryPath, executable);
  yield* fs.chmod(executable, 0o755);
  if (input.backend === "hyprland") {
    // The official protocol XML includes the BSD notices required with binary distribution.
    yield* fs.copy(
      path.join(input.repoRoot, "native/hyprland-snap-shot/protocols"),
      path.join(destination, "protocols"),
    );
  }
});

/** Release helpers must not embed the builder's home or dependency-cache paths. */
export function resourceMonitorReleaseEnvironment(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  // Cargo gives encoded flags precedence over RUSTFLAGS. Keep that precedence
  // and use its separator so build directories containing spaces stay one flag.
  const existing =
    env.CARGO_ENCODED_RUSTFLAGS !== undefined
      ? env.CARGO_ENCODED_RUSTFLAGS.split("\u001f").filter(Boolean)
      : (env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  const prefixes = [
    [env.HOME ?? env.USERPROFILE, "/build/home"],
    [env.CARGO_HOME, "/build/cargo"],
    [env.RUSTUP_HOME, "/build/rustup"],
    [repoRoot, "/build/stark-code"],
  ] as const;
  const mappings = prefixes.flatMap(([source, destination]) =>
    source ? [`--remap-path-prefix=${source}=${destination}`] : [],
  );
  return { ...env, CARGO_ENCODED_RUSTFLAGS: [...existing, ...mappings].join("\u001f") };
}

export const stageResourceMonitor = Effect.fn("stageResourceMonitor")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(input.repoRoot, "native/resource-monitor/Cargo.toml");
  const executableName = resourceMonitorExecutableName(input.platform);
  const rustTargets = resolveResourceMonitorRustTargets(input.platform, input.arch);
  const reuseResourceMonitor = yield* Config.Boolean(
    "STARK_CODE_DESKTOP_REUSE_RESOURCE_MONITOR",
  ).pipe(Config.withDefault(false));
  const builtBinaries: string[] = [];

  for (const rustTarget of rustTargets) {
    if (!reuseResourceMonitor) {
      const spawnCommand = yield* resolveSpawnCommand("cargo", [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        manifestPath,
        "--target",
        rustTarget,
      ]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.repoRoot,
          shell: spawnCommand.shell,
          env: resourceMonitorReleaseEnvironment(input.repoRoot, process.env),
        }),
        {
          label: `cargo build resource monitor (${rustTarget})`,
          verbose: input.verbose,
        },
      );
    }

    const binaryPath = path.join(
      input.repoRoot,
      "native/resource-monitor/target",
      rustTarget,
      "release",
      executableName,
    );
    if (!(yield* fs.exists(binaryPath))) {
      return yield* new ResourceMonitorBuildOutputMissingError({
        binaryPath,
        rustTarget,
        platform: input.platform,
        arch: input.arch,
      });
    }
    if (reuseResourceMonitor) {
      yield* Effect.log(`[desktop-artifact] Reusing cached resource monitor (${rustTarget}).`);
    }
    builtBinaries.push(binaryPath);
  }

  const destinationDirectory = path.join(input.stageResourcesDir, "resource-monitor");
  const destinationPath = path.join(destinationDirectory, executableName);
  yield* fs.remove(destinationDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(destinationDirectory, { recursive: true });

  if (builtBinaries.length === 1) {
    yield* fs.copyFile(builtBinaries[0]!, destinationPath);
  } else {
    yield* runCommand(
      ChildProcess.make("lipo", ["-create", ...builtBinaries, "-output", destinationPath]),
      {
        label: "lipo resource monitor universal binary",
        verbose: input.verbose,
      },
    );
  }

  if (input.platform !== "win") {
    yield* fs.chmod(destinationPath, 0o755);
  }
});

export const stageBrowserSecret = Effect.fn("stageBrowserSecret")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  if (input.platform !== "linux") return;
  // The helper links against the host's libsecret, so it can only be built on
  // Linux; the build script is a no-op elsewhere. A Linux artifact from
  // another host would ship without it and every v11 cookie import would
  // report the keyring as unavailable, so refuse rather than package that
  // silently. `universal` is a mac-only arch the option type still admits;
  // the helper script rejects it, so it maps to the concrete x64 the Linux
  // resource monitor uses for the same request.
  const hostPlatform = yield* HostProcess.Platform;
  if (hostPlatform !== "linux") {
    return yield* new LinuxBrowserSecretHostError({ hostPlatform });
  }
  const path = yield* Path.Path;
  yield* runCommand(
    ChildProcess.make(
      "node",
      [
        path.join(input.repoRoot, "apps/desktop/scripts/build-browser-secret.mjs"),
        "--arch",
        input.arch === "arm64" ? "arm64" : "x64",
        "--output",
        path.join(input.stageResourcesDir, "browser-secret", "stark-browser-secret"),
      ],
      { cwd: input.repoRoot },
    ),
    { label: "build Linux browser secret helper", verbose: input.verbose },
  );
});

export const stageDictation = Effect.fn("stageDictation")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  if (input.platform !== "mac") return;
  const hostPlatform = yield* HostProcess.Platform;
  if (hostPlatform !== "darwin") return yield* new MacDictationHostError({ hostPlatform });
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const directory = path.join(input.stageResourcesDir, "dictation");
  yield* runCommand(
    ChildProcess.make(
      "node",
      [
        path.join(input.repoRoot, "apps/desktop/scripts/build-dictation.mjs"),
        "--arch",
        input.arch,
        "--output",
        path.join(directory, "Stark Dictation.app"),
      ],
      { cwd: input.repoRoot },
    ),
    { label: "build macOS dictation helper", verbose: input.verbose },
  );
  yield* fs.copyFile(
    path.join(input.repoRoot, "native/dictation/entitlements.plist"),
    path.join(directory, "entitlements.plist"),
  );
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
        { label: `sips icon ${size}x${size}`, verbose },
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
        { label: `sips icon ${size}x${size}@2x`, verbose },
      );
    }

    // The same PNG-backed container used by the dev launcher also works where
    // sandboxed iconutil rejects valid generated iconsets.
    const entries = yield* Effect.forEach(
      [
        ["icp4", "icon_16x16.png"],
        ["icp5", "icon_32x32.png"],
        ["icp6", "icon_32x32@2x.png"],
        ["ic07", "icon_128x128.png"],
        ["ic08", "icon_256x256.png"],
        ["ic09", "icon_512x512.png"],
        ["ic10", "icon_512x512@2x.png"],
      ] as const,
      ([type, fileName]) =>
        fs.readFile(path.join(iconsetDir, fileName)).pipe(Effect.map((png) => ({ type, png }))),
    );
    yield* fs.writeFile(targetIcns, encodePngIcns(entries));
  });
}

function stageMacIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "mac",
        sourcePath: sourcePng,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "starkcode-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(ChildProcess.make({})`sips -z 512 512 ${sourcePng} --out ${iconPngPath}`, {
      label: "sips mac icon",
      verbose,
    });

    yield* generateMacIconSet(sourcePng, iconIcnsPath, tmpRoot, path, verbose);
  });
}

export const stageDesktopDmgBackground = Effect.fn("stageDesktopDmgBackground")(function* (
  stageResourcesDir: string,
  channel: "latest" | "nightly",
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(stageResourcesDir, "dmg", `dmg-background-${channel}.svg`);
  if (!(yield* fs.exists(sourcePath))) {
    return yield* new DesktopDmgBackgroundSourceMissingError({ channel, sourcePath });
  }

  for (const output of [
    { suffix: "", width: 640, height: 432 },
    { suffix: "@2x", width: 1280, height: 864 },
  ] as const) {
    const targetPath = path.join(
      stageResourcesDir,
      "dmg",
      `dmg-background-${channel}${output.suffix}.png`,
    );
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -s format png -z ${output.height} ${output.width} ${sourcePath} --out ${targetPath}`,
      {
        label: `sips ${channel} DMG background${output.suffix || "@1x"}`,
        verbose,
      },
    );
  }
});

function stageLinuxIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "linux",
        sourcePath: sourcePng,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(sourcePng, iconPath);

    const iconsDir = path.join(stageResourcesDir, "icons");
    yield* fs.makeDirectory(iconsDir, { recursive: true });
    for (const iconSize of LINUX_ICON_SIZES) {
      yield* stageLinuxIconSize(
        sourcePng,
        path.join(iconsDir, `${iconSize}x${iconSize}.png`),
        iconSize,
        verbose,
      );
    }
  });
}

export function stageLinuxIconSize(
  sourcePng: string,
  targetPng: string,
  iconSize: number,
  verbose: boolean,
) {
  const resize = (command: string) =>
    runCommand(
      ChildProcess.make(command, [sourcePng, "-resize", `${iconSize}x${iconSize}`, targetPng]),
      { label: `${command} linux icon ${iconSize}x${iconSize}`, verbose },
    );

  return resize("magick").pipe(
    Effect.catch((primaryCause) =>
      resize("convert").pipe(
        Effect.mapError(
          (fallbackCause) =>
            new LinuxIconResizeError({
              operation: "resize",
              iconSize,
              primaryTool: "magick",
              fallbackTool: "convert",
              cause: new AggregateError(
                [primaryCause, fallbackCause],
                "Both Linux icon resize tool attempts failed.",
                { cause: primaryCause },
              ),
            }),
        ),
      ),
    ),
  );
}

function stageWindowsIcons(stageResourcesDir: string, sourceIco: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourceIco))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "win",
        sourcePath: sourceIco,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(sourceIco, iconPath);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      return yield* new BundledClientAssetsMissingError({
        indexPath,
        missingFiles: missing,
      });
    }
  });
}

// The main-process bundle inlines every JS dependency (see
// apps/desktop/vite.config.ts), so the packaged app only installs the packages
// that bundle leaves external: native addons and playwright-core. Everything
// else already lives inside dist-electron and would only duplicate what the
// server bundle carries too.
export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  return resolveCatalogDependencies(
    selectDesktopRuntimeExternalDependencies(dependencies),
    catalog,
    "apps/desktop",
  );
}

const DesktopUpdateFeedConfigReason = Schema.Literals([
  "invalid-mode",
  "mode-required",
  "repository-removed",
  "conflicts-with-mock-updates",
  "url-required",
  "url-not-allowed",
  "url-invalid",
  "mock-output-dir",
  "mock-developer-id",
  "not-mac",
  "stark-needs-developer-id",
  "team-id-not-configured",
  "team-id-missing",
  "team-id-mismatch",
  "preview-version",
  "channel-not-enabled",
  "rehearsal-not-mock",
  "rehearsal-profile-invalid",
  "rehearsal-fault-invalid",
]);
export type DesktopUpdateFeedConfigReason = typeof DesktopUpdateFeedConfigReason.Type;

const describeFeedUrlProblem = (problem: (typeof FEED_URL_PROBLEMS)[number] | undefined) => {
  switch (problem) {
    case "origin-not-allowed":
      return "its origin is not in stark.brand.json updateFeedOrigins, which stays empty until hosting is approved";
    case "not-https":
      return "it is not https";
    case "credentials":
      return "it carries a user name or password";
    case "query-or-fragment":
      return "it has a query or fragment";
    case "not-a-directory":
      return "it does not end in /";
    case "not-canonical":
      return "it is not in canonical form (lowercase host, no default port, no dot segments)";
    case "unsafe-path":
      return "its path has characters other than letters, digits, . _ + -";
    case "loopback":
      return "it points at this machine";
    default:
      return "it is not a URL";
  }
};

/**
 * Why a build's update feed configuration was refused. Messages name
 * variables and the rule that failed, never a credential.
 */
export class DesktopUpdateFeedConfigError extends Schema.TaggedError<DesktopUpdateFeedConfigError>()(
  "DesktopUpdateFeedConfigError",
  {
    reason: DesktopUpdateFeedConfigReason,
    urlProblem: Schema.optionalKey(Schema.Literals(FEED_URL_PROBLEMS)),
    inputLength: Schema.optionalKey(Schema.Int),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-mode":
        return "STARK_CODE_DESKTOP_UPDATE_FEED must be `none`, `stark` or `mock`.";
      case "mode-required":
        return "A --signed build must say which update feed it carries: set STARK_CODE_DESKTOP_UPDATE_FEED to `none`, `stark` or `mock`.";
      case "repository-removed":
        return "STARK_CODE_DESKTOP_UPDATE_REPOSITORY was removed and is never read. Unset it; a Stark feed is STARK_CODE_DESKTOP_UPDATE_FEED=stark with STARK_CODE_DESKTOP_UPDATE_URL.";
      case "conflicts-with-mock-updates":
        return "--mock-updates (STARK_CODE_DESKTOP_MOCK_UPDATES) needs STARK_CODE_DESKTOP_UPDATE_FEED unset or `mock`.";
      case "url-required":
        return "STARK_CODE_DESKTOP_UPDATE_FEED=stark needs STARK_CODE_DESKTOP_UPDATE_URL.";
      case "url-not-allowed":
        return "STARK_CODE_DESKTOP_UPDATE_URL only applies with STARK_CODE_DESKTOP_UPDATE_FEED=stark.";
      case "url-invalid":
        return `STARK_CODE_DESKTOP_UPDATE_URL was refused: ${describeFeedUrlProblem(this.urlProblem)}.`;
      case "mock-output-dir":
        return "A mock update feed build must write inside release-mock/. Drop --output-dir or point it below release-mock/.";
      case "mock-developer-id":
        return "The localhost mock update feed cannot be baked into a Developer ID build. Use STARK_CODE_MACOS_SIGNING_MODE=development for an update rehearsal.";
      case "not-mac":
        return "Update feeds are only baked into macOS builds; use STARK_CODE_DESKTOP_UPDATE_FEED=none.";
      case "stark-needs-developer-id":
        return "A Stark update feed needs a Developer ID build, whose designated requirement pins the Stark team.";
      case "team-id-not-configured":
        return "A Stark update feed needs appleTeamId in stark.brand.json.";
      case "team-id-missing":
        return "A Stark update feed needs APPLE_TEAM_ID, equal to appleTeamId in stark.brand.json.";
      case "team-id-mismatch":
        return "APPLE_TEAM_ID is not appleTeamId from stark.brand.json; a Stark feed only ships builds signed by that team.";
      case "preview-version":
        return "Preview and pull request builds never carry an update feed; use STARK_CODE_DESKTOP_UPDATE_FEED=none.";
      case "channel-not-enabled":
        return "This version's update channel is not in stark.brand.json updateChannels (latest only).";
      case "rehearsal-not-mock":
        return "STARK_CODE_DESKTOP_REHEARSAL_PROFILE and STARK_CODE_DESKTOP_REHEARSAL_FAULT only apply with STARK_CODE_DESKTOP_UPDATE_FEED=mock.";
      case "rehearsal-profile-invalid":
        return "STARK_CODE_DESKTOP_REHEARSAL_PROFILE must be an absolute directory without . or .. segments.";
      case "rehearsal-fault-invalid":
        return `STARK_CODE_DESKTOP_REHEARSAL_FAULT must be one of: ${DESKTOP_REHEARSAL_FAULTS.join(", ")}.`;
    }
  }
}

/** The update feed a build bakes in, after its configuration was checked. */
export type DesktopUpdateFeedPlan =
  | { readonly kind: "none" }
  | { readonly kind: "stark"; readonly url: string }
  | {
      readonly kind: "mock";
      readonly url: string;
      /** A rehearsal's own profile and fault, baked into the app (see BakedRehearsalPolicy). */
      readonly rehearsal?: BakedRehearsalPolicy | null;
    };

export const NO_DESKTOP_UPDATE_FEED: DesktopUpdateFeedPlan = { kind: "none" };

const DESKTOP_UPDATE_FEED_MODES = ["none", "stark", "mock"] as const;
const isDesktopUpdateFeedMode = Schema.is(Schema.Literals(DESKTOP_UPDATE_FEED_MODES));

/**
 * Resolves STARK_CODE_DESKTOP_UPDATE_FEED and STARK_CODE_DESKTOP_UPDATE_URL.
 * The feed is always explicit: an unsigned build defaults to none, a signed
 * one must choose, and a Stark URL must be an HTTPS directory on an origin
 * stark.brand.json allowlists. Nothing ambient (CI repository variables,
 * tokens, package metadata) is ever read.
 */
export const resolveDesktopUpdateFeedPlan = Effect.fn("resolveDesktopUpdateFeedPlan")(function* (
  input: {
    readonly mode: string | undefined;
    readonly url: string | undefined;
    readonly repository: string | undefined;
    readonly mockUpdates: boolean;
    readonly mockUpdateServerPort: number | undefined;
    readonly signed: boolean;
    /** STARK_CODE_DESKTOP_REHEARSAL_PROFILE and _FAULT; mock builds only. */
    readonly rehearsalProfile?: string | undefined;
    readonly rehearsalFault?: string | undefined;
  },
  ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
) {
  if ((input.repository?.trim() ?? "") !== "") {
    return yield* new DesktopUpdateFeedConfigError({ reason: "repository-removed" });
  }
  const configuredMode = input.mode?.trim() ?? "";
  if (configuredMode !== "" && !isDesktopUpdateFeedMode(configuredMode)) {
    return yield* new DesktopUpdateFeedConfigError({
      reason: "invalid-mode",
      inputLength: configuredMode.length,
    });
  }
  const mode = isDesktopUpdateFeedMode(configuredMode)
    ? configuredMode
    : input.mockUpdates
      ? "mock"
      : input.signed
        ? undefined
        : "none";
  if (mode === undefined) {
    return yield* new DesktopUpdateFeedConfigError({ reason: "mode-required" });
  }
  if (input.mockUpdates && mode !== "mock") {
    return yield* new DesktopUpdateFeedConfigError({ reason: "conflicts-with-mock-updates" });
  }
  const url = input.url?.trim() ?? "";
  const rehearsalProfile = input.rehearsalProfile?.trim() ?? "";
  const rehearsalFault = input.rehearsalFault?.trim() ?? "";
  if (mode !== "mock" && (rehearsalProfile !== "" || rehearsalFault !== "")) {
    return yield* new DesktopUpdateFeedConfigError({ reason: "rehearsal-not-mock" });
  }
  if (mode !== "stark") {
    if (url !== "") return yield* new DesktopUpdateFeedConfigError({ reason: "url-not-allowed" });
    if (mode === "none") return NO_DESKTOP_UPDATE_FEED;
    if (rehearsalProfile !== "" && !isValidRehearsalProfile(rehearsalProfile)) {
      return yield* new DesktopUpdateFeedConfigError({ reason: "rehearsal-profile-invalid" });
    }
    if (rehearsalFault !== "" && !isDesktopRehearsalFault(rehearsalFault)) {
      return yield* new DesktopUpdateFeedConfigError({ reason: "rehearsal-fault-invalid" });
    }
    const rehearsal: BakedRehearsalPolicy | null =
      rehearsalProfile === "" && rehearsalFault === ""
        ? null
        : {
            profile: rehearsalProfile === "" ? null : rehearsalProfile,
            fault: isDesktopRehearsalFault(rehearsalFault) ? rehearsalFault : null,
          };
    const mock: DesktopUpdateFeedPlan = {
      kind: "mock",
      url: resolveMockUpdateServerUrl(input.mockUpdateServerPort),
      ...(rehearsal === null ? {} : { rehearsal }),
    };
    return mock;
  }
  if (url === "") return yield* new DesktopUpdateFeedConfigError({ reason: "url-required" });
  const checked = checkFeedUrl(url, "stark", ownership);
  if (!checked.ok) {
    return yield* new DesktopUpdateFeedConfigError({
      reason: "url-invalid",
      urlProblem: checked.problem,
    });
  }
  const stark: DesktopUpdateFeedPlan = { kind: "stark", url: checked.location.href };
  return stark;
});

/**
 * The signing a feed needs, checked before anything is built: a Stark feed
 * only on a macOS Developer ID build whose APPLE_TEAM_ID is the checked-in
 * team, and the localhost mock feed never on a Developer ID build.
 */
export const checkDesktopUpdateFeedSigning = Effect.fn("checkDesktopUpdateFeedSigning")(function* (
  input: {
    readonly feed: DesktopUpdateFeedPlan;
    readonly platform: typeof BuildPlatform.Type;
    readonly plan: MacSigningPlan | undefined;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
  ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
) {
  if (input.feed.kind === "none") return;
  if (input.platform !== "mac") {
    return yield* new DesktopUpdateFeedConfigError({ reason: "not-mac" });
  }
  if (input.feed.kind === "mock") {
    if (input.plan?.mode === "developer-id") {
      return yield* new DesktopUpdateFeedConfigError({ reason: "mock-developer-id" });
    }
    return;
  }
  if (input.plan?.mode !== "developer-id") {
    return yield* new DesktopUpdateFeedConfigError({ reason: "stark-needs-developer-id" });
  }
  if (ownership.appleTeamId === null) {
    return yield* new DesktopUpdateFeedConfigError({ reason: "team-id-not-configured" });
  }
  const teamId = input.env.APPLE_TEAM_ID?.trim().toUpperCase() ?? "";
  if (teamId === "") {
    return yield* new DesktopUpdateFeedConfigError({ reason: "team-id-missing" });
  }
  if (teamId !== ownership.appleTeamId) {
    return yield* new DesktopUpdateFeedConfigError({ reason: "team-id-mismatch" });
  }
});

/**
 * The electron-builder `publish` value for a build: `null` unless it carries a
 * feed. `null`, not an omitted key, is what stops electron-builder deriving a
 * GitHub feed from publish tokens, CI slug variables or a `repository` field.
 * A feed is generic with an explicit channel; without one electron-builder
 * derives `beta` from a -beta.N version and writes beta-mac.yml.
 */
export const resolveDesktopPublishConfig = Effect.fn("resolveDesktopPublishConfig")(function* (
  platform: typeof BuildPlatform.Type,
  version: string,
  feed: DesktopUpdateFeedPlan,
  ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
) {
  if (feed.kind === "none") return null;
  if (platform !== "mac") return yield* new DesktopUpdateFeedConfigError({ reason: "not-mac" });
  if (isDesktopPreviewVersion(version)) {
    return yield* new DesktopUpdateFeedConfigError({ reason: "preview-version" });
  }
  const channel = resolveDesktopUpdateChannel(version);
  if (!ownership.updateChannels.includes(channel)) {
    return yield* new DesktopUpdateFeedConfigError({ reason: "channel-not-enabled" });
  }
  return [{ provider: "generic" as const, url: feed.url, channel }];
});

/**
 * The update policy baked into the packaged package.json. The app accepts its
 * app-update.yml only when both agree and match stark.brand.json.
 */
export function createBakedUpdatePolicy(
  feed: DesktopUpdateFeedPlan,
  version: string,
  ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
): BakedUpdatePolicy {
  if (feed.kind === "none") {
    return { kind: "none", url: null, channels: [], appleTeamId: ownership.appleTeamId };
  }
  const rehearsal = feed.kind === "mock" ? (feed.rehearsal ?? null) : null;
  return {
    kind: feed.kind,
    url: feed.url,
    channels: [resolveDesktopUpdateChannel(version)],
    appleTeamId: ownership.appleTeamId,
    // Only a rehearsal build carries one; everything else leaves the key out.
    ...(rehearsal === null ? {} : { rehearsal }),
  };
}

/**
 * The variables electron-builder reads to pick a publisher or a repository
 * when a build gives it none. Builds never need them, so the packaging
 * environment drops them whatever `publish` says.
 */
const PUBLISH_DETECTION_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "KEYGEN_TOKEN",
  "BITBUCKET_TOKEN",
  "BT_TOKEN",
  "TRAVIS_REPO_SLUG",
  "APPVEYOR_REPO_NAME",
] as const;

export function removePublishDetectionEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const next = { ...env };
  for (const key of PUBLISH_DETECTION_ENV_KEYS) delete next[key];
  for (const key of Object.keys(next)) {
    if (key.startsWith("CIRCLE_PROJECT_")) delete next[key];
  }
  return next;
}

/** The electron-builder afterPack hook that adds `kind` to app-update.yml, relative to the repo root. */
export const DESKTOP_UPDATE_KIND_HOOK = "scripts/bake-desktop-update-kind.ts";

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

// Pull request builds (`-pr.<n>.`) and the maintainers' preview train
// (`-preview.<date>.<run>`) are downloaded by hand and never through an
// updater. Building them without a publish config means electron-builder
// emits no `latest*.yml`/`nightly*.yml` manifests or blockmaps for them and
// the app ships without `app-update.yml`, so neither a stable nor a nightly
// install can be pointed at one of these releases, and the build itself
// reports that no update feed is configured instead of polling.
export function isDesktopPreviewVersion(version: string): boolean {
  return /-pr\./.test(version) || /-preview\.\d{8}\.\d+$/.test(version);
}

export function resolveDesktopWebAssetBrand(version: string): WebAssetBrand {
  return resolveWebAssetBrandForChannel(resolveDesktopUpdateChannel(version));
}

export function resolveDesktopBuildIconAssets(version: string): DesktopBuildIconAssets {
  if (resolveDesktopUpdateChannel(version) === "nightly") {
    return {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    };
  }

  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  };
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}/`;
}

function isPathInside(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

// Electron Builder detects pnpm from npm_config_user_agent, whose value uses
// user-agent syntax (pnpm/11.10.0) rather than packageManager syntax
// (pnpm@11.10.0).
export function resolvePackageManagerUserAgent(packageManager: string): string {
  const trimmed = packageManager.trim();
  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1) {
    return trimmed;
  }

  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`;
}

export function resolveDesktopProductName(version: string): string {
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? `${BRAND.productName} (Nightly)`
    : (desktopPackageJson.productName ?? BRAND.productName);
}

export const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  version: string,
  signed: boolean,
  updateFeed: DesktopUpdateFeedPlan,
  macSigning:
    | {
        readonly mode: MacSignedMode;
        readonly entitlementsPath: string;
        readonly entitlementsInheritPath: string;
        readonly provisioningProfilePath?: string;
      }
    | undefined,
  // Windows only, and false when no Linux CLI archive was handed to the build:
  // staging skips the archive in that case, and listing a resource whose
  // source file was never written fails the electron-builder step.
  wslRuntimeBundled = false,
  arch?: typeof BuildArch.Type,
) {
  const buildConfig: Record<string, unknown> = {
    appId: DESKTOP_APP_ID,
    productName: resolveDesktopProductName(version),
    artifactName: "Stark-Code-${version}-${arch}.${ext}",
    electronLanguages: [...DESKTOP_ELECTRON_LANGUAGES],
    // Encrypt Chromium cookies at rest. Leave RunAsNode unchanged: bundled
    // local services use the Electron runtime as Node.
    electronFuses: { enableCookieEncryption: true },
    files: [
      ...DESKTOP_FILE_EXCLUSIONS,
      ...(platform === "mac"
        ? resolveMacFileExclusions(arch)
        : platform === "linux"
          ? LINUX_FILE_EXCLUSIONS
          : []),
    ],
    directories: {
      buildResources: "apps/desktop/resources",
    },
    // Smart unpack extracts entire native packages, including JavaScript and
    // metadata. Windows keeps those files archived so native dependencies do
    // not inflate the loose-file count and slow NSIS installation.
    ...(platform === "win"
      ? { asar: { smartUnpack: false }, asarUnpack: [WINDOWS_NATIVE_ASAR_UNPACK_GLOB] }
      : {}),
    extraResources: [
      ...DESKTOP_EXTRA_RESOURCES,
      ...(platform === "mac" ? MAC_DICTATION_EXTRA_RESOURCES : []),
      ...(platform === "linux" ? LINUX_CAPTURE_EXTRA_RESOURCES : []),
      ...(platform === "linux" ? LINUX_BROWSER_SECRET_EXTRA_RESOURCES : []),
      ...(platform === "win" ? WINDOWS_SERVER_EXTRA_RESOURCES : []),
      ...(platform === "win" && wslRuntimeBundled ? WSL_RUNTIME_EXTRA_RESOURCES : []),
    ],
  };
  const updateChannel = resolveDesktopUpdateChannel(version);
  // Set on the root and on the platform, which electron-builder reads first.
  const publish = yield* resolveDesktopPublishConfig(platform, version, updateFeed);
  buildConfig.publish = publish;

  if (platform === "mac") {
    const path = yield* Path.Path;
    const repoRoot = yield* RepoRoot;
    if (publish !== null) {
      // Adds the baked feed kind to app-update.yml before the app is signed.
      buildConfig.afterPack = path.join(repoRoot, DESKTOP_UPDATE_KIND_HOOK);
    }
    buildConfig.mac = {
      publish,
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      extendInfo: {
        // macOS 26 offers Messages/Mail codes in every text field unless opted out.
        NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
        NSLocalNetworkUsageDescription:
          "Stark Code connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
        NSScreenCaptureUsageDescription:
          "Stark Code captures the active window when you use the window capture shortcut.",
        NSMicrophoneUsageDescription: "Stark Code uses your microphone when you dictate a message.",
        NSSpeechRecognitionUsageDescription:
          "Stark Code transcribes your dictated messages on this Mac.",
        // macOS lists an app under Default web browser only when it opens web
        // pages as documents as well as http and https links (see protocols).
        CFBundleDocumentTypes: [
          {
            CFBundleTypeName: "Web page",
            CFBundleTypeRole: "Viewer",
            LSHandlerRank: "Alternate",
            LSItemContentTypes: ["public.html", "public.xhtml"],
          },
        ],
      },
      protocols: [
        {
          name: "Stark Code",
          schemes: ["starkcode", "starkcode-dev"],
        },
        // Lets people choose Stark Code as their default web browser, which opens
        // each link in a new thread's browser panel.
        {
          name: "Web site URL",
          schemes: ["http", "https"],
          role: "Viewer",
        },
      ],
      ...(signed ? { sign: path.join(repoRoot, "scripts/sign-macos.ts") } : {}),
      ...(macSigning
        ? {
            // electron-builder skips signing without an error when a custom `sign`
            // finds no identity, so preflightMacSigning and verifyMacSignedApp
            // are what stop an unsigned app.
            hardenedRuntime: true,
            type: macSigning.mode === "development" ? "development" : "distribution",
            // A development rehearsal is never notarized; a Developer ID build always is.
            notarize: macSigning.mode === "developer-id",
            entitlements: macSigning.entitlementsPath,
            entitlementsInherit: macSigning.entitlementsInheritPath,
            ...(macSigning.provisioningProfilePath
              ? { provisioningProfile: macSigning.provisioningProfilePath }
              : {}),
          }
        : {}),
    };
  }

  if (platform === "mac" && target === "dmg") {
    buildConfig.dmg = {
      // Give the themed installer its own Finder volume name. Finder caches
      // DMG window backgrounds by volume name, so reusing a generic name can
      // make a newly built background look unchanged during testing.
      title: `${resolveDesktopProductName(version)} ${version} Installer`,
      background: `dmg/dmg-background-${updateChannel}.png`,
      window: {
        width: 640,
        // The DMG backend derives bounds from the image, including Finder's
        // 32px title bar. Keep the last 32px of the artwork free of content.
        height: 432,
      },
      contents: [
        { x: 166, y: 214, type: "file" },
        { x: 474, y: 214, type: "link", path: "/Applications" },
      ],
      iconSize: 120,
      iconTextSize: 12,
      // Gatekeeper assesses a downloaded DMG by its own signature before the
      // notarization ticket stapled to it counts.
      ...(macSigning?.mode === "developer-id" ? { sign: true } : {}),
    };
  }

  if (platform === "linux") {
    // electron-builder 26 defaults to its legacy AppImage runtime, which
    // dynamically loads the system libfuse2 library. Pin the static runtime so
    // the AppImage also launches on distributions that only provide FUSE 3.
    buildConfig.toolsets = { appimage: "1.0.3" };
    const path = yield* Path.Path;
    const repoRoot = yield* RepoRoot;
    buildConfig.linux = {
      publish,
      // The .deb is built from the same unpacked app after the AppImage.
      // electron-builder lists both in latest-linux.yml and writes
      // resources/package-type into the .deb only, so electron-updater updates
      // each install in its own format.
      target: target === "AppImage" ? [target, "deb"] : [target],
      executableName: "starkcode",
      icon: "icons",
      category: "Development",
      synopsis: "Desktop GUI for coding agents",
      // Required by the .deb control file.
      maintainer: BRAND.companyName,
      // electron-builder turns these into MimeType=x-scheme-handler/<scheme>;
      // in the .desktop entry (Exec already gets %U), so browsers can hand
      // starkcode:// OAuth callbacks to the app.
      protocols: [
        {
          name: "Stark Code",
          schemes: ["starkcode", "starkcode-dev"],
        },
      ],
      desktop: {
        entry: {
          StartupWMClass: "starkcode",
        },
      },
    };
    buildConfig.deb = {
      // FPM runs outside the staged app directory, so source paths must be absolute.
      // AppStream consumers associate this metadata with our starkcode.desktop entry.
      fpm: [
        `${path.join(repoRoot, "apps/desktop/resources/linux/com.starkfuture.starkcode.metainfo.xml")}=/usr/share/metainfo/com.starkfuture.starkcode.metainfo.xml`,
        `${path.join(repoRoot, "LICENSE")}=/usr/share/doc/starkcode/copyright`,
      ],
      // Electron's runtime libraries. Debian 13 and Ubuntu 24.04 renamed some
      // for 64-bit time; the old name is the fallback for older releases.
      depends: [
        "libasound2t64 | libasound2",
        "libatspi2.0-0t64 | libatspi2.0-0",
        "libgbm1",
        "libgtk-3-0t64 | libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libsecret-1-0",
        "libuuid1",
        "libxss1",
        "libxtst6",
        "xdg-utils",
      ],
    };
  }

  if (platform === "win") {
    buildConfig.npmRebuild = false;
    // Keep blockmap-based differential downloads enabled while changing the
    // installed file topology. The optimization is in the payload shape, not
    // in trading update bandwidth for install speed.
    buildConfig.nsis = { differentialPackage: true };
    const winConfig: Record<string, unknown> = {
      publish,
      target: [target],
      icon: "icon.ico",
      // Smart App Control validates unpacked native addons independently from
      // the signed desktop executable. Extend release signing to every native
      // Windows library that Electron or the server sidecar loads at runtime.
      signExts: [".node", ".dll"],
      // Resource editing applies the product metadata and icon independently
      // of code signing. Disabling it for local unsigned builds leaves the
      // packaged executable with Electron's stock icon.
      signAndEditExecutable: true,
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  iconAssets: DesktopBuildIconAssets,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, iconAssets.macIconPng, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir, iconAssets.linuxIconPng, verbose);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir, iconAssets.windowsIconIco);
  }
});

// Copy the Linux CLI release archive into the stage verbatim and record its
// SHA-256 beside it. The desktop app verifies the digest inside the distro
// before extracting, and the digest also names the extracted runtime's cache
// directory, so it must be computed from the exact bytes that ship.
export const stageWslRuntimeArchive = Effect.fn("stageWslRuntimeArchive")(function* (input: {
  readonly sourceArchivePath: string;
  readonly archivePath: string;
  readonly hashPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceExists = yield* fs
    .exists(input.sourceArchivePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!sourceExists) {
    return yield* new WslRuntimeArchiveMissingError({ archivePath: input.sourceArchivePath });
  }
  yield* fs.makeDirectory(path.dirname(input.archivePath), { recursive: true });
  yield* fs.copyFile(input.sourceArchivePath, input.archivePath);
  const hash = NodeCrypto.createHash("sha256");
  yield* fs
    .stream(input.archivePath)
    .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
  const digest = hash.digest("hex");
  yield* fs.writeFileString(input.hashPath, `${digest}\n`);
  yield* Effect.log(
    `[desktop-artifact] Staged WSL runtime archive at ${input.archivePath} (${digest}).`,
  );
});

// Mirrors cliArchiveStem in scripts/build-cli-archive.ts (which imports from
// this module, so it cannot be imported here). WSL runs the same CPU arch as
// the Windows host.
export const wslRuntimeArchiveStem = (version: string, arch: typeof BuildArch.Type): string =>
  `stark-${version}-linux-${arch}`;

export const parseWslRuntimeArchiveMembers = (listing: string): ReadonlyArray<string> =>
  listing
    .split(/\r?\n/)
    .map((member) => member.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((member) => member.length > 0);

// Stage and pack the Windows server sidecar: the bundled server plus a hoisted
// install of only its runtime-external/native dependency closure for win32.
// The Windows primary runs from the archive through the asar-aware
// ELECTRON_RUN_AS_NODE runtime. Shipping one packed archive instead of
// thousands of loose files is what makes the NSIS install/update fast.
export const packWindowsServerAsar = Effect.fn("packWindowsServerAsar")(function* (input: {
  readonly sourceDir: string;
  readonly asarPath: string;
  readonly arch: typeof BuildArch.Type;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Native addons are unpacked only when they are Windows PE ("MZ") binaries.
  // Signed builds Authenticode-sign every unpacked .node file, which fails on
  // the darwin and linux prebuilds some packages (node-pty) ship alongside
  // their win32 ones. The Windows primary never loads those, so they stay packed.
  const unpackGlobs: string[] = [...WINDOWS_SERVER_ASAR_UNPACK_GLOBS];
  for (const entry of yield* fs.readDirectory(input.sourceDir, { recursive: true })) {
    if (!entry.endsWith(".node")) continue;
    const addonPath = path.join(input.sourceDir, entry);
    if ((yield* fs.stat(addonPath)).type !== "File") continue;
    const bytes = yield* fs.readFile(addonPath);
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) continue;
    const posixPath = entry.split(path.sep).join("/");
    // Backslash escapes are path separators to minimatch on Windows.
    if (/[\\*?[\]{}(),]/.test(posixPath)) {
      return yield* new WindowsServerSidecarPackError({
        asarPath: input.asarPath,
        cause: new Error(`native addon path contains glob syntax: ${posixPath}`),
      });
    }
    unpackGlobs.push(`**/${posixPath}`);
  }
  yield* Effect.tryPromise({
    try: () =>
      createPackageWithOptions(input.sourceDir, input.asarPath, {
        dot: true,
        unpack: `{${unpackGlobs.join(",")}}`,
        // glob 13 (via @electron/asar 4) matches `ignore` relative to `cwd`,
        // not against the absolute paths it crawls, so anchor it at the source.
        globOptions: {
          cwd: input.sourceDir,
          ignore: resolveWindowsServerAsarIgnoreGlobs(input.arch),
        },
      }),
    catch: (cause) => new WindowsServerSidecarPackError({ asarPath: input.asarPath, cause }),
  });
  const unpackedDirPath = `${input.asarPath}.unpacked`;
  if (!(yield* fs.exists(unpackedDirPath))) {
    return yield* new WindowsServerSidecarPackError({
      asarPath: input.asarPath,
      cause: new Error(`expected native binaries at ${unpackedDirPath}, but none were unpacked`),
    });
  }
});

export const stageWindowsServerSidecar = Effect.fn("stageWindowsServerSidecar")(function* (input: {
  readonly stageRoot: string;
  readonly repoRoot: string;
  readonly serverDistDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly appVersion: string;
  readonly runtimeExternalDependencies: Record<string, string>;
  readonly fffNodeVersion: string;
  readonly allowBuilds: Record<string, boolean>;
  readonly patchedDependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
  readonly asarPath: string;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const serverStageDir = path.join(input.stageRoot, "server");
  yield* fs.makeDirectory(path.join(serverStageDir, "apps/server"), { recursive: true });
  yield* fs.copy(input.serverDistDir, path.join(serverStageDir, "apps/server/dist"));

  const sidecarDependencies = {
    ...input.runtimeExternalDependencies,
    ...resolveFffNativeDependencies("win", input.arch, input.fffNodeVersion),
  };
  const sidecarPatchedDependencies = createStagePatchedDependencies(
    input.patchedDependencies,
    sidecarDependencies,
  );
  const sidecarPackageJson = {
    name: "starkcode-server",
    version: input.appVersion,
    private: true,
    packageManager: rootPackageJson.packageManager,
    dependencies: sidecarDependencies,
  };
  const sidecarPackageJsonString = yield* encodeJsonString(sidecarPackageJson);
  yield* fs.writeFileString(
    path.join(serverStageDir, "package.json"),
    `${sidecarPackageJsonString}\n`,
  );
  const sidecarWorkspaceConfig = {
    ...createStageWorkspaceConfig({
      platform: "win",
      arch: input.arch,
      allowBuilds: input.allowBuilds,
      patchedDependencies: sidecarPatchedDependencies,
      overrides: input.overrides,
    }),
    // The tree gets packed into server.asar, which cannot carry pnpm's
    // symlink/junction layout, so install a physical, hoisted node_modules.
    nodeLinker: "hoisted" as const,
  };
  const sidecarWorkspaceConfigString = yield* encodeStageWorkspaceConfig(sidecarWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(serverStageDir, "pnpm-workspace.yaml"),
    sidecarWorkspaceConfigString,
  );
  if (Object.keys(sidecarPatchedDependencies).length > 0) {
    yield* fs.copy(path.join(input.repoRoot, "patches"), path.join(serverStageDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing server sidecar runtime externals...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: serverStageDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod (server sidecar)", verbose: input.verbose },
  );

  yield* Effect.log("[desktop-artifact] Packing server.asar...");
  yield* fs.makeDirectory(path.dirname(input.asarPath), { recursive: true });
  yield* packWindowsServerAsar({
    sourceDir: serverStageDir,
    asarPath: input.asarPath,
    arch: input.arch,
  });
  const packedStat = yield* fs.stat(input.asarPath);
  yield* Effect.log(
    `[desktop-artifact] Packed server.asar (${String(packedStat.size)} bytes) + unpacked natives.`,
  );
});

function collectUnpackedAsarFiles(
  directory: DirectoryRecord,
  parentPath = "",
  output: string[] = [],
): readonly string[] {
  for (const [name, entry] of Object.entries(directory.files)) {
    const entryPath = parentPath.length === 0 ? name : `${parentPath}/${name}`;
    if ("files" in entry) {
      collectUnpackedAsarFiles(entry, entryPath, output);
    } else if (entry.unpacked) {
      output.push(entryPath);
    }
  }
  return output;
}

const countPayloadFiles = Effect.fn("desktopArtifact.countPayloadFiles")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pendingDirectories = [root];
  let count = 0;

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (directory === undefined) break;
    const entries = yield* fs.readDirectory(directory);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      const stat = yield* fs.stat(entryPath);
      if (stat.type === "Directory") {
        pendingDirectories.push(entryPath);
      } else if (stat.type === "File") {
        count += 1;
      }
    }
  }

  return count;
});

export const verifyWindowsPrimaryFffNativeLoad = Effect.fn(
  "desktopArtifact.verifyWindowsPrimaryFffNativeLoad",
)(function* (input: {
  readonly packagedAppDir: string;
  readonly asarPath: string;
  readonly appExecutableName: string;
  readonly targetArch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executablePath = path.join(input.packagedAppDir, input.appExecutableName);
  const executableStat = yield* fs.stat(executablePath).pipe(Effect.orElseSucceed(() => null));
  if (executableStat?.type !== "File") {
    return yield* new WindowsPrimaryNativeProbeError({
      executablePath,
      exitCode: -1,
      output: "The unpacked application does not contain its expected primary executable.",
    });
  }
  if (hostPlatform !== "win32" || hostArchitecture !== input.targetArch) return;

  const probeRoot = yield* fs.makeTempDirectoryScoped({
    prefix: "starkcode-windows-primary-native-probe-",
  });
  const fffEntryPath = path.join(input.asarPath, "node_modules/@ff-labs/fff-node/dist/index.js");
  const probeEnv = { ...process.env };
  delete probeEnv.ELECTRON_NO_ASAR;
  delete probeEnv.NODE_OPTIONS;

  yield* runCommand(
    ChildProcess.make(
      executablePath,
      [
        "--no-global-search-paths",
        "--input-type=module",
        "--eval",
        WINDOWS_PRIMARY_FFF_PROBE_SOURCE,
        fffEntryPath,
        probeRoot,
      ],
      {
        cwd: input.packagedAppDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...probeEnv,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_PATH: "",
        },
      },
    ),
    {
      label: "Windows primary fff native-load probe",
      verbose: input.verbose,
    },
  ).pipe(
    Effect.timeout(WINDOWS_PRIMARY_NATIVE_PROBE_TIMEOUT),
    Effect.catchTags({
      TimeoutError: () =>
        Effect.fail(
          new WindowsPrimaryNativeProbeError({
            executablePath,
            exitCode: -1,
            output: `The native-load probe did not finish within ${Duration.toSeconds(WINDOWS_PRIMARY_NATIVE_PROBE_TIMEOUT)}s.`,
          }),
        ),
      BuildCommandFailedError: (error) =>
        Effect.fail(
          new WindowsPrimaryNativeProbeError({
            executablePath,
            exitCode: error.exitCode,
            output: `${error.stderrTail ?? ""}${error.stdoutTail ?? ""}`.trim(),
          }),
        ),
    }),
  );
});

export const validateWindowsPackagedPayload = Effect.fn(
  "desktopArtifact.validateWindowsPackagedPayload",
)(function* (input: {
  readonly stageDistDir: string;
  readonly appExecutableName: string;
  readonly targetArch: typeof BuildArch.Type;
  // The version the embedded Linux CLI archive must carry; its top-level
  // directory is named stark-<version>-linux-<arch>.
  readonly appVersion: string;
  readonly expectWslRuntime?: boolean;
  readonly fileLimit?: number;
  readonly verbose?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fileLimit = input.fileLimit ?? WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT;
  const isFile = (filePath: string) =>
    fs.stat(filePath).pipe(
      Effect.map((stat) => stat.type === "File"),
      Effect.orElseSucceed(() => false),
    );
  const stageEntries = yield* fs.readDirectory(input.stageDistDir);
  let packagedAppDir: string | undefined;

  for (const entry of stageEntries) {
    if (!entry.endsWith("-unpacked")) continue;
    const candidate = path.join(input.stageDistDir, entry);
    const stat = yield* fs.stat(candidate).pipe(Effect.orElseSucceed(() => null));
    if (stat?.type === "Directory") {
      packagedAppDir = candidate;
      break;
    }
  }

  if (packagedAppDir === undefined) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "packaged-app-missing",
      packagedAppDir: path.join(input.stageDistDir, "win-unpacked"),
    });
  }

  const resourcesDir = path.join(packagedAppDir, "resources");
  const asarPath = path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE);
  if (!(yield* fs.exists(asarPath).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "sidecar-missing",
      packagedAppDir,
      missingFiles: [WINDOWS_SERVER_ASAR_RESOURCE],
    });
  }

  const unpackedFiles = yield* Effect.try({
    try: () => {
      // The entry lookup proves the archive contains the server executable,
      // while the single header walk identifies every file ASAR redirects to
      // the unpacked sibling at runtime.
      // @electron/asar resolves entry names using the host path separator.
      // POSIX separators work on Linux/macOS but fail on Windows even when the
      // entry is present in the archive.
      statFile(asarPath, path.join("apps", "server", "dist", "bin.mjs"));
      return [...collectUnpackedAsarFiles(getRawHeader(asarPath).header)].sort();
    },
    catch: (cause) =>
      new WindowsPackagedPayloadValidationError({
        reason: "sidecar-invalid",
        packagedAppDir,
        cause,
      }),
  });
  if (unpackedFiles.length === 0) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "sidecar-invalid",
      packagedAppDir,
      cause: new Error("server.asar does not declare any unpacked native files"),
    });
  }

  const missingFiles: string[] = [];
  for (const unpackedFile of unpackedFiles) {
    const unpackedPath = path.join(
      resourcesDir,
      `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`,
      ...unpackedFile.split("/"),
    );
    if (!(yield* isFile(unpackedPath))) {
      missingFiles.push(`${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked/${unpackedFile}`);
    }
  }
  if (missingFiles.length > 0) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "unpacked-native-missing",
      packagedAppDir,
      missingFiles,
    });
  }

  const resourceMonitorPath = path.join(
    resourcesDir,
    "resource-monitor",
    resourceMonitorExecutableName("win"),
  );
  if (!(yield* isFile(resourceMonitorPath))) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "resource-monitor-missing",
      packagedAppDir,
      missingFiles: ["resource-monitor/stark-resource-monitor.exe"],
    });
  }

  const wslArchivePath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_NAME);
  const wslArchiveHashPath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_HASH_NAME);
  const [hasWslArchive, hasWslArchiveHash] = yield* Effect.all([
    isFile(wslArchivePath),
    isFile(wslArchiveHashPath),
  ]);
  if (input.expectWslRuntime === true && (!hasWslArchive || !hasWslArchiveHash)) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "wsl-runtime-missing",
      packagedAppDir,
      missingFiles: [
        ...(hasWslArchive ? [] : [WSL_RUNTIME_ARCHIVE_NAME]),
        ...(hasWslArchiveHash ? [] : [WSL_RUNTIME_ARCHIVE_HASH_NAME]),
      ],
    });
  }
  if (hasWslArchive !== hasWslArchiveHash) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "wsl-runtime-missing",
      packagedAppDir,
      missingFiles: [hasWslArchive ? WSL_RUNTIME_ARCHIVE_HASH_NAME : WSL_RUNTIME_ARCHIVE_NAME],
    });
  }
  if (hasWslArchive && hasWslArchiveHash) {
    const invalidWslRuntime = (cause: unknown) =>
      new WindowsPackagedPayloadValidationError({
        reason: "wsl-runtime-invalid",
        packagedAppDir,
        cause,
      });
    const recordedHash = yield* fs
      .readFileString(wslArchiveHashPath)
      .pipe(Effect.mapError(invalidWslRuntime));
    const expectedHash = recordedHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
      return yield* invalidWslRuntime(new Error("invalid WSL runtime SHA-256 sidecar"));
    }
    const archiveHash = NodeCrypto.createHash("sha256");
    yield* fs.stream(wslArchivePath).pipe(
      Stream.runForEach((chunk) => Effect.sync(() => archiveHash.update(chunk))),
      Effect.mapError(invalidWslRuntime),
    );
    const actualHash = archiveHash.digest("hex");
    if (actualHash !== expectedHash) {
      return yield* invalidWslRuntime(
        new Error(`WSL runtime SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`),
      );
    }

    const listing = yield* spawnAndCollectOutput(
      ChildProcess.make("tar", ["-tzf", WSL_RUNTIME_ARCHIVE_NAME], {
        cwd: resourcesDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    ).pipe(Effect.mapError(invalidWslRuntime));
    if (listing.exitCode !== 0) {
      return yield* invalidWslRuntime(
        new Error(`tar could not list WSL runtime archive: ${listing.stderr.trim()}`),
      );
    }
    const members = parseWslRuntimeArchiveMembers(listing.stdout);
    // A release archive unpacks to one directory named after its stem; the
    // desktop app's WSL install script relies on that layout to find `stark-code`.
    const stem = wslRuntimeArchiveStem(input.appVersion, input.targetArch);
    const topLevel = new Set(members.map((member) => member.split("/")[0]));
    if (topLevel.size !== 1 || !topLevel.has(stem)) {
      return yield* invalidWslRuntime(
        new Error(
          `WSL runtime archive must contain a single top-level directory ${stem}, found ${[...topLevel].join(", ") || "nothing"}`,
        ),
      );
    }
    const requiredMembers = [`${stem}/stark-code`, `${stem}/client`, `${stem}/node_modules`];
    const missingMembers = requiredMembers.filter((member) => !members.includes(member));
    // node-pty can load a source build or the prebuild for the WSL target.
    const ptyCandidates = [
      `${stem}/node_modules/node-pty/build/Release/pty.node`,
      `${stem}/node_modules/node-pty/prebuilds/linux-${input.targetArch}/pty.node`,
    ];
    if (!ptyCandidates.some((member) => members.includes(member))) {
      missingMembers.push(...ptyCandidates);
    }
    if (missingMembers.length > 0) {
      return yield* new WindowsPackagedPayloadValidationError({
        reason: "wsl-runtime-invalid",
        packagedAppDir,
        missingFiles: missingMembers,
        cause: new Error("WSL runtime archive is not a Linux CLI release archive"),
      });
    }
    // The CLI archive runs the single-executable, never a loose server bundle.
    const bundleEntry = members.find((member) => member.endsWith("/bin.mjs"));
    if (bundleEntry !== undefined) {
      return yield* invalidWslRuntime(
        new Error(`WSL runtime archive contains a server bundle entry ${bundleEntry}`),
      );
    }
  }

  const fileCount = yield* countPayloadFiles(packagedAppDir);
  if (fileCount > fileLimit) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "file-limit-exceeded",
      packagedAppDir,
      fileCount,
      fileLimit,
    });
  }

  yield* verifyWindowsPrimaryFffNativeLoad({
    packagedAppDir,
    asarPath,
    appExecutableName: input.appExecutableName,
    targetArch: input.targetArch,
    verbose: input.verbose ?? false,
  });

  yield* verifyPackagedBundleIsSelfContained({
    asarPath,
    verbose: input.verbose ?? false,
  });

  yield* Effect.log(
    `[desktop-artifact] Validated Windows payload (${String(fileCount)} files, ${String(unpackedFiles.length)} sidecar natives).`,
  );
  return { packagedAppDir, fileCount, unpackedFiles } as const;
});

export class MissingMacNotarizationKeyFileError extends Schema.TaggedError<MissingMacNotarizationKeyFileError>()(
  "MissingMacNotarizationKeyFileError",
  {},
) {
  override get message(): string {
    return "APPLE_API_KEY must be the path of the App Store Connect AuthKey_<key id>.p8 file, and no file exists at that path.";
  }
}

/**
 * Checks what can be checked about signing before packaging: the API key file
 * exists, and a CSC_NAME qualifier resolves in the login keychain to the
 * certificate kind the mode needs, the way electron-builder will resolve it.
 * Returns that keychain identity, which the signed app must then carry.
 */
export const preflightMacSigning = Effect.fn("preflightMacSigning")(function* (input: {
  readonly plan: MacSigningPlan;
  readonly env: Readonly<Record<string, string | undefined>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const { plan } = input;
  if (plan.notarization === "api-key") {
    const keyPath = input.env.APPLE_API_KEY?.trim() ?? "";
    const keyExists = keyPath
      ? yield* fs.exists(keyPath).pipe(Effect.orElseSucceed(() => false))
      : false;
    if (!keyExists) return yield* new MissingMacNotarizationKeyFileError();
  }
  if (plan.mode === "unsigned" || plan.keychainIdentity === undefined) return undefined;

  const allIdentities = yield* spawnAndCollectOutput(
    ChildProcess.make("/usr/bin/security", ["find-identity", "-v"]),
  );
  const codesigningIdentities = yield* spawnAndCollectOutput(
    ChildProcess.make("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]),
  );
  const identity = selectMacSigningIdentity(
    parseMacSigningIdentities(allIdentities.stdout, codesigningIdentities.stdout),
    plan.mode,
    plan.keychainIdentity,
  );
  if (identity === undefined) return yield* new MacSigningIdentityNotFoundError();
  const selectedKind = classifyMacSigningCertificate(identity.name);
  if (selectedKind !== plan.mode) {
    return yield* new MacSigningIdentityMismatchError({ mode: plan.mode, selectedKind });
  }
  return identity;
});

export interface MacAppReleaseVerification {
  readonly authority: string | null;
  readonly teamId: string | null;
  readonly hardenedRuntime: boolean;
  readonly timestamped: boolean;
  readonly appStapled: boolean;
  /** spctl's `source`, such as "Notarized Developer ID"; null when not assessed. */
  readonly gatekeeper: string | null;
}

/**
 * Verifies the app electron-builder signed, while its stage still exists.
 * Only a developer-id build runs stapler and Gatekeeper, so a development
 * rehearsal never has to pass as Notarized Developer ID.
 */
export const verifyMacSignedApp = Effect.fn("verifyMacSignedApp")(function* (input: {
  readonly appPath: string;
  readonly mode: MacSignedMode;
  readonly expectedIdentityName: string | undefined;
  readonly expectedTeamId: string | undefined;
}) {
  const verification = yield* spawnAndCollectOutput(
    ChildProcess.make("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      input.appPath,
    ]),
  );
  const display = yield* spawnAndCollectOutput(
    ChildProcess.make("/usr/bin/codesign", ["--display", "--verbose=2", input.appPath]),
  );
  const signature = parseMacCodeSignature(`${display.stdout}\n${display.stderr}`);

  let stapled: boolean | undefined;
  let gatekeeper: GatekeeperAssessment | undefined;
  if (input.mode === "developer-id") {
    stapled = isStaplerValidation(
      yield* spawnAndCollectOutput(
        ChildProcess.make("/usr/bin/xcrun", ["stapler", "validate", input.appPath]),
      ),
    );
    const assessment = yield* spawnAndCollectOutput(
      ChildProcess.make("/usr/sbin/spctl", [
        "--assess",
        "--type",
        "execute",
        "--verbose=2",
        input.appPath,
      ]),
    );
    gatekeeper = parseGatekeeperAssessment(`${assessment.stdout}\n${assessment.stderr}`);
  }

  const failures = findMacAppVerificationFailures({
    mode: input.mode,
    expectedIdentityName: input.expectedIdentityName,
    expectedTeamId: input.expectedTeamId,
    signatureValid: verification.exitCode === 0,
    signature,
    stapled,
    gatekeeper,
  });
  if (failures.length > 0) {
    return yield* new MacReleaseVerificationError({ artifact: "app", mode: input.mode, failures });
  }
  const result: MacAppReleaseVerification = {
    authority: signature.authorities[0] ?? null,
    teamId: signature.teamIdentifier ?? null,
    hardenedRuntime: signature.hardenedRuntime,
    timestamped: signature.timestamped,
    appStapled: stapled === true,
    gatekeeper: gatekeeper?.source ?? null,
  };
  return result;
});

const digestFile = Effect.fn("digestFile")(function* (
  filePath: string,
  algorithm: "sha256" | "sha512",
  encoding: "hex" | "base64",
) {
  const fs = yield* FileSystem.FileSystem;
  const hash = NodeCrypto.createHash(algorithm);
  let bytes = 0;
  yield* fs.stream(filePath).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        hash.update(chunk);
        bytes += chunk.byteLength;
      }),
    ),
  );
  return { bytes, digest: hash.digest(encoding) };
});

class MacDmgMetadataRefreshError extends Schema.TaggedError<MacDmgMetadataRefreshError>()(
  "MacDmgMetadataRefreshError",
  {
    file: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not rebuild the block map of ${this.file} after stapling.`;
  }
}

const isBlockMapModule = (
  value: unknown,
): value is {
  readonly buildBlockMap: (file: string, compression: "gzip", outFile: string) => Promise<unknown>;
} =>
  typeof value === "object" &&
  value !== null &&
  "buildBlockMap" in value &&
  typeof value.buildBlockMap === "function";

// electron-builder's own writer, so a rebuilt block map matches the ones it emits.
const loadElectronBuilderBlockMapWriter = (desktopPackageJsonPath: string) => {
  const desktopRequire = NodeModule.createRequire(desktopPackageJsonPath);
  const builderRequire = NodeModule.createRequire(desktopRequire.resolve("electron-builder"));
  const blockMap: unknown = builderRequire("app-builder-lib/out/targets/blockmap/blockmap.js");
  if (!isBlockMapModule(blockMap)) {
    throw new Error("app-builder-lib no longer exports buildBlockMap.");
  }
  return blockMap.buildBlockMap;
};

/**
 * Rebuilds what electron-builder derived from a DMG after the DMG changed: its
 * block map and its digest in every update manifest beside it.
 */
const refreshMacDmgUpdateMetadata = Effect.fn("refreshMacDmgUpdateMetadata")(function* (input: {
  readonly dmgPath: string;
  readonly stageDistDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const dmgName = path.basename(input.dmgPath);
  const blockMapPath = `${input.dmgPath}.blockmap`;
  if (yield* fs.exists(blockMapPath)) {
    yield* Effect.tryPromise({
      try: () =>
        loadElectronBuilderBlockMapWriter(path.join(repoRoot, "apps/desktop/package.json"))(
          input.dmgPath,
          "gzip",
          blockMapPath,
        ),
      catch: (cause) => new MacDmgMetadataRefreshError({ file: dmgName, cause }),
    });
  }

  const { bytes, digest } = yield* digestFile(input.dmgPath, "sha512", "base64");
  for (const entry of yield* fs.readDirectory(input.stageDistDir)) {
    if (!entry.endsWith(".yml") || entry.startsWith("builder-")) continue;
    const manifestPath = path.join(input.stageDistDir, entry);
    const manifest = yield* fs.readFileString(manifestPath);
    const refreshed = replaceUpdateManifestFileDigest(manifest, {
      url: dmgName,
      sha512: digest,
      size: bytes,
    });
    if (refreshed !== manifest) yield* fs.writeFileString(manifestPath, refreshed);
  }
});

/** Stamps `starkFeedKind: mock` into every channel manifest a mock build wrote. */
export const markMockFeedManifests = Effect.fn("markMockFeedManifests")(function* (
  stageDistDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const entry of yield* fs.readDirectory(stageDistDir)) {
    if (!entry.endsWith(".yml") || entry.startsWith("builder-")) continue;
    const manifestPath = path.join(stageDistDir, entry);
    const manifest = yield* fs.readFileString(manifestPath);
    const marked = withMockFeedKind(manifest);
    if (marked !== manifest) yield* fs.writeFileString(manifestPath, marked);
  }
});

export class MacNotarizationCommandError extends Schema.TaggedError<MacNotarizationCommandError>()(
  "MacNotarizationCommandError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `xcrun notarytool could not run (${this.reason}). Its arguments are not shown because they carry the notarization credentials.`;
  }
}

/**
 * Notarizes, staples and checks a Developer ID DMG, then rebuilds the metadata
 * electron-builder derived from it. Stapling rewrites the DMG after
 * electron-builder hashed it, so the block map and manifest digests are
 * recomputed from the final bytes before anything is copied out or recorded.
 */
export const finalizeMacDmg = Effect.fn("finalizeMacDmg")(function* (input: {
  readonly dmgPath: string;
  readonly stageDistDir: string;
  readonly notarization: MacNotarizationCredential;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly verbose: boolean;
}) {
  const path = yield* Path.Path;
  const dmgName = path.basename(input.dmgPath);
  yield* Effect.log(`[desktop-artifact] Notarizing ${dmgName}; this waits for Apple...`);
  const submission = yield* spawnAndCollectOutput(
    ChildProcess.make("/usr/bin/xcrun", [
      "notarytool",
      "submit",
      input.dmgPath,
      "--wait",
      "--output-format",
      "json",
      ...notarytoolCredentialArguments(input.notarization, input.env),
    ]),
  ).pipe(
    // A spawn error quotes the whole command line, credentials included.
    Effect.mapError((error) => new MacNotarizationCommandError({ reason: error.reason._tag })),
  );
  const { id, status } = parseNotarySubmission(submission.stdout);
  if (submission.exitCode !== 0 || status !== "Accepted") {
    return yield* new MacReleaseVerificationError({
      artifact: "dmg",
      mode: "developer-id",
      failures: ["notarization-rejected"],
      ...(id ? { notarySubmissionId: id } : {}),
    });
  }

  yield* runCommand(ChildProcess.make("/usr/bin/xcrun", ["stapler", "staple", input.dmgPath]), {
    label: `xcrun stapler staple ${dmgName}`,
    verbose: input.verbose,
  });
  const stapled = isStaplerValidation(
    yield* spawnAndCollectOutput(
      ChildProcess.make("/usr/bin/xcrun", ["stapler", "validate", input.dmgPath]),
    ),
  );
  const assessment = yield* spawnAndCollectOutput(
    ChildProcess.make("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=2",
      input.dmgPath,
    ]),
  );
  const failures: MacReleaseCheck[] = [];
  if (!stapled) failures.push("not-stapled");
  if (
    !isGatekeeperNotarized(parseGatekeeperAssessment(`${assessment.stdout}\n${assessment.stderr}`))
  ) {
    failures.push("gatekeeper-rejected");
  }
  if (failures.length > 0) {
    return yield* new MacReleaseVerificationError({
      artifact: "dmg",
      mode: "developer-id",
      failures,
    });
  }

  yield* refreshMacDmgUpdateMetadata({ dmgPath: input.dmgPath, stageDistDir: input.stageDistDir });
});

const PackagedDesktopUpdateFeedReason = Schema.Literals([
  "unexpected-app-update",
  "app-update-missing",
  "app-update-mismatch",
  "requirement-not-pinned",
  "requirement-identifier",
]);

/** The packaged app does not carry exactly the update feed and signature the build asked for. */
export class PackagedDesktopUpdateFeedError extends Schema.TaggedError<PackagedDesktopUpdateFeedError>()(
  "PackagedDesktopUpdateFeedError",
  {
    reason: PackagedDesktopUpdateFeedReason,
    file: Schema.String,
    problem: Schema.optionalKey(Schema.Literals(STARK_UPDATE_FEED_PROBLEMS)),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unexpected-app-update":
        return `${this.file} exists, but this build carries no update feed. electron-builder derived one; refusing to ship it.`;
      case "app-update-missing":
        return `No app-update.yml was packaged, but this build carries an update feed (${this.file}).`;
      case "app-update-mismatch":
        return `${this.file} is not the update feed this build baked (${this.problem ?? "mismatch"}).`;
      case "requirement-not-pinned":
        return `The designated requirement of ${this.file} does not pin the bundle id and the Stark team.`;
      case "requirement-identifier":
        return `The designated requirement of ${this.file} does not name the Stark bundle id.`;
    }
  }
}

export interface PackagedUpdateFeedEvidence {
  /** app-update.yml relative to the stage dist directory, or null for a build without a feed. */
  readonly file: string | null;
  readonly sha256: string | null;
}

/**
 * Reads every app-update.yml electron-builder packaged (in a macOS .app's
 * Resources, or `resources/` of an unpacked Linux or Windows app) and checks
 * it with the code the app uses at runtime. A build without a feed must have
 * none; a build with one must have exactly the baked feed.
 */
export const verifyPackagedUpdateFeed = Effect.fn("verifyPackagedUpdateFeed")(function* (
  input: { readonly stageDistDir: string; readonly policy: BakedUpdatePolicy },
  ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates: string[] = [];
  for (const entry of (yield* fs.readDirectory(input.stageDistDir)).toSorted()) {
    const entryPath = path.join(input.stageDistDir, entry);
    const stat = yield* fs.stat(entryPath).pipe(Effect.orElseSucceed(() => null));
    if (stat?.type !== "Directory") continue;
    candidates.push(path.join(entryPath, "resources", "app-update.yml"));
    for (const child of (yield* fs.readDirectory(entryPath)).toSorted()) {
      if (child.endsWith(".app")) {
        candidates.push(path.join(entryPath, child, "Contents", "Resources", "app-update.yml"));
      }
    }
  }
  const found: string[] = [];
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) found.push(candidate);
  }
  const relative = (file: string) => path.relative(input.stageDistDir, file);
  if (input.policy.kind === "none") {
    const [unexpected] = found;
    if (unexpected !== undefined) {
      return yield* new PackagedDesktopUpdateFeedError({
        reason: "unexpected-app-update",
        file: relative(unexpected),
      });
    }
    const none: PackagedUpdateFeedEvidence = { file: null, sha256: null };
    return none;
  }
  const [first] = found;
  if (first === undefined) {
    return yield* new PackagedDesktopUpdateFeedError({
      reason: "app-update-missing",
      file: input.stageDistDir,
    });
  }
  for (const file of found) {
    const validation = validateStarkUpdateFeed(
      yield* fs.readFileString(file),
      input.policy,
      ownership,
    );
    if (!validation.ok) {
      return yield* new PackagedDesktopUpdateFeedError({
        reason: "app-update-mismatch",
        file: relative(file),
        problem: validation.problem,
      });
    }
  }
  const evidence: PackagedUpdateFeedEvidence = {
    file: relative(first),
    sha256: (yield* digestFile(first, "sha256", "hex")).digest,
  };
  return evidence;
});

/**
 * Reads the signed app's designated requirement, which Squirrel.Mac holds
 * every update to. A Stark feed build must pin the bundle id and the
 * checked-in team; every signed build must at least name the bundle id.
 */
export const verifyMacDesignatedRequirement = Effect.fn("verifyMacDesignatedRequirement")(
  function* (
    input: { readonly appPath: string; readonly feed: DesktopUpdateFeedPlan },
    ownership: UpdateOwnership = STARK_UPDATE_OWNERSHIP,
  ) {
    const display = yield* spawnAndCollectOutput(
      ChildProcess.make("/usr/bin/codesign", ["--display", "-r-", input.appPath]),
    );
    const requirement = parseDesignatedRequirement(`${display.stdout}\n${display.stderr}`);
    const file = input.appPath;
    if (input.feed.kind === "stark") {
      const teamId = ownership.appleTeamId;
      if (
        teamId === null ||
        !requirementPinsIdentity(requirement, { bundleId: ownership.bundleId, teamId })
      ) {
        return yield* new PackagedDesktopUpdateFeedError({
          reason: "requirement-not-pinned",
          file,
        });
      }
    } else if (requirement.identifier !== ownership.bundleId) {
      return yield* new PackagedDesktopUpdateFeedError({ reason: "requirement-identifier", file });
    }
    return requirement;
  },
);

/** What release-proof.json records about the update feed, from the packaged files. */
export interface DesktopReleaseFeed {
  readonly kind: BakedUpdatePolicy["kind"];
  readonly url: string | null;
  readonly channel: string | null;
  readonly policy: BakedUpdatePolicy;
  readonly appUpdateYml: PackagedUpdateFeedEvidence;
}

export function describeDesktopReleaseFeed(
  policy: BakedUpdatePolicy,
  appUpdateYml: PackagedUpdateFeedEvidence,
): DesktopReleaseFeed {
  return {
    kind: policy.kind,
    url: policy.url,
    channel: policy.channels[0] ?? null,
    policy,
    appUpdateYml,
  };
}

export interface DesktopReleaseArtifact {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * The contents of release-proof.json. It names the signing certificate and
 * which credential set notarized the build, never a credential value.
 */
export function createDesktopReleaseProof(input: {
  readonly version: string;
  readonly arch: typeof BuildArch.Type;
  readonly commit: string;
  readonly builtAt: string;
  readonly feed: DesktopReleaseFeed;
  readonly artifacts: ReadonlyArray<DesktopReleaseArtifact>;
  readonly plan: MacSigningPlan;
  readonly app: MacAppReleaseVerification | undefined;
  /** `codesign -d -r-` of the signed app, or undefined when it is unsigned. */
  readonly requirement: string | undefined;
  readonly dmgStapled: boolean;
  readonly ownership?: UpdateOwnership;
}) {
  const ownership = input.ownership ?? STARK_UPDATE_OWNERSHIP;
  const teamId = ownership.appleTeamId;
  const teamPinned =
    teamId !== null &&
    input.app?.teamId === teamId &&
    input.requirement !== undefined &&
    requirementPinsIdentity(parseDesignatedRequirement(`designated => ${input.requirement}`), {
      bundleId: ownership.bundleId,
      teamId,
    });
  return {
    schema: 1,
    version: input.version,
    channel: resolveDesktopUpdateChannel(input.version),
    arch: input.arch,
    commit: input.commit,
    builtAt: input.builtAt,
    feed: input.feed,
    artifacts: input.artifacts,
    mac: {
      signingMode: input.plan.mode,
      identitySource: input.plan.identitySource ?? null,
      notarization: input.plan.notarization ?? null,
      authority: input.app?.authority ?? null,
      teamId: input.app?.teamId ?? null,
      hardenedRuntime: input.app?.hardenedRuntime ?? false,
      timestamped: input.app?.timestamped ?? false,
      appStapled: input.app?.appStapled ?? false,
      dmgStapled: input.dmgStapled,
      gatekeeper: input.app?.gatekeeper ?? null,
      designatedRequirement: input.requirement ?? null,
      teamPinned,
      // Only a notarized Developer ID build of the checked-in team, whose
      // requirement pins that team, on a Stark feed or explicitly without
      // one, is fit for another Mac.
      distributable:
        input.plan.mode === "developer-id" &&
        input.app?.appStapled === true &&
        input.app.gatekeeper === NOTARIZED_DEVELOPER_ID_SOURCE &&
        (input.feed.kind === "stark" || input.feed.kind === "none") &&
        teamPinned,
    },
  };
}

export const RELEASE_PROOF_FILE_NAME = "release-proof.json";
const encodeReleaseProof = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

/**
 * Writes release-proof.json beside the artifacts. It hashes the files as they
 * were finally copied out, so it must run after every artifact mutation.
 */
export const writeDesktopReleaseProof = Effect.fn("writeDesktopReleaseProof")(function* (
  input: Omit<Parameters<typeof createDesktopReleaseProof>[0], "artifacts" | "builtAt"> & {
    readonly outputDir: string;
    readonly artifactPaths: ReadonlyArray<string>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const artifacts: DesktopReleaseArtifact[] = [];
  for (const artifactPath of input.artifactPaths) {
    const { bytes, digest } = yield* digestFile(artifactPath, "sha256", "hex");
    artifacts.push({ file: path.basename(artifactPath), bytes, sha256: digest });
  }
  const proof = createDesktopReleaseProof({
    ...input,
    builtAt: DateTime.formatIso(yield* DateTime.now),
    artifacts,
  });
  const proofPath = path.join(input.outputDir, RELEASE_PROOF_FILE_NAME);
  yield* fs.writeFileString(proofPath, `${yield* encodeReleaseProof(proof)}\n`);
  return proofPath;
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcess.Platform;
  if (hostPlatform === "linux" && options.platform === "linux") {
    yield* preflightLinuxDesktopBuild(options.arch);
  }
  if (hostPlatform === "darwin" && options.platform === "mac") {
    yield* preflightMacDesktopBuild(options.arch);
  }
  if (hostPlatform === "win32" && options.platform === "win") {
    yield* preflightWindowsDesktopBuild({
      arch: options.arch,
      bundlesWslRuntime: bundlesWslRuntime({
        platform: options.platform,
        runtimeArchivePath: options.wslRuntime,
      }),
    });
  }
  // Signing credentials are read from the process environment only, never
  // from the repo .env files that worktree setup links everywhere.
  const macSigningPlan =
    options.platform === "mac"
      ? yield* resolveMacSigningPlan({ signed: options.signed, env: process.env })
      : undefined;
  const macSigningIdentity =
    macSigningPlan && hostPlatform === "darwin"
      ? yield* preflightMacSigning({ plan: macSigningPlan, env: process.env })
      : undefined;
  if (macSigningPlan) {
    yield* Effect.log(
      `[desktop-artifact] macOS signing: ${macSigningPlan.mode}${macSigningPlan.notarization ? `, notarized with the ${macSigningPlan.notarization} credentials` : ""}.`,
    );
  }
  yield* checkDesktopUpdateFeedSigning({
    feed: options.updateFeed,
    platform: options.platform,
    plan: macSigningPlan,
    env: process.env,
  });
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const workspaceAllowBuilds = workspaceConfig.allowBuilds ?? {};

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new UnsupportedDesktopBuildPlatformError({
      platform: options.platform,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new MissingServerProductionDependenciesError({
      manifestPath: "apps/server/package.json",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () => resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/desktop"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "workspace-overrides",
        manifestPath: "pnpm-workspace.yaml",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () => resolveCatalogDependencies(serverDependencies, workspaceCatalog, "apps/server"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "server-production",
        manifestPath: "apps/server/package.json",
        cause,
      }),
  });
  const resolvedServerRuntimeExternalDependencies = selectCliRuntimeExternalDependencies(
    resolvedServerDependencies,
  );
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "desktop-runtime",
        manifestPath: "apps/desktop/package.json",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  // Fails before staging when this version cannot carry the requested feed.
  yield* resolveDesktopPublishConfig(options.platform, appVersion, options.updateFeed);
  const bakedUpdatePolicy = createBakedUpdatePolicy(options.updateFeed, appVersion);
  yield* Effect.log(
    `[desktop-artifact] Update feed: ${options.updateFeed.kind === "none" ? "none (the app never checks for updates)" : `${options.updateFeed.kind} ${options.updateFeed.url}`}.`,
  );
  const rehearsal = bakedUpdatePolicy.rehearsal ?? null;
  if (rehearsal !== null) {
    yield* Effect.log(
      `[desktop-artifact] Update rehearsal: profile ${rehearsal.profile ?? "none"}, fault ${rehearsal.fault ?? "none"}.`,
    );
  }
  const iconAssets = resolveDesktopBuildIconAssets(appVersion);
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `starkcode-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  yield* Effect.try({
    try: () => prepareStarkWorkbench({ force: true }),
    catch: (cause) => new StarkWorkbenchBundlePreparationError({ cause }),
  });
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    const spawnCommand = yield* resolveSpawnCommand("vp", ["run", "build:desktop"]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: repoRoot,
        shell: spawnCommand.shell,
      }),
      { label: "vp run build:desktop", verbose: options.verbose },
    );
  }

  const requiredBuildInputs = [
    { artifact: "desktop-dist", artifactPath: distDirs.desktopDist },
    { artifact: "desktop-resources", artifactPath: distDirs.desktopResources },
    { artifact: "server-dist", artifactPath: distDirs.serverDist },
  ] as const;
  for (const input of requiredBuildInputs) {
    if (!(yield* fs.exists(input.artifactPath))) {
      return yield* new MissingDesktopBuildInputError({
        ...input,
        buildCommand: "vp run build:desktop",
      });
    }
  }

  // Assert against the emitted bundle, not the bundler config. `alwaysBundle`
  // only forces packages IN, so a transitive dependency of an external package
  // is bundled by default however the predicate is written — that silently
  // inlined a native loader (node-gyp-build-optional-packages) while every
  // list-based test still passed. An inlined native loader resolves its
  // prebuilds relative to the bundle and quietly falls back to a slower
  // pure-JS path, so this fails the build rather than shipping a silent
  // regression.
  {
    const chunkNames = (yield* fs.readDirectory(distDirs.serverDist)).filter((entry) =>
      entry.endsWith(".mjs"),
    );
    let totalRegions = 0;
    const inlined = new Set<string>();
    const inlinedPackages = new Set<string>();
    for (const chunkName of chunkNames) {
      const source = yield* fs.readFileString(path.join(distDirs.serverDist, chunkName));
      const scan = findInlinedExternalPackages(source);
      totalRegions += scan.regionCount;
      for (const name of scan.inlined) inlined.add(name);
      for (const name of scan.inlinedPackages) inlinedPackages.add(name);
    }
    if (inlined.size > 0) {
      return yield* new InlinedExternalPackageError({
        packages: [...inlined].sort(),
      });
    }
    // No regions at all means the scan went blind (marker format changed), not
    // that the bundle is clean.
    if (totalRegions === 0) {
      return yield* new InlinedExternalPackageError({
        packages: ["<no module regions found; the bundle scan needs updating>"],
      });
    }
    // The check above is one-directional: it only proves nothing external got
    // inlined. A regression to externalizing everything would also pass it,
    // since source-file regions still exist -- and that is the failure this
    // whole change exists to prevent, because those packages are not in the
    // selected sidecar closure and both backends would die on ERR_MODULE_NOT_FOUND.
    // `effect` is imported by every server module, so it is inlined in any
    // correctly bundled build.
    // The list-based check above only sees packages someone already thought to
    // list. bufferutil and utf-8-validate were inlined for exactly that reason:
    // native, but absent from the list, so nothing flagged them. Ask the store
    // what each inlined package actually is instead.
    const nativeInlined: string[] = [];
    for (const name of [...inlinedPackages].sort()) {
      const packageDir = yield* findStorePackageDirectory(repoRoot, name);
      if (packageDir === null) continue;
      if (yield* hasNativeLoaderMarkers(packageDir)) nativeInlined.push(name);
    }
    if (nativeInlined.length > 0) {
      return yield* new InlinedNativePackageError({ packages: nativeInlined });
    }

    if (!inlinedPackages.has(BUNDLE_SELF_CONTAINED_SENTINEL)) {
      return yield* new ExternalizedBundleError({
        sentinel: BUNDLE_SELF_CONTAINED_SENTINEL,
        inlinedPackageCount: inlinedPackages.size,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new MissingDesktopBuildInputError({
      artifact: "bundled-server-client",
      artifactPath: bundledClientEntry,
      buildCommand: "vp run build:desktop",
    });
  }

  const webAssetBrand = resolveDesktopWebAssetBrand(appVersion);
  yield* applyWebBrandAssets(webAssetBrand, "apps/server/dist/client");
  yield* Effect.log(`[desktop-artifact] Applied ${webAssetBrand} web client branding.`);
  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  if (options.platform !== "win") {
    yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });
  }

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  if (options.platform === "linux") {
    const extensionDir = path.join(stageAppDir, "apps/desktop/gnome-extension");
    yield* fs.makeDirectory(extensionDir, { recursive: true });
    for (const file of gnomeCaptureBundle.files) {
      yield* fs.copyFile(
        path.join(repoRoot, "apps/desktop/gnome-extension", file),
        path.join(extensionDir, file),
      );
    }
  }
  if (options.platform === "mac" && options.target === "dmg") {
    yield* stageDesktopDmgBackground(
      stageResourcesDir,
      resolveDesktopUpdateChannel(appVersion),
      options.verbose,
    );
  }
  // On Windows the server tree ships in the server.asar sidecar instead of
  // app.asar (see stageWindowsServerSidecar), so the app stage omits it.
  if (options.platform !== "win") {
    yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  }
  yield* stageResourceMonitor({
    repoRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
    verbose: options.verbose,
  });
  if (options.platform === "linux") {
    for (const backend of ["kde", "hyprland"] as const)
      yield* stageLinuxCaptureHelper({
        backend,
        repoRoot,
        stageResourcesDir,
        arch: options.arch,
        verbose: options.verbose,
      });
  }
  yield* stageBrowserSecret({
    repoRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
    verbose: options.verbose,
  });
  yield* stageDictation({
    repoRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
    verbose: options.verbose,
  });

  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      macIconPng: path.join(repoRoot, iconAssets.macIconPng),
      linuxIconPng: path.join(repoRoot, iconAssets.linuxIconPng),
      windowsIconIco: path.join(repoRoot, iconAssets.windowsIconIco),
    },
    options.verbose,
  );

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  const stageProdResourcesDir = path.join(stageAppDir, "apps/desktop/prod-resources");
  yield* fs.copy(stageResourcesDir, stageProdResourcesDir);

  const macPasskeyEnv =
    options.platform === "mac" && options.signed ? loadRepoEnv({ repoRoot }) : undefined;
  const configuredMacPasskeySigning =
    macPasskeyEnv && isMacPasskeySigningRequested(macPasskeyEnv)
      ? yield* Effect.try({
          try: () => resolveMacPasskeySigningConfiguration(macPasskeyEnv),
          catch: MacPasskeySigningConfigurationResolutionError.fromCause,
        })
      : undefined;
  const macPasskeySigning = configuredMacPasskeySigning
    ? {
        ...configuredMacPasskeySigning,
        provisioningProfilePath: path.resolve(
          repoRoot,
          configuredMacPasskeySigning.provisioningProfilePath,
        ),
      }
    : undefined;
  const macEntitlementsPath = macPasskeySigning
    ? path.join(stageAppDir, "entitlements.mac.plist")
    : undefined;
  let macWebAuthn: MacWebAuthnEntitlements | undefined;
  if (macPasskeySigning && macEntitlementsPath) {
    if (!(yield* fs.exists(macPasskeySigning.provisioningProfilePath))) {
      return yield* new MacProvisioningProfileNotFoundError({
        provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
      });
    }
    macWebAuthn = resolveMacWebAuthnEntitlements(
      yield* fs.readFileString(macPasskeySigning.provisioningProfilePath),
      macPasskeySigning,
    );
    yield* Effect.log(
      `[desktop-artifact] In-app browser passkeys: Touch ID ${macWebAuthn.touchIdKeychainAccessGroup ? "enabled" : "disabled"}, browser passkeys ${macWebAuthn.browserPasskeys ? "enabled" : "disabled"}.`,
    );
    yield* fs.writeFileString(
      macEntitlementsPath,
      renderMacPasskeyEntitlements(macPasskeySigning, macWebAuthn),
    );
  }

  // Windows splits dependencies per process: app.asar carries only the
  // desktop main-process externals, while the server bundle's externals live
  // in the server.asar sidecar (see stageWindowsServerSidecar). macOS and
  // Linux merge both sets into one app.asar.
  const stageDependencies =
    options.platform === "win"
      ? { ...resolvedDesktopRuntimeDependencies }
      : resolveMergedStageDependencies({
          platform: options.platform,
          serverDependencies: resolvedServerDependencies,
          desktopDependencies: resolvedDesktopRuntimeDependencies,
          arch: options.arch,
          fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
        });
  const stagePatchedDependencies = createStagePatchedDependencies(
    workspacePatchedDependencies,
    stageDependencies,
  );
  const windowsServerAsarPath =
    options.platform === "win"
      ? path.join(stageAppDir, WINDOWS_SERVER_RESOURCE_SOURCE_DIR, WINDOWS_SERVER_ASAR_RESOURCE)
      : undefined;
  const stagePackageJson: StagePackageJson = {
    name: "starkcode",
    version: appVersion,
    buildVersion: appVersion,
    starkcodeCommitHash: commitHash,
    // Read by apps/desktop/src/preview/Passkeys.ts; must match the signed entitlements.
    ...(macWebAuthn ? { starkcodeWebAuthn: macWebAuthn } : {}),
    [BAKED_UPDATE_POLICY_KEY]: bakedUpdatePolicy,
    private: true,
    packageManager: rootPackageJson.packageManager,
    description:
      "Stark Code is an open-source desktop app for coding agents. Work with your existing agent subscriptions, review code changes, and run commands in your projects. Connect from desktop, web, or mobile to continue working remotely.",
    license: "MIT",
    // Required by the .deb control file.
    homepage: "https://starkfuture.com",
    author: "Stark Future",
    main: "apps/desktop/dist-electron/boot.cjs",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      appVersion,
      options.signed,
      options.updateFeed,
      macSigningPlan && macSigningPlan.mode !== "unsigned"
        ? {
            mode: macSigningPlan.mode,
            entitlementsPath:
              macPasskeySigning && macEntitlementsPath
                ? macEntitlementsPath
                : path.join(stageResourcesDir, MAC_ENTITLEMENTS_FILE_NAME),
            // Helper processes never get the passkey entitlements, only the
            // hardened-runtime exceptions and microphone access.
            entitlementsInheritPath: path.join(stageResourcesDir, MAC_ENTITLEMENTS_FILE_NAME),
            ...(macPasskeySigning
              ? { provisioningProfilePath: macPasskeySigning.provisioningProfilePath }
              : {}),
          }
        : undefined,
      bundlesWslRuntime({ platform: options.platform, runtimeArchivePath: options.wslRuntime }),
      options.arch,
    ),
    dependencies: stageDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  const stageWorkspaceConfig = createStageWorkspaceConfig({
    platform: options.platform,
    arch: options.arch,
    allowBuilds: workspaceAllowBuilds,
    patchedDependencies: stagePatchedDependencies,
    overrides: resolvedOverrides,
  });
  const stageWorkspaceConfigString = yield* encodeStageWorkspaceConfig(stageWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stageWorkspaceConfigString,
  );

  if (Object.keys(stagePatchedDependencies).length > 0) {
    yield* fs.copy(path.join(repoRoot, "patches"), path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: stageAppDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod", verbose: options.verbose },
  );
  yield* stageClerkPasskeyNativeBinaries(stageAppDir, options.platform, options.arch);
  yield* stageKeyringNativeBinaries(stageAppDir, options.platform, options.arch);

  // Only the Windows artifact carries the server sidecar and the WSL runtime;
  // other platforms ignore the --wsl-runtime input.
  if (options.platform === "win" && windowsServerAsarPath) {
    yield* stageWindowsServerSidecar({
      stageRoot,
      repoRoot,
      serverDistDir: distDirs.serverDist,
      arch: options.arch,
      appVersion,
      runtimeExternalDependencies: resolvedServerRuntimeExternalDependencies,
      fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
      allowBuilds: workspaceAllowBuilds,
      patchedDependencies: workspacePatchedDependencies,
      overrides: resolvedOverrides,
      asarPath: windowsServerAsarPath,
      verbose: options.verbose,
    });
  }
  yield* stageCursorSdkPlatformPackages(
    path.join(
      options.platform === "win" ? path.join(stageRoot, "server") : stageAppDir,
      "node_modules",
    ),
    path.join(stageProdResourcesDir, "cursor-sdk"),
  );
  if (
    options.wslRuntime !== undefined &&
    bundlesWslRuntime({ platform: options.platform, runtimeArchivePath: options.wslRuntime })
  ) {
    yield* stageWslRuntimeArchive({
      sourceArchivePath: options.wslRuntime,
      archivePath: path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from),
      hashPath: path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE.from),
    });
  }

  // electron-builder treats several set-but-empty variables (e.g. CSC_LINK="")
  // as enabled, so copy the host env and scrub empty values instead of relying
  // on `extendEnv` merging.
  const buildEnv: NodeJS.ProcessEnv = removePublishDetectionEnv(
    removeUnusedSigningCredentials(process.env, {
      signed: options.signed,
      macSigningMode: macSigningPlan?.mode,
    }),
  );
  buildEnv.npm_config_user_agent = resolvePackageManagerUserAgent(rootPackageJson.packageManager);
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (options.platform === "linux") {
    // fpm compresses the .deb with the system xz through tar. Threaded mode
    // takes seconds on a many-core runner instead of about two minutes.
    buildEnv.XZ_DEFAULTS = "-T0";
  }

  if (hostPlatform === "win32") {
    const python = yield* resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }
  if (options.verbose) {
    const debugNamespaces = [
      "electron-builder",
      "electron-builder:*",
      ...(options.platform === "mac" ? ["electron-osx-sign*", "electron-notarize*"] : []),
    ];
    buildEnv.DEBUG = [buildEnv.DEBUG, ...debugNamespaces].filter(Boolean).join(",");
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const builderArgs = [
    "exec",
    "--filter",
    "@starkfuture/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    platformConfig.cliFlag,
    `--${options.arch}`,
    "--publish",
    "never",
  ];
  const builderCommand = yield* resolveSpawnCommand("vp", builderArgs, { env: buildEnv });
  yield* runCommand(
    ChildProcess.make(builderCommand.command, builderCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: builderCommand.shell,
    }),
    {
      label: `vp exec --filter @starkfuture/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new DesktopBuildDistDirectoryMissingError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  yield* validatePackagedStarkWorkbench({
    stageDistDir,
    platform: options.platform,
    productName: resolveDesktopProductName(appVersion),
  });
  const packagedUpdateFeed = yield* verifyPackagedUpdateFeed({
    stageDistDir,
    policy: bakedUpdatePolicy,
  });

  // Prove the packaged bundle is self-contained by loading it the way the WSL
  // backend does, rather than by reasoning about the emitted source.
  //
  // Static analysis kept getting this wrong here. Scanning for bare imports
  // matched specifiers inside effect's JSDoc examples and inside ajv's runtime
  // codegen template, and asserting that one sentinel package was inlined
  // missed a build that inlined `effect` while leaving `yaml` external. Node's
  // resolver has no such ambiguity: it either finds every import or it does not.
  //
  // Only Windows unpacks anything; macOS and Linux keep the whole tree inside
  // the app asar. Windows validates and executes the separately packed server
  // sidecar after electron-builder copies it into the final payload.
  if (options.platform === "win") {
    yield* validateWindowsPackagedPayload({
      stageDistDir,
      appExecutableName: `${resolveDesktopProductName(appVersion)}.exe`,
      targetArch: options.arch,
      appVersion,
      expectWslRuntime: bundlesWslRuntime({
        platform: options.platform,
        runtimeArchivePath: options.wslRuntime,
      }),
      verbose: options.verbose,
    });
  }

  // Verify and finalize signed macOS artifacts while the stage still exists,
  // and before anything is copied out or hashed into the release proof.
  let macAppVerification: MacAppReleaseVerification | undefined;
  let macRequirement: string | undefined;
  let macDmgStapled = false;
  if (macSigningPlan && macSigningPlan.mode !== "unsigned") {
    const appPath = path.join(
      stageDistDir,
      macPackagedAppDirectoryName(options.arch),
      `${resolveDesktopProductName(appVersion)}.app`,
    );
    macAppVerification = yield* verifyMacSignedApp({
      appPath,
      mode: macSigningPlan.mode,
      expectedIdentityName: macSigningIdentity?.name,
      expectedTeamId: macSigningPlan.expectedTeamId,
    });
    macRequirement = (yield* verifyMacDesignatedRequirement({ appPath, feed: options.updateFeed }))
      .text;
    yield* Effect.log(
      `[desktop-artifact] Verified the ${macSigningPlan.mode} signature of the packaged app.`,
    );
    if (macSigningPlan.notarization) {
      const dmgNames = (yield* fs.readDirectory(stageDistDir)).filter((entry) =>
        entry.endsWith(".dmg"),
      );
      for (const dmgName of dmgNames) {
        yield* finalizeMacDmg({
          dmgPath: path.join(stageDistDir, dmgName),
          stageDistDir,
          notarization: macSigningPlan.notarization,
          env: process.env,
          verbose: options.verbose,
        });
      }
      macDmgStapled = dmgNames.length > 0;
    }
  }

  // A mock build's channel manifests say so; the mock server serves nothing
  // else and the release publisher refuses them.
  if (options.updateFeed.kind === "mock") {
    yield* markMockFeedManifests(stageDistDir);
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new DesktopBuildNoArtifactsProducedError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  if (macSigningPlan) {
    const proofPath = yield* writeDesktopReleaseProof({
      outputDir: options.outputDir,
      artifactPaths: copiedArtifacts,
      version: appVersion,
      arch: options.arch,
      commit: commitHash,
      feed: describeDesktopReleaseFeed(bakedUpdatePolicy, packagedUpdateFeed),
      plan: macSigningPlan,
      app: macAppVerification,
      requirement: macRequirement,
      dmgStapled: macDmgStapled,
    });
    yield* Effect.log(`[desktop-artifact] Wrote ${proofPath}.`);
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.Literals("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: STARK_CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.String("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: STARK_CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.Literals("arch", BuildArch.literals).pipe(
    Flag.withDescription(
      "Build arch, for example arm64/x64/universal (env: STARK_CODE_DESKTOP_ARCH).",
    ),
    Flag.optional,
  ),
  buildVersion: Flag.String("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: STARK_CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.String("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: STARK_CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.Boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: STARK_CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.Boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: STARK_CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.Boolean("signed").pipe(
    Flag.withDescription(
      "Sign the build. macOS signs per STARK_CODE_MACOS_SIGNING_MODE (developer-id, notarized, by default; or development) and fails without complete credentials; Windows uses Azure Trusted Signing (env: STARK_CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.Boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: STARK_CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.Boolean("mock-updates").pipe(
    Flag.withDescription(
      "Bake the localhost mock update feed, the same as STARK_CODE_DESKTOP_UPDATE_FEED=mock; writes below release-mock/ and is refused for Developer ID builds (env: STARK_CODE_DESKTOP_MOCK_UPDATES).",
    ),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.Int("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription(
      "Mock update server port (env: STARK_CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT).",
    ),
    Flag.optional,
  ),
  wslRuntime: Flag.String("wsl-runtime").pipe(
    Flag.withDescription(
      "Path to the Linux CLI release archive (stark-<version>-linux-x64.tar.gz) to embed as the WSL runtime of a Windows build (env: STARK_CODE_DESKTOP_WSL_RUNTIME).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for Stark Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
