// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off - Rehearsal steps run against temp directories, a temp git repository and fake codesign/ditto/lsof.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import Plist from "plist";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { declaresMockFeedKind, parseFaultPlanJson } from "./mock-update-server.ts";
import { parseUpdateManifest } from "./lib/update-manifest.ts";
import {
  buildCommand,
  compareGuard,
  describeGuardHolders,
  DEFAULT_MARKER,
  FAILURE_ROWS,
  FEEDS,
  formatPlan,
  generateFeed,
  type GuardSnapshot,
  launchCommand,
  parseLsofHolders,
  type PlannedCommand,
  rehearsalPaths,
  rehearsalPlan,
  type RehearsalConfig,
  resolveConfig,
  type Runner,
  scrubBuildEnv,
  stampMockManifest,
  type StepContext,
  stepBuild,
  stepCleanupN1,
  stepPrepareN1,
  takeGuardSnapshot,
  verifyBuild,
} from "./update-rehearsal.ts";

const IDENTITY = "0123456789abcdef0123456789abcdef01234567";
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string) {
  const dir = await NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)));
  temporaryRoots.push(dir);
  return dir;
}

async function makeConfig(overrides: Record<string, string> = {}): Promise<RehearsalConfig> {
  const homeDir = await tempDir("rehearsal-home-");
  const repo = await tempDir("rehearsal-repo-");
  return resolveConfig(
    { "run-id": "t1", identity: IDENTITY, root: NodePath.join(homeDir, "rehearsal"), ...overrides },
    { repo, homeDir, now: () => new Date("2026-10-30T12:00:00Z") },
  );
}

const silentContext = (
  config: RehearsalConfig,
  runner: Runner,
  extra: Partial<StepContext> = {},
): StepContext => ({
  config,
  dryRun: false,
  runner,
  log: () => {},
  now: () => new Date("2026-10-30T12:00:00Z"),
  readBakedPolicy: () => undefined,
  tmpDir: NodeOS.tmpdir(),
  ...extra,
});

describe("configuration", () => {
  it("defaults to a scratch root outside the live home and the repository", async () => {
    const homeDir = await tempDir("rehearsal-home-");
    const repo = await tempDir("rehearsal-repo-");
    const config = resolveConfig({ "run-id": "r1" }, { repo, homeDir, now: () => new Date() });
    expect(config.root).toBe(NodePath.join(homeDir, ".stark-code-update-rehearsal", "r1"));
    const paths = rehearsalPaths(config);
    expect(paths.starkHome.startsWith(config.root)).toBe(true);
    expect(paths.desktopDataDir.startsWith(config.root)).toBe(true);
    expect(paths.buildDir("n")).toBe(NodePath.join(repo, "release-mock", "rehearsal-r1", "n"));
  });

  it.each([
    [".stark-code", "live Stark home"],
    [".stark-code/userdata/rehearsal", "live Stark home"],
    ["", "live Stark home"],
    ["Library/Application Support/stark-code-rehearsal", "Application Support"],
  ])("refuses a root at ~/%s", async (relative, message) => {
    const homeDir = await tempDir("rehearsal-home-");
    const repo = await tempDir("rehearsal-repo-");
    expect(() =>
      resolveConfig(
        { root: NodePath.join(homeDir, relative) },
        { repo, homeDir, now: () => new Date() },
      ),
    ).toThrow(message);
  });

  it("refuses a root inside the repository and indistinct or preview versions", async () => {
    const homeDir = await tempDir("rehearsal-home-");
    const repo = await tempDir("rehearsal-repo-");
    const defaults = { repo, homeDir, now: () => new Date() };
    expect(() => resolveConfig({ root: NodePath.join(repo, "x") }, defaults)).toThrow(
      "outside the repository",
    );
    expect(() => resolveConfig({ "n-version": "0.0.46-alpha.2" }, defaults)).toThrow(
      "different versions",
    );
    expect(() => resolveConfig({ "n1-version": "0.0.46-preview.20261030.1" }, defaults)).toThrow(
      "Preview and PR versions",
    );
  });
});

