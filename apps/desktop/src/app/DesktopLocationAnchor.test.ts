// @effect-diagnostics nodeBuiltinImport:off - Fixtures are plain files in a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { afterEach, beforeEach } from "vite-plus/test";

import * as DesktopLocationAnchor from "./DesktopLocationAnchor.ts";

let root = "";
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-location-anchor-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const anchor = (
  overrides: Partial<DesktopLocationAnchor.DesktopLocationAnchorRecord> = {},
): DesktopLocationAnchor.DesktopLocationAnchorRecord => ({
  version: 1,
  starkHome: "/Volumes/Data/stark-home",
  desktopDataDirectory: "/Volumes/Data/app-data",
  lastVersion: "0.0.46-alpha.1",
  handoff: null,
  ...overrides,
});

const HANDOFF = { fromVersion: "0.0.46-alpha.1", toVersion: "0.0.46-alpha.2", at: "now" };

/** A packaged app directory whose package.json carries `starkcodeUpdate`. */
const appWithPolicy = (policy: unknown) => {
  const appPath = NodePath.join(root, "app.asar");
  NodeFS.mkdirSync(appPath, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(appPath, "package.json"),
    JSON.stringify({ name: "starkcode", version: "0.0.46", starkcodeUpdate: policy }),
  );
  return appPath;
};

const MOCK_POLICY = {
  kind: "mock",
  url: "http://localhost:3123/",
  channels: ["latest"],
  appleTeamId: "T254LS2J9A",
};

describe("resolveDesktopLocations", () => {
  it("prefers a baked rehearsal profile over the environment and the anchor", () => {
    const locations = DesktopLocationAnchor.resolveDesktopLocations({
      env: { starkHome: "/Users/me/.stark-code" },
      anchor: anchor({ handoff: HANDOFF }),
      rehearsalProfile: "/tmp/rehearsal/profile",
    });
    assert.strictEqual(locations.source, "rehearsal-profile");
    assert.deepStrictEqual(locations.starkHome, Option.some("/tmp/rehearsal/profile/home"));
    assert.deepStrictEqual(
      locations.desktopDataDirectory,
      Option.some("/tmp/rehearsal/profile/app-data"),
    );
  });

  it("uses the environment when it names a location", () => {
    const locations = DesktopLocationAnchor.resolveDesktopLocations({
      env: { desktopDataDirectory: "/custom/app-data" },
      anchor: anchor({ handoff: HANDOFF }),
      rehearsalProfile: null,
    });
    assert.strictEqual(locations.source, "environment");
    assert.isTrue(Option.isNone(locations.starkHome));
    assert.deepStrictEqual(locations.desktopDataDirectory, Option.some("/custom/app-data"));
  });

  it("follows the anchor only on the relaunch after an install handoff", () => {
    const relaunch = DesktopLocationAnchor.resolveDesktopLocations({
      env: {},
      anchor: anchor({ handoff: HANDOFF }),
      rehearsalProfile: null,
    });
    assert.strictEqual(relaunch.source, "anchor-handoff");
    assert.deepStrictEqual(relaunch.starkHome, Option.some("/Volumes/Data/stark-home"));

    const ordinary = DesktopLocationAnchor.resolveDesktopLocations({
      env: { starkHome: "  " },
      anchor: anchor(),
      rehearsalProfile: null,
    });
    assert.strictEqual(ordinary.source, "default");
    assert.isTrue(Option.isNone(ordinary.starkHome));
  });
});

describe("applyDesktopStartupLocations", () => {
  it("puts a baked rehearsal profile in the environment and never touches the anchor", () => {
    const env: NodeJS.ProcessEnv = { STARK_CODE_HOME: "/Users/me/.stark-code" };
    const appPath = appWithPolicy({
      ...MOCK_POLICY,
      rehearsal: { profile: "/tmp/rehearsal/profile", fault: "migration-fail" },
    });
    const result = DesktopLocationAnchor.applyDesktopStartupLocations({
      env,
      homeDirectory: root,
      appPath,
      isPackaged: true,
    });
    assert.strictEqual(result.source, "rehearsal-profile");
    assert.isNull(result.anchorPath);
    assert.deepStrictEqual(result.rehearsal, {
      profile: "/tmp/rehearsal/profile",
      fault: "migration-fail",
    });
    assert.strictEqual(env.STARK_CODE_HOME, "/tmp/rehearsal/profile/home");
    assert.strictEqual(env.STARK_CODE_DESKTOP_DATA_DIR, "/tmp/rehearsal/profile/app-data");
  });

  it("restores custom locations after the updater relaunch drops the environment", () => {
    const anchorPath = DesktopLocationAnchor.desktopLocationAnchorPath(root);
    DesktopLocationAnchor.writeDesktopLocationAnchor(anchorPath, anchor({ handoff: HANDOFF }));
    const env: NodeJS.ProcessEnv = {};
    const result = DesktopLocationAnchor.applyDesktopStartupLocations({
      env,
      homeDirectory: root,
      appPath: appWithPolicy(MOCK_POLICY),
      isPackaged: true,
    });
    assert.strictEqual(result.source, "anchor-handoff");
    assert.strictEqual(result.anchorPath, anchorPath);
    assert.strictEqual(env.STARK_CODE_HOME, "/Volumes/Data/stark-home");
    assert.strictEqual(env.STARK_CODE_DESKTOP_DATA_DIR, "/Volumes/Data/app-data");
    assert.strictEqual((NodeFS.statSync(anchorPath).mode & 0o777).toString(8), "600");
  });

  it("leaves development builds and an unreadable anchor alone", () => {
    const env: NodeJS.ProcessEnv = {};
    const development = DesktopLocationAnchor.applyDesktopStartupLocations({
      env,
      homeDirectory: root,
      appPath: appWithPolicy(MOCK_POLICY),
      isPackaged: false,
    });
    assert.isNull(development.anchorPath);
    assert.deepStrictEqual(env, {});

    const anchorPath = DesktopLocationAnchor.desktopLocationAnchorPath(root);
    NodeFS.mkdirSync(NodePath.dirname(anchorPath), { recursive: true });
    NodeFS.writeFileSync(anchorPath, "{ not json");
    const packaged = DesktopLocationAnchor.applyDesktopStartupLocations({
      env,
      homeDirectory: root,
      appPath: appWithPolicy({ kind: "none", url: null, channels: [], appleTeamId: null }),
      isPackaged: true,
    });
    assert.strictEqual(packaged.source, "default");
    assert.isNull(packaged.rehearsal);
    assert.deepStrictEqual(env, {});
  });

  it("records the locations in use, with or without a handoff", () => {
    const record = DesktopLocationAnchor.currentDesktopLocationAnchor({
      env: { STARK_CODE_HOME: "/custom/home" },
      appVersion: "0.0.46",
      handoff: HANDOFF,
    });
    assert.deepStrictEqual(record, {
      version: 1,
      starkHome: "/custom/home",
      desktopDataDirectory: null,
      lastVersion: "0.0.46",
      handoff: HANDOFF,
    });
    const anchorPath = DesktopLocationAnchor.desktopLocationAnchorPath(root);
    DesktopLocationAnchor.writeDesktopLocationAnchor(anchorPath, record);
    assert.deepStrictEqual(DesktopLocationAnchor.readDesktopLocationAnchor(anchorPath), record);
  });
});
