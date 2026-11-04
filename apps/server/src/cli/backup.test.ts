// @effect-diagnostics nodeBuiltinImport:off - The fake app bundle is a package.json in a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@starkfuture/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as AppBuild from "../appBuild.ts";
import { cli } from "../binCli.ts";
import { eventIds, makeTestHome, migrateHome, seedRows } from "../testUtils/stateFixtures.ts";

const BUNDLE_VERSION = "0.0.46-alpha.1";
const BUNDLE_COMMIT = "2342aec3c7eddd5428c18575c8927affbecb9a1f";

/** A packaged app's asar root: the staged package.json the release build writes. */
const makeFakeBundle = Effect.acquireRelease(
  Effect.sync(() => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-bundle-"));
    NodeFS.writeFileSync(
      NodePath.join(root, "package.json"),
      JSON.stringify({
        name: "starkcode",
        version: BUNDLE_VERSION,
        buildVersion: BUNDLE_VERSION,
        starkcodeCommitHash: BUNDLE_COMMIT,
      }),
    );
    return root;
  }),
  (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

/** Runs the bundled CLI from `bundleRoot` and returns its `--json` line. */
const runBundledCli = (bundleRoot: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Command.runWith(cli, { version: "0.0.0" })(args).pipe(
      Effect.provideService(AppBuild.AppBundleRoot, bundleRoot),
      Effect.ignore,
    );
    const line = (yield* TestConsole.logLines).findLast(
      (entry): entry is string => typeof entry === "string" && entry.startsWith("{"),
    );
    return JSON.parse(line ?? "{}") as Record<string, any>;
  }).pipe(Effect.provide(layerCliRuntime));

describe("stark-code backup", () => {
  it.effect("restores a pre-install backup under the bundled CLI of the version that made it", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      const bundle = yield* makeFakeBundle;
      yield* migrateHome(home);
      seedRows(home, "before", 2);

      // The desktop app takes the pre-install backup through its bundled CLI
      // and names its own version, as DesktopInstallPreflight does.
      const created = yield* runBundledCli(bundle, [
        "backup",
        "create",
        "--reason",
        "pre-install",
        "--app-version",
        BUNDLE_VERSION,
        "--target-version",
        "0.0.46-alpha.2",
        "--base-dir",
        home.baseDir,
        "--json",
      ]);
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      assert.strictEqual(created.manifest.app.version, BUNDLE_VERSION);
      assert.strictEqual(created.manifest.app.commit, BUNDLE_COMMIT);
      seedRows(home, "after", 1);

      // The update failed and the same version was reinstalled: the plain
      // command the docs give, with no --app-version, restores it.
      const restored = yield* runBundledCli(bundle, [
        "backup",
        "restore",
        created.id,
        "--base-dir",
        home.baseDir,
        "--json",
      ]);
      assert.strictEqual(restored.ok, true, JSON.stringify(restored));
      assert.strictEqual(restored.backupAppVersion, BUNDLE_VERSION);
      assert.deepStrictEqual(eventIds(home.dbPath), ["before-0", "before-1"]);
    }),
  );

  it.effect("records no commit outside a packaged app or for another version", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      const bundle = yield* makeFakeBundle;
      yield* migrateHome(home);
      // A source checkout has no staged package.json above the server.
      const development = yield* runBundledCli(home.baseDir, [
        "backup",
        "create",
        "--base-dir",
        home.baseDir,
        "--json",
      ]);
      assert.strictEqual(development.ok, true, JSON.stringify(development));
      assert.isNull(development.manifest.app.commit);
      const otherVersion = yield* runBundledCli(bundle, [
        "backup",
        "create",
        "--app-version",
        "0.0.44",
        "--base-dir",
        home.baseDir,
        "--json",
      ]);
      assert.strictEqual(otherVersion.manifest.app.version, "0.0.44");
      assert.isNull(otherVersion.manifest.app.commit);
    }),
  );

  it.effect("keeps --app-version as an override of the bundle's version", () =>
    Effect.gen(function* () {
      const home = yield* makeTestHome;
      const bundle = yield* makeFakeBundle;
      yield* migrateHome(home);
      const created = yield* runBundledCli(bundle, [
        "backup",
        "create",
        "--reason",
        "pre-install",
        "--app-version",
        BUNDLE_VERSION,
        "--base-dir",
        home.baseDir,
        "--json",
      ]);
      const dryRun = yield* runBundledCli(bundle, [
        "backup",
        "restore",
        created.id,
        "--dry-run",
        "--app-version",
        "0.0.45",
        "--base-dir",
        home.baseDir,
        "--json",
      ]);
      assert.strictEqual(dryRun.restorable, false);
      assert.strictEqual(dryRun.incompatibility, "app-version");
    }),
  );
});
