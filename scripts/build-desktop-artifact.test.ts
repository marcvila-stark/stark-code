// @effect-diagnostics nodeBuiltinImport:off - Tests use Node's glob matcher to verify electron-builder exclusions.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { extractFile } from "@electron/asar";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// plist is CommonJS; Node cannot load its named exports from an ES module.
import Plist from "plist";

import {
  BundleNotSelfContainedError,
  BuildCommandFailedError,
  parseWslRuntimeArchiveMembers,
  DesktopDmgBackgroundSourceMissingError,
  createStageWorkspaceConfig,
  createStagePatchedDependencies,
  readWorkspaceConfig,
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_EXTRA_RESOURCES,
  LINUX_CAPTURE_EXTRA_RESOURCES,
  LINUX_BROWSER_SECRET_EXTRA_RESOURCES,
  MAC_DICTATION_EXTRA_RESOURCES,
  LINUX_FILE_EXCLUSIONS,
  MAC_FILE_EXCLUSIONS,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  InvalidMockUpdateServerPortError,
  UnsupportedDesktopBuildArchitectureError,
  isMacPasskeySigningConfigurationError,
  LinuxIconResizeError,
  LinuxDesktopBuildPrerequisitesMissingError,
  MacDesktopBuildPrerequisitesMissingError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  packWindowsServerAsar,
  preflightLinuxDesktopBuild,
  preflightMacDesktopBuild,
  preflightWindowsDesktopBuild,
  renderMacPasskeyEntitlements,
  resolveMacWebAuthnEntitlements,
  resolveClerkPasskeyNativeArtifacts,
  resolveMacPasskeySigningConfiguration,
  resolveDesktopRuntimeDependencies,
  resolveMergedStageDependencies,
  resolveFffNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveResourceMonitorRustTargets,
  resolveWindowsServerAsarIgnoreGlobs,
  resourceMonitorExecutableName,
  resourceMonitorReleaseEnvironment,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolvePackageManagerUserAgent,
  stageLinuxIconSize,
  stageDesktopDmgBackground,
  stageResourceMonitor,
  stageLinuxCaptureHelper,
  stageWslRuntimeArchive,
  bundlesWslRuntime,
  STAGE_INSTALL_ARGS,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
  LinuxBrowserSecretHostError,
  stageBrowserSecret,
  stageDictation,
  MacDictationHostError,
  validateWindowsPackagedPayload,
  WindowsPrimaryNativeProbeError,
  WindowsDesktopBuildPrerequisitesMissingError,
  WindowsPackagedPayloadValidationError,
  WINDOWS_NATIVE_ASAR_UNPACK_GLOB,
  stageCursorSdkPlatformPackages,
  WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
  WSL_RUNTIME_ARCHIVE_NAME,
  WSL_RUNTIME_EXTRA_RESOURCES,
  WslRuntimeArchiveMissingError,
  wslRuntimeArchiveStem,
  ConflictingMacSigningCredentialsError,
  IncompleteMacSigningCredentialsError,
  InvalidMacSigningIdentityNameError,
  InvalidMacSigningModeError,
  InvalidMacSigningTeamIdError,
  MAC_ENTITLEMENTS_FILE_NAME,
  MacNotarizationCommandError,
  MacReleaseVerificationError,
  MacSigningIdentityMismatchError,
  MacSigningIdentityNotFoundError,
  MacSigningModeRequiresSignedBuildError,
  MissingMacNotarizationCredentialsError,
  MissingMacNotarizationKeyFileError,
  MissingMacSigningIdentityError,
  NOTARIZED_DEVELOPER_ID_SOURCE,
  RELEASE_PROOF_FILE_NAME,
  DESKTOP_UPDATE_KIND_HOOK,
  DesktopUpdateFeedConfigError,
  NO_DESKTOP_UPDATE_FEED,
  PackagedDesktopUpdateFeedError,
  checkDesktopUpdateFeedSigning,
  createBakedUpdatePolicy,
  describeDesktopReleaseFeed,
  removePublishDetectionEnv,
  resolveDesktopPublishConfig,
  resolveDesktopUpdateFeedPlan,
  verifyMacDesignatedRequirement,
  verifyPackagedUpdateFeed,
  classifyMacSigningCertificate,
  createDesktopReleaseProof,
  finalizeMacDmg,
  findMacAppVerificationFailures,
  isGatekeeperNotarized,
  isMacPasskeySigningRequested,
  isStaplerValidation,
  macPackagedAppDirectoryName,
  parseGatekeeperAssessment,
  parseMacCodeSignature,
  parseMacSigningIdentities,
  parseNotarySubmission,
  preflightMacSigning,
  removeUnusedSigningCredentials,
  resolveMacSigningPlan,
  selectMacSigningIdentity,
  verifyMacSignedApp,
  writeDesktopReleaseProof,
  type DesktopUpdateFeedPlan,
  type MacSigningPlan,
} from "./build-desktop-artifact.ts";
import { afterPack, withUpdateFeedKind } from "./bake-desktop-update-kind.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import type { UpdateOwnership } from "./lib/update-feed-ownership.ts";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import { symlinksSupported } from "@starkfuture/shared/testing/symlinks";

// Keeps pnpm from auto-installing TypeScript, a types-only peer, into the app.
const stagePackageExtensions = {
  "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
  "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
};

// A minimal stand-in for the Linux CLI release archive: one top-level
// directory named after the archive stem holding the executable, the web
// client, and the runtime externals with node-pty built from source.
const makeLinuxCliArchiveFixture = Effect.fn("test.makeLinuxCliArchiveFixture")(function* (input: {
  readonly root: string;
  readonly stem: string;
  readonly extraMembers?: ReadonlyArray<string>;
  readonly omitMembers?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const contentRoot = path.join(input.root, "content");
  const members = [
    `${input.stem}/stark-code`,
    `${input.stem}/client/index.html`,
    `${input.stem}/node_modules/node-pty/package.json`,
    `${input.stem}/node_modules/node-pty/build/Release/pty.node`,
    ...(input.extraMembers ?? []),
  ].filter((member) => !(input.omitMembers ?? []).includes(member));
  for (const member of members) {
    const memberPath = path.join(contentRoot, member);
    yield* fs.makeDirectory(path.dirname(memberPath), { recursive: true });
    yield* fs.writeFileString(memberPath, member);
  }
  const archivePath = path.join(input.root, `${input.stem}.tar.gz`);
  const tar = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", archivePath, "-C", contentRoot, "."], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  assert.equal(Number(yield* tar.exitCode), 0);
  return archivePath;
});

function mockProcess(exitCode: number, stdout = "", stderr = "") {
  const encodedStdout = new TextEncoder().encode(stdout);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encodedStdout) : Stream.empty,
    stderr: stderr ? Stream.make(new TextEncoder().encode(stderr)) : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function macToolSpawnerLayer(
  commands: Array<ReadonlyArray<string>>,
  respond: (
    command: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly exitCode?: number; readonly stdout?: string; readonly stderr?: string },
    PlatformError.PlatformError
  >,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      const invocation = [childProcess.command, ...childProcess.args];
      commands.push(invocation);
      return respond(invocation).pipe(
        Effect.map((result) => mockProcess(result.exitCode ?? 0, result.stdout, result.stderr)),
      );
    }),
  );
}

const DEVELOPER_ID_CODESIGN_DISPLAY = `Executable=/stage/dist/mac-arm64/Stark Code (Alpha).app/Contents/MacOS/Stark Code (Alpha)
Identifier=com.starkfuture.starkcode
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=27+7 location=embedded
Signature size=9045
Authority=Developer ID Application: Stark Future GmbH (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=29 Oct 2026 at 10:15:03
Info.plist entries=31
TeamIdentifier=ABCDE12345
Runtime Version=15.0.0
Sealed Resources version=2 rules=13 files=1840
Internal requirements count=1 size=224`;

const DEVELOPMENT_CODESIGN_DISPLAY = `Executable=/stage/dist/mac-arm64/Stark Code (Alpha).app/Contents/MacOS/Stark Code (Alpha)
Identifier=com.starkfuture.starkcode
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=27+7 location=embedded
Signature size=4789
Authority=Apple Development: Jane Doe (ABCDE12345)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
Signed Time=29 Oct 2026 at 10:15:03
Info.plist entries=31
TeamIdentifier=ABCDE12345
Runtime Version=15.0.0
Sealed Resources version=2 rules=13 files=1840
Internal requirements count=1 size=212`;

function iconResizeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
) {
  let commandIndex = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0));
    }),
  );
}

const WINDOWS_PAYLOAD_FIXTURE_VERSION = "1.2.3";

const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(function* (input: {
  readonly copyUnpackedNatives: boolean;
  readonly serverEntrySource?: string;
  readonly wslRuntime?: "valid" | "loose-server-tree" | "missing-pty" | "bad-digest";
  readonly targetArch?: "x64" | "arm64";
  readonly ptyPrebuildArch?: "x64" | "arm64";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "stark-windows-payload-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "MZ native-binary");

  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath, arch: "x64" });

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  if (input.copyUnpackedNatives) {
    yield* fs.copy(
      `${generatedAsarPath}.unpacked`,
      path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
    );
  }
  yield* fs.writeFileString(
    path.join(resourcesDir, "resource-monitor/stark-resource-monitor.exe"),
    "monitor",
  );
  const appExecutableName = "starkcode.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");

  if (input.wslRuntime !== undefined) {
    const stem = wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, input.targetArch ?? "x64");
    const sourceArchivePath =
      input.wslRuntime === "loose-server-tree"
        ? // The old hand-rolled runtime: apps/server/dist + node_modules at the
          // archive root, no single stem directory, no `stark-code` executable.
          yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem: "apps",
            omitMembers: ["apps/stark-code", "apps/client/index.html"],
            extraMembers: ["apps/server/dist/bin.mjs", "node_modules/node-pty/package.json"],
          })
        : yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem,
            ...(input.wslRuntime === "missing-pty" || input.ptyPrebuildArch !== undefined
              ? { omitMembers: [`${stem}/node_modules/node-pty/build/Release/pty.node`] }
              : {}),
            ...(input.ptyPrebuildArch !== undefined
              ? {
                  extraMembers: [
                    `${stem}/node_modules/node-pty/prebuilds/linux-${input.ptyPrebuildArch}/pty.node`,
                  ],
                }
              : {}),
          });
    const archivePath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_NAME);
    const hashPath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_HASH_NAME);
    yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });
    if (input.wslRuntime === "bad-digest") {
      yield* fs.writeFileString(hashPath, `${"0".repeat(64)}\n`);
    }
  }

  return {
    stageDistDir,
    packagedAppDir,
    sourceDir,
    generatedAsarPath,
    appExecutableName,
  } as const;
});

