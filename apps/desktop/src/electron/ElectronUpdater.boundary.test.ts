// @effect-diagnostics nodeBuiltinImport:off - Loads the installed electron-updater with a stand-in for Electron's network module.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterAll, assert, beforeEach, describe, it, vi } from "vite-plus/test";

// ElectronUpdater.ts imports the electron-updater singleton; the boundary
// tests drive their own updater instance instead.
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

import { bindUpdaterToValidatedFeed, type BindableAutoUpdater } from "./ElectronUpdater.ts";
import {
  validateStarkUpdateFeed,
  type BakedUpdatePolicy,
  type UpdateOwnership,
} from "../updates/updateFeedPolicy.ts";

/**
 * Electron's `net` as seen from electron-updater: every URL it is asked to
 * contact is recorded in `hits`, and routes answer with a body or a redirect.
 * Redirects follow Electron's rules: in `manual` mode a listener must call
 * `followRedirect()` synchronously, in `follow` mode the request continues
 * unless a listener aborts it.
 */
class FakeNetwork {
  readonly hits: Array<string> = [];
  readonly routes = new Map<string, { status: number; body?: string; location?: string }>();

  route(url: string, response: { status: number; body?: string; location?: string }): void {
    this.routes.set(url, response);
  }

  request(options: Record<string, unknown>): FakeClientRequest {
    const port = options.port === undefined ? "" : `:${String(options.port)}`;
    return new FakeClientRequest(
      this,
      `${String(options.protocol)}//${String(options.hostname)}${port}${String(options.path)}`,
      options.redirect === "manual" ? "manual" : "follow",
    );
  }
}

class FakeClientRequest extends NodeEvents.EventEmitter {
  private aborted = false;
  private followRedirectCallback: (() => void) | undefined;
  private readonly network: FakeNetwork;
  private readonly url: string;
  private readonly redirectMode: "manual" | "follow";

  constructor(network: FakeNetwork, url: string, redirectMode: "manual" | "follow") {
    super();
    this.network = network;
    this.url = url;
    this.redirectMode = redirectMode;
  }

  setHeader(): void {}

  followRedirect(): void {
    this.followRedirectCallback?.();
  }

  abort(): void {
    this.aborted = true;
    this.emit("abort");
  }

  end(): void {
    setImmediate(() => this.dispatch(this.url));
  }

  private dispatch(url: string): void {
    if (this.aborted) return;
    this.network.hits.push(url);
    const parsed = new URL(url);
    const route = this.network.routes.get(`${parsed.origin}${parsed.pathname}`) ?? { status: 404 };
    if (route.location !== undefined) {
      const target = new URL(route.location, url).href;
      let followed = this.redirectMode === "follow";
      this.followRedirectCallback = () => {
        followed = true;
      };
      this.emit("redirect", route.status, "GET", target, {});
      this.followRedirectCallback = undefined;
      if (this.aborted) return;
      if (!followed) {
        this.emit("error", new Error("Redirect was cancelled"));
        return;
      }
      this.dispatch(target);
      return;
    }
    const body = Buffer.from(route.body ?? "");
    const response = Object.assign(new NodeStream.PassThrough(), {
      statusCode: route.status,
      statusMessage: route.status === 200 ? "OK" : "Not Found",
      headers: { "content-length": String(body.length) } as Record<string, string>,
    });
    this.emit("response", response);
    response.end(body);
  }
}

const network = new FakeNetwork();
const nativeFeeds: Array<string> = [];
const makeNativeUpdater = () =>
  Object.assign(new NodeEvents.EventEmitter(), {
    setFeedURL: (options: { readonly url: string }) => {
      nativeFeeds.push(options.url);
    },
    checkForUpdates: () => undefined,
    quitAndInstall: () => undefined,
  });
