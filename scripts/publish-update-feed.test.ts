// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off - Publisher fixtures are plain files in a temp directory; no network and no real signing.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import Plist from "plist";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CHANNEL_MANIFEST_KEY,
  compareVersions,
  executeUpload,
  type FeedBody,
  type FeedObject,
  type FeedObjectClient,
  feedUrlProblems,
  LOCK_KEY,
  makeDirectoryFeedClient,
  makeHttpsFeedClient,
  makeS3FeedClient,
  parsePublishTarget,
  planUpload,
  PublishRefusedError,
  type PublishSeams,
  type RunCommand,
  verifyRelease,
  type VerifiedRelease,
  defaultPublishSeams,
} from "./publish-update-feed.ts";

const FEED_URL = "https://updates.stark.test/stark-code/";
const TEAM_ID = "ABCDE12345";
const VERSION = "0.0.47";
const BUNDLE_ID = "com.starkfuture.starkcode";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "publish-update-feed-test-"));
  temporaryRoots.push(dir);
  return dir;
}

const sha = (algorithm: "sha256" | "sha512", bytes: Uint8Array, encoding: "hex" | "base64") =>
  NodeCrypto.createHash(algorithm).update(bytes).digest(encoding);

interface FixtureOptions {
  readonly arches?: ReadonlyArray<string>;
  readonly proof?: (arch: string, proof: Record<string, unknown>) => Record<string, unknown>;
  readonly manifestUrl?: (file: string) => string;
  readonly manifestExtra?: string;
}

/** One build directory per arch, shaped like build-desktop-artifact output. */
async function makeRelease(options: FixtureOptions = {}) {
  const root = await makeTempDir();
  const dirs: string[] = [];
  for (const arch of options.arches ?? ["arm64", "x64"]) {
    const dir = NodePath.join(root, arch);
    await NodeFSP.mkdir(dir);
    const files: Record<string, Uint8Array> = {
      [`Stark-Code-${VERSION}-${arch}.zip`]: new TextEncoder().encode(`zip ${arch}`),
      [`Stark-Code-${VERSION}-${arch}.zip.blockmap`]: new TextEncoder().encode(`zipmap ${arch}`),
      [`Stark-Code-${VERSION}-${arch}.dmg`]: new TextEncoder().encode(`dmg ${arch}`),
      [`Stark-Code-${VERSION}-${arch}.dmg.blockmap`]: new TextEncoder().encode(`dmgmap ${arch}`),
    };
    for (const [name, bytes] of Object.entries(files)) {
      await NodeFSP.writeFile(NodePath.join(dir, name), bytes);
    }
    const zipName = `Stark-Code-${VERSION}-${arch}.zip`;
    const zip = files[zipName]!;
    await NodeFSP.writeFile(
      NodePath.join(dir, "latest-mac.yml"),
      [
        `version: ${VERSION}`,
        "files:",
        `  - url: ${options.manifestUrl?.(zipName) ?? zipName}`,
        `    sha512: ${sha("sha512", zip, "base64")}`,
        `    size: ${zip.length}`,
        ...(options.manifestExtra ? [options.manifestExtra] : []),
        "releaseDate: '2026-10-30T12:00:00.000Z'",
        "",
      ].join("\n"),
    );
    const proof = {
      schema: 1,
      version: VERSION,
      channel: "latest",
      arch,
      commit: "c0ffee",
      feed: { kind: "stark", url: FEED_URL, channel: "latest" },
      artifacts: Object.entries(files).map(([file, bytes]) => ({
        file,
        bytes: bytes.length,
        sha256: sha("sha256", bytes, "hex"),
      })),
      mac: {
        signingMode: "developer-id",
        teamId: TEAM_ID,
        appStapled: true,
        dmgStapled: true,
        gatekeeper: "Notarized Developer ID",
        distributable: true,
      },
    };
    await NodeFSP.writeFile(
      NodePath.join(dir, "release-proof.json"),
      JSON.stringify(options.proof?.(arch, proof) ?? proof),
    );
    dirs.push(dir);
  }
  return dirs;
}

interface FakeApp {
  readonly bundleId?: string;
  readonly version?: string;
  readonly updateYml?: string;
}