const FEED_OWNERSHIP: UpdateOwnership = {
  bundleId: "com.starkfuture.starkcode",
  appleTeamId: "ABCDE12345",
  updateFeedOrigins: ["https://updates.stark.test"],
  updateChannels: ["latest"],
};
const STARK_FEED = { kind: "stark", url: "https://updates.stark.test/stark-code/mac/" } as const;
const MOCK_FEED = { kind: "mock", url: "http://localhost:3123/" } as const;

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "Stark Code (Alpha)");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Stark Code (Nightly)");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("switches the bundled splash and favicon branding for nightly versions", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "production");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "nightly");
  });

  it.effect("resolves the update feed only from explicit configuration", () =>
    Effect.gen(function* () {
      const resolve = (
        input: Partial<Parameters<typeof resolveDesktopUpdateFeedPlan>[0]>,
        ownership: UpdateOwnership = FEED_OWNERSHIP,
      ) =>
        resolveDesktopUpdateFeedPlan(
          {
            mode: undefined,
            url: undefined,
            repository: undefined,
            mockUpdates: false,
            mockUpdateServerPort: undefined,
            signed: false,
            ...input,
          },
          ownership,
        );
      const refusal = (input: Partial<Parameters<typeof resolveDesktopUpdateFeedPlan>[0]>) =>
        resolve(input).pipe(Effect.flip);

      assert.deepStrictEqual(yield* resolve({}), { kind: "none" });
      assert.deepStrictEqual(yield* resolve({ signed: true, mode: " none " }), { kind: "none" });
      assert.deepStrictEqual(
        yield* resolve({ signed: true, mode: "stark", url: STARK_FEED.url }),
        STARK_FEED,
      );
      assert.deepStrictEqual(yield* resolve({ mode: "mock" }), {
        kind: "mock",
        url: "http://localhost:3000/",
      });
      assert.deepStrictEqual(yield* resolve({ mockUpdates: true, mockUpdateServerPort: 3123 }), {
        kind: "mock",
        url: "http://localhost:3123/",
      });

      // A rehearsal bakes its own profile and fault into a mock build only.
      assert.deepStrictEqual(
        yield* resolve({
          mode: "mock",
          mockUpdateServerPort: 3123,
          rehearsalProfile: "/tmp/rehearsal/profile",
          rehearsalFault: "migration-fail",
        }),
        {
          kind: "mock",
          url: "http://localhost:3123/",
          rehearsal: { profile: "/tmp/rehearsal/profile", fault: "migration-fail" },
        },
      );
      assert.deepStrictEqual(
        createBakedUpdatePolicy(
          {
            kind: "mock",
            url: "http://localhost:3123/",
            rehearsal: { profile: "/tmp/rehearsal/profile", fault: null },
          },
          "0.0.46-alpha.2",
          FEED_OWNERSHIP,
        ).rehearsal,
        { profile: "/tmp/rehearsal/profile", fault: null },
      );

      // Malformed or contradictory input is a typed error, never a silent default.
      const reasons: Array<[Partial<Parameters<typeof resolveDesktopUpdateFeedPlan>[0]>, string]> =
        [
          [{ signed: true }, "mode-required"],
          [{ mode: "github" }, "invalid-mode"],
          [{ mode: "STARK" }, "invalid-mode"],
          [{ repository: "pingdotgg/t3code" }, "repository-removed"],
          [{ repository: "starkfuture/stark-code", mode: "none" }, "repository-removed"],
          [{ mode: "stark" }, "url-required"],
          [{ mode: "none", url: STARK_FEED.url }, "url-not-allowed"],
          [{ mode: "mock", url: STARK_FEED.url }, "url-not-allowed"],
          [
            { mockUpdates: true, mode: "stark", url: STARK_FEED.url },
            "conflicts-with-mock-updates",
          ],
          [{ mockUpdates: true, mode: "none" }, "conflicts-with-mock-updates"],
          [{ rehearsalProfile: "/tmp/profile" }, "rehearsal-not-mock"],
          [
            { mode: "stark", url: STARK_FEED.url, rehearsalFault: "migration-fail" },
            "rehearsal-not-mock",
          ],
          [{ mode: "mock", rehearsalProfile: "relative/profile" }, "rehearsal-profile-invalid"],
          [{ mode: "mock", rehearsalFault: "wipe-disk" }, "rehearsal-fault-invalid"],
        ];
      for (const [input, reason] of reasons) {
        assert.equal((yield* refusal(input)).reason, reason, JSON.stringify(input));
      }
      const urlProblems: Array<[string, string]> = [
        ["http://updates.stark.test/stark-code/", "not-https"],
        ["http://localhost:3123/", "not-https"],
        ["https://github.com/pingdotgg/t3code/releases/", "origin-not-allowed"],
        ["https://user:secret@updates.stark.test/stark-code/", "credentials"],
        ["https://updates.stark.test/stark-code/?channel=beta", "query-or-fragment"],
        ["https://updates.stark.test/stark-code", "not-a-directory"],
        ["https://localhost/stark-code/", "loopback"],
      ];
      for (const [url, problem] of urlProblems) {
        const error = yield* refusal({ mode: "stark", url });
        assert.equal(error.reason, "url-invalid", url);
        assert.equal(error.urlProblem, problem, url);
        assert.notInclude(error.message, "secret");
      }

      // stark.brand.json allowlists no origin until hosting is approved, so
      // every Stark feed fails closed today.
      const today = yield* resolveDesktopUpdateFeedPlan({
        mode: "stark",
        url: STARK_FEED.url,
        repository: undefined,
        mockUpdates: false,
        mockUpdateServerPort: undefined,
        signed: true,
      }).pipe(Effect.flip);
      assert.equal(today.urlProblem, "origin-not-allowed");
      assert.include(today.message, "updateFeedOrigins");
    }),
  );

  it.effect("writes publish: null for every build without a feed, preview and PR builds", () =>
    Effect.gen(function* () {
      const builds = [
        ["mac", "dmg", "0.0.46"],
        ["mac", "dmg", "0.0.46-beta.1"],
        ["mac", "dmg", "0.0.33-pr.8182.1"],
        ["mac", "dmg", "0.0.41-preview.20260912.1589"],
        ["linux", "AppImage", "0.0.46"],
        ["win", "nsis", "0.0.46"],
      ] as const;
      for (const [platform, target, version] of builds) {
        const config = yield* createBuildConfig(
          platform,
          target,
          version,
          false,
          NO_DESKTOP_UPDATE_FEED,
          undefined,
        );
        // null, never an omitted key: electron-builder derives a feed for undefined.
        assert.property(config, "publish");
        assert.isNull(config.publish, `${platform} ${version}`);
        assert.isNull(
          (config[platform] as Record<string, unknown>).publish,
          `${platform} ${version}`,
        );
        assert.notProperty(config, "afterPack");
      }

      const stark = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.47-beta.1",
        true,
        STARK_FEED,
        undefined,
      );
      const starkPublish = [{ provider: "generic", url: STARK_FEED.url, channel: "latest" }];
      assert.deepStrictEqual(stark.publish, starkPublish);
      assert.deepStrictEqual((stark.mac as Record<string, unknown>).publish, starkPublish);
      assert.isTrue(String(stark.afterPack).endsWith(DESKTOP_UPDATE_KIND_HOOK));
      const fs = yield* FileSystem.FileSystem;
      assert.isTrue(
        yield* fs.exists(NodePath.join(import.meta.dirname, "..", DESKTOP_UPDATE_KIND_HOOK)),
      );

      const refusals: Array<["mac" | "linux" | "win", string, string]> = [
        ["mac", "0.0.33-pr.8182.1", "preview-version"],
        ["mac", "0.0.41-preview.20260912.1589", "preview-version"],
        ["mac", "0.0.47-nightly.20261030.1", "channel-not-enabled"],
        ["linux", "0.0.47", "not-mac"],
        ["win", "0.0.47", "not-mac"],
      ];
      for (const [platform, version, reason] of refusals) {
        const error = yield* resolveDesktopPublishConfig(platform, version, STARK_FEED).pipe(
          Effect.flip,
        );
        assert.equal(error.reason, reason, `${platform} ${version}`);
      }
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect(
    "leaves the installed electron-builder no feed to derive from a hostile environment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The installed library, not a copy of its rules: an upgrade that
          // changes how it derives a publisher fails here.
          const desktopRequire = NodeModule.createRequire(
            NodePath.join(import.meta.dirname, "../apps/desktop/package.json"),
          );
          const builderRequire = NodeModule.createRequire(
            desktopRequire.resolve("electron-builder"),
          );
          const { getAppUpdatePublishConfiguration } = builderRequire(
            "app-builder-lib/out/publish/PublishManager.js",
          ) as {
            getAppUpdatePublishConfiguration(
              packager: unknown,
              targetSpecificOptions: null,
              arch: number,
              errorIfCannot: boolean,
            ): Promise<Record<string, unknown> | null>;
          };
          const { getRepositoryInfo } = builderRequire(
            "app-builder-lib/out/util/repositoryInfo.js",
          ) as {
            getRepositoryInfo(
              projectDir: string,
              metadata: Record<string, unknown> | null,
              devMetadata: Record<string, unknown> | null,
            ): Promise<unknown>;
          };
          const fs = yield* FileSystem.FileSystem;
          const stage = yield* fs.makeTempDirectoryScoped({ prefix: "stark-publish-probe-" });

          const hostileEnv: Record<string, string> = {
            GH_TOKEN: "token",
            GITHUB_TOKEN: "token",
            GITLAB_TOKEN: "token",
            KEYGEN_TOKEN: "token",
            BITBUCKET_TOKEN: "token",
            TRAVIS_REPO_SLUG: "pingdotgg/t3code",
            APPVEYOR_REPO_NAME: "pingdotgg/t3code",
            CIRCLE_PROJECT_USERNAME: "pingdotgg",
            CIRCLE_PROJECT_REPONAME: "t3code",
          };
          const withEnv = <A>(env: Record<string, string>, run: () => Promise<A>) =>
            Effect.promise(async () => {
              const saved = Object.fromEntries(
                Object.keys(hostileEnv).map((key) => [key, process.env[key]] as const),
              );
              for (const key of Object.keys(hostileEnv)) delete process.env[key];
              Object.assign(process.env, env);
              try {
                return await run();
              } finally {
                for (const [key, value] of Object.entries(saved)) {
                  if (value === undefined) delete process.env[key];
                  else process.env[key] = value;
                }
              }
            });
          // A package.json `repository` naming upstream, as one careless commit could add.
          const upstreamRepository = yield* Effect.promise(() =>
            getRepositoryInfo(stage, { repository: "https://github.com/pingdotgg/t3code" }, null),
          );
          const resolveAppUpdate = (
            config: Record<string, unknown>,
            platform: "mac" | "linux" | "win",
            env: Record<string, string> = hostileEnv,
          ) =>
            withEnv(env, async () => {
              const info = {
                repositoryInfo: Promise.resolve(upstreamRepository),
                appInfo: { channel: null },
                config,
              };
              return getAppUpdatePublishConfiguration(
                {
                  platform: { name: platform },
                  platformSpecificBuildOptions: config[platform] ?? {},
                  config,
                  info,
                  appInfo: { updaterCacheDirName: "starkcode-updater", channel: null },
                  expandMacro: (value: string) => value,
                },
                null,
                1,
                false,
              );
            });

          // Controls: what an omitted or empty publish produced before.
          assert.include(yield* resolveAppUpdate({}, "mac"), {
            provider: "github",
            owner: "pingdotgg",
            repo: "t3code",
          });
          assert.include(yield* resolveAppUpdate({ publish: [] }, "mac", {}), {
            provider: "github",
            owner: "pingdotgg",
            repo: "t3code",
          });

          for (const [platform, target, version] of [
            ["mac", "dmg", "0.0.46"],
            ["mac", "dmg", "0.0.33-pr.8182.1"],
            ["mac", "dmg", "0.0.41-preview.20260912.1589"],
            ["linux", "AppImage", "0.0.46"],
            ["win", "nsis", "0.0.46"],
          ] as const) {
            const config = yield* createBuildConfig(
              platform,
              target,
              version,
              false,
              NO_DESKTOP_UPDATE_FEED,
              undefined,
            );
            assert.isNull(yield* resolveAppUpdate(config, platform), `${platform} ${version}`);
          }
          const stark = yield* createBuildConfig(
            "mac",
            "dmg",
            "0.0.47",
            true,
            STARK_FEED,
            undefined,
          );
          assert.deepStrictEqual(yield* resolveAppUpdate(stark, "mac"), {
            provider: "generic",
            url: STARK_FEED.url,
            channel: "latest",
            updaterCacheDirName: "starkcode-updater",
          });

          // The packaging environment never carries the variables that select a publisher.
          const scrubbed = removePublishDetectionEnv({ ...hostileEnv, PATH: "/usr/bin" });
          assert.deepStrictEqual(scrubbed, { PATH: "/usr/bin" });
          assert.isNull(
            yield* withEnv(
              Object.fromEntries(
                Object.entries(scrubbed).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              () =>
                getAppUpdatePublishConfiguration(
                  {
                    platform: { name: "mac" },
                    platformSpecificBuildOptions: {},
                    config: {},
                    info: {
                      repositoryInfo: getRepositoryInfo(stage, { name: "starkcode" }, null),
                      appInfo: { channel: null },
                      config: {},
                    },
                    appInfo: { updaterCacheDirName: "starkcode-updater", channel: null },
                    expandMacro: (value: string) => value,
                  },
                  null,
                  1,
                  false,
                ),
            ),
          );
        }),
      ).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("stages only the desktop main-process externals", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@clerk/electron": "catalog:",
          "@clerk/electron-passkeys": "catalog:",
          "@crowecawcaw/xa11y": "0.13.0",
          "@effect/platform-node": "catalog:",
          "@napi-rs/keyring": "^1.3.0",
          "@starkfuture/contracts": "workspace:*",
          "@starkfuture/shared": "workspace:*",
          "dbus-next": "0.10.2",
          effect: "catalog:",
          electron: "41.5.0",
          "electron-updater": "^6.6.2",
          "ffi-rs": "1.3.2",
          "playwright-core": "1.60.0",
        },
        {
          "@clerk/electron": "0.0.37",
          "@clerk/electron-passkeys": "0.0.3",
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@clerk/electron-passkeys": "0.0.3",
        "@crowecawcaw/xa11y": "0.13.0",
        "@napi-rs/keyring": "^1.3.0",
        "ffi-rs": "1.3.2",
        "playwright-core": "1.60.0",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@ff-labs/fff-node": "0.9.4",
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
        "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
        "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
      },
    );

    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      {},
    );
  });

  it("installs optional native dependencies for the target desktop architecture", () => {
    assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod"]);
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "x64" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["x64"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "linux", arch: "x64" }), {
      supportedArchitectures: {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
      packageExtensions: stagePackageExtensions,
    });
    // Windows stages only win32 natives; WSL runs the separately built Linux
    // CLI archive rather than anything installed here.
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "x64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["x64"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "arm64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["arm64"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "universal" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
      packageExtensions: stagePackageExtensions,
    });
  });

  // pnpm writes "set this to true or false" placeholders into allowBuilds when a
  // tarball changes. pnpm ignores them, but the release build decode rejects them.
  it.effect("decodes the repo allowBuilds and every file: tarball it names exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { allowBuilds = {} } = yield* readWorkspaceConfig();
      const repoRoot = path.join(import.meta.dirname, "..");
      for (const key of Object.keys(allowBuilds)) {
        const tarball = key.split("@file:")[1];
        if (tarball === undefined) continue;
        assert.isTrue(
          yield* fs.exists(path.join(repoRoot, tarball)),
          `allowBuilds names a missing tarball: ${key}`,
        );
      }
    }),
  );

  it("stages pnpm 11 allowBuilds and patchedDependencies in the workspace yaml", () => {
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "linux",
        arch: "x64",
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      }),
      {
        supportedArchitectures: {
          os: ["linux"],
          cpu: ["x64"],
          libc: ["glibc"],
        },
        packageExtensions: stagePackageExtensions,
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      },
    );

    // Empty maps must not be written — pnpm would still require reviewed
    // packages if allowBuilds is present but incomplete, and omitting empty
    // patchedDependencies keeps the stage yaml minimal.
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "mac",
        arch: "arm64",
        allowBuilds: {},
        patchedDependencies: {},
        overrides: {},
      }),
      {
        supportedArchitectures: {
          os: ["darwin"],
          cpu: ["arm64"],
        },
        packageExtensions: stagePackageExtensions,
      },
    );
  });

  it("limits Electron locales and excludes separately packaged resources", () => {
    assert.deepStrictEqual(DESKTOP_ELECTRON_LANGUAGES, ["en-US"]);
    // Every platform staging input is emitted once at resources/, so adding one
    // without its exclusion silently packs a second copy into app.asar. The
    // snapshot below cannot catch that on its own: adding a resource and
    // forgetting the exclusion leaves the exclusion list untouched, so it still
    // matches. Assert the invariant first, where the failure names the culprit.
    for (const resource of [
      ...WSL_RUNTIME_EXTRA_RESOURCES,
      ...LINUX_BROWSER_SECRET_EXTRA_RESOURCES,
      ...MAC_DICTATION_EXTRA_RESOURCES,
    ]) {
      assert.include(
        DESKTOP_FILE_EXCLUSIONS,
        `!${resource.from}`,
        `${resource.from} ships via extraResources and must be excluded from app.asar`,
      );
    }

    assert.deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, [
      "!apps/desktop/resources/stark-workbench",
      "!apps/desktop/resources/stark-workbench/**/*",
      "!apps/desktop/prod-resources/stark-workbench",
      "!apps/desktop/prod-resources/stark-workbench/**/*",
      "!**/node_modules/@cursor/sdk-*/**/*",
      "!apps/desktop/prod-resources/cursor-sdk",
      "!apps/desktop/prod-resources/cursor-sdk/**/*",
      "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
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
      "!apps/desktop/prod-resources/windows-server",
      "!apps/desktop/prod-resources/windows-server/**/*",
      "!apps/desktop/prod-resources/wsl-runtime.tar.gz",
      "!apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
      "!apps/desktop/gnome-extension",
      "!apps/desktop/gnome-extension/**/*",
    ]);
    assert.equal(WINDOWS_SERVER_RESOURCE_SOURCE_DIR, "apps/desktop/prod-resources/windows-server");
    assert.deepStrictEqual(WINDOWS_SERVER_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/windows-server",
        to: ".",
        filter: ["server.asar", "server.asar.unpacked/**/*"],
      },
    ]);
  });

  it.effect("applies platform-specific packaging to the build config", () =>
    Effect.gen(function* () {
      const mac = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        NO_DESKTOP_UPDATE_FEED,
        undefined,
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        NO_DESKTOP_UPDATE_FEED,
        undefined,
      );
      const win = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        NO_DESKTOP_UPDATE_FEED,
        undefined,
        true,
      );
      const winWithoutWslRuntime = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        NO_DESKTOP_UPDATE_FEED,
        undefined,
        false,
      );

      // Windows unpacks native files explicitly so their JavaScript and metadata
      // stay archived. Other platforms retain electron-builder's defaults.
      assert.notProperty(mac, "asar");
      assert.notProperty(linux, "asar");
      assert.notProperty(mac, "asarUnpack");
      assert.notProperty(linux, "asarUnpack");
      assert.deepStrictEqual(win.asar, { smartUnpack: false });
      assert.deepStrictEqual(win.asarUnpack, [WINDOWS_NATIVE_ASAR_UNPACK_GLOB]);
      assert.deepStrictEqual(winWithoutWslRuntime.asar, win.asar);
      assert.deepStrictEqual(winWithoutWslRuntime.asarUnpack, win.asarUnpack);
      assert.deepStrictEqual(mac.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...MAC_DICTATION_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(linux.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...LINUX_CAPTURE_EXTRA_RESOURCES,
        { from: "apps/desktop/prod-resources/browser-secret", to: "browser-secret" },
      ]);
      assert.deepStrictEqual(win.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
        ...WSL_RUNTIME_EXTRA_RESOURCES,
      ]);
      // No Linux CLI archive means staging never writes the runtime, so
      // listing it here would fail the build on a missing source file.
      assert.deepStrictEqual(winWithoutWslRuntime.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(win.nsis, { differentialPackage: true });
      // The Claude SDK platform packages and .bin shims never ship.
      assert.deepStrictEqual(WINDOWS_SERVER_ASAR_IGNORE_GLOBS, [
        "**/node_modules/@cursor/sdk-*",
        "**/node_modules/@cursor/sdk-*/**",
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
        "**/node_modules/.bin",
        "**/node_modules/.bin/**",
        "**/*.map",
      ]);
      assert.deepStrictEqual(mac.dmg, {
        title: "Stark Code (Alpha) 1.2.3 Installer",
        background: "dmg/dmg-background-latest.png",
        window: { width: 640, height: 432 },
        contents: [
          { x: 166, y: 214, type: "file" },
          { x: 474, y: 214, type: "link", path: "/Applications" },
        ],
        iconSize: 120,
        iconTextSize: 12,
      });
      // A Linux AppImage build also emits the .deb from the same run.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).target, ["AppImage", "deb"]);
      // Linux must register the renderer schemes so the generated .desktop
      // entry advertises MimeType=x-scheme-handler/starkcode; for OAuth deep links.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).protocols, [
        { name: "Stark Code", schemes: ["starkcode", "starkcode-dev"] },
      ]);
      // macOS also offers itself as a web browser, so it can be chosen as the default.
      assert.deepStrictEqual((mac.mac as Record<string, unknown>).protocols, [
        { name: "Stark Code", schemes: ["starkcode", "starkcode-dev"] },
        { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
      ]);
      // macOS lists a default browser only when it also opens web pages as documents.
      const macInfo = (mac.mac as { extendInfo: Record<string, unknown> }).extendInfo;
      assert.strictEqual(macInfo.NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac, true);
      assert.equal(
        macInfo.NSMicrophoneUsageDescription,
        "Stark Code uses your microphone when you dictate a message.",
      );
      assert.equal(
        macInfo.NSSpeechRecognitionUsageDescription,
        "Stark Code transcribes your dictated messages on this Mac.",
      );
      assert.deepStrictEqual(macInfo.CFBundleDocumentTypes, [
        {
          CFBundleTypeName: "Web page",
          CFBundleTypeRole: "Viewer",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: ["public.html", "public.xhtml"],
        },
      ]);
      assert.deepStrictEqual(linux.toolsets, { appimage: "1.0.3" });
      assert.notProperty(mac, "toolsets");
      assert.notProperty(win, "toolsets");
      assert.deepStrictEqual(mac.files, [...DESKTOP_FILE_EXCLUSIONS, ...MAC_FILE_EXCLUSIONS]);
      assert.deepStrictEqual(linux.files, [...DESKTOP_FILE_EXCLUSIONS, ...LINUX_FILE_EXCLUSIONS]);
      assert.deepStrictEqual(win.files, DESKTOP_FILE_EXCLUSIONS);
      assert.deepStrictEqual(winWithoutWslRuntime.files, win.files);
      assert.notProperty(mac.mac as Record<string, unknown>, "sign");
      assert.propertyVal(
        (mac.mac as Record<string, unknown>).extendInfo as Record<string, unknown>,
        "NSLocalNetworkUsageDescription",
        "Stark Code connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
      );
      for (const config of [mac, linux, win]) {
        assert.deepStrictEqual(config.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
        assert.deepStrictEqual(config.electronFuses, { enableCookieEncryption: true });
      }
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("excludes foreign node-pty prebuilds from macOS and Linux packages", () => {
    assert.deepStrictEqual(MAC_FILE_EXCLUSIONS, [
      "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
      "!**/node_modules/node-pty/third_party/conpty/**/*",
    ]);
    assert.deepStrictEqual(LINUX_FILE_EXCLUSIONS, [
      ...MAC_FILE_EXCLUSIONS,
      "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
    ]);
  });

  it("unpacks native binaries while keeping their JavaScript and metadata archived", () => {
    for (const file of [
      "node_modules/@napi-rs/keyring/keyring.win32-x64-msvc.node",
      "node_modules/@clerk/electron-passkeys/electron-passkeys.win32-x64-msvc.node",
      "node_modules/@ff-labs/fff-bin-win32-x64/fff_c.dll",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
      "node_modules/native/addon.so",
      "node_modules/native/addon.so.1",
      "node_modules/native/addon.dylib",
    ]) {
      assert.isTrue(
        NodePath.matchesGlob(file, WINDOWS_NATIVE_ASAR_UNPACK_GLOB),
        `${file} must be available as a real file`,
      );
    }

    for (const file of [
      "node_modules/@napi-rs/keyring/index.js",
      "node_modules/@napi-rs/keyring/keytar.js",
      "node_modules/@clerk/electron-passkeys/index.js",
    ]) {
      assert.isFalse(
        NodePath.matchesGlob(file, WINDOWS_NATIVE_ASAR_UNPACK_GLOB),
        `${file} should remain inside the archive`,
      );
    }
  });

  it("stages only the externals of both bundles in merged packages", () => {
    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "mac",
        serverDependencies: {
          "@cursor/sdk": "1.0.22",
          "@anthropic-ai/claude-agent-sdk": "^0.3.170",
          "@ff-labs/fff-node": "0.9.4",
          "@opencode-ai/sdk": "^1.3.15",
          "@pierre/diffs": "1.3.0",
          "node-pty": "1.1.0",
        },
        desktopDependencies: {
          "@napi-rs/keyring": "1.3.0",
          "playwright-core": "1.60.0",
        },
        arch: "arm64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@cursor/sdk": "1.0.22",
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@napi-rs/keyring": "1.3.0",
        "playwright-core": "1.60.0",
        "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      },
    );

    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "linux",
        serverDependencies: { "@ff-labs/fff-node": "0.9.4", "node-pty": "1.1.0", effect: "4.0.0" },
        desktopDependencies: { "@crowecawcaw/xa11y": "0.13.0" },
        arch: "x64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@crowecawcaw/xa11y": "0.13.0",
        "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
        "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
      },
    );
  });

  it.effect("ships Cursor platform assets outside asar for spawning and native loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stark-cursor-helpers-" });
        const nodeModules = path.join(root, "node_modules");
        const destination = path.join(root, "resources/node_modules/@cursor");
        const cursorDirectory = symlinksSupported
          ? path.join(root, "store/@cursor")
          : path.join(nodeModules, "@cursor");
        yield* fs.makeDirectory(path.join(cursorDirectory, "sdk"), { recursive: true });
        if (symlinksSupported) {
          yield* fs.makeDirectory(path.join(nodeModules, "@cursor"), { recursive: true });
          yield* fs.symlink(
            path.join(cursorDirectory, "sdk"),
            path.join(nodeModules, "@cursor/sdk"),
          );
        }
        const helpers = [
          "sdk-darwin-arm64/bin/rg",
          "sdk-darwin-arm64/bin/cursorsandbox",
          "sdk-darwin-arm64/vendor/tree-sitter/index.js",
          "sdk-darwin-arm64/vendor/tree-sitter/binding.node",
          "sdk-darwin-arm64/vendor/tree-sitter-bash/binding.node",
          "sdk-darwin-arm64/package.json",
          "sdk-win32-x64/bin/rg.exe",
        ];
        for (const helper of helpers) {
          const source = path.join(cursorDirectory, helper);
          yield* fs.makeDirectory(path.dirname(source), { recursive: true });
          yield* fs.writeFileString(source, "fixture helper", { mode: 0o755 });
        }
        yield* stageCursorSdkPlatformPackages(nodeModules, destination);
        for (const helper of helpers) {
          assert.equal(yield* fs.readFileString(path.join(destination, helper)), "fixture helper");
          const packagedPath = `node_modules/@cursor/${helper}`;
          assert.isTrue(
            DESKTOP_FILE_EXCLUSIONS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob.slice(1)),
            ),
          );
          assert.isTrue(
            WINDOWS_SERVER_ASAR_IGNORE_GLOBS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob),
            ),
          );
        }
      }),
    ),
  );

  it("excludes node-pty binaries for the other Windows architecture", () => {
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("x64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-arm64",
      "**/node_modules/node-pty/prebuilds/win32-arm64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64/**",
    ]);
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("arm64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-x64",
      "**/node_modules/node-pty/prebuilds/win32-x64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64/**",
    ]);
  });

  it.effect("unpacks target Windows natives while excluding the other architecture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "stark-windows-architecture-test-",
        });
        const sourceDir = path.join(tempDir, "server");
        const nativeFiles = [
          "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-arm64/conpty/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-x64/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-x64/pty.node",
          "node_modules/node-pty/prebuilds/linux-x64/pty.node",
        ];

        for (const nativeFile of nativeFiles) {
          const nativePath = path.join(sourceDir, nativeFile);
          yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
          yield* fs.writeFileString(nativePath, nativeFile.includes("linux") ? "\x7fELF" : "MZ");
        }

        const asarPath = path.join(tempDir, "server.asar");
        yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
        const unpackedRoot = `${asarPath}.unpacked`;

        assert.isTrue(
          yield* fs.exists(
            path.join(
              unpackedRoot,
              "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
            ),
          ),
        );
        assert.isTrue(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
          ),
        );
        // Signed builds sign every unpacked .node, so the ELF prebuild stays packed.
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/linux-x64")),
        );
        assert.equal(
          extractFile(
            asarPath,
            path.join("node_modules", "node-pty", "prebuilds", "linux-x64", "pty.node"),
          ).toString(),
          "\x7fELF",
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-arm64")),
        );
        assert.isFalse(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64"),
          ),
        );
      }),
    ),
  );

  it("remaps release resource monitor paths without changing the build identity or flags", () => {
    const env = {
      HOME: "/Users/builder",
      CARGO_HOME: "/Volumes/Build Cache/cargo",
      RUSTUP_HOME: "/Volumes/Build Cache/rustup",
      RUSTFLAGS: "-C opt-level=2",
    };
    const actual = resourceMonitorReleaseEnvironment("/work/Stark Code", env);
    assert.equal(actual.HOME, env.HOME);
    assert.equal(actual.CARGO_HOME, env.CARGO_HOME);
    assert.equal(actual.RUSTFLAGS, env.RUSTFLAGS);
    assert.deepEqual(actual.CARGO_ENCODED_RUSTFLAGS?.split("\u001f"), [
      "-C",
      "opt-level=2",
      "--remap-path-prefix=/Users/builder=/build/home",
      "--remap-path-prefix=/Volumes/Build Cache/cargo=/build/cargo",
      "--remap-path-prefix=/Volumes/Build Cache/rustup=/build/rustup",
      "--remap-path-prefix=/work/Stark Code=/build/stark-code",
    ]);
    const encoded = resourceMonitorReleaseEnvironment("/repo", {
      ...env,
      CARGO_ENCODED_RUSTFLAGS: "--cfg\u001fstark_release",
    }).CARGO_ENCODED_RUSTFLAGS!;
    assert.isTrue(encoded.startsWith("--cfg\u001fstark_release\u001f"));
    assert.isFalse(encoded.includes("opt-level=2"));
    assert.include(DESKTOP_FILE_EXCLUSIONS, "!apps/desktop/prod-resources/resource-monitor/**/*");
  });

  it.effect("stages a cached resource monitor without invoking Cargo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "stark-resource-monitor-cache-test-",
        });
        const binaryPath = path.join(
          repoRoot,
          "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/stark-resource-monitor",
        );
        const stageResourcesDir = path.join(repoRoot, "stage");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "cached monitor");

        yield* stageResourceMonitor({
          repoRoot,
          stageResourcesDir,
          platform: "linux",
          arch: "x64",
          verbose: false,
        }).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { STARK_CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
              }),
            ),
          ),
        );

        assert.equal(
          yield* fs.readFileString(
            path.join(stageResourcesDir, "resource-monitor/stark-resource-monitor"),
          ),
          "cached monitor",
        );
      }),
    ),
  );

  it.effect("reports every missing Linux desktop build prerequisite with an install command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            commands.push(childProcess);
            const fails =
              childProcess.command === "cargo" ||
              childProcess.command === "rustc" ||
              childProcess.command === "pkg-config";
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );

        const error = yield* preflightLinuxDesktopBuild("arm64").pipe(
          Effect.provide(spawner),
          Effect.flip,
        );

        assert.instanceOf(error, LinuxDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["cargo", "rust-target", "libsecret"]);
        assert.include(error.message, "Rust compiler and Cargo (cargo, rustc)");
        assert.include(error.message, "Requested Rust standard library");
        assert.include(
          error.message,
          "sudo apt-get install cargo rustc libsecret-1-dev pkg-config",
        );
        assert.include(error.message, "rustup target add aarch64-unknown-linux-gnu");
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === "rustc" && command.args.includes("aarch64-unknown-linux-gnu"),
          ),
        );
      }),
    ),
  );

  it.effect("reports missing macOS tools and Rust targets before building", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            const fails = childProcess.command === "rustc" || childProcess.command === "sips";
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightMacDesktopBuild("universal").pipe(
          Effect.provide(spawner),
          Effect.flip,
        );

        assert.instanceOf(error, MacDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["rust", "sips"]);
        assert.deepStrictEqual(error.rustTargets, ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
        assert.include(error.message, "xcode-select --install");
        assert.include(error.message, "rustup target add aarch64-apple-darwin x86_64-apple-darwin");
      }),
    ),
  );

  it.effect("reports missing Windows toolchain capabilities before building", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "stark-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            const fails =
              childProcess.command === "rustc" ||
              childProcess.command === "powershell.exe" ||
              childProcess.command === pythonPath;
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: true,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { npm_config_python: pythonPath } }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["rust", "python", "msvc"]);
        assert.equal(error.rustTarget, "x86_64-pc-windows-msvc");
        assert.include(error.message, "Visual Studio Build Tools components");
      }),
    ),
  );

  it.effect("does not require MSVC when reusing a prebuilt Windows resource monitor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "stark-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const commands: string[] = [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            commands.push(childProcess.command);
            return Effect.succeed(mockProcess(childProcess.command === "powershell.exe" ? 1 : 0));
          }),
        );

        yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: true,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    npm_config_python: pythonPath,
                    STARK_CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true",
                  },
                }),
              ),
            ),
          ),
        );

        assert.notInclude(commands, "powershell.exe");
      }),
    ),
  );

  it.effect("rejects a PATH-discovered Python executable that is not Python 3", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "stark-python2-preflight-" });
        const pythonPath = path.join(tempDir, "python");
        yield* fs.writeFileString(pythonPath, "python2");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            if (childProcess.command === "python") {
              return Effect.succeed(mockProcess(0, `${pythonPath}\n`));
            }
            if (childProcess.command === pythonPath) {
              return Effect.succeed(mockProcess(1));
            }
            return Effect.succeed(mockProcess(0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: false,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { STARK_CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
                }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["python"]);
      }),
    ),
  );

  it.effect("builds and stages native capture helpers for each Linux architecture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "stark-kde-stage-test-" });
        const protocols = path.join(repoRoot, "native/hyprland-snap-shot/protocols");
        yield* fs.makeDirectory(protocols, { recursive: true });
        yield* fs.writeFileString(path.join(protocols, "capture.xml"), "BSD protocol notice");
        for (const backend of ["kde", "hyprland"] as const) {
          for (const [arch, target] of [
            ["x64", "x86_64-unknown-linux-gnu"],
            ["arm64", "aarch64-unknown-linux-gnu"],
          ] as const) {
            const binary = path.join(
              repoRoot,
              `native/${backend}-snap-shot/target`,
              target,
              `release/stark-${backend}-snap-shot`,
            );
            const stageResourcesDir = path.join(repoRoot, "stage", backend, arch);
            const spawner = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) =>
                Effect.gen(function* () {
                  assert.equal(command._tag, "StandardCommand");
                  if (command._tag !== "StandardCommand") return mockProcess(1);
                  assert.equal(command.command, "cargo");
                  assert.deepEqual(command.args, [
                    "build",
                    "--locked",
                    "--release",
                    "--manifest-path",
                    path.join(repoRoot, `native/${backend}-snap-shot/Cargo.toml`),
                    "--target",
                    target,
                  ]);
                  yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
                  yield* fs.writeFileString(binary, `helper-${arch}`);
                  return mockProcess(0);
                }),
              ),
            );
            yield* stageLinuxCaptureHelper({
              backend,
              repoRoot,
              stageResourcesDir,
              arch,
              verbose: false,
            }).pipe(Effect.provide(spawner));
            const installed = path.join(
              stageResourcesDir,
              `${backend}-capture/stark-${backend}-snap-shot`,
            );
            assert.equal(yield* fs.readFileString(installed), `helper-${arch}`);
            assert.equal((yield* fs.stat(installed)).mode & 0o777, 0o755);
            if (backend === "hyprland")
              assert.equal(
                yield* fs.readFileString(
                  path.join(stageResourcesDir, "hyprland-capture/protocols/capture.xml"),
                ),
                "BSD protocol notice",
              );
          }
        }
      }),
    ),
  );

  // The fixture's starkcode.exe is a text placeholder, not an executable. These
  // cases reach the native-load probe, so pin only that host-platform check to
  // Linux. Host-native paths and the real Windows tar/archive checks still run.
  it.effect("validates every ASAR-unpacked native in the packaged Windows payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const secondAsarPath = path.join(path.dirname(fixture.generatedAsarPath), "second.asar");
        yield* packWindowsServerAsar({
          sourceDir: fixture.sourceDir,
          asarPath: secondAsarPath,
          arch: "x64",
        });
        const [firstAsar, secondAsar] = yield* Effect.all([
          fs.readFile(fixture.generatedAsarPath),
          fs.readFile(secondAsarPath),
        ]);

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        assert.deepStrictEqual(result.unpackedFiles, ["node_modules/native/addon.node"]);
        assert.isBelow(result.fileCount, WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT);
        assert.deepStrictEqual(secondAsar, firstAsar);
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("accepts an embedded Linux CLI release archive with a matching digest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        });

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["x64", "arm64"] as const)(
    "accepts an embedded archive with the Linux %s node-pty prebuild",
    (targetArch) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            wslRuntime: "valid",
            targetArch,
            ptyPrebuildArch: targetArch,
          });
          const result = yield* validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch,
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          });

          assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        }),
      ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["x64", "arm64"] as const)(
    "rejects a node-pty prebuild for the wrong architecture in a Linux %s archive",
    (targetArch) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            wslRuntime: "valid",
            targetArch,
            ptyPrebuildArch: targetArch === "x64" ? "arm64" : "x64",
          });
          const error = yield* validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch,
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          }).pipe(Effect.flip);

          assert.instanceOf(error, WindowsPackagedPayloadValidationError);
          assert.equal(error.reason, "wsl-runtime-invalid");
        }),
      ),
  );

  it.effect("rejects an embedded archive built for a different release version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: "9.9.9",
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("rejects a Windows package missing its expected WSL runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-missing");
      }),
    ),
  );

  it.effect("rejects a loose server tree that is not a Linux CLI release archive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "loose-server-tree",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("rejects an embedded archive without the Linux node-pty binary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "missing-pty",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
        assert.deepStrictEqual(error.missingFiles, [
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/build/Release/pty.node`,
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/prebuilds/linux-x64/pty.node`,
        ]);
      }),
    ),
  );

  it.effect("rejects an emitted WSL archive whose sidecar digest does not match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "bad-digest",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("probes fff through the packaged Windows primary instead of helper executables", () => {
    const commands: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: {
        readonly cwd?: string;
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const primaryProbe = commands.find(
          (command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1",
        );
        if (primaryProbe === undefined) return assert.fail("Windows primary probe was not spawned");

        assert.equal(
          primaryProbe.command,
          path.join(fixture.packagedAppDir, fixture.appExecutableName),
        );
        assert.deepStrictEqual(primaryProbe.args.slice(0, 3), [
          "--no-global-search-paths",
          "--input-type=module",
          "--eval",
        ]);
        assert.include(primaryProbe.args[3], "FileFinder.create");
        assert.equal(
          primaryProbe.args[4],
          path.join(
            fixture.packagedAppDir,
            "resources/server.asar/node_modules/@ff-labs/fff-node/dist/index.js",
          ),
        );
        assert.equal(primaryProbe.options.cwd, fixture.packagedAppDir);
        assert.equal(primaryProbe.options.env?.NODE_PATH, "");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("builds the Linux browser secret helper for a concrete architecture", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      // `universal` is a mac-only arch the option type still admits. The helper
      // script only knows x64 and arm64, so the request maps to x64, the same
      // concrete target the Linux resource monitor resolves it to.
      yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "universal",
        verbose: false,
      });
      const helper = commands.find((command) =>
        command.args.some((arg) => arg.endsWith("build-browser-secret.mjs")),
      );
      assert.isDefined(helper);
      const path = yield* Path.Path;
      assert.deepStrictEqual(helper.args.slice(-4), [
        "--arch",
        "x64",
        "--output",
        path.join("/stage/resources", "browser-secret", "stark-browser-secret"),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("refuses a Linux build on a host that cannot build the browser secret helper", () => {
    const commands: Array<{ readonly command: string }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      // The helper links against the host's libsecret and its build script is
      // a no-op elsewhere, so a Linux artifact built on macOS would ship
      // without it and report the keyring as unavailable on every import.
      const error = yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "x64",
        verbose: false,
      }).pipe(Effect.flip);
      assert.instanceOf(error, LinuxBrowserSecretHostError);
      assert.equal(error.hostPlatform, "darwin");
      assert.include(error.message, "Linux host");
      assert.lengthOf(commands, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.Architecture, "arm64"),
        ),
      ),
    );
  });

  it.effect("refuses a Mac artifact when the dictation compiler cannot run on its host", () =>
    Effect.gen(function* () {
      const error = yield* stageDictation({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "mac",
        arch: "universal",
        verbose: false,
      }).pipe(Effect.flip);
      assert.instanceOf(error, MacDictationHostError);
      assert.equal(error.hostPlatform, "linux");
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("skips the primary native probe for cross-architecture Windows payloads", () => {
    const commands: Array<{
      readonly command: string;
      readonly options: {
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        assert.isFalse(
          commands.some((command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1"),
        );
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === process.execPath && command.options.env?.NODE_PATH === "",
          ),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("rejects a cross-architecture Windows payload without its primary executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const executablePath = path.join(fixture.packagedAppDir, fixture.appExecutableName);
        yield* fs.remove(executablePath);

        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPrimaryNativeProbeError);
        assert.equal(error.executablePath, executablePath);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    ),
  );

  it.effect("rejects a packaged sidecar whose ASAR-unpacked native is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: false });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unpacked-native-missing");
        assert.deepStrictEqual(error.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);
      }),
    ),
  );

  it.effect("rejects directories in place of packaged executable files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const nativePath = path.join(
          fixture.packagedAppDir,
          "resources/server.asar.unpacked/node_modules/native/addon.node",
        );
        yield* fs.remove(nativePath);
        yield* fs.makeDirectory(nativePath);

        const nativeError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(nativeError, WindowsPackagedPayloadValidationError);
        assert.equal(nativeError.reason, "unpacked-native-missing");
        assert.deepStrictEqual(nativeError.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);

        yield* fs.remove(nativePath, { recursive: true });
        yield* fs.writeFileString(nativePath, "native-binary");
        const resourceMonitorPath = path.join(
          fixture.packagedAppDir,
          "resources/resource-monitor/stark-resource-monitor.exe",
        );
        yield* fs.remove(resourceMonitorPath);
        yield* fs.makeDirectory(resourceMonitorPath);

        const resourceMonitorError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(resourceMonitorError, WindowsPackagedPayloadValidationError);
        assert.equal(resourceMonitorError.reason, "resource-monitor-missing");
        assert.deepStrictEqual(resourceMonitorError.missingFiles, [
          "resource-monitor/stark-resource-monitor.exe",
        ]);
      }),
    ),
  );

  it.effect("rejects a Windows payload that regresses above the file-count budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          fileLimit: 2,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "file-limit-exceeded");
        assert.isAbove(error.fileCount ?? 0, 2);
      }),
    ),
  );

  it.effect("rejects a sidecar whose extracted server bundle cannot resolve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "starkcode-deliberately-missing-package";\n',
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "starkcode-deliberately-missing-package");
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("preserves both Linux icon resize failures with structural context", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const error = yield* stageLinuxIconSize("source.png", "target.png", 512, false).pipe(
        Effect.provide(iconResizeSpawnerLayer(commands, [1, 2])),
        Effect.flip,
      );

      assert.instanceOf(error, LinuxIconResizeError);
      assert.equal(error.operation, "resize");
      assert.equal(error.iconSize, 512);
      assert.equal(error.primaryTool, "magick");
      assert.equal(error.fallbackTool, "convert");
      assert.include(error.message, "512x512");
      assert.include(error.message, "`magick`");
      assert.include(error.message, "`convert`");
      assert.notInclude(error.message, "non-zero exit code");

      assert.instanceOf(error.cause, AggregateError);
      const aggregateCause = error.cause as AggregateError;
      assert.lengthOf(aggregateCause.errors, 2);
      assert.strictEqual(aggregateCause.cause, aggregateCause.errors[0]);
      assert.instanceOf(aggregateCause.errors[0], BuildCommandFailedError);
      assert.instanceOf(aggregateCause.errors[1], BuildCommandFailedError);
      const primaryError = aggregateCause.errors[0] as BuildCommandFailedError;
      const fallbackError = aggregateCause.errors[1] as BuildCommandFailedError;
      assert.equal(primaryError.command, "magick linux icon 512x512");
      assert.equal(primaryError.exitCode, 1);
      assert.include(primaryError.message, "magick linux icon");
      assert.equal(fallbackError.command, "convert linux icon 512x512");
      assert.equal(fallbackError.exitCode, 2);
      assert.include(fallbackError.message, "convert linux icon");
      assert.deepStrictEqual(
        commands.map(({ command }) => command),
        ["magick", "convert"],
      );
    });
  });

  it.effect("rasterizes staged DMG backgrounds at standard and Retina sizes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "starkcode-dmg-background-",
        });
        const dmgDir = path.join(stageResourcesDir, "dmg");
        yield* fs.makeDirectory(dmgDir, { recursive: true });
        const sourcePath = path.join(dmgDir, "dmg-background-nightly.svg");
        yield* fs.writeFileString(sourcePath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];

        yield* stageDesktopDmgBackground(stageResourcesDir, "nightly", false).pipe(
          Effect.provide(iconResizeSpawnerLayer(commands, [0, 0])),
        );

        assert.deepStrictEqual(
          commands.map((command) => [command.command, ...command.args]),
          [
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "432",
              "640",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly.png"),
            ],
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "864",
              "1280",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly@2x.png"),
            ],
          ],
        );
      }),
    ),
  );

  it.effect("fails clearly when the selected DMG background source is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "starkcode-dmg-background-missing-",
        });

        const error = yield* stageDesktopDmgBackground(stageResourcesDir, "latest", false).pipe(
          Effect.flip,
        );

        assert.instanceOf(error, DesktopDmgBackgroundSourceMissingError);
        assert.equal(error.channel, "latest");
        assert.include(error.sourcePath, "dmg-background-latest.svg");
      }),
    ),
  );

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      STARK_CODE_APPLE_TEAM_ID: "abc1234567",
      STARK_CODE_MACOS_PROVISIONING_PROFILE: "/tmp/starkcode.provisionprofile",
      STARK_CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
    });

    assert.deepStrictEqual(configuration, {
      appId: "com.starkfuture.starkcode",
      teamId: "ABC1234567",
      rpDomains: ["example.clerk.accounts.dev"],
      provisioningProfilePath: "/tmp/starkcode.provisionprofile",
    });
  });

  it("normalizes explicit macOS passkey RP domains and renders required entitlements", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      STARK_CODE_APPLE_TEAM_ID: "ABC1234567",
      STARK_CODE_MACOS_PROVISIONING_PROFILE: "/tmp/starkcode.provisionprofile",
      STARK_CODE_CLERK_PASSKEY_RP_DOMAINS:
        " Clerk.Example.com,example.clerk.accounts.dev,clerk.example.com ",
    });
    const entitlements = renderMacPasskeyEntitlements(configuration, {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });

    assert.deepStrictEqual(configuration.rpDomains, [
      "clerk.example.com",
      "example.clerk.accounts.dev",
    ]);
    assert.include(entitlements, "<string>ABC1234567.com.starkfuture.starkcode</string>");
    assert.include(entitlements, "<string>webcredentials:clerk.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:example.clerk.accounts.dev</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
    assert.include(entitlements, "<key>com.apple.security.device.audio-input</key>");
    assert.notInclude(entitlements, "keychain-access-groups");
    assert.notInclude(entitlements, "com.apple.developer.web-browser.public-key-credential");
  });

  it("grants in-app browser passkey entitlements only when the provisioning profile does", () => {
    const configuration = { appId: "com.starkfuture.starkcode", teamId: "ABC1234567" };
    // Profiles are CMS envelopes around a plain XML plist.
    const profile = (entitlements: string, outside = "") =>
      `0\x82\x1f\x9a\x06\t*\x86H<?xml version="1.0"?><plist version="1.0"><dict>${outside}<key>Entitlements</key><dict>${entitlements}</dict></dict></plist>\x00\x01`;
    const teamWildcardGroups = `<key>keychain-access-groups</key>
      <array>
        <string>ABC1234567.*</string>
        <string>com.apple.token</string>
      </array>`;

    assert.deepStrictEqual(resolveMacWebAuthnEntitlements(profile(""), configuration), {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile("<key>keychain-access-groups</key><array><string>OTHERTEAM1.*</string></array>"),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    // Only real values inside the Entitlements dict count: not comments, not
    // explicit false, not keys elsewhere in the profile.
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `<!-- ${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key><true/> -->
          <key>com.apple.developer.web-browser.public-key-credential</key><false/>`,
          teamWildcardGroups,
        ),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key>
          <true/>`,
        ),
        configuration,
      ),
      {
        touchIdKeychainAccessGroup: "ABC1234567.com.starkfuture.starkcode.webauthn",
        browserPasskeys: true,
      },
    );

    const entitlements = renderMacPasskeyEntitlements(
      { ...configuration, rpDomains: ["clerk.example.com"], provisioningProfilePath: "" },
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}<key>com.apple.developer.web-browser.public-key-credential</key><true/>`,
        ),
        configuration,
      ),
    );
    assert.match(
      entitlements,
      /<key>keychain-access-groups<\/key>\s*<array>\s*<string>ABC1234567\.com\.starkfuture\.starkcode\.webauthn<\/string>\s*<\/array>/u,
    );
    assert.match(
      entitlements,
      /<key>com\.apple\.developer\.web-browser\.public-key-credential<\/key>\s*<true\/>/u,
    );
  });

  it("rejects incomplete macOS passkey signing configuration", () => {
    const captureError = (env: Readonly<Record<string, string | undefined>>) => {
      try {
        resolveMacPasskeySigningConfiguration(env);
      } catch (error) {
        return error;
      }
      return assert.fail("Expected passkey signing configuration to fail.");
    };

    const missingProfileError = captureError({
      STARK_CODE_APPLE_TEAM_ID: "ABC1234567",
      STARK_CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev",
    });
    assert.instanceOf(missingProfileError, MissingMacPasskeyProvisioningProfileError);
    assert.equal(
      missingProfileError.message,
      "STARK_CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.",
    );

    const unsafeDomain =
      "https://domain-user:domain-secret@example.clerk.accounts.dev/path?token=query-secret";
    const invalidDomainError = captureError({
      STARK_CODE_APPLE_TEAM_ID: "ABC1234567",
      STARK_CODE_MACOS_PROVISIONING_PROFILE: "/tmp/starkcode.provisionprofile",
      STARK_CODE_CLERK_PASSKEY_RP_DOMAINS: unsafeDomain,
    });
    assert.instanceOf(invalidDomainError, InvalidMacPasskeyRpDomainError);
    assert.equal(invalidDomainError.reason, "scheme-not-allowed");
    assert.equal(invalidDomainError.inputLength, unsafeDomain.length);
    assert.equal(invalidDomainError.message, "Invalid passkey RP domain (scheme-not-allowed).");
    assert.notProperty(invalidDomainError, "domain");
    assert.notProperty(invalidDomainError, "cause");
    const serializedInvalidDomainError = JSON.stringify(invalidDomainError);
    assert.notInclude(serializedInvalidDomainError, unsafeDomain);
    assert.notInclude(serializedInvalidDomainError, "domain-user");
    assert.notInclude(serializedInvalidDomainError, "domain-secret");
    assert.notInclude(serializedInvalidDomainError, "query-secret");
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          STARK_CODE_APPLE_TEAM_ID: "ABC1234567",
          STARK_CODE_MACOS_PROVISIONING_PROFILE: "/tmp/starkcode.provisionprofile",
          STARK_CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev:8443",
        }),
      /Invalid passkey RP domain/u,
    );
    const invalidPublishableKeyError = captureError({
      STARK_CODE_APPLE_TEAM_ID: "ABC1234567",
      STARK_CODE_MACOS_PROVISIONING_PROFILE: "/tmp/starkcode.provisionprofile",
      STARK_CODE_CLERK_PUBLISHABLE_KEY: "pk_test_%",
    });
    assert.instanceOf(invalidPublishableKeyError, InvalidMacPasskeyPublishableKeyError);
    assert.ok(invalidPublishableKeyError.cause);
    assert.equal(
      invalidPublishableKeyError.message,
      "STARK_CODE_CLERK_PUBLISHABLE_KEY is invalid.",
    );
    assert.notProperty(invalidPublishableKeyError, "publishableKey");
    assert.notInclude(invalidPublishableKeyError.message, "pk_test_%");
  });

  it("preserves known passkey signing configuration errors at the build boundary", () => {
    const decodingCause = new Error("publishable-key-decode-failed");
    const knownError = new InvalidMacPasskeyPublishableKeyError({ cause: decodingCause });
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(knownError);

    assert.strictEqual(error, knownError);
    assert.instanceOf(error, InvalidMacPasskeyPublishableKeyError);
    assert.strictEqual(error.cause, decodingCause);
    assert.isTrue(isMacPasskeySigningConfigurationError(error));
  });

  it("wraps unknown passkey signing configuration defects without copying cause text", () => {
    const secret = "pk_test_do-not-retain";
    const cause = new Error(secret);
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(cause);

    assert.instanceOf(error, MacPasskeySigningConfigurationResolutionError);
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message, "Failed to resolve macOS passkey signing configuration.");
    assert.notInclude(error.message, secret);
  });

  it.effect("adds passkey entitlements and both renderer protocols to signed macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, NO_DESKTOP_UPDATE_FEED, {
        mode: "developer-id",
        entitlementsPath: "/tmp/entitlements.mac.plist",
        entitlementsInheritPath: "/tmp/stage/apps/desktop/resources/entitlements.mac.plist",
        provisioningProfilePath: "/tmp/starkcode.provisionprofile",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "com.starkfuture.starkcode");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      // Helper processes keep the plain hardened-runtime entitlements.
      assert.equal(
        mac.entitlementsInherit,
        "/tmp/stage/apps/desktop/resources/entitlements.mac.plist",
      );
      assert.equal(mac.provisioningProfile, "/tmp/starkcode.provisionprofile");
      assert.match(String(mac.sign), /[\\/]scripts[\\/]sign-macos\.ts$/);
      assert.deepStrictEqual(mac.protocols, [
        { name: "Stark Code", schemes: ["starkcode", "starkcode-dev"] },
        { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("uses the nightly DMG background for nightly macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3-nightly.20260815.1",
        false,
        NO_DESKTOP_UPDATE_FEED,
        undefined,
      );

      assert.equal(
        (config.dmg as Record<string, unknown>).background,
        "dmg/dmg-background-nightly.png",
      );
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("configures Windows executable metadata and native signing extensions", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        NO_DESKTOP_UPDATE_FEED,
        undefined,
      );

      const win = config.win as Record<string, unknown>;
      assert.equal(win.icon, "icon.ico");
      assert.deepStrictEqual(win.signExts, [".node", ".dll"]);
      assert.equal(win.signAndEditExecutable, true);
      assert.notProperty(win, "azureSignOptions");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("stages the resource monitor as an external executable resource", () => {
    assert.deepStrictEqual(DESKTOP_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/resources/browser-capture-host.cjs",
        to: "browser-capture-host.cjs",
      },
      {
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
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("mac", "universal"), [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("linux", "x64"), [
      "x86_64-unknown-linux-gnu",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("win", "arm64"), [
      "aarch64-pc-windows-msvc",
    ]);
    assert.equal(resourceMonitorExecutableName("mac"), "stark-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win"), "stark-resource-monitor.exe");
  });

  it("ships the Linux CLI release archive as the WSL runtime", () => {
    assert.equal(WSL_RUNTIME_ARCHIVE_NAME, "wsl-runtime.tar.gz");
    assert.equal(WSL_RUNTIME_ARCHIVE_HASH_NAME, "wsl-runtime.tar.gz.sha256");
    assert.deepStrictEqual(WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE, {
      from: "apps/desktop/prod-resources/wsl-runtime.tar.gz",
      to: "wsl-runtime.tar.gz",
    });
    assert.deepStrictEqual(WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE, {
      from: "apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
      to: "wsl-runtime.tar.gz.sha256",
    });
    // Both the staging and the packaging config hang off this one decision:
    // Windows only, and only when CI handed the build a Linux CLI archive.
    const runtimeArchivePath = "/tmp/stark-1.2.3-linux-x64.tar.gz";
    assert.isTrue(bundlesWslRuntime({ platform: "win", runtimeArchivePath }));
    assert.isFalse(bundlesWslRuntime({ platform: "win", runtimeArchivePath: undefined }));
    assert.isFalse(bundlesWslRuntime({ platform: "linux", runtimeArchivePath }));
    assert.isFalse(bundlesWslRuntime({ platform: "mac", runtimeArchivePath }));
    assert.equal(wslRuntimeArchiveStem("1.2.3", "x64"), "stark-1.2.3-linux-x64");
  });

  it("parses Windows bsdtar member listings with CRLF line endings", () => {
    assert.deepStrictEqual(
      parseWslRuntimeArchiveMembers(
        "./stark-1.2.3-linux-x64/stark-code\r\nstark-1.2.3-linux-x64/client/\r\n",
      ),
      ["stark-1.2.3-linux-x64/stark-code", "stark-1.2.3-linux-x64/client"],
    );
  });

  it.effect("stages the Linux CLI archive verbatim with its SHA-256 sidecar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stark-wsl-runtime-stage-" });
        const sourceArchivePath = yield* makeLinuxCliArchiveFixture({
          root,
          stem: "stark-1.2.3-linux-x64",
        });
        const stageAppDir = path.join(root, "app");
        const archivePath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from);
        const hashPath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE.from);

        yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });

        const [source, staged] = yield* Effect.all([
          fs.readFile(sourceArchivePath),
          fs.readFile(archivePath),
        ]);
        assert.deepStrictEqual(staged, source);
        // The digest both gates installation inside the distro and names the
        // extracted runtime's cache directory.
        const hash = yield* fs.readFileString(hashPath);
        assert.equal(hash, `${NodeCrypto.createHash("sha256").update(source).digest("hex")}\n`);
      }),
    ),
  );

  it.effect("fails when the Linux CLI archive handed to the build does not exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stark-wsl-runtime-missing-" });
        const error = yield* stageWslRuntimeArchive({
          sourceArchivePath: path.join(root, "stark-1.2.3-linux-x64.tar.gz"),
          archivePath: path.join(root, WSL_RUNTIME_ARCHIVE_NAME),
          hashPath: path.join(root, WSL_RUNTIME_ARCHIVE_HASH_NAME),
        }).pipe(Effect.flip);

        assert.instanceOf(error, WslRuntimeArchiveMissingError);
      }),
    ),
  );

  it("promotes target fff binaries to direct staged dependencies", () => {
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "universal", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      "@ff-labs/fff-bin-darwin-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("win", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-arm64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-arm64-musl": "0.9.4",
    });
  });

  it("resolves target Clerk passkey native artifacts", () => {
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("mac", "universal"), [
      {
        packageName: "@clerk/electron-passkeys-darwin-arm64",
        binaryFileName: "electron-passkeys.darwin-arm64.node",
      },
      {
        packageName: "@clerk/electron-passkeys-darwin-x64",
        binaryFileName: "electron-passkeys.darwin-x64.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("win", "x64"), [
      {
        packageName: "@clerk/electron-passkeys-win32-x64-msvc",
        binaryFileName: "electron-passkeys.win32-x64-msvc.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("linux", "x64"), []);
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000/");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123/");
  });

  it("derives the electron-builder package manager user agent from packageManager", () => {
    assert.equal(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.equal(resolvePackageManagerUserAgent(" yarn@4.9.2 "), "yarn/4.9.2");
    assert.equal(resolvePackageManagerUserAgent("pnpm"), "pnpm");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it("classifies invalid configured ports with the decoder's number grammar", () => {
    const cause = new Error("invalid configured port");

    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).reason,
      "not-numeric",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("12.5", cause).reason,
      "not-integer",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("65536", cause).reason,
      "out-of-range",
    );
    assert.strictEqual(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).cause,
      cause,
    );
  });

  it.effect("resolves default platform and architecture from host references", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "win32"),
            Layer.succeed(HostProcess.Architecture, "x64"),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PROCESSOR_ARCHITECTURE: "AMD64",
                  PROCESSOR_ARCHITEW6432: "ARM64",
                },
              }),
            ),
          ),
        ),
      );

      assert.equal(resolved.platform, "win");
      assert.equal(resolved.target, "nsis");
      assert.equal(resolved.arch, "arm64");
    }),
  );

  it.effect("rejects universal builds on Linux and Windows before staging binaries", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "win"] as const) {
        const error = yield* Effect.flip(
          resolveBuildOptions({
            platform: Option.some(platform),
            target: Option.none(),
            arch: Option.some("universal"),
            buildVersion: Option.none(),
            outputDir: Option.none(),
            skipBuild: Option.none(),
            keepStage: Option.none(),
            signed: Option.none(),
            verbose: Option.none(),
            mockUpdates: Option.none(),
            mockUpdateServerPort: Option.none(),
            wslRuntime: Option.none(),
          }),
        );

        assert.instanceOf(error, UnsupportedDesktopBuildArchitectureError);
        assert.deepStrictEqual(error.supportedArchitectures, ["x64", "arm64"]);
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                STARK_CODE_DESKTOP_SKIP_BUILD: "true",
                STARK_CODE_DESKTOP_KEEP_STAGE: "true",
                STARK_CODE_DESKTOP_SIGNED: "true",
                STARK_CODE_DESKTOP_VERBOSE: "true",
                STARK_CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.updateFeed.kind, "none");
    }),
  );

  it.effect("keeps the mock feed to rehearsal builds written below release-mock/", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolveMock = (
        overrides: Partial<Parameters<typeof resolveBuildOptions>[0]>,
        env: Record<string, string> = {},
      ) =>
        resolveBuildOptions({
          platform: Option.some("mac"),
          target: Option.none(),
          arch: Option.some("arm64"),
          buildVersion: Option.none(),
          outputDir: Option.none(),
          skipBuild: Option.none(),
          keepStage: Option.none(),
          signed: Option.none(),
          verbose: Option.none(),
          mockUpdates: Option.some(true),
          mockUpdateServerPort: Option.some(3123),
          wslRuntime: Option.none(),
          ...overrides,
        }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));
      const refusal = (
        overrides: Partial<Parameters<typeof resolveBuildOptions>[0]>,
        env: Record<string, string> = {},
      ) =>
        resolveMock(overrides, env).pipe(
          Effect.flip,
          Effect.map((error) => {
            assert.instanceOf(error, DesktopUpdateFeedConfigError);
            return error as DesktopUpdateFeedConfigError;
          }),
        );

      const mock = yield* resolveMock({});
      assert.deepStrictEqual(mock.updateFeed, { kind: "mock", url: "http://localhost:3123/" });
      assert.equal(path.basename(mock.outputDir), "release-mock");
      const nested = yield* resolveMock({ outputDir: Option.some("release-mock/n") });
      assert.equal(path.basename(path.dirname(nested.outputDir)), "release-mock");
      const fromEnv = yield* resolveMock(
        { mockUpdates: Option.none() },
        { STARK_CODE_DESKTOP_UPDATE_FEED: "mock" },
      );
      assert.equal(fromEnv.updateFeed.kind, "mock");

      for (const outputDir of ["release", "release-mock-copy", "release-mock/../release"]) {
        const error = yield* refusal({ outputDir: Option.some(outputDir) });
        assert.equal(error.reason, "mock-output-dir", outputDir);
      }
      const absolute = yield* refusal({
        outputDir: Option.some(path.join(path.dirname(mock.outputDir), "..", "elsewhere")),
      });
      assert.equal(absolute.reason, "mock-output-dir");
      assert.equal(
        (yield* refusal(
          {},
          {
            STARK_CODE_DESKTOP_UPDATE_FEED: "stark",
            STARK_CODE_DESKTOP_UPDATE_URL: STARK_FEED.url,
          },
        )).reason,
        "conflicts-with-mock-updates",
      );
      const removed = yield* refusal(
        {},
        { STARK_CODE_DESKTOP_UPDATE_REPOSITORY: "example/stark-code" },
      );
      assert.equal(removed.reason, "repository-removed");
      assert.include(removed.message, "STARK_CODE_DESKTOP_UPDATE_URL");
      assert.equal(
        (yield* refusal({ mockUpdates: Option.none(), signed: Option.some(true) })).reason,
        "mode-required",
      );

      const mockBeta = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.46-beta.1",
        false,
        mock.updateFeed,
        undefined,
      );
      const mockPublish = [
        { provider: "generic", url: "http://localhost:3123/", channel: "latest" },
      ];
      assert.deepStrictEqual(mockBeta.publish, mockPublish);
      assert.deepStrictEqual((mockBeta.mac as Record<string, unknown>).publish, mockPublish);
      assert.isTrue(String(mockBeta.afterPack).endsWith(DESKTOP_UPDATE_KIND_HOOK));
      const nightly = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.46-nightly.20261029.7",
        false,
        mock.updateFeed,
        undefined,
      ).pipe(Effect.flip);
      assert.instanceOf(nightly, DesktopUpdateFeedConfigError);
      assert.equal((nightly as DesktopUpdateFeedConfigError).reason, "channel-not-enabled");
      assert.deepStrictEqual(createBakedUpdatePolicy(mock.updateFeed, "0.0.46-beta.1"), {
        kind: "mock",
        url: "http://localhost:3123/",
        channels: ["latest"],
        appleTeamId: "6QNLKCM5Y5",
      });
      assert.deepStrictEqual(createBakedUpdatePolicy(NO_DESKTOP_UPDATE_FEED, "0.0.46"), {
        kind: "none",
        url: null,
        channels: [],
        appleTeamId: "6QNLKCM5Y5",
      });
    }),
  );

  it.effect("pins a Stark feed to Developer ID builds of the checked-in team", () =>
    Effect.gen(function* () {
      const developerId: MacSigningPlan = {
        mode: "developer-id",
        identitySource: "keychain",
        keychainIdentity: "Stark Future GmbH (ABCDE12345)",
        notarization: "keychain-profile",
        expectedTeamId: "ABCDE12345",
      };
      const development: MacSigningPlan = {
        mode: "development",
        identitySource: "keychain",
        keychainIdentity: "2222222222222222222222222222222222222222",
        notarization: undefined,
        expectedTeamId: undefined,
      };
      const check = (
        feed: DesktopUpdateFeedPlan,
        plan: MacSigningPlan | undefined,
        env: Record<string, string> = { APPLE_TEAM_ID: "ABCDE12345" },
        platform: "mac" | "linux" | "win" = "mac",
        ownership: UpdateOwnership = FEED_OWNERSHIP,
      ) => checkDesktopUpdateFeedSigning({ feed, platform, plan, env }, ownership);
      const reasonOf = (effect: ReturnType<typeof check>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      yield* check(STARK_FEED, developerId);
      yield* check(STARK_FEED, developerId, { APPLE_TEAM_ID: "abcde12345" });
      yield* check(NO_DESKTOP_UPDATE_FEED, undefined, {}, "linux");
      yield* check(MOCK_FEED, development);
      yield* check(MOCK_FEED, undefined);

      assert.equal(yield* reasonOf(check(MOCK_FEED, developerId)), "mock-developer-id");
      assert.equal(yield* reasonOf(check(MOCK_FEED, undefined, {}, "linux")), "not-mac");
      assert.equal(yield* reasonOf(check(STARK_FEED, development)), "stark-needs-developer-id");
      assert.equal(yield* reasonOf(check(STARK_FEED, undefined)), "stark-needs-developer-id");
      assert.equal(yield* reasonOf(check(STARK_FEED, developerId, {})), "team-id-missing");
      assert.equal(
        yield* reasonOf(check(STARK_FEED, developerId, { APPLE_TEAM_ID: "ZZZZZ99999" })),
        "team-id-mismatch",
      );
      assert.equal(
        yield* reasonOf(
          check(STARK_FEED, developerId, { APPLE_TEAM_ID: "ABCDE12345" }, "mac", {
            ...FEED_OWNERSHIP,
            appleTeamId: null,
          }),
        ),
        "team-id-not-configured",
      );
      // APPLE_TEAM_ID must name the team stark.brand.json checks in.
      assert.equal(
        yield* reasonOf(
          checkDesktopUpdateFeedSigning({
            feed: STARK_FEED,
            platform: "mac",
            plan: developerId,
            env: { APPLE_TEAM_ID: "ABCDE12345" },
          }),
        ),
        "team-id-mismatch",
      );
      yield* checkDesktopUpdateFeedSigning({
        feed: STARK_FEED,
        platform: "mac",
        plan: developerId,
        env: { APPLE_TEAM_ID: "6QNLKCM5Y5" },
      });
    }),
  );

  it.effect("checks the packaged app-update.yml with the code the app runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dist = yield* fs.makeTempDirectoryScoped({ prefix: "stark-packaged-feed-" });
        const appRelative = path.join(
          "mac-arm64",
          "Stark Code (Alpha).app",
          "Contents",
          "Resources",
          "app-update.yml",
        );
        const appUpdateYml = path.join(dist, appRelative);
        yield* fs.makeDirectory(path.dirname(appUpdateYml), { recursive: true });
        const none = createBakedUpdatePolicy(NO_DESKTOP_UPDATE_FEED, "0.0.47", FEED_OWNERSHIP);
        const stark = createBakedUpdatePolicy(STARK_FEED, "0.0.47", FEED_OWNERSHIP);
        const verify = (policy: typeof none) =>
          verifyPackagedUpdateFeed({ stageDistDir: dist, policy }, FEED_OWNERSHIP);
        const refusal = (policy: typeof none) =>
          verify(policy).pipe(
            Effect.flip,
            Effect.map((error) => {
              assert.instanceOf(error, PackagedDesktopUpdateFeedError);
              return error as PackagedDesktopUpdateFeedError;
            }),
          );

        assert.deepStrictEqual(yield* verify(none), { file: null, sha256: null });
        assert.equal((yield* refusal(stark)).reason, "app-update-missing");

        // What electron-builder writes for a token plus an upstream slug.
        yield* fs.writeFileString(
          appUpdateYml,
          "owner: pingdotgg\nrepo: t3code\nprovider: github\nupdaterCacheDirName: starkcode-updater\n",
        );
        const unexpected = yield* refusal(none);
        assert.equal(unexpected.reason, "unexpected-app-update");
        assert.equal(unexpected.file, appRelative);
        const upstream = yield* refusal(stark);
        assert.equal(upstream.reason, "app-update-mismatch");
        assert.equal(upstream.problem, "yml-unexpected-key");
        // A token without a repository leaves a provider-less file.
        yield* fs.writeFileString(appUpdateYml, "updaterCacheDirName: starkcode-updater\n");
        assert.equal((yield* refusal(stark)).problem, "yml-missing-key");
        // Exactly the baked feed, kind included.
        const baked = `provider: generic\nurl: ${STARK_FEED.url}\nchannel: latest\nupdaterCacheDirName: starkcode-updater\nkind: stark\n`;
        yield* fs.writeFileString(appUpdateYml, baked);
        assert.deepStrictEqual(yield* verify(stark), {
          file: appRelative,
          sha256: NodeCrypto.createHash("sha256").update(baked).digest("hex"),
        });
        yield* fs.writeFileString(appUpdateYml, baked.replace("kind: stark", "kind: mock"));
        assert.equal((yield* refusal(stark)).problem, "kind-mismatch");

        // Unpacked Linux and Windows apps are checked too.
        yield* fs.remove(appUpdateYml);
        const linuxYml = path.join(dist, "linux-unpacked", "resources", "app-update.yml");
        yield* fs.makeDirectory(path.dirname(linuxYml), { recursive: true });
        yield* fs.writeFileString(linuxYml, "provider: github\nowner: pingdotgg\nrepo: t3code\n");
        assert.equal(
          (yield* refusal(none)).file,
          path.join("linux-unpacked", "resources", "app-update.yml"),
        );
      }),
    ),
  );

  it.effect("requires a Stark feed build's designated requirement to pin the team", () =>
    Effect.gen(function* () {
      const developerIdRequirement = `Executable=/stage/Stark Code (Alpha).app/Contents/MacOS/Stark Code (Alpha)
designated => anchor apple generic and identifier "com.starkfuture.starkcode" and (certificate leaf[field.1.2.840.113635.100.6.1.9] /* exists */ or certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ABCDE12345)`;
      const developmentRequirement = `designated => identifier "com.starkfuture.starkcode" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: Jane Doe (QWERTY1234)" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */`;
      const commands: Array<ReadonlyArray<string>> = [];
      const verify = (output: string, feed: DesktopUpdateFeedPlan) =>
        verifyMacDesignatedRequirement({ appPath: "/stage/App.app", feed }, FEED_OWNERSHIP).pipe(
          Effect.provide(macToolSpawnerLayer(commands, () => Effect.succeed({ stdout: output }))),
        );
      const reasonOf = (output: string, feed: DesktopUpdateFeedPlan) =>
        verify(output, feed).pipe(
          Effect.flip,
          Effect.map((error) => {
            assert.instanceOf(error, PackagedDesktopUpdateFeedError);
            return (error as PackagedDesktopUpdateFeedError).reason;
          }),
        );

      assert.equal((yield* verify(developerIdRequirement, STARK_FEED)).teamId, "ABCDE12345");
      assert.deepStrictEqual(commands[0], [
        "/usr/bin/codesign",
        "--display",
        "-r-",
        "/stage/App.app",
      ]);
      assert.equal(yield* reasonOf(developmentRequirement, STARK_FEED), "requirement-not-pinned");
      assert.equal(
        yield* reasonOf(developerIdRequirement.replace("ABCDE12345", "ZZZZZ99999"), STARK_FEED),
        "requirement-not-pinned",
      );
      assert.equal(
        (yield* verify(developmentRequirement, MOCK_FEED)).identifier,
        "com.starkfuture.starkcode",
      );
      assert.equal(
        yield* reasonOf('# designated => cdhash H"0123abcd"', MOCK_FEED),
        "requirement-identifier",
      );
    }),
  );

  it.effect("bakes the feed kind into app-update.yml before signing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        assert.equal(
          withUpdateFeedKind("provider: generic\nurl: x\n", "mock"),
          "provider: generic\nurl: x\nkind: mock\n",
        );
        assert.equal(
          withUpdateFeedKind("provider: generic\r\nkind: stark\r\n", "mock"),
          "provider: generic\nkind: mock\n",
        );

        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "stark-update-kind-hook-" });
        const file = path.join(dir, "app-update.yml");
        const written = "provider: generic\nurl: http://localhost:3123/\nchannel: latest\n";
        const context = (metadata: Record<string, unknown>, platform = "darwin") => ({
          appOutDir: dir,
          electronPlatformName: platform,
          packager: { getResourcesDir: () => dir, info: { metadata } },
        });

        // Nothing to mark yet: the hook leaves the missing file to the verifier.
        yield* Effect.promise(() => afterPack(context({ starkcodeUpdate: { kind: "mock" } })));
        assert.isFalse(yield* fs.exists(file));

        yield* fs.writeFileString(file, written);
        for (const metadata of [{}, { starkcodeUpdate: { kind: "none" } }]) {
          yield* Effect.promise(() => afterPack(context(metadata)));
        }
        yield* Effect.promise(() =>
          afterPack(context({ starkcodeUpdate: { kind: "mock" } }, "linux")),
        );
        assert.equal(yield* fs.readFileString(file), written);

        yield* Effect.promise(() => afterPack(context({ starkcodeUpdate: { kind: "mock" } })));
        assert.equal(yield* fs.readFileString(file), `${written}kind: mock\n`);
      }),
    ),
  );

  it.effect("accepts each complete macOS signing credential combination", () =>
    Effect.gen(function* () {
      const developmentIdentity = "2222222222222222222222222222222222222222";
      assert.deepStrictEqual(
        yield* resolveMacSigningPlan({
          signed: false,
          env: { CSC_NAME: developmentIdentity, APPLE_KEYCHAIN_PROFILE: "stark-notary" },
        }),
        {
          mode: "unsigned",
          identitySource: undefined,
          keychainIdentity: undefined,
          notarization: undefined,
          expectedTeamId: undefined,
        },
      );
      assert.deepStrictEqual(
        yield* resolveMacSigningPlan({
          signed: true,
          env: {
            CSC_LINK: "/secrets/developer-id.p12",
            CSC_KEY_PASSWORD: "p12-secret",
            APPLE_API_KEY: "/secrets/AuthKey_KEY1234567.p8",
            APPLE_API_KEY_ID: "KEY1234567",
            APPLE_API_ISSUER: "issuer-secret",
          },
        }),
        {
          mode: "developer-id",
          identitySource: "certificate-file",
          keychainIdentity: undefined,
          notarization: "api-key",
          expectedTeamId: undefined,
        },
      );
      assert.deepStrictEqual(
        yield* resolveMacSigningPlan({
          signed: true,
          env: {
            CSC_NAME: " Stark Future GmbH (ABCDE12345) ",
            APPLE_ID: "release@example.com",
            APPLE_APP_SPECIFIC_PASSWORD: "app-secret",
            APPLE_TEAM_ID: "abcde12345",
          },
        }),
        {
          mode: "developer-id",
          identitySource: "keychain",
          keychainIdentity: "Stark Future GmbH (ABCDE12345)",
          notarization: "apple-id",
          expectedTeamId: "ABCDE12345",
        },
      );
      // Blank values are unset, as they are for electron-builder.
      assert.deepStrictEqual(
        yield* resolveMacSigningPlan({
          signed: true,
          env: {
            CSC_LINK: "  ",
            CSC_NAME: "Stark Future GmbH (ABCDE12345)",
            APPLE_KEYCHAIN_PROFILE: "stark-notary",
            APPLE_KEYCHAIN: "/Users/maintainer/Library/Keychains/login.keychain-db",
          },
        }),
        {
          mode: "developer-id",
          identitySource: "keychain",
          keychainIdentity: "Stark Future GmbH (ABCDE12345)",
          notarization: "keychain-profile",
          expectedTeamId: undefined,
        },
      );
      // A development rehearsal never notarizes, whatever Apple credentials
      // the shell carries.
      assert.deepStrictEqual(
        yield* resolveMacSigningPlan({
          signed: true,
          env: {
            STARK_CODE_MACOS_SIGNING_MODE: "development",
            CSC_NAME: developmentIdentity,
            APPLE_ID: "release@example.com",
          },
        }),
        {
          mode: "development",
          identitySource: "keychain",
          keychainIdentity: developmentIdentity,
          notarization: undefined,
          expectedTeamId: undefined,
        },
      );
    }),
  );

  it.effect("names missing or conflicting macOS signing variables, never their values", () =>
    Effect.gen(function* () {
      const secrets = [
        "/secrets/developer-id.p12",
        "p12-secret",
        "app-secret",
        "issuer-secret",
        "/secrets/AuthKey_KEY1234567.p8",
      ];
      const rejection = (env: Readonly<Record<string, string>>, signed = true) =>
        resolveMacSigningPlan({ signed, env }).pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              for (const secret of secrets) {
                assert.notInclude(error.message, secret);
                assert.notInclude(JSON.stringify(error), secret);
              }
            }),
          ),
        );
      const keychain = { CSC_NAME: "Stark Future GmbH (ABCDE12345)" };
      const profile = { APPLE_KEYCHAIN_PROFILE: "stark-notary" };

      assert.instanceOf(yield* rejection(profile), MissingMacSigningIdentityError);

      const missingPassword = yield* rejection({
        CSC_LINK: "/secrets/developer-id.p12",
        ...profile,
      });
      assert.instanceOf(missingPassword, IncompleteMacSigningCredentialsError);
      assert.deepStrictEqual(missingPassword.missing, ["CSC_KEY_PASSWORD"]);
      assert.include(missingPassword.message, "CSC_KEY_PASSWORD");

      const twoIdentities = yield* rejection({
        CSC_LINK: "/secrets/developer-id.p12",
        CSC_KEY_PASSWORD: "p12-secret",
        ...keychain,
        ...profile,
      });
      assert.instanceOf(twoIdentities, ConflictingMacSigningCredentialsError);
      assert.deepStrictEqual(twoIdentities.credentialSets, ["certificate-file", "keychain"]);

      const notNotarized = yield* rejection(keychain);
      assert.instanceOf(notNotarized, MissingMacNotarizationCredentialsError);
      assert.include(notNotarized.message, "STARK_CODE_MACOS_SIGNING_MODE=development");

      const partialApiKey = yield* rejection({
        ...keychain,
        APPLE_API_KEY: "/secrets/AuthKey_KEY1234567.p8",
        APPLE_API_ISSUER: "issuer-secret",
      });
      assert.instanceOf(partialApiKey, IncompleteMacSigningCredentialsError);
      assert.equal(partialApiKey.credentialSet, "api-key");
      assert.deepStrictEqual(partialApiKey.missing, ["APPLE_API_KEY_ID"]);

      const appleIdWithoutTeam = yield* rejection({
        ...keychain,
        APPLE_ID: "release@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "app-secret",
      });
      assert.instanceOf(appleIdWithoutTeam, IncompleteMacSigningCredentialsError);
      assert.deepStrictEqual(appleIdWithoutTeam.missing, ["APPLE_TEAM_ID"]);

      const keychainWithoutProfile = yield* rejection({
        ...keychain,
        APPLE_KEYCHAIN: "/Users/maintainer/Library/Keychains/login.keychain-db",
      });
      assert.instanceOf(keychainWithoutProfile, IncompleteMacSigningCredentialsError);
      assert.deepStrictEqual(keychainWithoutProfile.missing, ["APPLE_KEYCHAIN_PROFILE"]);

      const twoNotarizations = yield* rejection({
        ...keychain,
        ...profile,
        APPLE_ID: "release@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "app-secret",
        APPLE_TEAM_ID: "ABCDE12345",
      });
      assert.instanceOf(twoNotarizations, ConflictingMacSigningCredentialsError);
      assert.deepStrictEqual(twoNotarizations.credentialSets, ["apple-id", "keychain-profile"]);

      // electron-builder refuses a certificate-type prefix in CSC_NAME.
      assert.instanceOf(
        yield* rejection({
          CSC_NAME: "Developer ID Application: Stark Future GmbH (ABCDE12345)",
          ...profile,
        }),
        InvalidMacSigningIdentityNameError,
      );
      assert.instanceOf(
        yield* rejection({ ...keychain, ...profile, APPLE_TEAM_ID: "SHORT" }),
        InvalidMacSigningTeamIdError,
      );
      assert.instanceOf(
        yield* rejection({ STARK_CODE_MACOS_SIGNING_MODE: "adhoc", ...keychain, ...profile }),
        InvalidMacSigningModeError,
      );
      // A mode without --signed would otherwise build unsigned without a word.
      assert.instanceOf(
        yield* rejection({ STARK_CODE_MACOS_SIGNING_MODE: "developer-id" }, false),
        MacSigningModeRequiresSignedBuildError,
      );
    }),
  );

  it("keeps signing credentials away from builds that must not use them", () => {
    const env = {
      PATH: "/usr/bin",
      CSC_LINK: "/secrets/developer-id.p12",
      CSC_KEY_PASSWORD: "p12-secret",
      CSC_NAME: "Stark Future GmbH (ABCDE12345)",
      APPLE_ID: "release@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "app-secret",
      APPLE_TEAM_ID: "ABCDE12345",
      APPLE_API_KEY: "/secrets/AuthKey_KEY1234567.p8",
      APPLE_API_KEY_ID: "KEY1234567",
      APPLE_API_ISSUER: "issuer-secret",
      APPLE_KEYCHAIN: "/Users/maintainer/Library/Keychains/login.keychain-db",
      APPLE_KEYCHAIN_PROFILE: "stark-notary",
    };

    assert.deepStrictEqual(
      removeUnusedSigningCredentials(env, { signed: false, macSigningMode: "unsigned" }),
      { PATH: "/usr/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    );
    assert.deepStrictEqual(
      removeUnusedSigningCredentials(env, { signed: true, macSigningMode: "development" }),
      {
        PATH: "/usr/bin",
        CSC_LINK: "/secrets/developer-id.p12",
        CSC_KEY_PASSWORD: "p12-secret",
        CSC_NAME: "Stark Future GmbH (ABCDE12345)",
      },
    );
    assert.deepStrictEqual(
      removeUnusedSigningCredentials(env, { signed: true, macSigningMode: "developer-id" }),
      env,
    );
    // Signed Linux and Windows builds have no macOS plan.
    assert.deepStrictEqual(
      removeUnusedSigningCredentials(env, { signed: true, macSigningMode: undefined }),
      env,
    );
  });

  it("opts into macOS passkey signing only with a provisioning profile", () => {
    assert.isFalse(
      isMacPasskeySigningRequested({
        STARK_CODE_APPLE_TEAM_ID: "ABCDE12345",
        STARK_CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
      }),
    );
    assert.isFalse(isMacPasskeySigningRequested({ STARK_CODE_MACOS_PROVISIONING_PROFILE: " " }));
    assert.isTrue(
      isMacPasskeySigningRequested({
        STARK_CODE_MACOS_PROVISIONING_PROFILE: "/profiles/starkcode.provisionprofile",
      }),
    );
  });

  it.effect("grants signed macOS builds the hardened-runtime exceptions and microphone only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entitlements: unknown = Plist.parse(
        yield* fs.readFileString(
          NodePath.join(
            import.meta.dirname,
            "../apps/desktop/resources",
            MAC_ENTITLEMENTS_FILE_NAME,
          ),
        ),
      );

      assert.deepStrictEqual(entitlements, {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
        "com.apple.security.cs.disable-library-validation": true,
        "com.apple.security.device.audio-input": true,
      });
    }),
  );

  it.effect("signs each macOS mode with hardened runtime and its own notarization", () =>
    Effect.gen(function* () {
      const entitlementsPath = "/stage/apps/desktop/resources/entitlements.mac.plist";
      const developerId = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.46-beta.1",
        true,
        NO_DESKTOP_UPDATE_FEED,
        {
          mode: "developer-id",
          entitlementsPath,
          entitlementsInheritPath: entitlementsPath,
        },
      );
      const development = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.46-beta.1",
        true,
        NO_DESKTOP_UPDATE_FEED,
        {
          mode: "development",
          entitlementsPath,
          entitlementsInheritPath: entitlementsPath,
        },
      );
      const unsigned = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.46-beta.1",
        false,
        NO_DESKTOP_UPDATE_FEED,
        undefined,
      );

      assert.include(developerId.mac as Record<string, unknown>, {
        hardenedRuntime: true,
        type: "distribution",
        notarize: true,
        entitlements: entitlementsPath,
        entitlementsInherit: entitlementsPath,
      });
      assert.notProperty(developerId.mac as Record<string, unknown>, "provisioningProfile");
      assert.propertyVal(developerId.dmg as Record<string, unknown>, "sign", true);

      assert.include(development.mac as Record<string, unknown>, {
        hardenedRuntime: true,
        type: "development",
        notarize: false,
        entitlements: entitlementsPath,
      });
      assert.notProperty(development.dmg as Record<string, unknown>, "sign");

      for (const key of ["hardenedRuntime", "notarize", "type", "entitlements"]) {
        assert.notProperty(unsigned.mac as Record<string, unknown>, key);
      }
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("predicts which keychain certificate electron-builder signs each mode with", () => {
    const identities = parseMacSigningIdentities(
      `Policy: X.509 Basic
  Matching identities
  1) 1111111111111111111111111111111111111111 "Developer ID Application: Stark Future GmbH (ABCDE12345)"
  2) 3333333333333333333333333333333333333333 "Developer ID Installer: Stark Future GmbH (ABCDE12345)"
     2 identities found`,
      `  1) 1111111111111111111111111111111111111111 "Developer ID Application: Stark Future GmbH (ABCDE12345)"
  2) 2222222222222222222222222222222222222222 "Apple Development: Jane Doe (ABCDE12345)"
     2 valid identities found`,
    );
    assert.deepStrictEqual(identities, [
      '1111111111111111111111111111111111111111 "Developer ID Application: Stark Future GmbH (ABCDE12345)"',
      '3333333333333333333333333333333333333333 "Developer ID Installer: Stark Future GmbH (ABCDE12345)"',
      '2222222222222222222222222222222222222222 "Apple Development: Jane Doe (ABCDE12345)"',
    ]);

    // The SHA-1 of an Apple Development certificate reaches it through
    // electron-builder's non-Apple fallback.
    assert.deepStrictEqual(
      selectMacSigningIdentity(
        identities,
        "development",
        "2222222222222222222222222222222222222222",
      ),
      {
        hash: "2222222222222222222222222222222222222222",
        name: "Apple Development: Jane Doe (ABCDE12345)",
      },
    );
    // A name both certificates share signs a development build with Developer ID.
    const sharedName = selectMacSigningIdentity(identities, "development", "(ABCDE12345)");
    assert.equal(sharedName?.name, "Developer ID Application: Stark Future GmbH (ABCDE12345)");
    assert.equal(classifyMacSigningCertificate(sharedName?.name ?? ""), "developer-id");
    assert.equal(
      selectMacSigningIdentity(identities, "developer-id", "Stark Future GmbH (ABCDE12345)")?.hash,
      "1111111111111111111111111111111111111111",
    );
    // With no Developer ID match, a Developer ID build falls back to a development certificate.
    const fallback = selectMacSigningIdentity(identities, "developer-id", "Jane Doe");
    assert.equal(classifyMacSigningCertificate(fallback?.name ?? ""), "development");
    assert.isUndefined(selectMacSigningIdentity(identities, "developer-id", "Someone Else"));
  });

  it("selects the same keychain identity as the installed electron-builder", async () => {
    // Load electron-builder's own identity search the way the desktop build
    // resolves it, so a builder upgrade that changes the search fails here.
    const desktopRequire = NodeModule.createRequire(
      NodePath.join(import.meta.dirname, "../apps/desktop/package.json"),
    );
    const builderRequire = NodeModule.createRequire(desktopRequire.resolve("electron-builder"));
    const macCodeSign = builderRequire("app-builder-lib/out/codeSign/macCodeSign.js") as {
      findIdentityRawResult: Promise<ReadonlyArray<string>> | null;
    };
    const { MacTargetHelper } = builderRequire("app-builder-lib/out/mac/MacTargetHelper.js") as {
      readonly MacTargetHelper: {
        getCertificateTypes(isMas: boolean, isDevelopment: boolean): ReadonlyArray<string>;
        new (packager: { readonly forceCodeSigning: boolean }): {
          findSigningIdentity(
            isMas: boolean,
            isDevelopment: boolean,
            qualifier: string,
            keychainFile: null,
            config: { readonly type: string; readonly sign: string },
          ): Promise<{ readonly name: string; readonly hash: string } | null>;
        };
      };
    };

    // The non-MAS lists: development never names "Apple Development".
    assert.deepStrictEqual(MacTargetHelper.getCertificateTypes(false, true), [
      "Mac Developer",
      "Developer ID Application",
    ]);
    assert.deepStrictEqual(MacTargetHelper.getCertificateTypes(false, false), [
      "Developer ID Application",
    ]);

    const identities = parseMacSigningIdentities(
      `  1) 1111111111111111111111111111111111111111 "Developer ID Application: Stark Future GmbH (ABCDE12345)"
  2) 3333333333333333333333333333333333333333 "Developer ID Installer: Stark Future GmbH (ABCDE12345)"
     2 identities found`,
      `  1) 1111111111111111111111111111111111111111 "Developer ID Application: Stark Future GmbH (ABCDE12345)"
  2) 2222222222222222222222222222222222222222 "Apple Development: Jane Doe (ABCDE12345)"
  3) 4444444444444444444444444444444444444444 "Apple Distribution: Stark Future GmbH (ABCDE12345)"
  4) 5555555555555555555555555555555555555555 "Mac Developer: Jane Doe (ABCDE12345)"
     4 valid identities found`,
    );
    const helper = new MacTargetHelper({ forceCodeSigning: false });
    // electron-builder caches the keychain listing here; seeding it keeps
    // `security` from running.
    const cachedIdentities = macCodeSign.findIdentityRawResult;
    macCodeSign.findIdentityRawResult = Promise.resolve(identities);
    try {
      for (const mode of ["development", "developer-id"] as const) {
        for (const qualifier of [
          "2222222222222222222222222222222222222222",
          "4444444444444444444444444444444444444444",
          "5555555555555555555555555555555555555555",
          "(ABCDE12345)",
          "Stark Future GmbH (ABCDE12345)",
          "Jane Doe",
          "Someone Else",
        ]) {
          const builderIdentity = await helper.findSigningIdentity(
            false,
            mode === "development",
            qualifier,
            null,
            {
              // The build config's `type` for each mode; a custom `sign`
              // keeps electron-builder from reporting a missing identity.
              type: mode === "development" ? "development" : "distribution",
              sign: "scripts/sign-macos.ts",
            },
          );
          assert.deepStrictEqual(
            selectMacSigningIdentity(identities, mode, qualifier),
            builderIdentity === null
              ? undefined
              : { hash: builderIdentity.hash, name: builderIdentity.name },
            `${mode} with CSC_NAME=${qualifier}`,
          );
        }
      }
      // The development certificate's SHA-1 is what selects it for a rehearsal.
      const rehearsal = await helper.findSigningIdentity(
        false,
        true,
        "2222222222222222222222222222222222222222",
        null,
        { type: "development", sign: "scripts/sign-macos.ts" },
      );
      assert.equal(rehearsal?.name, "Apple Development: Jane Doe (ABCDE12345)");
    } finally {
      macCodeSign.findIdentityRawResult = cachedIdentities;
    }
  });

  it.effect("stops a signed build whose keychain identity is the wrong kind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const keychain = macToolSpawnerLayer([], (command) =>
          Effect.succeed({
            stdout: command.includes("codesigning")
              ? `  1) 1111111111111111111111111111111111111111 "Developer ID Application: Stark Future GmbH (ABCDE12345)"
  2) 2222222222222222222222222222222222222222 "Apple Development: Jane Doe (ABCDE12345)"
     2 valid identities found`
              : "",
          }),
        );
        const plan = (mode: "development" | "developer-id", keychainIdentity: string) => ({
          mode,
          identitySource: "keychain" as const,
          keychainIdentity,
          notarization: mode === "developer-id" ? ("keychain-profile" as const) : undefined,
          expectedTeamId: undefined,
        });

        const development = yield* preflightMacSigning({
          plan: plan("development", "2222222222222222222222222222222222222222"),
          env: {},
        }).pipe(Effect.provide(keychain));
        assert.equal(development?.name, "Apple Development: Jane Doe (ABCDE12345)");

        const mismatch = yield* preflightMacSigning({
          plan: plan("development", "(ABCDE12345)"),
          env: {},
        }).pipe(Effect.provide(keychain), Effect.flip);
        assert.instanceOf(mismatch, MacSigningIdentityMismatchError);
        assert.include(mismatch.message, "a Developer ID Application certificate");
        assert.include(mismatch.message, "SHA-1 of an Apple Development certificate");

        assert.instanceOf(
          yield* preflightMacSigning({ plan: plan("developer-id", "Nobody"), env: {} }).pipe(
            Effect.provide(keychain),
            Effect.flip,
          ),
          MacSigningIdentityNotFoundError,
        );

        const missingKey = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "stark-notary-key-test-" }),
          "AuthKey_KEY1234567.p8",
        );
        assert.instanceOf(
          yield* preflightMacSigning({
            plan: { ...plan("developer-id", "Stark Future GmbH"), notarization: "api-key" },
            env: { APPLE_API_KEY: missingKey },
          }).pipe(Effect.provide(keychain), Effect.flip),
          MissingMacNotarizationKeyFileError,
        );
      }),
    ),
  );

  it("parses codesign, Gatekeeper, stapler and notarytool output", () => {
    assert.deepStrictEqual(parseMacCodeSignature(DEVELOPER_ID_CODESIGN_DISPLAY), {
      authorities: [
        "Developer ID Application: Stark Future GmbH (ABCDE12345)",
        "Developer ID Certification Authority",
        "Apple Root CA",
      ],
      teamIdentifier: "ABCDE12345",
      hardenedRuntime: true,
      timestamped: true,
    });
    assert.deepStrictEqual(
      parseMacCodeSignature(`Executable=/stage/Stark Code (Alpha).app/Contents/MacOS/Stark Code (Alpha)
Identifier=Electron
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=512 flags=0x20002(adhoc,linker-signed) hashes=10+7 location=embedded
Signature=adhoc
TeamIdentifier=not set
Sealed Resources=none`),
      { authorities: [], teamIdentifier: undefined, hardenedRuntime: false, timestamped: false },
    );
    // A signature without a secure timestamp only carries "Signed Time".
    assert.isFalse(parseMacCodeSignature(DEVELOPMENT_CODESIGN_DISPLAY).timestamped);

    const notarized = parseGatekeeperAssessment(`/stage/Stark Code (Alpha).app: accepted
source=Notarized Developer ID
origin=Developer ID Application: Stark Future GmbH (ABCDE12345)`);
    assert.deepStrictEqual(notarized, { accepted: true, source: NOTARIZED_DEVELOPER_ID_SOURCE });
    assert.isTrue(isGatekeeperNotarized(notarized));
    const unnotarized = parseGatekeeperAssessment(`/stage/Stark Code (Alpha).app: rejected
source=Unnotarized Developer ID`);
    assert.deepStrictEqual(unnotarized, { accepted: false, source: "Unnotarized Developer ID" });
    assert.isFalse(isGatekeeperNotarized(unnotarized));

    assert.isTrue(
      isStaplerValidation({
        exitCode: 0,
        stdout: "Processing: /stage/app.dmg\nThe validate action worked!\n",
      }),
    );
    assert.isFalse(
      isStaplerValidation({
        exitCode: 65,
        stdout: "Processing: /stage/app.dmg\napp.dmg does not have a ticket stapled to it.\n",
      }),
    );

    assert.deepStrictEqual(
      parseNotarySubmission(
        'Conducting pre-submission checks...\n{"id":"6c1d1e4a","status":"Accepted","message":"Processing complete"}\n',
      ),
      { id: "6c1d1e4a", status: "Accepted" },
    );
    assert.deepStrictEqual(parseNotarySubmission("Error: HTTP status code: 401"), {
      id: undefined,
      status: undefined,
    });
  });

  it("holds a development rehearsal to a hardened development signature only", () => {
    const developmentSignature = parseMacCodeSignature(DEVELOPMENT_CODESIGN_DISPLAY);
    const developerIdSignature = parseMacCodeSignature(DEVELOPER_ID_CODESIGN_DISPLAY);
    const check = (input: Partial<Parameters<typeof findMacAppVerificationFailures>[0]>) =>
      findMacAppVerificationFailures({
        mode: "development",
        expectedIdentityName: undefined,
        expectedTeamId: undefined,
        signatureValid: true,
        signature: developmentSignature,
        stapled: undefined,
        gatekeeper: undefined,
        ...input,
      });

    assert.deepStrictEqual(
      check({ expectedIdentityName: "Apple Development: Jane Doe (ABCDE12345)" }),
      [],
    );
    // electron-builder chose Developer ID for a development build.
    assert.deepStrictEqual(
      check({
        expectedIdentityName: "Apple Development: Jane Doe (ABCDE12345)",
        signature: developerIdSignature,
      }),
      ["unexpected-certificate", "unexpected-identity"],
    );
    assert.deepStrictEqual(
      check({
        signatureValid: false,
        signature: { ...developmentSignature, hardenedRuntime: false },
      }),
      ["signature-invalid", "hardened-runtime-missing"],
    );

    const notarized = { accepted: true, source: NOTARIZED_DEVELOPER_ID_SOURCE };
    assert.deepStrictEqual(
      check({
        mode: "developer-id",
        expectedTeamId: "ABCDE12345",
        signature: developerIdSignature,
        stapled: true,
        gatekeeper: notarized,
      }),
      [],
    );
    // The development signature cannot pass as a release.
    assert.deepStrictEqual(
      check({
        mode: "developer-id",
        expectedTeamId: "ZYXWV98765",
        stapled: false,
        gatekeeper: { accepted: false, source: "Unnotarized Developer ID" },
      }),
      [
        "unexpected-certificate",
        "team-mismatch",
        "timestamp-missing",
        "not-stapled",
        "gatekeeper-rejected",
      ],
    );
  });

  it.effect("runs stapler and Gatekeeper checks only for developer-id apps", () =>
    Effect.gen(function* () {
      const appPath = `/stage/dist/${macPackagedAppDirectoryName("arm64")}/Stark Code (Alpha).app`;
      const developmentCommands: Array<ReadonlyArray<string>> = [];
      const development = yield* verifyMacSignedApp({
        appPath,
        mode: "development",
        expectedIdentityName: "Apple Development: Jane Doe (ABCDE12345)",
        expectedTeamId: undefined,
      }).pipe(
        Effect.provide(
          macToolSpawnerLayer(developmentCommands, (command) =>
            Effect.succeed(
              command.includes("--display") ? { stderr: DEVELOPMENT_CODESIGN_DISPLAY } : {},
            ),
          ),
        ),
      );
      assert.deepStrictEqual(development, {
        authority: "Apple Development: Jane Doe (ABCDE12345)",
        teamId: "ABCDE12345",
        hardenedRuntime: true,
        timestamped: false,
        appStapled: false,
        gatekeeper: null,
      });
      assert.deepStrictEqual(
        developmentCommands.map((command) => command.slice(0, 2).join(" ")),
        ["/usr/bin/codesign --verify", "/usr/bin/codesign --display"],
      );

      const releaseCommands: Array<ReadonlyArray<string>> = [];
      const rejected = yield* verifyMacSignedApp({
        appPath,
        mode: "developer-id",
        expectedIdentityName: undefined,
        expectedTeamId: "ABCDE12345",
      }).pipe(
        Effect.provide(
          macToolSpawnerLayer(releaseCommands, (command) =>
            Effect.succeed(
              command.includes("--display")
                ? { stderr: DEVELOPER_ID_CODESIGN_DISPLAY }
                : command.includes("stapler")
                  ? { stdout: "The validate action worked!\n" }
                  : command[0] === "/usr/sbin/spctl"
                    ? {
                        exitCode: 3,
                        stderr: `${appPath}: rejected\nsource=Unnotarized Developer ID\n`,
                      }
                    : {},
            ),
          ),
        ),
        Effect.flip,
      );
      assert.instanceOf(rejected, MacReleaseVerificationError);
      assert.deepStrictEqual(rejected.failures, ["gatekeeper-rejected"]);
      assert.include(rejected.message, NOTARIZED_DEVELOPER_ID_SOURCE);
      assert.deepStrictEqual(
        releaseCommands.map((command) => command.slice(0, 2).join(" ")),
        [
          "/usr/bin/codesign --verify",
          "/usr/bin/codesign --display",
          "/usr/bin/xcrun stapler",
          "/usr/sbin/spctl --assess",
        ],
      );
    }),
  );

  it.effect("staples the DMG before rebuilding its block map and manifest digest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageDistDir = yield* fs.makeTempDirectoryScoped({
          prefix: "stark-dmg-finalize-test-",
        });
        const dmgName = "Stark-Code-0.0.46-beta.1-arm64.dmg";
        const dmgPath = path.join(stageDistDir, dmgName);
        const manifestPath = path.join(stageDistDir, "latest-mac.yml");
        yield* fs.writeFileString(dmgPath, "dmg as electron-builder hashed it");
        yield* fs.writeFileString(`${dmgPath}.blockmap`, "stale block map");
        yield* fs.writeFileString(
          manifestPath,
          `version: 0.0.46-beta.1
files:
  - url: Stark-Code-0.0.46-beta.1-arm64.zip
    sha512: zipdigest
    size: 100
  - url: ${dmgName}
    sha512: staledigest
    size: 33
path: Stark-Code-0.0.46-beta.1-arm64.zip
sha512: zipdigest
releaseDate: '2026-10-29T10:00:00.000Z'
`,
        );

        const commands: Array<ReadonlyArray<string>> = [];
        yield* finalizeMacDmg({
          dmgPath,
          stageDistDir,
          notarization: "keychain-profile",
          env: { APPLE_KEYCHAIN_PROFILE: "stark-notary" },
          verbose: false,
        }).pipe(
          Effect.provide(
            macToolSpawnerLayer(commands, (command) => {
              if (command.includes("notarytool")) {
                return Effect.succeed({ stdout: '{"id":"6c1d1e4a","status":"Accepted"}' });
              }
              if (command.includes("staple")) {
                return Effect.as(
                  fs.writeFileString(dmgPath, " with a stapled ticket", { flag: "a" }),
                  {},
                );
              }
              if (command.includes("validate")) {
                return Effect.succeed({ stdout: "The validate action worked!\n" });
              }
              return Effect.succeed({
                stderr: `${dmgPath}: accepted\nsource=Notarized Developer ID\n`,
              });
            }),
          ),
        );

        assert.deepStrictEqual(commands, [
          [
            "/usr/bin/xcrun",
            "notarytool",
            "submit",
            dmgPath,
            "--wait",
            "--output-format",
            "json",
            "--keychain-profile",
            "stark-notary",
          ],
          ["/usr/bin/xcrun", "stapler", "staple", dmgPath],
          ["/usr/bin/xcrun", "stapler", "validate", dmgPath],
          [
            "/usr/sbin/spctl",
            "--assess",
            "--type",
            "open",
            "--context",
            "context:primary-signature",
            "--verbose=2",
            dmgPath,
          ],
        ]);
        const finalDmg = yield* fs.readFile(dmgPath);
        const finalDigest = NodeCrypto.createHash("sha512").update(finalDmg).digest("base64");
        assert.equal(
          yield* fs.readFileString(manifestPath),
          `version: 0.0.46-beta.1
files:
  - url: Stark-Code-0.0.46-beta.1-arm64.zip
    sha512: zipdigest
    size: 100
  - url: ${dmgName}
    sha512: ${finalDigest}
    size: ${finalDmg.byteLength}
path: Stark-Code-0.0.46-beta.1-arm64.zip
sha512: zipdigest
releaseDate: '2026-10-29T10:00:00.000Z'
`,
        );
        const blockMap = JSON.parse(
          NodeZlib.gunzipSync(yield* fs.readFile(`${dmgPath}.blockmap`)).toString("utf8"),
        ) as { readonly files: ReadonlyArray<{ readonly sizes: ReadonlyArray<number> }> };
        assert.equal(
          blockMap.files[0]?.sizes.reduce((total, size) => total + size, 0),
          finalDmg.byteLength,
        );
      }),
    ),
  );

  it.effect("leaves the DMG and its metadata alone when notarization is rejected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageDistDir = yield* fs.makeTempDirectoryScoped({
          prefix: "stark-dmg-rejected-test-",
        });
        const dmgPath = path.join(stageDistDir, "Stark-Code-0.0.46-beta.1-arm64.dmg");
        yield* fs.writeFileString(dmgPath, "unnotarized dmg");
        const commands: Array<ReadonlyArray<string>> = [];

        const error = yield* finalizeMacDmg({
          dmgPath,
          stageDistDir,
          notarization: "apple-id",
          env: {
            APPLE_ID: "release@example.com",
            APPLE_APP_SPECIFIC_PASSWORD: "app-secret",
            APPLE_TEAM_ID: "ABCDE12345",
          },
          verbose: false,
        }).pipe(
          Effect.provide(
            macToolSpawnerLayer(commands, () =>
              Effect.succeed({ stdout: '{"id":"9f00c2b7","status":"Invalid"}' }),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, MacReleaseVerificationError);
        assert.deepStrictEqual(error.failures, ["notarization-rejected"]);
        assert.include(error.message, "xcrun notarytool log 9f00c2b7");
        assert.notInclude(error.message, "app-secret");
        assert.lengthOf(commands, 1);
        assert.equal(yield* fs.readFileString(dmgPath), "unnotarized dmg");

        // A spawn failure quotes the command line, which carries the password.
        const spawnFailure = yield* finalizeMacDmg({
          dmgPath,
          stageDistDir,
          notarization: "apple-id",
          env: {
            APPLE_ID: "release@example.com",
            APPLE_APP_SPECIFIC_PASSWORD: "app-secret",
            APPLE_TEAM_ID: "ABCDE12345",
          },
          verbose: false,
        }).pipe(
          Effect.provide(
            macToolSpawnerLayer([], (command) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                  pathOrDescriptor: command.join(" "),
                }),
              ),
            ),
          ),
          Effect.flip,
        );
        assert.instanceOf(spawnFailure, MacNotarizationCommandError);
        assert.include(spawnFailure.message, "NotFound");
        assert.notInclude(spawnFailure.message, "app-secret");
        assert.notInclude(JSON.stringify(spawnFailure), "app-secret");
      }),
    ),
  );

  it.effect("records final artifact digests in a release proof without credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outputDir = yield* fs.makeTempDirectoryScoped({
          prefix: "stark-release-proof-test-",
        });
        const dmgPath = path.join(outputDir, "Stark-Code-0.0.46-beta.1-arm64.dmg");
        yield* fs.writeFileString(dmgPath, "final stapled dmg");
        const plan = {
          mode: "developer-id" as const,
          identitySource: "keychain" as const,
          keychainIdentity: "Stark Future GmbH (ABCDE12345)",
          notarization: "keychain-profile" as const,
          expectedTeamId: "ABCDE12345",
        };
        const app = {
          authority: "Developer ID Application: Stark Future GmbH (ABCDE12345)",
          teamId: "ABCDE12345",
          hardenedRuntime: true,
          timestamped: true,
          appStapled: true,
          gatekeeper: NOTARIZED_DEVELOPER_ID_SOURCE,
        };
        const requirement =
          'anchor apple generic and identifier "com.starkfuture.starkcode" and (certificate leaf[field.1.2.840.113635.100.6.1.9] /* exists */ or certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ABCDE12345)';
        const noFeed = describeDesktopReleaseFeed(
          createBakedUpdatePolicy(NO_DESKTOP_UPDATE_FEED, "0.0.46-beta.1", FEED_OWNERSHIP),
          { file: null, sha256: null },
        );

        const proofPath = yield* writeDesktopReleaseProof({
          outputDir,
          artifactPaths: [dmgPath],
          version: "0.0.46-beta.1",
          arch: "arm64",
          commit: "abcdef123456",
          feed: noFeed,
          plan,
          app,
          requirement,
          dmgStapled: true,
          ownership: FEED_OWNERSHIP,
        });

        assert.equal(path.basename(proofPath), RELEASE_PROOF_FILE_NAME);
        const proof = JSON.parse(yield* fs.readFileString(proofPath)) as ReturnType<
          typeof createDesktopReleaseProof
        >;
        assert.deepStrictEqual(proof.artifacts, [
          {
            file: "Stark-Code-0.0.46-beta.1-arm64.dmg",
            bytes: "final stapled dmg".length,
            sha256: NodeCrypto.createHash("sha256").update("final stapled dmg").digest("hex"),
          },
        ]);
        assert.deepStrictEqual(proof.mac, {
          signingMode: "developer-id",
          identitySource: "keychain",
          notarization: "keychain-profile",
          authority: "Developer ID Application: Stark Future GmbH (ABCDE12345)",
          teamId: "ABCDE12345",
          hardenedRuntime: true,
          timestamped: true,
          appStapled: true,
          dmgStapled: true,
          gatekeeper: NOTARIZED_DEVELOPER_ID_SOURCE,
          designatedRequirement: requirement,
          teamPinned: true,
          distributable: true,
        });
        assert.deepStrictEqual(proof.feed, {
          kind: "none",
          url: null,
          channel: null,
          policy: { kind: "none", url: null, channels: [], appleTeamId: "ABCDE12345" },
          appUpdateYml: { file: null, sha256: null },
        });
        assert.equal(proof.channel, "latest");
        assert.isFalse(Number.isNaN(Date.parse(proof.builtAt)));

        type ProofInput = Parameters<typeof createDesktopReleaseProof>[0];
        const proofInput: ProofInput = {
          version: "0.0.46-beta.1",
          arch: "arm64",
          commit: "abcdef123456",
          builtAt: proof.builtAt,
          artifacts: [],
          dmgStapled: false,
          plan,
          app,
          requirement,
          feed: noFeed,
          ownership: FEED_OWNERSHIP,
        };
        const starkFeed = describeDesktopReleaseFeed(
          createBakedUpdatePolicy(STARK_FEED, "0.0.46-beta.1", FEED_OWNERSHIP),
          {
            file: "mac-arm64/Stark Code (Alpha).app/Contents/Resources/app-update.yml",
            sha256: "0".repeat(64),
          },
        );
        assert.isTrue(
          createDesktopReleaseProof({ ...proofInput, feed: starkFeed }).mac.distributable,
        );
        // The checked-in team is 6QNLKCM5Y5, not the fixture's.
        const { ownership: _fixtureOwnership, ...checkedInOwnership } = proofInput;
        // Rehearsals, mock feeds, other teams and unpinned requirements are never fit for another Mac.
        const notDistributable: Array<[string, ProofInput]> = [
          [
            "mock feed",
            {
              ...proofInput,
              feed: describeDesktopReleaseFeed(
                createBakedUpdatePolicy(MOCK_FEED, "0.0.46-beta.1", FEED_OWNERSHIP),
                { file: "x", sha256: "0".repeat(64) },
              ),
            },
          ],
          [
            "development signature",
            {
              ...proofInput,
              plan: { ...plan, mode: "development", notarization: undefined },
              app: { ...app, appStapled: false, gatekeeper: null },
            },
          ],
          ["another team", { ...proofInput, app: { ...app, teamId: "ZZZZZ99999" } }],
          [
            "unpinned requirement",
            { ...proofInput, requirement: requirement.replace("ABCDE12345", "ZZZZZ99999") },
          ],
          ["no requirement", { ...proofInput, requirement: undefined }],
          ["checked-in ownership", checkedInOwnership],
        ];
        for (const [label, input] of notDistributable) {
          assert.isFalse(createDesktopReleaseProof(input).mac.distributable, label);
        }
        const unsigned = createDesktopReleaseProof({
          ...proofInput,
          plan: {
            mode: "unsigned",
            identitySource: undefined,
            keychainIdentity: undefined,
            notarization: undefined,
            expectedTeamId: undefined,
          },
          app: undefined,
          requirement: undefined,
        });
        assert.equal(unsigned.mac.signingMode, "unsigned");
        assert.isFalse(unsigned.mac.distributable);
        assert.notInclude(JSON.stringify(unsigned), "keychainIdentity");
      }),
    ),
  );
});