// MacUpdater takes Squirrel's updater when it is constructed; each test gets its own.
let nativeUpdater = makeNativeUpdater();
const sessionListeners: Array<unknown> = [];
const fakeElectron = {
  net: { request: (options: Record<string, unknown>) => network.request(options) },
  session: {
    fromPartition: () => ({
      webRequest: { onBeforeRequest: (listener: unknown) => sessionListeners.push(listener) },
    }),
  },
  get autoUpdater() {
    return nativeUpdater;
  },
};

// Put the stand-in where electron-updater's own `require("electron")` finds it.
const desktopRequire = NodeModule.createRequire(import.meta.url);
const updaterMain = desktopRequire.resolve("electron-updater");
const updaterRequire = NodeModule.createRequire(updaterMain);
const electronPath = updaterRequire.resolve("electron");
const electronModule = new NodeModule.Module(electronPath);
electronModule.filename = electronPath;
electronModule.loaded = true;
electronModule.exports = fakeElectron;
updaterRequire.cache[electronPath] = electronModule;

interface TestRequest {
  on(event: string, listener: (value: never) => void): unknown;
  followRedirect(): void;
  end(): void;
}

/** The parts of electron-updater's MacUpdater these tests drive. */
interface TestUpdater {
  httpExecutor: {
    download(url: URL, destination: string, options: Record<string, unknown>): Promise<string>;
    downloadToBuffer(url: URL, options: Record<string, unknown>): Promise<Buffer>;
    createRequest(options: Record<string, unknown>, callback: () => void): TestRequest;
  };
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  readonly disableDifferentialDownload: boolean;
  readonly previousBlockmapBaseUrlOverride: string | null;
  readonly updateInfoAndProvider: unknown;
  getOrCreateDownloadHelper(): Promise<{ readonly cacheDir: string }>;
  isUpdateSupported: (info: unknown) => boolean;
  checkForUpdates(): Promise<{ readonly isUpdateAvailable: boolean } | null>;
  downloadUpdate(): Promise<unknown>;
  on(event: string, listener: (value: never) => void): unknown;
}

const { MacUpdater } = updaterRequire("./MacUpdater.js") as {
  readonly MacUpdater: new (options: undefined, app: unknown) => TestUpdater;
};
const { CancellationToken } = updaterRequire("builder-util-runtime") as {
  readonly CancellationToken: new () => unknown;
};
const { ElectronHttpExecutor } = updaterRequire("./electronHttpExecutor.js") as {
  readonly ElectronHttpExecutor: new () => TestUpdater["httpExecutor"];
};
const updaterPackage = JSON.parse(
  NodeFS.readFileSync(NodePath.join(NodePath.dirname(updaterMain), "..", "package.json"), "utf8"),
) as { readonly version: string };

const FEED_URL = "https://updates.stark.test/stark-code/mac/";
const MANIFEST_URL = `${FEED_URL}latest-mac.yml`;
const ZIP_NAME = "Stark-Code-0.0.47-mac.zip";
const ZIP_BODY = "zip bytes of 0.0.47";
const ZIP_SHA512 = NodeCrypto.createHash("sha512").update(ZIP_BODY).digest("base64");
const OWNERSHIP: UpdateOwnership = {
  bundleId: "com.starkfuture.starkcode",
  appleTeamId: "T254LS2J9A",
  updateFeedOrigins: ["https://updates.stark.test"],
  updateChannels: ["latest"],
};
const POLICY: BakedUpdatePolicy = {
  kind: "stark",
  url: FEED_URL,
  channels: ["latest"],
  appleTeamId: "T254LS2J9A",
};
const APP_UPDATE_YML = `provider: generic
url: ${FEED_URL}
channel: latest
updaterCacheDirName: starkcode-updater
kind: stark
`;

const manifest = (files: string, extra = "") => `version: 0.0.47
${files}${extra}
releaseDate: '2026-10-30T10:00:00.000Z'
`;
const fileEntry = (url: string) => `files:
  - url: ${url}
    sha512: ${ZIP_SHA512}
    size: ${ZIP_BODY.length}`;

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-updater-boundary-"));
afterAll(() => {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
  // Leave no stand-in behind for other files that share this worker.
  delete updaterRequire.cache[electronPath];
});

