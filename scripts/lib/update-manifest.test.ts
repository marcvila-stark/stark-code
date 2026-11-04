import { assert, describe, it } from "@effect/vitest";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  replaceUpdateManifestFileDigest,
  withMockFeedKind,
} from "./update-manifest.ts";

const manifest = `version: 0.0.46-beta.1
files:
  - url: Stark-Code-0.0.46-beta.1-arm64.zip
    sha512: zipdigest
    size: 100
  - url: Stark-Code-0.0.46-beta.1-arm64.dmg
    sha512: dmgdigest
    size: 200
path: Stark-Code-0.0.46-beta.1-arm64.zip
sha512: zipdigest
releaseDate: '2026-10-29T10:00:00.000Z'
`;

describe("withMockFeedKind", () => {
  it("marks a manifest for the mock server once, keeping everything else", () => {
    const marked = withMockFeedKind(manifest);
    // The line the mock server looks for (declaresMockFeedKind in scripts/mock-update-server.ts).
    assert.match(marked, /^starkFeedKind: mock$/mu);
    assert.strictEqual(withMockFeedKind(marked), marked);
    const parsed = parseUpdateManifest(marked, "latest-mac.yml", "macOS");
    assert.strictEqual(parsed.extras.starkFeedKind, "mock");
    assert.deepStrictEqual(
      parsed.files,
      parseUpdateManifest(manifest, "latest-mac.yml", "macOS").files,
    );
  });
});

describe("replaceUpdateManifestFileDigest", () => {
  it("rewrites only the changed file's entry", () => {
    const refreshed = replaceUpdateManifestFileDigest(manifest, {
      url: "Stark-Code-0.0.46-beta.1-arm64.dmg",
      sha512: "stapled+dmg/digest==",
      size: 230,
    });

    assert.equal(
      refreshed,
      manifest.replace(
        "sha512: dmgdigest\n    size: 200",
        "sha512: stapled+dmg/digest==\n    size: 230",
      ),
    );
    assert.deepStrictEqual(parseUpdateManifest(refreshed, "latest-mac.yml", "macOS").files, [
      { url: "Stark-Code-0.0.46-beta.1-arm64.zip", sha512: "zipdigest", size: 100 },
      { url: "Stark-Code-0.0.46-beta.1-arm64.dmg", sha512: "stapled+dmg/digest==", size: 230 },
    ]);
  });

  it("keeps the legacy top-level digest in step with the file it names", () => {
    const refreshed = replaceUpdateManifestFileDigest(manifest, {
      url: "Stark-Code-0.0.46-beta.1-arm64.zip",
      sha512: "newzip",
      size: 101,
    });

    assert.include(
      refreshed,
      "  - url: Stark-Code-0.0.46-beta.1-arm64.zip\n    sha512: newzip\n    size: 101",
    );
    assert.include(refreshed, "\nsha512: newzip\n");
    assert.include(refreshed, "    sha512: dmgdigest\n    size: 200");
  });

  it("leaves a manifest that does not list the file unchanged", () => {
    assert.strictEqual(
      replaceUpdateManifestFileDigest(manifest, {
        url: "Stark-Code-0.0.46-beta.1-x64.dmg",
        sha512: "other",
        size: 1,
      }),
      manifest,
    );
  });
});

describe("update manifest file urls", () => {
  const withFileUrl = (url: string, path = url) =>
    manifest
      .replace("  - url: Stark-Code-0.0.46-beta.1-arm64.zip", `  - url: ${url}`)
      .replace("path: Stark-Code-0.0.46-beta.1-arm64.zip", `path: ${path}`);

  it("accepts plain names inside the feed directory", () => {
    assert.deepStrictEqual(
      parseUpdateManifest(
        withFileUrl("0.0.46-beta.1/Stark-Code-0.0.46-beta.1-arm64.zip"),
        "latest-mac.yml",
        "macOS",
      ).files[0]?.url,
      "0.0.46-beta.1/Stark-Code-0.0.46-beta.1-arm64.zip",
    );
  });

  it("rejects a scheme, a host, a leading slash and traversal when parsing", () => {
    for (const url of [
      "https://other.host/Stark-Code.zip",
      "//other.host/Stark-Code.zip",
      "/Stark-Code.zip",
      "../Stark-Code.zip",
      "releases/../../Stark-Code.zip",
      "'%2e%2e/Stark-Code.zip'",
      "dir\\Stark-Code.zip",
    ]) {
      assert.throws(
        () =>
          parseUpdateManifest(
            withFileUrl(url, "Stark-Code-0.0.46-beta.1-arm64.dmg"),
            "latest-mac.yml",
            "macOS",
          ),
        /is not a plain name inside the feed/,
        url,
      );
    }
  });

  it("rejects a legacy path that leaves the feed or names an unlisted file", () => {
    assert.throws(
      () =>
        parseUpdateManifest(
          withFileUrl("Stark-Code-0.0.46-beta.1-arm64.zip", "https://other.host/Stark-Code.zip"),
          "latest-mac.yml",
          "macOS",
        ),
      /is not a plain name inside the feed/,
    );
    assert.throws(
      () =>
        parseUpdateManifest(
          withFileUrl("Stark-Code-0.0.46-beta.1-arm64.zip", "Other.zip"),
          "latest-mac.yml",
          "macOS",
        ),
      /is not one of its files/,
    );
  });

  it("rejects foreign file urls when merging manifests built elsewhere", () => {
    const primary = parseUpdateManifest(manifest, "latest-mac.yml", "macOS");
    const foreign = {
      ...primary,
      files: [{ url: "https://other.host/Stark-Code-0.0.46-beta.1-x64.zip", sha512: "x", size: 1 }],
    };
    assert.throws(
      () => mergeUpdateManifests(primary, foreign, "macOS"),
      /is not a plain name inside the feed \(absolute\)/,
    );
    assert.throws(
      () =>
        mergeUpdateManifests(
          { ...primary, files: [{ url: "/abs.zip", sha512: "x", size: 1 }] },
          primary,
          "macOS",
        ),
      /\(rooted\)/,
    );
  });
});
