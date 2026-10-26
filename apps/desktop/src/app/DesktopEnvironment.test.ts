import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/Stark Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/Stark Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("keeps an explicitly configured development profile inside the chosen directory", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        { STARK_CODE_DESKTOP_DATA_DIR: "/tmp/stark-code/electron" },
      );
      assert.strictEqual(environment.appDataDirectory, "/tmp/stark-code/electron");
      assert.strictEqual(environment.branding.baseName, "Stark Code");
    }),
  );

  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          STARK_CODE_HOME: " /tmp/stark-code ",
          STARK_CODE_COMMIT_HASH: " 0123456789abcdef ",
          STARK_CODE_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          STARK_CODE_DEV_REMOTE_STARK_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          STARK_CODE_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          STARK_CODE_OTLP_METRICS_URL: " http://127.0.0.1:4318/v1/metrics ",
          STARK_CODE_OTLP_LOGS_URL: " http://127.0.0.1:4318/v1/logs ",
          STARK_CODE_OTLP_EXPORT_INTERVAL_MS: "2500",
          STARK_CODE_OTLP_HEADERS: "authorization=Basic%20abc%3D%3D,x-tenant=stark-code",
          STARK_CODE_OTLP_PROTOCOL: "http/protobuf",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(environment.appDataDirectory, "/Users/alice/Library/Application Support");
      assert.equal(environment.baseDir, "/tmp/stark-code");
      assert.equal(environment.stateDir, "/tmp/stark-code/userdata");
      assert.equal(environment.desktopSettingsPath, "/tmp/stark-code/userdata/desktop-settings.json");
      assert.equal(environment.clientSettingsPath, "/tmp/stark-code/userdata/client-settings.json");
      assert.equal(
        environment.savedEnvironmentRegistryPath,
        "/tmp/stark-code/userdata/saved-environments.json",
      );
      assert.equal(environment.serverSettingsPath, "/tmp/stark-code/userdata/settings.json");
      assert.equal(environment.logDir, "/tmp/stark-code/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/stark-code/userdata/browser-artifacts");
      assert.equal(environment.rootDir, "/repo");
      assert.equal(environment.appRoot, "/repo");
      assert.equal(environment.serverRoot, "/repo");
      assert.equal(environment.backendEntryPath, "/repo/apps/server/dist/bin.mjs");
      assert.equal(environment.backendCwd, "/repo");
      assert.equal(environment.appUserModelId, "com.starkfuture.starkcode.dev");
      assert.equal(environment.linuxWmClass, "starkcode-dev");
      assert.equal(
        environment.linuxDesktopEntryName,
        "com.starkfuture.StarkCode.Development.desktop",
      );
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(
        environment.devRemoteStarkServerEntryPath,
        Option.some("/remote/server.mjs"),
      );
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.none());
      assert.deepEqual(environment.otlpMetricsUrl, Option.none());
      assert.deepEqual(environment.otlpLogsUrl, Option.none());
      assert.equal(environment.otlpExportIntervalMs, 10_000);
      assert.deepEqual(environment.otlpHeaders, Option.none());
      assert.equal(environment.otlpProtocol, "http/json");
    }),
  );

  it.effect("stores production state under userdata in an explicit home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          STARK_CODE_HOME: "/tmp/stark-code",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, "/tmp/stark-code/userdata");
      assert.equal(environment.logDir, "/tmp/stark-code/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/stark-code/userdata/browser-artifacts");
      assert.equal(environment.serverSettingsPath, "/tmp/stark-code/userdata/settings.json");
      assert.equal(environment.otlpProtocol, "http/json");
    }),
  );

  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("uses the stable desktop entry as the packaged Linux portal identity", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "linux",
        isPackaged: true,
        appPath: "/tmp/.mount_starkcode/resources/app.asar",
        resourcesPath: "/tmp/.mount_starkcode/resources",
      });

      assert.equal(environment.linuxDesktopEntryName, "com.starkfuture.StarkCode.desktop");
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.stark-code/dev");
      assert.equal(production.stateDir, "/Users/alice/.stark-code/userdata");
    }),
  );

  it.effect("uses a configured app user model id override", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          STARK_CODE_DESKTOP_APP_USER_MODEL_ID: " com.starkfuture.starkcode.dev.local ",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        },
      );

      assert.equal(environment.appUserModelId, "com.starkfuture.starkcode.dev.local");
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
        Option.some("/Users/alice/project"),
      );
    }),
  );
});