function makeUpdater(
  feed: { readonly yml: string; readonly policy: BakedUpdatePolicy } = {
    yml: APP_UPDATE_YML,
    policy: POLICY,
  },
) {
  const appUpdateConfigPath = NodePath.join(workDir, "app-update.yml");
  NodeFS.writeFileSync(appUpdateConfigPath, feed.yml);
  const logs: Array<string> = [];
  nativeUpdater = makeNativeUpdater();
  const updater = new MacUpdater(undefined, {
    version: "0.0.46",
    name: "Stark Code (Alpha)",
    isPackaged: true,
    appUpdateConfigPath,
    userDataPath: workDir,
    baseCachePath: workDir,
    whenReady: () => Promise.resolve(),
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined,
  });
  updater.httpExecutor = new ElectronHttpExecutor();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.logger = {
    info: (message: string) => logs.push(`info ${message}`),
    warn: (message: unknown) => logs.push(`warn ${String(message)}`),
    error: (message: unknown) => logs.push(`error ${String(message)}`),
    debug: () => undefined,
  };
  const validation = validateStarkUpdateFeed(feed.yml, feed.policy, OWNERSHIP);
  if (!validation.ok) throw new Error(`fixture feed is invalid: ${validation.problem}`);
  bindUpdaterToValidatedFeed(
    updater as unknown as BindableAutoUpdater,
    { feed: undefined },
    validation.feed,
  );
  return { updater, logs };
}

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { readonly code?: string; readonly message?: string }) =>
      error.code ?? error.message ?? "rejected",
  );

const forbiddenHits = () => network.hits.filter((url) => !url.startsWith(FEED_URL));