describe("commands", () => {
  it("builds with the mock feed, development signing and the baked profile, never --mock-updates", async () => {
    const config = await makeConfig();
    const paths = rehearsalPaths(config);
    const n = buildCommand(config, "n");
    expect(n.env).toEqual({
      STARK_CODE_DESKTOP_UPDATE_FEED: "mock",
      STARK_CODE_DESKTOP_REHEARSAL_PROFILE: paths.profileDir,
      STARK_CODE_MACOS_SIGNING_MODE: "development",
      CSC_NAME: IDENTITY.toUpperCase(),
    });
    expect(n.argv).toEqual(
      expect.arrayContaining([
        "--signed",
        "--build-version",
        "0.0.46-alpha.1",
        "--mock-update-server-port",
        "3123",
      ]),
    );
    expect(n.argv).not.toContain("--mock-updates");
    expect(n.argv.at(-1)).toBe(NodePath.join("release-mock", "rehearsal-t1", "n"));
    expect(buildCommand(config, "n1").argv).toContain("0.0.46-alpha.2");
    expect(buildCommand(config, "n1-fault-migration").env).toMatchObject({
      STARK_CODE_DESKTOP_REHEARSAL_FAULT: "migration-fail",
    });
  });

  it("requires the signing identity's full SHA-1", async () => {
    const config = { ...(await makeConfig()), identity: "Apple Development: someone" };
    expect(() => buildCommand(config, "n")).toThrow("40-character SHA-1");
  });

  it("removes publish tokens and other feed inputs from the build environment", () => {
    expect(
      scrubBuildEnv({
        PATH: "/usr/bin",
        GH_TOKEN: "x",
        GITHUB_TOKEN: "x",
        GITLAB_TOKEN: "x",
        TRAVIS_REPO_SLUG: "pingdotgg/t3code",
        CIRCLE_PROJECT_USERNAME: "x",
        STARK_CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
        STARK_CODE_DESKTOP_MOCK_UPDATES: "1",
        STARK_CODE_DESKTOP_REHEARSAL_PROFILE: "/elsewhere",
        CSC_NAME: "kept",
      }),
    ).toEqual({ PATH: "/usr/bin", CSC_NAME: "kept" });
  });

  it("launches N on the rehearsal profile with a DevTools port", async () => {
    const config = await makeConfig();
    const launch = launchCommand(config);
    const paths = rehearsalPaths(config);
    expect(launch.env).toEqual({
      STARK_CODE_HOME: paths.starkHome,
      STARK_CODE_DESKTOP_DATA_DIR: paths.desktopDataDir,
    });
    expect(launch.argv[0]).toBe(
      NodePath.join(paths.installedApp, "Contents", "MacOS", "Stark Code (Alpha)"),
    );
    expect(launch.argv).toContain("--remote-debugging-port=9333");
  });

  it("orders the plan: guard, builds, feed, fixture, inventories around the upgrade, guard, record", async () => {
    const config = await makeConfig();
    const ids = rehearsalPlan(config).map((entry) => entry.id);
    const before = (a: string, b: string) => expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
    expect(ids[0]).toBe("guard-before");
    expect(ids.at(-1)).toBe("record");
    before("build-n", "prepare-n1");
    before("prepare-n1", "build-n1");
    before("build-n1-fault", "cleanup-n1");
    before("verify-builds", "install-n");
    before("feed", "serve-feed");
    before("renderer-before", "quit-n");
    before("quit-n", "inventory-before");
    before("inventory-before", "upgrade");
    before("upgrade", "inventory-after");
    before("inventory-after", "compare");
    before("compare-restart", "guard-after");
    const text = formatPlan(config);
    expect(text).toContain("release-inventory.ts compare");
    expect(text).not.toMatch(
      new RegExp(
        `${NodePath.join(config.homeDir, ".stark-code").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!-)`,
      ),
    );
  });

  it("lists failure rows whose fault plans the mock feed accepts", () => {
    for (const row of FAILURE_ROWS) {
      expect(() => parseFaultPlanJson(JSON.stringify({ faults: row.faults }))).not.toThrow();
      expect(FEEDS.map((feed) => feed.name)).toContain(row.feed);
    }
  });
});

