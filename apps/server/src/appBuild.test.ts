// @effect-diagnostics nodeBuiltinImport:off - Fake app bundles are package.json files in temporary directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import * as AppBuild from "./appBuild.ts";

const roots: string[] = [];
const bundleWith = (contents: unknown) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-app-build-"));
  roots.push(root);
  NodeFS.writeFileSync(
    NodePath.join(root, "package.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("app build", () => {
  it("finds the bundle root above the server's dist and src directories", () => {
    expect(AppBuild.bundleRootFor("/A/app.asar/apps/server/dist")).toBe("/A/app.asar");
    expect(AppBuild.bundleRootFor("/repo/apps/server/src")).toBe("/repo");
  });

  it("reads the version and commit the release build staged", () => {
    const root = bundleWith({
      name: "starkcode",
      version: "0.0.46-alpha.2",
      starkcodeCommitHash: "2342AEC3C7EDDD5428C18575C8927AFFBECB9A1F",
    });
    expect(AppBuild.readBundledAppBuild(root)).toEqual({
      version: "0.0.46-alpha.2",
      commit: "2342aec3c7eddd5428c18575c8927affbecb9a1f",
    });
    expect(
      AppBuild.readBundledAppBuild(bundleWith({ name: "starkcode", version: "1.0.0" })),
    ).toEqual({ version: "1.0.0", commit: null });
  });

  it("ignores a package.json the release build did not stage", () => {
    // The source checkout's root package.json is the monorepo's.
    expect(
      AppBuild.readBundledAppBuild(bundleWith({ name: "@starkfuture/monorepo", version: "1.0.0" })),
    ).toBeNull();
    expect(AppBuild.readBundledAppBuild(bundleWith("{not json"))).toBeNull();
    expect(
      AppBuild.readBundledAppBuild(NodePath.join(NodeOS.tmpdir(), "missing-bundle")),
    ).toBeNull();
  });

  it("prefers the bundle, then STARK_CODE_APP_VERSION, then the server package", () => {
    const bundled = { version: "0.0.46-alpha.1", commit: "abcdef1" };
    expect(
      AppBuild.resolveAppBuild({ bundled, environmentVersion: "9.9.9", packageVersion: "0.0.45" }),
    ).toEqual({ version: "0.0.46-alpha.1", commit: "abcdef1", source: "bundle" });
    expect(
      AppBuild.resolveAppBuild({
        bundled: null,
        environmentVersion: "0.0.46-dev",
        packageVersion: "0.0.45",
      }),
    ).toEqual({ version: "0.0.46-dev", commit: null, source: "environment" });
    expect(
      AppBuild.resolveAppBuild({
        bundled: null,
        environmentVersion: " ",
        packageVersion: "0.0.45",
      }),
    ).toEqual({ version: "0.0.45", commit: null, source: "server-package" });
  });

  it("names the commit only for the bundle's own version", () => {
    const build: AppBuild.AppBuild = { version: "1.0.0", commit: "abcdef1", source: "bundle" };
    expect(AppBuild.commitFor(build, "1.0.0")).toBe("abcdef1");
    // `--app-version` acting as another version has no commit to name.
    expect(AppBuild.commitFor(build, "0.9.0")).toBeNull();
    expect(
      AppBuild.commitFor({ version: "1.0.0", commit: null, source: "environment" }, "1.0.0"),
    ).toBeNull();
  });

  it("falls back to the server package in this source checkout", () => {
    // The checkout has no staged package.json above apps/server/src.
    expect(AppBuild.readBundledAppBuild(AppBuild.bundleRootFor(import.meta.dirname))).toBeNull();
    expect(packageJson.name).toBe("stark-code");
  });
});