describe("electron-updater boundary", () => {
  beforeEach(() => {
    network.hits.length = 0;
    network.routes.clear();
    nativeFeeds.length = 0;
  });

  it("runs against the pinned electron-updater", () => {
    // The guard wraps this version's executor, redirect and Squirrel hand-off;
    // an upgrade must re-run these tests before it ships.
    assert.equal(updaterPackage.version, "6.8.9");
  });

  it("checks a clean feed and downloads its files through the guard", async () => {
    const { updater } = makeUpdater();
    network.route(MANIFEST_URL, {
      status: 200,
      body: manifest(fileEntry(ZIP_NAME), `\npath: ${ZIP_NAME}`),
    });
    network.route(`${FEED_URL}${ZIP_NAME}`, { status: 200, body: ZIP_BODY });

    const result = (await updater.checkForUpdates()) as { readonly isUpdateAvailable: boolean };
    assert.isTrue(result.isUpdateAvailable);
    const destination = NodePath.join(workDir, "clean.zip");
    await updater.httpExecutor.download(new URL(`${FEED_URL}${ZIP_NAME}`), destination, {
      cancellationToken: new CancellationToken(),
      sha512: ZIP_SHA512,
    });

    assert.equal(NodeFS.readFileSync(destination, "utf8"), ZIP_BODY);
    assert.equal(network.hits.length, 2);
    assert.match(
      network.hits[0] ?? "",
      /^https:\/\/updates\.stark\.test\/stark-code\/mac\/latest-mac\.yml\?noCache=/u,
    );
    assert.deepStrictEqual(forbiddenHits(), []);
    assert.isTrue(updater.disableDifferentialDownload);
    assert.isNull(updater.previousBlockmapBaseUrlOverride);
  });

  const hostileManifests: ReadonlyArray<readonly [string, string]> = [
    [
      "a foreign absolute file URL",
      manifest(fileEntry("https://evil.test/Stark-Code-0.0.47-mac.zip")),
    ],
    [
      "a legacy path to a foreign host",
      manifest(
        "files: []",
        `\npath: https://evil.test/Stark-Code-0.0.47-mac.zip\nsha512: ${ZIP_SHA512}`,
      ),
    ],
    ["a protocol-relative file URL", manifest(fileEntry("//evil.test/Stark-Code-0.0.47-mac.zip"))],
    [
      "an encoded traversal",
      manifest(fileEntry("'%2e%2e/%2e%2e/%2e%2e/evil/Stark-Code-0.0.47-mac.zip'")),
    ],
  ];

  it.each(hostileManifests)(
    "refuses a manifest with %s before downloading",
    async (_label, body) => {
      const { updater } = makeUpdater();
      network.route(MANIFEST_URL, { status: 200, body });

      assert.equal(await errorCode(updater.checkForUpdates()), "ERR_STARK_UPDATE_FEED_INVALID");
      assert.isNull(updater.updateInfoAndProvider);
      assert.equal(network.hits.length, 1);
      assert.deepStrictEqual(forbiddenHits(), []);
    },
  );

  it.each(hostileManifests)(
    "never contacts the destination of %s, even past the manifest check",
    async (_label, body) => {
      const { updater } = makeUpdater();
      network.route(MANIFEST_URL, { status: 200, body });
      // Take the manifest check away to prove the request guard holds alone.
      updater.isUpdateSupported = () => true;

      const result = (await updater.checkForUpdates()) as { readonly isUpdateAvailable: boolean };
      assert.isTrue(result.isUpdateAvailable);
      assert.equal(await errorCode(updater.downloadUpdate()), "ERR_STARK_UPDATE_REQUEST_REFUSED");
      assert.deepStrictEqual(forbiddenHits(), []);
      assert.isFalse(network.hits.some((url) => url.includes("evil")));
    },
  );

  const redirectTargets: ReadonlyArray<readonly [string, string]> = [
    ["a foreign host", "https://evil.test/latest-mac.yml"],
    ["plain HTTP on the feed host", "http://updates.stark.test/stark-code/mac/latest-mac.yml"],
    ["loopback", "http://127.0.0.1:9/latest-mac.yml"],
    ["a path outside the feed", "https://updates.stark.test/other/latest-mac.yml"],
  ];

  it.each(redirectTargets)("refuses a manifest redirect to %s", async (_label, target) => {
    const { updater } = makeUpdater();
    network.route(MANIFEST_URL, { status: 302, location: target });

    assert.equal(await errorCode(updater.checkForUpdates()), "ERR_STARK_UPDATE_REQUEST_REFUSED");
    assert.equal(network.hits.length, 1);
    assert.deepStrictEqual(forbiddenHits(), []);
  });

  it("follows a redirect inside the feed and refuses the next hop out of it", async () => {
    const { updater, logs } = makeUpdater();
    network.route(MANIFEST_URL, { status: 302, location: `${FEED_URL}mirror/latest-mac.yml` });
    network.route(`${FEED_URL}mirror/latest-mac.yml`, {
      status: 301,
      location: "https://evil.test/latest-mac.yml",
    });

    assert.equal(await errorCode(updater.checkForUpdates()), "ERR_STARK_UPDATE_REQUEST_REFUSED");
    assert.equal(network.hits.length, 2);
    assert.deepStrictEqual(forbiddenHits(), []);
    assert.isTrue(
      logs.some((line) =>
        line.includes("redirect https://evil.test/latest-mac.yml: refused (origin)"),
      ),
    );
  });

  it("refuses artifact and block-map redirects and foreign block maps", async () => {
    const { updater } = makeUpdater();
    network.route(`${FEED_URL}${ZIP_NAME}`, { status: 302, location: "https://evil.test/x.zip" });
    network.route(`${FEED_URL}${ZIP_NAME}.blockmap`, {
      status: 307,
      location: "https://evil.test/x.zip.blockmap",
    });

    const download = updater.httpExecutor.download(
      new URL(`${FEED_URL}${ZIP_NAME}`),
      NodePath.join(workDir, "redirected.zip"),
      { cancellationToken: new CancellationToken(), sha512: ZIP_SHA512 },
    );
    assert.equal(await errorCode(download), "ERR_STARK_UPDATE_REQUEST_REFUSED");
    for (const url of [`${FEED_URL}${ZIP_NAME}.blockmap`, "https://evil.test/old.zip.blockmap"]) {
      const blockMap = updater.httpExecutor.downloadToBuffer(new URL(url), {
        cancellationToken: new CancellationToken(),
      });
      assert.equal(await errorCode(blockMap), "ERR_STARK_UPDATE_REQUEST_REFUSED");
    }
    assert.deepStrictEqual(forbiddenHits(), []);
  });

  it("refuses a range request whose redirect would be followed by hand", async () => {
    const { updater } = makeUpdater();
    network.route(`${FEED_URL}${ZIP_NAME}`, { status: 302, location: "https://evil.test/x.zip" });
    // The differential downloader's path: manual redirects, followRedirect() in its listener.
    const request = updater.httpExecutor.createRequest(
      {
        protocol: "https:",
        hostname: "updates.stark.test",
        path: `/stark-code/mac/${ZIP_NAME}`,
        headers: { range: "bytes=0-9" },
        redirect: "manual",
      },
      () => undefined,
    );
    request.on("redirect", () => request.followRedirect());
    const failure = new Promise<string>((resolve) =>
      request.on("error", (error: { readonly code?: string }) => resolve(error.code ?? "error")),
    );
    request.end();

    assert.equal(await failure, "ERR_STARK_UPDATE_REQUEST_REFUSED");
    assert.equal(network.hits.length, 1);
    assert.deepStrictEqual(forbiddenHits(), []);
  });

  it("refuses requests that try to override their destination", async () => {
    const { updater } = makeUpdater();
    const request = updater.httpExecutor.createRequest(
      {
        protocol: "https:",
        hostname: "updates.stark.test",
        path: `/stark-code/mac/${ZIP_NAME}`,
        headers: { Host: "evil.test" },
      },
      () => undefined,
    );
    const failure = new Promise<string>((resolve) =>
      request.on("error", (error: { readonly code?: string }) => resolve(error.code ?? "error")),
    );
    request.end();

    assert.equal(await failure, "ERR_STARK_UPDATE_REQUEST_REFUSED");
    assert.deepStrictEqual(network.hits, []);
  });

  it("keeps a rehearsal build's download cache inside its profile", async () => {
    // The adapter's platform cache stands in for ~/Library/Caches, shared by every install.
    const release = makeUpdater().updater;
    assert.equal(
      (await release.getOrCreateDownloadHelper()).cacheDir,
      NodePath.join(workDir, "starkcode-updater"),
    );

    const profile = NodePath.join(workDir, "rehearsal", "profile");
    const rehearsal = makeUpdater({
      yml: APP_UPDATE_YML.replace(FEED_URL, "http://localhost:3123/").replace(
        "kind: stark",
        "kind: mock",
      ),
      policy: {
        kind: "mock",
        url: "http://localhost:3123/",
        channels: ["latest"],
        appleTeamId: "T254LS2J9A",
        rehearsal: { profile, fault: null },
      },
    }).updater;
    assert.equal(
      (await rehearsal.getOrCreateDownloadHelper()).cacheDir,
      NodePath.join(profile, "caches", "starkcode-updater"),
    );
  });

  it("gives Squirrel.Mac nothing but its loopback hand-off", () => {
    const { updater } = makeUpdater();
    const errors: Array<unknown> = [];
    updater.on("error", (error: unknown) => errors.push(error));

    nativeUpdater.setFeedURL({ url: "http://127.0.0.1:51234" });
    nativeUpdater.setFeedURL({ url: "https://evil.test/squirrel.json" });
    nativeUpdater.setFeedURL({ url: "http://localhost:51234" });

    assert.deepStrictEqual(nativeFeeds, ["http://127.0.0.1:51234"]);
    assert.equal(errors.length, 2);
    assert.isAtLeast(sessionListeners.length, 1);
  });
});