describe("R2: existing profile in an isolated account", () => {
  it("needs the isolated account's home and never defaults to this account's data", async () => {
    const homeDir = await tempDir("rehearsal-home-");
    const repo = await tempDir("rehearsal-repo-");
    const defaults = { repo, homeDir, now: () => new Date() };
    expect(() => resolveConfig({ profile: "existing" }, defaults)).toThrow("--account-home");
    expect(() => resolveConfig({ profile: "existing", "account-home": homeDir }, defaults)).toThrow(
      "this account's own home",
    );
    const insideIsolated = resolveConfig(
      { profile: "existing", "account-home": homeDir, "isolated-account": true },
      defaults,
    );
    expect(rehearsalPaths(insideIsolated).starkHome).toBe(NodePath.join(homeDir, ".stark-code"));
  });

  it("builds without a baked profile and runs the inventory from the shared standalone copy", async () => {
    const homeDir = await tempDir("rehearsal-home-");
    const repo = await tempDir("rehearsal-repo-");
    const config = resolveConfig(
      {
        "run-id": "r2",
        identity: IDENTITY,
        profile: "existing",
        "account-home": "/Users/stark-r2",
      },
      { repo, homeDir, now: () => new Date() },
    );
    expect(buildCommand(config, "n").env).not.toHaveProperty(
      "STARK_CODE_DESKTOP_REHEARSAL_PROFILE",
    );
    expect(buildCommand(config, "n").env).toMatchObject({ STARK_CODE_DESKTOP_UPDATE_FEED: "mock" });
    const plan = rehearsalPlan(config);
    expect(plan.some((entry) => entry.id === "guard-before")).toBe(false);
    const inventory = plan.find((entry) => entry.id === "r2a-inventory-before")?.command;
    expect(inventory?.argv[1]).toBe("/Users/Shared/stark-update-rehearsal/release-inventory.ts");
    expect(inventory?.argv).toContain("/Users/stark-r2/.stark-code");
    // The default root (~/.stark-code-update-rehearsal) shares a prefix with the live home.
    expect(formatPlan(config)).not.toMatch(
      new RegExp(
        `${NodePath.join(homeDir, ".stark-code").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!-)`,
      ),
    );
  });
});

describe("feeds", () => {
  const zipBytes = new Uint8Array(Array.from({ length: 1000 }, (_, index) => index % 256));
  const sha512 = (bytes: Uint8Array) =>
    NodeCrypto.createHash("sha512").update(bytes).digest("base64");

  async function makeBuild(
    config: RehearsalConfig,
    variant: "n1" | "n1-fault-migration",
    bytes = zipBytes,
  ) {
    const dir = rehearsalPaths(config).buildDir(variant);
    await NodeFSP.mkdir(dir, { recursive: true });
    const zip = "Stark-Code-0.0.46-alpha.2-arm64.zip";
    await NodeFSP.writeFile(NodePath.join(dir, zip), bytes);
    await NodeFSP.writeFile(NodePath.join(dir, `${zip}.blockmap`), "map");
    await NodeFSP.writeFile(
      NodePath.join(dir, "latest-mac.yml"),
      `version: 0.0.46-alpha.2\nfiles:\n  - url: ${zip}\n    sha512: ${sha512(zipBytes)}\n    size: ${zipBytes.length}\npath: ${zip}\nsha512: ${sha512(zipBytes)}\nreleaseDate: '2026-10-30T12:00:00.000Z'\n`,
    );
    return zip;
  }

  it("stamps the mock kind so only the mock server serves the manifest", () => {
    const raw =
      "version: 1.0.0\nfiles:\n  - url: a.zip\n    sha512: x\n    size: 1\nreleaseDate: '2026-10-30'\n";
    expect(declaresMockFeedKind(raw)).toBe(false);
    const stamped = stampMockManifest(raw, "0.0.45");
    expect(declaresMockFeedKind(stamped)).toBe(true);
    expect(parseUpdateManifest(stamped, "x", "macOS").version).toBe("0.0.45");
  });

  it("generates the normal, corrupt and older feeds from N+1", async () => {
    const config = await makeConfig();
    const paths = rehearsalPaths(config);
    const zip = await makeBuild(config, "n1");
    const [feed, corrupt, older] = FEEDS;
    const feedDir = await generateFeed(paths, feed!);
    expect((await NodeFSP.readdir(feedDir)).toSorted()).toEqual([
      zip,
      `${zip}.blockmap`,
      "latest-mac.yml",
    ]);
    const manifest = await NodeFSP.readFile(NodePath.join(feedDir, "latest-mac.yml"), "utf8");
    expect(declaresMockFeedKind(manifest)).toBe(true);
    expect(manifest).not.toMatch(/^path:/m);

    const corruptZip = new Uint8Array(
      await NodeFSP.readFile(NodePath.join(await generateFeed(paths, corrupt!), zip)),
    );
    expect(corruptZip.length).toBe(zipBytes.length);
    expect(corruptZip.filter((byte, index) => byte !== zipBytes[index])).toHaveLength(1);
    expect(sha512(corruptZip)).not.toBe(sha512(zipBytes));
    // The source build is untouched by the corrupt copy.
    expect(
      new Uint8Array(await NodeFSP.readFile(NodePath.join(paths.buildDir("n1"), zip))),
    ).toEqual(zipBytes);

    const olderManifest = await NodeFSP.readFile(
      NodePath.join(await generateFeed(paths, older!), "latest-mac.yml"),
      "utf8",
    );
    expect(parseUpdateManifest(olderManifest, "x", "macOS").version).toBe("0.0.45");
  });

  it("refuses to build a feed from a ZIP that does not match its manifest", async () => {
    const config = await makeConfig();
    await makeBuild(config, "n1", new Uint8Array([1, 2, 3]));
    await expect(generateFeed(rehearsalPaths(config), FEEDS[0]!)).rejects.toThrow(
      "does not match its manifest digest",
    );
  });
});