// The self-containment check runs the packaged tree in a scratch directory. Its
// own node_modules holds the sidecar externals and must be ignored, but any
// node_modules *above* it would let Node's parent walk satisfy an import that is
// missing from the package, so the probe refuses to run in that case.
it("lists ancestor node_modules, nearest first, excluding the start directory", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"), [
    "C:\\tmp\\probe\\node_modules",
    "C:\\tmp\\node_modules",
    "C:\\node_modules",
  ]);
});

it("includes the filesystem root for posix paths", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("/tmp/probe", "/"), [
    "/tmp/node_modules",
    "/node_modules",
  ]);
});

// A UNC root must keep its \\server\share prefix. Rebuilding it from segments
// produced relative paths, which fs.exists resolves against the build cwd, so
// the guard checked directories that do not exist and silently passed.
it("keeps the prefix of a UNC path instead of going relative", () => {
  const paths = ancestorNodeModulesPaths("\\\\server\\share\\tmp\\app", "\\");
  for (const candidate of paths) {
    assert.ok(candidate.startsWith("\\\\server\\share"), candidate);
  }
  assert.deepStrictEqual(paths[0], "\\\\server\\share\\tmp\\node_modules");
});

it.effect.skipIf(!symlinksSupported)("rebases packaged links into the isolated tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "starkcode-copy-symlinks-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const packageDir = path.join(source, "node_modules/.pnpm/example@1/node_modules/example");
    const relativePackageLink = path.join(source, "node_modules/example-relative");
    const absolutePackageLink = path.join(source, "node_modules/example-absolute");

    yield* fs.makeDirectory(packageDir, { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = true;\n");
    yield* fs.symlink(
      path.join(".pnpm", "example@1", "node_modules", "example"),
      relativePackageLink,
    );
    yield* fs.symlink(packageDir, absolutePackageLink);

    yield* copyDirectoryPreservingSymlinks(source, destination);

    const copiedPackage = path.join(
      destination,
      "node_modules/.pnpm/example@1/node_modules/example",
    );
    const resolvedCopiedPackage = yield* fs.realPath(copiedPackage);
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-relative")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-absolute")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-relative")),
      resolvedCopiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-absolute")),
      resolvedCopiedPackage,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("ignores trailing separators", () => {
  assert.deepStrictEqual(
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app\\", "\\"),
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"),
  );
});
