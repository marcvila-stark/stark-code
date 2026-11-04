import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock, network } = vi.hoisted(() => {
  const network = {
    requests: [] as Array<string>,
    nativeFeeds: [] as Array<string>,
    sessionListener: undefined as
      | ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void)
      | undefined,
  };
  const updater = {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    fullChangelog: false,
    previousBlockmapBaseUrlOverride: "https://elsewhere.example.test/old/" as string | null,
    isUpdateSupported: vi.fn((_info: unknown): boolean => true),
    logger: null,
    emit: vi.fn(),
    httpExecutor: {
      createRequest: (options: { protocol: string; hostname: string; path: string }) => {
        network.requests.push(`${options.protocol}//${options.hostname}${options.path}`);
        return { on: () => undefined, abort: () => undefined };
      },
    },
    nativeUpdater: {
      setFeedURL: (options: { url: string }) => {
        network.nativeFeeds.push(options.url);
      },
    },
    netSession: {
      webRequest: {
        onBeforeRequest: (listener: NonNullable<typeof network.sessionListener>) => {
          network.sessionListener = listener;
        },
      },
    },
    channelValue: "latest" as string | null,
    get channel(): string | null {
      return this.channelValue;
    },
    // electron-updater's channel setter also allows downgrades.
    set channel(value: string | null) {
      this.channelValue = value;
      this.allowDowngrade = true;
    },
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn((_cancellationToken?: unknown) => Promise.resolve([] as Array<string>)),
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
  };
  return { autoUpdaterMock: updater, network };
});

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
  // electron-updater's token: `cancel()` aborts a running transfer.
  CancellationToken: class {
    cancelled = false;
    cancel() {
      this.cancelled = true;
    }
  },
}));

// Each test loads fresh modules: the updater's feed binding is module state.
const load = async () => {
  vi.resetModules();
  const ElectronUpdater = await import("./ElectronUpdater.ts");
  const policy = await import("../updates/updateFeedPolicy.ts");
  return { ElectronUpdater, policy };
};

const MOCK_POLICY = {
  kind: "mock" as const,
  url: "http://localhost:3123/",
  channels: ["latest"],
  appleTeamId: null,
};
const MOCK_APP_UPDATE_YML = `provider: generic
url: http://localhost:3123/
channel: latest
updaterCacheDirName: starkcode-updater
kind: mock
`;

const validatedMockFeed = (policy: Awaited<ReturnType<typeof load>>["policy"]) => {
  const result = policy.validateStarkUpdateFeed(MOCK_APP_UPDATE_YML, MOCK_POLICY);
  if (!result.ok) throw new Error(`fixture feed is invalid: ${result.problem}`);
  return result.feed;
};