/** ditto writes a minimal .app; codesign answers with the given exit code. */
function fakeCommands(options: { app?: FakeApp; codesignExit?: number } = {}) {
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const runCommand: RunCommand = async (command, args) => {
    calls.push({ command, args });
    if (command === "ditto") {
      const contents = NodePath.join(args[3]!, "Stark Code (Alpha).app", "Contents");
      await NodeFSP.mkdir(NodePath.join(contents, "Resources"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(contents, "Info.plist"),
        Plist.build({
          CFBundleIdentifier: options.app?.bundleId ?? BUNDLE_ID,
          CFBundleShortVersionString: options.app?.version ?? VERSION,
        }),
      );
      await NodeFSP.writeFile(
        NodePath.join(contents, "Resources", "app-update.yml"),
        options.app?.updateYml ??
          `provider: generic\nurl: ${FEED_URL}\nchannel: latest\nupdaterCacheDirName: stark-code-updater\n`,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "codesign") {
      const exitCode = options.codesignExit ?? 0;
      return { exitCode, stdout: "", stderr: exitCode === 0 ? "" : "test-requirement: failed\n" };
    }
    return { exitCode: 127, stdout: "", stderr: "unexpected command" };
  };
  return { calls, runCommand };
}

/** Seams as they will look once hosting (S1) and signing (S2) are decided. */
const approvedSeams: PublishSeams = {
  approvedOrigins: () => ["https://updates.stark.test"],
  teamId: () => TEAM_ID,
  bundleId: () => BUNDLE_ID,
  designatedRequirement: ({ teamId }) =>
    `anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`,
  assertSafeManifestFileUrl: defaultPublishSeams.assertSafeManifestFileUrl,
  readBakedPolicy: () => ({
    kind: "stark",
    url: FEED_URL,
    channels: ["latest"],
    appleTeamId: TEAM_ID,
    rehearsal: null,
  }),
};

const failedIds = (checks: ReadonlyArray<{ id: string; ok: boolean }>) =>
  checks.filter((check) => !check.ok).map((check) => check.id);

describe("versions", () => {
  it("orders prereleases before their release and compares numeric identifiers as numbers", () => {
    const ordered = [
      "0.0.45",
      "0.0.46-alpha.1",
      "0.0.46-alpha.2",
      "0.0.46-alpha.10",
      "0.0.46-beta.1",
      "0.0.46",
      "0.1.0",
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareVersions(ordered[index - 1]!, ordered[index]!)).toBe(-1);
      expect(compareVersions(ordered[index]!, ordered[index - 1]!)).toBe(1);
    }
    expect(compareVersions("0.0.46", "0.0.46+build.7")).toBe(0);
    expect(() => compareVersions("latest", "0.0.1")).toThrow("not a semantic version");
  });
});

describe("feed URL policy", () => {
  it("refuses every origin while the checked-in allowlist is empty", () => {
    expect(defaultPublishSeams.approvedOrigins()).toEqual([]);
    expect(feedUrlProblems(FEED_URL, defaultPublishSeams.approvedOrigins())).toEqual([
      "no update origin is approved (stark.brand.json updateFeedOrigins is empty; hosting decision S1 is open)",
    ]);
  });

  it.each([
    ["http://updates.stark.test/stark-code/", "the feed must use https"],
    ["https://localhost/stark-code/", "loopback, private or local host"],
    ["https://127.0.0.1/stark-code/", "loopback, private or local host"],
    ["https://[::1]/stark-code/", "loopback, private or local host"],
    ["https://192.168.1.4/stark-code/", "loopback, private or local host"],
    ["https://canary.localhost/x/", "loopback, private or local host"],
    ["https://build.local/x/", "loopback, private or local host"],
    ["https://user:pw@updates.stark.test/stark-code/", "credentials"],
    ["https://updates.stark.test/stark-code/?token=1", "query or fragment"],
    ["https://updates.stark.test/stark-code", "must end in '/'"],
    ["https://github.com/pingdotgg/t3code/", "not an approved update origin"],
  ])("refuses %s", (url, problem) => {
    expect(feedUrlProblems(url, ["https://updates.stark.test"]).join("; ")).toContain(problem);
  });

  it("accepts an approved Stark HTTPS origin", () => {
    expect(feedUrlProblems(FEED_URL, ["https://updates.stark.test"])).toEqual([]);
  });
});

describe("verifyRelease", () => {
  it("passes a complete, notarized, Stark-signed release and checks the ZIP's app", async () => {
    const commands = fakeCommands();
    const result = await verifyRelease(
      { buildDirs: await makeRelease(), feedUrl: FEED_URL, arches: ["arm64", "x64"] },
      { seams: approvedSeams, runCommand: commands.runCommand, makeTempDir },
    );
    expect(failedIds(result.checks)).toEqual([]);
    expect(result.release?.version).toBe(VERSION);
    expect(result.release?.artifacts.map((artifact) => artifact.file).toSorted()).toHaveLength(8);
    expect(result.release?.manifest).toContain(`Stark-Code-${VERSION}-arm64.zip`);
    expect(result.release?.manifest).toContain(`Stark-Code-${VERSION}-x64.zip`);
    const codesign = commands.calls.filter((call) => call.command === "codesign");
    expect(codesign).toHaveLength(2);
    expect(codesign[0]?.args).toContain(
      `=anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`,
    );
  });

  it("refuses today: no approved origin, and checks the app's own pinned requirement", async () => {
    const commands = fakeCommands();
    const result = await verifyRelease(
      { buildDirs: await makeRelease(), feedUrl: FEED_URL, arches: ["arm64", "x64"] },
      { seams: defaultPublishSeams, runCommand: commands.runCommand, makeTempDir },
    );
    expect(result.release).toBeUndefined();
    const failed = failedIds(result.checks);
    expect(failed).toContain("feed-url");
    expect(failed).toContain("proof-team:arm64");
    expect(failed).toContain("payload-baked-policy:arm64");
    // The requirement is the one the app's update check uses (stark.brand.json team).
    const codesign = commands.calls.find((call) => call.command === "codesign");
    expect(codesign?.args).toContain(
      `=anchor apple generic and identifier "${BUNDLE_ID}" and certificate leaf[subject.OU] = "${defaultPublishSeams.teamId()}"`,
    );
  });

  it("refuses a mock or rehearsal build and a manifest that declares the mock feed", async () => {
    const result = await verifyRelease(
      {
        buildDirs: await makeRelease({
          proof: (arch, proof) =>
            arch === "arm64"
              ? {
                  ...proof,
                  feed: { kind: "mock", url: "http://127.0.0.1:3123", channel: "latest" },
                }
              : { ...proof, rehearsal: { profile: "/tmp/rehearsal", fault: null } },
          manifestExtra: "starkFeedKind: mock",
        }),
        feedUrl: FEED_URL,
        arches: ["arm64", "x64"],
      },
      { seams: approvedSeams, runCommand: fakeCommands().runCommand, makeTempDir },
    );
    expect(failedIds(result.checks)).toEqual(
      expect.arrayContaining(["proof-feed:arm64", "proof-not-rehearsal:x64", "manifest-kind"]),
    );
    expect(result.release).toBeUndefined();
  });

  it("refuses a build that is not notarized Developer ID or carries another team", async () => {
    const result = await verifyRelease(
      {
        buildDirs: await makeRelease({
          proof: (arch, proof) => ({
            ...proof,
            mac:
              arch === "arm64"
                ? { signingMode: "development", teamId: TEAM_ID, distributable: false }
                : { ...(proof["mac"] as object), teamId: "ZZZZZ99999" },
          }),
        }),
        feedUrl: FEED_URL,
        arches: ["arm64", "x64"],
      },
      { seams: approvedSeams, runCommand: fakeCommands().runCommand, makeTempDir },
    );
    expect(failedIds(result.checks)).toEqual(
      expect.arrayContaining(["proof-distributable:arm64", "proof-team:x64"]),
    );
  });

  it("refuses changed bytes, a missing architecture and a manifest whose files leave the feed", async () => {
    const dirs = await makeRelease({
      arches: ["arm64"],
      manifestUrl: (file) => `https://elsewhere.test/${file}`,
    });
    await NodeFSP.appendFile(NodePath.join(dirs[0]!, `Stark-Code-${VERSION}-arm64.dmg`), "x");
    const result = await verifyRelease(
      { buildDirs: dirs, feedUrl: FEED_URL, arches: ["arm64", "x64"] },
      { seams: approvedSeams, runCommand: fakeCommands().runCommand, makeTempDir },
    );
    expect(failedIds(result.checks)).toEqual(
      expect.arrayContaining([
        "arch-complete",
        `artifact-hash:Stark-Code-${VERSION}-arm64.dmg`,
        // The shared manifest parser refuses a file URL outside the feed outright.
        "manifest-parse",
      ]),
    );
  });

  it("refuses a payload whose signature, identity or baked feed is wrong", async () => {
    const commands = fakeCommands({
      codesignExit: 3,
      app: {
        bundleId: "com.example.other",
        updateYml: "provider: generic\nurl: http://localhost:3000\nchannel: latest\n",
      },
    });
    const result = await verifyRelease(
      { buildDirs: await makeRelease({ arches: ["arm64"] }), feedUrl: FEED_URL, arches: ["arm64"] },
      {
        seams: { ...approvedSeams, readBakedPolicy: () => undefined },
        runCommand: commands.runCommand,
        makeTempDir,
      },
    );
    expect(failedIds(result.checks)).toEqual([
      "payload-signature:arm64",
      "payload-bundle:arm64",
      "payload-app-update-yml:arm64",
      "payload-baked-policy:arm64",
    ]);
  });
});

// ---------------------------------------------------------------------------

/** In-memory object store that records every operation in order. */
function makeFakeClient(initial: Record<string, Uint8Array> = {}) {
  const objects = new Map(Object.entries(initial));
  const operations: string[] = [];
  let conflictOnChannel = false;
  const toObject = (bytes: Uint8Array): FeedObject => ({
    etag: `"${sha("sha256", bytes, "hex").slice(0, 12)}"`,
    bytes: bytes.length,
    sha256: sha("sha256", bytes, "hex"),
  });
  const read = async (body: FeedBody) =>
    "bytes" in body ? body.bytes : new Uint8Array(await NodeFSP.readFile(body.path));
  const client: FeedObjectClient = {
    describe: "fake",
    head: async (key) => {
      operations.push(`head ${key}`);
      const bytes = objects.get(key);
      return bytes === undefined ? undefined : toObject(bytes);
    },
    get: async (key) => {
      operations.push(`get ${key}`);
      const bytes = objects.get(key);
      return bytes === undefined ? undefined : { object: toObject(bytes), body: bytes };
    },
    putIfAbsent: async (key, body) => {
      operations.push(`putIfAbsent ${key}`);
      if (objects.has(key)) return "exists";
      objects.set(key, await read(body));
      return "created";
    },
    putIfMatch: async (key, body, _options, expected) => {
      operations.push(`putIfMatch ${key}`);
      const current = objects.get(key);
      const matches =
        expected === "absent"
          ? current === undefined
          : current !== undefined && toObject(current).etag === expected.etag;
      if (!matches || conflictOnChannel) return "conflict";
      objects.set(key, await read(body));
      return "written";
    },
    delete: async (key) => {
      operations.push(`delete ${key}`);
      objects.delete(key);
    },
  };
  return {
    client,
    objects,
    operations,
    conflictNextChannelWrite: () => {
      conflictOnChannel = true;
    },
  };
}

async function verifiedRelease(): Promise<VerifiedRelease> {
  const result = await verifyRelease(
    { buildDirs: await makeRelease(), feedUrl: FEED_URL, arches: ["arm64", "x64"] },
    { seams: approvedSeams, runCommand: fakeCommands().runCommand, makeTempDir },
  );
  if (result.release === undefined) throw new Error("fixture release did not verify");
  return result.release;
}

const options = { now: () => new Date("2026-10-30T12:00:00.000Z"), nonce: "test" };
const manifestFor = (version: string, extra = "") =>
  new TextEncoder().encode(
    `version: ${version}\nfiles:\n  - url: a.zip\n    sha512: x\n    size: 1\n${extra}releaseDate: '2026-10-01T00:00:00.000Z'\n`,
  );

describe("upload", () => {
  it("plans the lock first, every artifact before the channel manifest, and unlocks last", async () => {
    const plan = planUpload(await verifiedRelease());
    const kinds = plan.map((step) => step.kind);
    expect(kinds[0]).toBe("lock");
    expect(kinds.at(-1)).toBe("unlock");
    expect(kinds.at(-2)).toBe("channel");
    expect(kinds.lastIndexOf("artifact")).toBeLessThan(kinds.indexOf("channel"));
    expect(kinds.lastIndexOf("verify")).toBeLessThan(kinds.indexOf("channel"));
  });

  it("uploads artifacts, then replaces the channel manifest, then releases the lock", async () => {
    const release = await verifiedRelease();
    const fake = makeFakeClient({ [CHANNEL_MANIFEST_KEY]: manifestFor("0.0.46") });
    const outcome = await executeUpload(release, fake.client, options);
    expect(outcome.uploaded).toHaveLength(8);
    expect(outcome.previousVersion).toBe("0.0.46");
    const channelWrite = fake.operations.indexOf(`putIfMatch ${CHANNEL_MANIFEST_KEY}`);
    const lastArtifactWrite = fake.operations.findLastIndex((op) =>
      op.startsWith("putIfAbsent Stark"),
    );
    expect(fake.operations[0]).toBe(`putIfAbsent ${LOCK_KEY}`);
    expect(lastArtifactWrite).toBeLessThan(channelWrite);
    expect(fake.operations.at(-1)).toBe(`delete ${LOCK_KEY}`);
    expect(new TextDecoder().decode(fake.objects.get(CHANNEL_MANIFEST_KEY))).toBe(release.manifest);
    expect(fake.objects.has(LOCK_KEY)).toBe(false);
  });

  it("refuses while another publish holds the lock and leaves that lock alone", async () => {
    const fake = makeFakeClient({ [LOCK_KEY]: new TextEncoder().encode('{"version":"0.0.48"}') });
    await expect(executeUpload(await verifiedRelease(), fake.client, options)).rejects.toThrow(
      /Another publish holds/,
    );
    expect(fake.objects.has(LOCK_KEY)).toBe(true);
    expect(fake.operations.some((op) => op.startsWith("putIfAbsent Stark"))).toBe(false);
  });

  it.each([["0.0.47"], ["0.0.48"]])(
    "refuses when the feed already offers %s and changes nothing",
    async (live) => {
      const fake = makeFakeClient({ [CHANNEL_MANIFEST_KEY]: manifestFor(live) });
      await expect(executeUpload(await verifiedRelease(), fake.client, options)).rejects.toThrow(
        PublishRefusedError,
      );
      expect(fake.operations.some((op) => op.startsWith("putIfAbsent Stark"))).toBe(false);
      expect(fake.objects.has(LOCK_KEY)).toBe(false);
    },
  );

  it("refuses a live manifest that declares the mock feed", async () => {
    const fake = makeFakeClient({
      [CHANNEL_MANIFEST_KEY]: manifestFor("0.0.40", "starkFeedKind: mock\n"),
    });
    await expect(executeUpload(await verifiedRelease(), fake.client, options)).rejects.toThrow(
      /mock feed/,
    );
  });

  it("never overwrites an artifact with different bytes and keeps identical ones", async () => {
    const release = await verifiedRelease();
    const [first, second] = release.artifacts;
    const same = makeFakeClient({
      [first!.file]: new Uint8Array(await NodeFSP.readFile(first!.path)),
    });
    const outcome = await executeUpload(release, same.client, options);
    expect(outcome.alreadyPresent).toEqual([first!.file]);

    const different = makeFakeClient({ [second!.file]: new TextEncoder().encode("tampered") });
    await expect(executeUpload(release, different.client, options)).rejects.toThrow(/immutable/);
    expect(different.objects.has(CHANNEL_MANIFEST_KEY)).toBe(false);
    expect(new TextDecoder().decode(different.objects.get(second!.file))).toBe("tampered");
  });

  it("does not replace a channel manifest that changed during the publish", async () => {
    const fake = makeFakeClient({ [CHANNEL_MANIFEST_KEY]: manifestFor("0.0.46") });
    fake.conflictNextChannelWrite();
    await expect(executeUpload(await verifiedRelease(), fake.client, options)).rejects.toThrow(
      /changed while this publish ran/,
    );
    expect(new TextDecoder().decode(fake.objects.get(CHANNEL_MANIFEST_KEY))).toContain("0.0.46");
    expect(fake.objects.has(LOCK_KEY)).toBe(false);
  });

  it("publishes into a local directory with atomic create and replace", async () => {
    const release = await verifiedRelease();
    const root = await makeTempDir();
    const client = makeDirectoryFeedClient(root);
    expect(client.describe).toContain("dry run, not a production uploader");
    await executeUpload(release, client, options);
    const entries = (await NodeFSP.readdir(root)).toSorted();
    expect(entries).toContain(CHANNEL_MANIFEST_KEY);
    expect(entries).not.toContain(LOCK_KEY);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(entries).toHaveLength(9);

    const body = { bytes: new TextEncoder().encode("x") };
    const put = { contentType: "text/plain", cacheControl: "no-cache", sha256: "0" };
    expect(await client.putIfAbsent(CHANNEL_MANIFEST_KEY, body, put)).toBe("exists");
    expect(await client.putIfMatch(CHANNEL_MANIFEST_KEY, body, put, { etag: "stale" })).toBe(
      "conflict",
    );
    await expect(executeUpload(release, client, options)).rejects.toThrow(/would not be newer/);
  });
});

describe("store clients", () => {
  it("drives the AWS CLI with conditional writes and a checksum, never credentials", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const client = makeS3FeedClient({
      bucket: "stark-updates",
      prefix: "/stark-code/",
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        if (args[1] === "head-object") {
          return {
            exitCode: 254,
            stdout: "",
            stderr: "An error occurred (404) when calling the HeadObject operation: Not Found",
          };
        }
        if (args.includes("--if-match")) {
          return { exitCode: 254, stdout: "", stderr: "An error occurred (PreconditionFailed)" };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
      makeTempDir,
    });
    const sha256 = sha("sha256", new TextEncoder().encode("x"), "hex");
    const put = { contentType: "text/yaml", cacheControl: "no-cache", sha256 };
    expect(await client.head("latest-mac.yml")).toBeUndefined();
    expect(await client.putIfAbsent("a.zip", { bytes: new TextEncoder().encode("x") }, put)).toBe(
      "created",
    );
    expect(
      await client.putIfMatch(CHANNEL_MANIFEST_KEY, { bytes: new TextEncoder().encode("x") }, put, {
        etag: '"abc"',
      }),
    ).toBe("conflict");
    const putCall = calls.find((call) => call.includes("put-object"))!;
    expect(putCall).toEqual(
      expect.arrayContaining(["--key", "stark-code/a.zip", "--if-none-match", "*"]),
    );
    expect(putCall).toContain("--checksum-sha256");
    expect(putCall).toContain(`sha256=${sha256}`);
    expect(calls.flat().join(" ")).not.toMatch(/AWS_SECRET|aws_access_key/i);
  });

  it("sends conditional HTTPS writes and refuses to follow redirects", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = makeHttpsFeedClient({
      baseUrl: "https://upload.stark.test/stark-code",
      token: "upload-token",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(null, { status: init?.method === "PUT" ? 412 : 404 });
      },
    });
    const put = { contentType: "application/zip", cacheControl: "immutable", sha256: "0" };
    expect(await client.putIfAbsent("a.zip", { bytes: new Uint8Array([1]) }, put)).toBe("exists");
    expect(await client.head("a.zip")).toBeUndefined();
    const [putRequest] = requests;
    expect(putRequest?.url).toBe("https://upload.stark.test/stark-code/a.zip");
    expect(putRequest?.init.headers).toMatchObject({
      "if-none-match": "*",
      authorization: "Bearer upload-token",
    });
    expect(requests.every((request) => request.init.redirect === "error")).toBe(true);
  });

  it("parses the three publish targets", () => {
    expect(parsePublishTarget("s3://stark-updates/stark-code/")).toEqual({
      kind: "s3",
      bucket: "stark-updates",
      prefix: "/stark-code/",
    });
    expect(parsePublishTarget("https://upload.stark.test/feed/").kind).toBe("https");
    expect(parsePublishTarget("dir:/tmp/feed")).toEqual({ kind: "dir", path: "/tmp/feed" });
    expect(() => parsePublishTarget("ftp://x/")).toThrow("Unsupported publish target");
  });
});