describe("live-install guard", () => {
  const snapshot = (overrides: Partial<GuardSnapshot>): GuardSnapshot => ({
    phase: "before",
    takenAt: "x",
    entries: [{ path: "/live/statev2.sqlite", exists: true, size: 10, mtimeMs: 1, ino: 5 }],
    holders: [],
    holdersChecked: true,
    lsof: "",
    ...overrides,
  });

  it("parses lsof field output", () => {
    expect(
      parseLsofHolders(
        "p123\ncStark Code\nn/live/statev2.sqlite\nn/live/statev2.sqlite-wal\np9\ncnode\nn/live/x\n",
      ),
    ).toEqual([
      { pid: 123, command: "Stark Code", path: "/live/statev2.sqlite" },
      { pid: 123, command: "Stark Code", path: "/live/statev2.sqlite-wal" },
      { pid: 9, command: "node", path: "/live/x" },
    ]);
  });

  it("passes unchanged data, reports changes by the developer's own app, fails on a rehearsal holder", () => {
    expect(compareGuard(snapshot({}), snapshot({ phase: "after" })).status).toBe("unchanged");
    const changed = snapshot({
      phase: "after",
      entries: [{ path: "/live/statev2.sqlite", exists: true, size: 12, mtimeMs: 2, ino: 5 }],
      holders: [
        {
          pid: 1,
          command: "/Applications/Stark Code (Alpha).app/…",
          path: "/live/statev2.sqlite",
          rehearsal: false,
        },
      ],
    });
    expect(compareGuard(snapshot({}), changed)).toMatchObject({
      status: "changed-not-by-rehearsal",
      changed: ["/live/statev2.sqlite"],
    });
    const violated = snapshot({
      phase: "after",
      holders: [
        {
          pid: 2,
          command: "/rehearsal/Applications/…",
          path: "/live/statev2.sqlite",
          rehearsal: true,
        },
      ],
    });
    expect(compareGuard(snapshot({}), violated).status).toBe("violated");
    expect(
      compareGuard(snapshot({ holdersChecked: false }), snapshot({ phase: "after" })).status,
    ).toBe("unverified");
  });

  it("names every process that held a live file at either check, foreign or rehearsal", () => {
    const foreign = {
      pid: 1,
      command: "/Applications/Stark Code (Alpha).app/Contents/MacOS/Stark Code (Alpha)",
      path: "/live/statev2.sqlite-wal",
      rehearsal: false,
    };
    const after = snapshot({ phase: "after", holders: [foreign], lsof: "p1\ncStark\nn/live/x\n" });
    const verdict = compareGuard(snapshot({}), after);
    expect(verdict.holders).toEqual({ before: [], after: [foreign] });
    expect(verdict.lsof).toEqual({ before: "", after: "p1\ncStark\nn/live/x\n" });
    expect(describeGuardHolders(snapshot({}))).toBe("guard-before: no process held a live file");
    expect(describeGuardHolders(after)).toBe(
      "guard-after: pid 1 (not the rehearsal) held /live/statev2.sqlite-wal: /Applications/Stark Code (Alpha).app/Contents/MacOS/Stark Code (Alpha)",
    );
    expect(describeGuardHolders(snapshot({ holdersChecked: false }))).toBe(
      "guard-before: holders could not be checked (lsof failed)",
    );
  });

  it("marks a process running from the rehearsal root as a rehearsal holder", async () => {
    const config = await makeConfig();
    const live = NodePath.join(config.homeDir, ".stark-code", "userdata");
    await NodeFSP.mkdir(live, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(live, "statev2.sqlite"), "db");
    const runner: Runner = async (command) => {
      if (command.argv[0] === "lsof") {
        return {
          exitCode: 0,
          stdout: `p77\ncStark\nn${NodePath.join(live, "statev2.sqlite")}\n`,
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: `${rehearsalPaths(config).installedApp}/Contents/MacOS/Stark Code (Alpha)\n`,
        stderr: "",
      };
    };
    const taken = await takeGuardSnapshot(config, "after", runner);
    expect(taken.holders).toEqual([expect.objectContaining({ pid: 77, rehearsal: true })]);
    // The raw lsof output is kept as evidence next to the parsed holders.
    expect(taken.lsof).toBe(`p77\ncStark\nn${NodePath.join(live, "statev2.sqlite")}\n`);
    expect(taken.entries.find((entry) => entry.path.endsWith("statev2.sqlite"))?.exists).toBe(true);
  });
});

describe("build verification", () => {
  async function fakeBuild(
    config: RehearsalConfig,
    proof: Record<string, unknown>,
    updateYml: string,
  ) {
    const dir = rehearsalPaths(config).buildDir("n");
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, "Stark-Code-0.0.46-alpha.1-arm64.zip"), "zip");
    await NodeFSP.writeFile(NodePath.join(dir, "release-proof.json"), JSON.stringify(proof));
    const calls: PlannedCommand[] = [];
    const runner: Runner = async (command) => {
      calls.push(command);
      const [tool, ...args] = command.argv;
      if (tool === "ditto") {
        const contents = NodePath.join(args[3]!, "Stark Code (Alpha).app", "Contents");
        await NodeFSP.mkdir(NodePath.join(contents, "Resources"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(contents, "Info.plist"),
          Plist.build({
            CFBundleIdentifier: "com.starkfuture.starkcode",
            CFBundleShortVersionString: "0.0.46-alpha.1",
          }),
        );
        await NodeFSP.writeFile(NodePath.join(contents, "Resources", "app-update.yml"), updateYml);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (tool === "codesign" && args[0] === "-d") {
        return {
          exitCode: 0,
          stdout: "",
          stderr:
            'Authority=Apple Development: Dev (ABC)\nTeamIdentifier=TEAM123456\ndesignated => identifier "com.starkfuture.starkcode" and anchor apple generic\n',
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { calls, runner };
  }

  const goodProof = {
    version: "0.0.46-alpha.1",
    commit: "c0ffee",
    feed: { kind: "mock", url: "http://localhost:3123", channel: "latest" },
    mac: { signingMode: "development", distributable: false },
    artifacts: [{ file: "Stark-Code-0.0.46-alpha.1-arm64.zip", bytes: 3, sha256: "x" }],
  };

  it("accepts a development-signed mock build with the baked rehearsal profile", async () => {
    const config = await makeConfig();
    const { runner } = await fakeBuild(
      config,
      goodProof,
      "provider: generic\nurl: http://localhost:3123\nchannel: latest\n",
    );
    const result = await verifyBuild(config, "n", {
      runner,
      readBakedPolicy: () => ({
        kind: "mock",
        url: "http://localhost:3123",
        channels: ["latest"],
        appleTeamId: null,
        rehearsal: { profile: rehearsalPaths(config).profileDir, fault: null },
      }),
    });
    expect(result.problems).toEqual([]);
    expect(result).toMatchObject({ ok: true, teamIdentifier: "TEAM123456", commit: "c0ffee" });
  });

  it("refuses a build without the baked profile, with a non-loopback feed or marked distributable", async () => {
    const config = await makeConfig();
    const { runner } = await fakeBuild(
      config,
      { ...goodProof, mac: { signingMode: "developer-id", distributable: true } },
      "provider: generic\nurl: https://updates.example.test/\nchannel: latest\n",
    );
    const result = await verifyBuild(config, "n", { runner, readBakedPolicy: () => undefined });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/expected development/);
    expect(result.problems.join("\n")).toMatch(/never be distributable/);
    expect(result.problems.join("\n")).toMatch(/not the loopback mock feed/);
    expect(result.problems.join("\n")).toMatch(/no baked update policy \(U0 not integrated\?\)/);
  });
});

describe("scratch commit", () => {
  const git = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const gitRunner: Runner = async (command) => {
    try {
      const [file, ...args] = command.argv;
      const stdout = NodeChildProcess.execFileSync(file!, args, {
        cwd: command.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (cause) {
      const failure = cause as { status?: number; stderr?: string };
      return { exitCode: failure.status ?? 1, stdout: "", stderr: String(failure.stderr ?? "") };
    }
  };

  async function makeRepo(config: RehearsalConfig) {
    const repo = config.repo;
    git(repo, "init", "-q", "-b", "work");
    git(repo, "config", "user.email", "rehearsal@example.test");
    git(repo, "config", "user.name", "Rehearsal");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "config", "core.hooksPath", NodePath.join(repo, ".no-hooks"));
    const file = NodePath.join(repo, DEFAULT_MARKER.file);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, `<span>Version</span>\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    return git(repo, "rev-parse", "HEAD");
  }

  it("adds the visible marker on a scratch branch, then returns and deletes it", async () => {
    const config = await makeConfig();
    const base = await makeRepo(config);
    const context = silentContext(config, gitRunner);
    await stepPrepareN1(context, DEFAULT_MARKER);
    expect(git(config.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("rehearsal/n1-t1");
    expect(git(config.repo, "rev-parse", "HEAD^")).toBe(base);
    expect(
      await NodeFSP.readFile(NodePath.join(config.repo, DEFAULT_MARKER.file), "utf8"),
    ).toContain("update rehearsal N+1");
    // N+1 builds only from the scratch commit; N refuses it.
    const builds: string[] = [];
    const recording: Runner = async (command) => {
      if (command.argv[1] === "scripts/build-desktop-artifact.ts") {
        builds.push(command.argv.join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return gitRunner(command);
    };
    await expect(stepBuild(silentContext(config, recording), "n")).rejects.toThrow(
      "run cleanup-n1",
    );
    expect(await stepBuild(silentContext(config, recording), "n1")).toBe(0);
    expect(builds).toHaveLength(1);

    await stepCleanupN1(context);
    expect(git(config.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("work");
    expect(git(config.repo, "branch", "--list", "rehearsal/*")).toBe("");
    await expect(stepBuild(silentContext(config, recording), "n1")).rejects.toThrow(
      "run prepare-n1",
    );
  });

  it("refuses a dirty worktree and a marker anchor that is not unique", async () => {
    const config = await makeConfig();
    await makeRepo(config);
    await NodeFSP.writeFile(NodePath.join(config.repo, "dirty.txt"), "x");
    await expect(stepPrepareN1(silentContext(config, gitRunner), DEFAULT_MARKER)).rejects.toThrow(
      "uncommitted",
    );
    await NodeFSP.rm(NodePath.join(config.repo, "dirty.txt"));
    await expect(
      stepPrepareN1(silentContext(config, gitRunner), { ...DEFAULT_MARKER, anchor: "<nope>" }),
    ).rejects.toThrow("exactly once");
  });
});