describe("ElectronUpdater", () => {
  beforeEach(() => {
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channelValue = "latest";
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.previousBlockmapBaseUrlOverride = "https://elsewhere.example.test/old/";
    autoUpdaterMock.checkForUpdates.mockReset();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadUpdate.mockReset();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockReset();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
    network.requests.length = 0;
    network.nativeFeeds.length = 0;
  });

  it.effect("scopes updater event listeners", () =>
    Effect.promise(load).pipe(
      Effect.flatMap(({ ElectronUpdater }) =>
        Effect.gen(function* () {
          const listener = vi.fn();

          yield* Effect.scoped(
            Effect.gen(function* () {
              const updater = yield* ElectronUpdater.ElectronUpdater;
              yield* updater.on("update-available", listener);
            }),
          );

          assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
          assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [
            ["update-available", listener],
          ]);
        }).pipe(Effect.provide(ElectronUpdater.layer)),
      ),
    ),
  );

  it.effect("sends nothing until a validated feed is set, and refuses look-alike feeds", () =>
    Effect.promise(load).pipe(
      Effect.flatMap(({ ElectronUpdater }) =>
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;

          const checkError = yield* updater.checkForUpdates.pipe(Effect.flip);
          assert.instanceOf(checkError.cause, ElectronUpdater.ElectronUpdaterNoFeedError);
          const downloadError = yield* updater.downloadUpdate.pipe(Effect.flip);
          assert.instanceOf(downloadError.cause, ElectronUpdater.ElectronUpdaterNoFeedError);
          assert.equal(autoUpdaterMock.checkForUpdates.mock.calls.length, 0);
          assert.equal(autoUpdaterMock.downloadUpdate.mock.calls.length, 0);

          // The same fields as a validated feed, but not produced by the validator.
          const lookAlike = {
            provider: "generic",
            url: "https://github.com/pingdotgg/t3code/releases/",
            channel: "latest",
            kind: "stark",
            channels: ["latest"],
            appleTeamId: null,
            location: {
              href: "https://github.com/pingdotgg/t3code/releases/",
              origin: "https://github.com",
              protocol: "https:",
              basePath: "/pingdotgg/t3code/releases/",
            },
            cacheBasePath: null,
          } as const;
          const exit = yield* Effect.exit(updater.setFeedURL(lookAlike));
          assert.isTrue(Exit.isFailure(exit));
          assert.equal(autoUpdaterMock.setFeedURL.mock.calls.length, 0);
        }).pipe(Effect.provide(ElectronUpdater.layer)),
      ),
    ),
  );

  it.effect(
    "binds a validated feed with its request policy, no downgrades and full downloads",
    () =>
      Effect.promise(load).pipe(
        Effect.flatMap(({ ElectronUpdater, policy }) =>
          Effect.gen(function* () {
            const updater = yield* ElectronUpdater.ElectronUpdater;
            const feed = validatedMockFeed(policy);

            yield* updater.setFeedURL(feed);

            assert.deepEqual(autoUpdaterMock.setFeedURL.mock.calls, [
              [{ provider: "generic", url: "http://localhost:3123/", channel: "latest" }],
            ]);
            assert.isNull(autoUpdaterMock.previousBlockmapBaseUrlOverride);
            assert.isTrue(autoUpdaterMock.disableDifferentialDownload);
            assert.isFalse(autoUpdaterMock.allowDowngrade);

            // Requests go through the guard: the feed's own files pass, anything else
            // never reaches the executor.
            const executor = autoUpdaterMock.httpExecutor;
            executor.createRequest({
              protocol: "http:",
              hostname: "localhost",
              port: "3123",
              path: "/Stark-Code-0.0.47-arm64.zip",
            } as never);
            const refused = executor.createRequest({
              protocol: "https:",
              hostname: "objects.githubusercontent.com",
              path: "/pingdotgg/t3code/latest-mac.yml",
            } as never) as unknown as {
              end: () => void;
              on: (event: string, cb: (e: unknown) => void) => void;
            };
            const refusal = yield* Effect.promise(
              () =>
                new Promise<unknown>((resolve) => {
                  refused.on("error", resolve);
                  refused.end();
                }),
            );
            assert.instanceOf(refusal, policy.StarkUpdateRequestRefusedError);
            assert.deepEqual(network.requests, ["http://localhost/Stark-Code-0.0.47-arm64.zip"]);

            // Squirrel only ever gets its loopback hand-off.
            autoUpdaterMock.nativeUpdater.setFeedURL({ url: "http://127.0.0.1:52311" });
            autoUpdaterMock.nativeUpdater.setFeedURL({ url: "https://evil.example.test/feed" });
            assert.deepEqual(network.nativeFeeds, ["http://127.0.0.1:52311"]);
            assert.equal(autoUpdaterMock.emit.mock.calls[0]?.[0], "error");

            // The session backstop cancels the same destinations.
            const cancelled: Array<boolean> = [];
            network.sessionListener?.({ url: "https://evil.example.test/x.zip" }, (response) =>
              cancelled.push(response.cancel),
            );
            network.sessionListener?.({ url: "http://localhost:3123/latest-mac.yml" }, (response) =>
              cancelled.push(response.cancel),
            );
            assert.deepEqual(cancelled, [true, false]);

            // A manifest naming a foreign file fails the check before any download.
            assert.throws(
              () =>
                autoUpdaterMock.isUpdateSupported({
                  version: "0.0.47",
                  files: [{ url: "https://evil.example.test/x.zip", sha512: "x", size: 1 }],
                }),
              /will not download/u,
            );
            assert.isTrue(
              autoUpdaterMock.isUpdateSupported({
                version: "0.0.47",
                files: [{ url: "Stark-Code-0.0.47-arm64.zip", sha512: "x", size: 1 }],
                starkFeedKind: "mock",
              }),
            );
          }).pipe(Effect.provide(ElectronUpdater.layer)),
        ),
      ),
  );

  it.effect("keeps the channel inside the feed's channels and never allows a downgrade", () =>
    Effect.promise(load).pipe(
      Effect.flatMap(({ ElectronUpdater, policy }) =>
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.setFeedURL(validatedMockFeed(policy));

          yield* updater.setChannel("nightly");
          assert.equal(autoUpdaterMock.channel, "latest");
          assert.isFalse(autoUpdaterMock.allowDowngrade);

          yield* updater.setChannel("latest");
          assert.isFalse(autoUpdaterMock.allowDowngrade);

          yield* updater.setAllowDowngrade(true);
          assert.isFalse(yield* updater.allowDowngrade);

          yield* updater.setDisableDifferentialDownload(false);
          assert.isTrue(autoUpdaterMock.disableDifferentialDownload);
        }).pipe(Effect.provide(ElectronUpdater.layer)),
      ),
    ),
  );

  it.effect("wraps rejected update checks in the method-specific typed error", () =>
    Effect.promise(load).pipe(
      Effect.flatMap(({ ElectronUpdater, policy }) =>
        Effect.gen(function* () {
          const cause = new Error("network unavailable");
          autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.setFeedURL(validatedMockFeed(policy));
          autoUpdaterMock.channelValue = "beta";

          const error = yield* updater.checkForUpdates.pipe(Effect.flip);

          assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
          assert.equal(error.channel, "beta");
          assert.strictEqual(error.cause, cause);
          assert.equal(
            error.message,
            "Electron updater failed to check for updates on channel beta.",
          );
          assert.notInclude(error.message, cause.message);
        }).pipe(Effect.provide(ElectronUpdater.layer)),
      ),
    ),
  );

  it.effect("preserves the execution-time channel on download failures", () =>
    Effect.promise(load).pipe(
      Effect.flatMap(({ ElectronUpdater, policy }) =>
        Effect.gen(function* () {
          const cause = new Error("download unavailable");
          autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => Promise.reject(cause));
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.setFeedURL(validatedMockFeed(policy));
          autoUpdaterMock.channelValue = "nightly";

          const error = yield* updater.downloadUpdate.pipe(Effect.flip);

          assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
          assert.equal(error.channel, "nightly");
          assert.strictEqual(error.cause, cause);
          assert.equal(
            error.message,
            "Electron updater failed to download the update on channel nightly.",
          );
          assert.notInclude(error.message, cause.message);
        }).pipe(Effect.provide(ElectronUpdater.layer)),
      ),
    ),
  );

  it.effect("cancels the transfer itself when the download is interrupted", () =>
    Effect.promise(load).pipe(
      Effect.flatMap(({ ElectronUpdater, policy }) =>
        Effect.gen(function* () {
          let token: { readonly cancelled: boolean } | undefined;
          autoUpdaterMock.downloadUpdate.mockImplementationOnce((cancellationToken?: unknown) => {
            token = cancellationToken as { readonly cancelled: boolean };
            return new Promise<Array<string>>(() => undefined);
          });
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.setFeedURL(validatedMockFeed(policy));

          const transfer = yield* updater.downloadUpdate.pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.equal(token?.cancelled, false);
          yield* Fiber.interrupt(transfer);
          assert.equal(token?.cancelled, true);
        }).pipe(Effect.provide(ElectronUpdater.layer)),
      ),
    ),
  );

  it.effect("sets full changelog mode", () =>
    Effect.promise(load).pipe(
      Effect.flatMap(({ ElectronUpdater }) =>
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;

          yield* updater.setFullChangelog(true);
          assert.equal(autoUpdaterMock.fullChangelog, true);

          yield* updater.setFullChangelog(false);
          assert.equal(autoUpdaterMock.fullChangelog, false);
        }).pipe(Effect.provide(ElectronUpdater.layer)),
      ),
    ),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.promise(load).pipe(
      Effect.flatMap(({ ElectronUpdater }) =>
        Effect.gen(function* () {
          const cause = new Error("quit and install failed");
          autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
            throw cause;
          });
          const updater = yield* ElectronUpdater.ElectronUpdater;
          autoUpdaterMock.channelValue = "alpha";

          const error = yield* updater
            .quitAndInstall({ isSilent: true, isForceRunAfter: false })
            .pipe(Effect.flip);

          assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
          assert.equal(error.channel, "alpha");
          assert.equal(error.isSilent, true);
          assert.equal(error.isForceRunAfter, false);
          assert.strictEqual(error.cause, cause);
          assert.equal(
            error.message,
            "Electron updater failed to quit and install the update on channel alpha (silent: true, force run after: false).",
          );
          assert.notInclude(error.message, cause.message);
          assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
        }).pipe(Effect.provide(ElectronUpdater.layer)),
      ),
    ),
  );
});
