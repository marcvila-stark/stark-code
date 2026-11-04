import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/process";

import {
  STARK_UPDATE_OWNERSHIP,
  checkFeedUrl,
  checkOwnSignature,
  checkUpdateFileUrl,
  checkUpdateInfo,
  decideDesktopUpdateFeed,
  evaluateUpdateRequest,
  isSquirrelHandoffFeedUrl,
  checkBakedUpdatePolicy,
  designatedRequirementForTeam,
  isValidatedStarkUpdateFeed,
  parseCodeSignatureSummary,
  parseDesignatedRequirement,
  readBakedUpdatePolicy,
  requirementPinsIdentity,
  resolveDesktopUpdateFeed,
  validateStarkUpdateFeed,
  type BakedUpdatePolicy,
  type FeedUrlProblem,
  type UpdateOwnership,
  type ValidatedStarkUpdateFeed,
} from "./updateFeedPolicy.ts";

const TEAM = "6QNLKCM5Y5";
const OWNERSHIP: UpdateOwnership = {
  bundleId: "com.starkfuture.starkcode",
  appleTeamId: TEAM,
  updateFeedOrigins: ["https://updates.stark.test"],
  updateChannels: ["latest"],
};
const FEED_URL = "https://updates.stark.test/stark-code/mac/";
const STARK_POLICY: BakedUpdatePolicy = {
  kind: "stark",
  url: FEED_URL,
  channels: ["latest"],
  appleTeamId: TEAM,
};
const MOCK_POLICY: BakedUpdatePolicy = {
  kind: "mock",
  url: "http://localhost:3123/",
  channels: ["latest"],
  appleTeamId: TEAM,
};
const yml = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
const STARK_YML = yml({
  provider: "generic",
  url: FEED_URL,
  channel: "latest",
  updaterCacheDirName: "starkcode-updater",
  kind: "stark",
});
const MOCK_YML = yml({
  provider: "generic",
  url: "http://localhost:3123/",
  channel: "latest",
  updaterCacheDirName: "starkcode-updater",
  kind: "mock",
});
const packageJsonWith = (policy: BakedUpdatePolicy | undefined) =>
  JSON.stringify({
    name: "starkcode",
    version: "0.0.47",
    ...(policy ? { starkcodeUpdate: policy } : {}),
  });

const DEVELOPER_ID_SIGNATURE = `Executable=/Applications/Stark Code (Alpha).app/Contents/MacOS/Stark Code (Alpha)
Identifier=com.starkfuture.starkcode
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=27+7 location=embedded
Signature size=9045
Authority=Developer ID Application: Stark Future GmbH (${TEAM})
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=29 Oct 2026 at 10:15:03
TeamIdentifier=${TEAM}
Runtime Version=15.0.0
designated => anchor apple generic and identifier "com.starkfuture.starkcode" and (certificate leaf[field.1.2.840.113635.100.6.1.9] /* exists */ or certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${TEAM})`;
const DEVELOPMENT_SIGNATURE = `Executable=/Applications/Stark Code (Alpha).app/Contents/MacOS/Stark Code (Alpha)
Identifier=com.starkfuture.starkcode
Authority=Apple Development: Jane Doe (QWERTY1234)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
TeamIdentifier=${TEAM}
designated => identifier "com.starkfuture.starkcode" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: Jane Doe (QWERTY1234)" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */`;
const AD_HOC_SIGNATURE = `Executable=/Applications/Stark Code (Alpha).app/Contents/MacOS/Stark Code (Alpha)
Identifier=com.starkfuture.starkcode
CodeDirectory v=20400 size=1234 flags=0x20002(adhoc,linker-signed) hashes=27+0 location=embedded
Signature=adhoc
TeamIdentifier=not set
# designated => cdhash H"0123456789abcdef0123456789abcdef01234567"`;
const UNSIGNED_SIGNATURE = "/Applications/Stark Code (Alpha).app: code object is not signed at all";
const SELF_SIGNED_SIGNATURE = `Identifier=com.starkfuture.starkcode
Authority=Stark Throwaway Identity
TeamIdentifier=not set
designated => identifier "com.starkfuture.starkcode" and certificate root = H"5f1ac0ffee5f1ac0ffee5f1ac0ffee5f1ac0ffee"`;
const OTHER_TEAM_SIGNATURE = DEVELOPER_ID_SIGNATURE.replaceAll(TEAM, "ABCDE12345");

const validFeed = (policy = STARK_POLICY, appUpdateYml = STARK_YML): ValidatedStarkUpdateFeed => {
  const result = validateStarkUpdateFeed(appUpdateYml, policy, OWNERSHIP);
  if (!result.ok) throw new Error(`fixture feed is invalid: ${result.problem}`);
  return result.feed;
};

describe("readBakedUpdatePolicy", () => {
  it("treats a package without a policy as non-updating and a malformed one as invalid", () => {
    assert.deepStrictEqual(readBakedUpdatePolicy(packageJsonWith(undefined)), {
      ok: true,
      policy: { kind: "none", url: null, channels: [], appleTeamId: null },
    });
    assert.deepStrictEqual(readBakedUpdatePolicy(packageJsonWith(STARK_POLICY)), {
      ok: true,
      policy: STARK_POLICY,
    });
    assert.isFalse(readBakedUpdatePolicy(undefined).ok);
    assert.isFalse(readBakedUpdatePolicy("{not json").ok);
    assert.isFalse(
      readBakedUpdatePolicy(
        JSON.stringify({ starkcodeUpdate: { ...STARK_POLICY, owner: "pingdotgg" } }),
      ).ok,
    );
    assert.isFalse(
      readBakedUpdatePolicy(
        JSON.stringify({ starkcodeUpdate: { ...STARK_POLICY, kind: "github" } }),
      ).ok,
    );
  });

  it("reads a rehearsal and accepts it only on a mock feed with an absolute profile", () => {
    const rehearsal = { profile: "/tmp/rehearsal/profile", fault: "migration-fail" as const };
    const baked = readBakedUpdatePolicy(packageJsonWith({ ...MOCK_POLICY, rehearsal }));
    assert.deepStrictEqual(baked, { ok: true, policy: { ...MOCK_POLICY, rehearsal } });
    assert.isTrue(checkBakedUpdatePolicy({ ...MOCK_POLICY, rehearsal }, OWNERSHIP).ok);
    assert.isFalse(
      readBakedUpdatePolicy(
        packageJsonWith({
          ...MOCK_POLICY,
          rehearsal: { profile: null, fault: "wipe-disk" },
        } as never),
      ).ok,
    );
    for (const policy of [
      { ...STARK_POLICY, rehearsal },
      { ...MOCK_POLICY, rehearsal: { profile: "relative/profile", fault: null } },
      { ...MOCK_POLICY, rehearsal: { profile: "/tmp/../Users/me", fault: null } },
    ]) {
      const checked = checkBakedUpdatePolicy(policy, OWNERSHIP);
      assert.isFalse(checked.ok, JSON.stringify(policy));
      assert.strictEqual(!checked.ok && checked.problem, "policy-rehearsal-invalid");
    }
  });
});

describe("checkFeedUrl", () => {
  it("accepts only canonical HTTPS directories on an allowlisted origin for Stark feeds", () => {
    assert.deepStrictEqual(checkFeedUrl(FEED_URL, "stark", OWNERSHIP), {
      ok: true,
      location: {
        href: FEED_URL,
        origin: "https://updates.stark.test",
        protocol: "https:",
        basePath: "/stark-code/mac/",
      },
    });
    const problems: Array<[string, FeedUrlProblem]> = [
      ["not a url", "not-a-url"],
      ["http://updates.stark.test/stark-code/", "not-https"],
      ["https://user:pass@updates.stark.test/stark-code/", "credentials"],
      ["https://updates.stark.test/stark-code/?channel=beta", "query-or-fragment"],
      ["https://updates.stark.test/stark-code/#x", "query-or-fragment"],
      ["https://updates.stark.test/stark-code", "not-a-directory"],
      ["https://UPDATES.stark.test/stark-code/", "not-canonical"],
      ["https://updates.stark.test:443/stark-code/", "not-canonical"],
      ["https://updates.stark.test/a/../stark-code/", "not-canonical"],
      ["https://updates.stark.test/stark%20code/", "unsafe-path"],
      ["https://localhost/stark-code/", "loopback"],
      ["https://127.0.0.1/stark-code/", "loopback"],
      ["https://github.com/pingdotgg/t3code/releases/", "origin-not-allowed"],
      ["https://updates.stark.test.evil.test/stark-code/", "origin-not-allowed"],
    ];
    for (const [url, problem] of problems) {
      assert.deepStrictEqual(checkFeedUrl(url, "stark", OWNERSHIP), { ok: false, problem }, url);
    }
  });

  it("refuses every Stark feed while stark.brand.json allowlists no origin", () => {
    assert.deepStrictEqual(STARK_UPDATE_OWNERSHIP.updateFeedOrigins, []);
    assert.equal(STARK_UPDATE_OWNERSHIP.appleTeamId, TEAM);
    assert.deepStrictEqual(checkFeedUrl(FEED_URL, "stark"), {
      ok: false,
      problem: "origin-not-allowed",
    });
    // An allowlist entry is itself held to the rules.
    assert.deepStrictEqual(
      checkFeedUrl("https://updates.stark.test/x/", "stark", {
        ...OWNERSHIP,
        updateFeedOrigins: ["http://updates.stark.test", "https://updates.stark.test/x"],
      }),
      { ok: false, problem: "origin-not-allowed" },
    );
  });

  it("accepts only a plain loopback port for mock feeds", () => {
    assert.isTrue(checkFeedUrl("http://localhost:3123/", "mock").ok);
    assert.isTrue(checkFeedUrl("http://127.0.0.1:3123/", "mock").ok);
    for (const url of [
      "https://localhost:3123/",
      "http://updates.stark.test:3123/",
      "http://10.0.0.5:3123/",
    ]) {
      assert.deepStrictEqual(checkFeedUrl(url, "mock"), { ok: false, problem: "not-loopback" });
    }
    for (const url of [
      "http://localhost/",
      "http://localhost:3123/feed/",
      "http://localhost:3123",
    ]) {
      assert.deepStrictEqual(checkFeedUrl(url, "mock"), { ok: false, problem: "not-canonical" });
    }
  });
});

describe("checkUpdateFileUrl", () => {
  it("allows plain relative names and refuses anything that could leave the feed", () => {
    for (const url of ["Stark-Code-0.0.47-arm64.zip", "0.0.47/Stark-Code-0.0.47-arm64.dmg"]) {
      assert.isNull(checkUpdateFileUrl(url), url);
    }
    const problems: Array<[string, string]> = [
      ["", "empty"],
      ["https://evil.test/Stark-Code.zip", "absolute"],
      ["file:///etc/passwd", "absolute"],
      ["//evil.test/Stark-Code.zip", "protocol-relative"],
      ["/Stark-Code.zip", "rooted"],
      ["a\\b.zip", "backslash"],
      ["%2e%2e/evil.zip", "percent-encoded"],
      ["..%2fevil.zip", "percent-encoded"],
      ["Stark-Code.zip?x=1", "query-or-fragment"],
      ["../evil.zip", "traversal"],
      ["a/./b.zip", "traversal"],
      ["a//b.zip", "unsafe-segment"],
      [".hidden.zip", "unsafe-segment"],
      ["Stark Code.zip", "unsafe-segment"],
    ];
    for (const [url, problem] of problems) {
      assert.equal(checkUpdateFileUrl(url), problem, url);
    }
  });
});

describe("validateStarkUpdateFeed", () => {
  it("returns a validated generic feed for a matching app-update.yml", () => {
    const result = validateStarkUpdateFeed(STARK_YML, STARK_POLICY, OWNERSHIP);
    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.include(result.feed, {
      provider: "generic",
      url: FEED_URL,
      channel: "latest",
      kind: "stark",
    });
    assert.isTrue(isValidatedStarkUpdateFeed(result.feed));
    assert.isFalse(isValidatedStarkUpdateFeed({ ...result.feed }));
    assert.isTrue(validateStarkUpdateFeed(MOCK_YML, MOCK_POLICY, OWNERSHIP).ok);
  });

  it("puts a rehearsal build's updater cache inside its profile, and only there", () => {
    const rehearsed = validateStarkUpdateFeed(
      MOCK_YML,
      { ...MOCK_POLICY, rehearsal: { profile: "/tmp/rehearsal/profile/", fault: null } },
      OWNERSHIP,
    );
    assert.strictEqual(
      rehearsed.ok && rehearsed.feed.cacheBasePath,
      "/tmp/rehearsal/profile/caches",
    );
    // Every other build keeps electron-updater's platform cache directory.
    const plainMock = validateStarkUpdateFeed(MOCK_YML, MOCK_POLICY, OWNERSHIP);
    assert.strictEqual(plainMock.ok && plainMock.feed.cacheBasePath, null);
    const noProfile = validateStarkUpdateFeed(
      MOCK_YML,
      { ...MOCK_POLICY, rehearsal: { profile: null, fault: "migration-fail" } },
      OWNERSHIP,
    );
    assert.strictEqual(noProfile.ok && noProfile.feed.cacheBasePath, null);
    const release = validateStarkUpdateFeed(STARK_YML, STARK_POLICY, OWNERSHIP);
    assert.strictEqual(release.ok && release.feed.cacheBasePath, null);
  });

  it("refuses upstream, foreign, loopback and malformed feeds", () => {
    const cases: Array<[string, string, BakedUpdatePolicy, UpdateOwnership]> = [
      [
        "github upstream",
        yml({ provider: "github", owner: "pingdotgg", repo: "t3code", updaterCacheDirName: "x" }),
        STARK_POLICY,
        OWNERSHIP,
      ],
      [
        "github with host",
        `${STARK_YML.replace("provider: generic", "provider: github")}\nhost: evil.test`,
        STARK_POLICY,
        OWNERSHIP,
      ],
      [
        "gitlab",
        STARK_YML.replace("provider: generic", "provider: gitlab"),
        STARK_POLICY,
        OWNERSHIP,
      ],
      ["s3", STARK_YML.replace("provider: generic", "provider: s3"), STARK_POLICY, OWNERSHIP],
      [
        "custom",
        STARK_YML.replace("provider: generic", "provider: custom"),
        STARK_POLICY,
        OWNERSHIP,
      ],
      [
        "foreign origin",
        STARK_YML.replace(FEED_URL, "https://evil.test/stark-code/mac/"),
        STARK_POLICY,
        OWNERSHIP,
      ],
      [
        "plain http",
        STARK_YML.replace(FEED_URL, "http://updates.stark.test/stark-code/mac/"),
        STARK_POLICY,
        OWNERSHIP,
      ],
      [
        "localhost in a Stark build",
        MOCK_YML.replace("kind: mock", "kind: stark"),
        { ...MOCK_POLICY, kind: "stark" },
        OWNERSHIP,
      ],
      ["mock kind against a Stark policy", MOCK_YML, STARK_POLICY, OWNERSHIP],
      ["kind missing", STARK_YML.replace("kind: stark", ""), STARK_POLICY, OWNERSHIP],
      ["provider missing", STARK_YML.replace("provider: generic", ""), STARK_POLICY, OWNERSHIP],
      [
        "nightly channel",
        STARK_YML.replace("channel: latest", "channel: nightly"),
        STARK_POLICY,
        OWNERSHIP,
      ],
      [
        "channel not enabled",
        STARK_YML.replace("channel: latest", "channel: nightly"),
        { ...STARK_POLICY, channels: ["nightly"] },
        OWNERSHIP,
      ],
      ["policy says none", STARK_YML, { ...STARK_POLICY, kind: "none" }, OWNERSHIP],
      ["empty allowlist", STARK_YML, STARK_POLICY, { ...OWNERSHIP, updateFeedOrigins: [] }],
      ["team not configured", STARK_YML, STARK_POLICY, { ...OWNERSHIP, appleTeamId: null }],
      ["other team baked", STARK_YML, { ...STARK_POLICY, appleTeamId: "ABCDE12345" }, OWNERSHIP],
      ["not yaml", "provider: [generic", STARK_POLICY, OWNERSHIP],
    ];
    for (const [label, appUpdateYml, policy, ownership] of cases) {
      assert.isFalse(validateStarkUpdateFeed(appUpdateYml, policy, ownership).ok, label);
    }
    assert.deepStrictEqual(validateStarkUpdateFeed(STARK_YML, STARK_POLICY), {
      ok: false,
      problem: "policy-url-invalid",
      urlProblem: "origin-not-allowed",
    });
  });
});

describe("evaluateUpdateRequest", () => {
  const feed = validFeed();

  it("allows the feed's own manifest, artifacts and block maps", () => {
    for (const url of [
      `${FEED_URL}latest-mac.yml`,
      `${FEED_URL}latest-mac.yml?noCache=1jh7k2`,
      `${FEED_URL}Stark-Code-0.0.47-arm64.zip`,
      `${FEED_URL}Stark-Code-0.0.47-arm64.zip.blockmap`,
      `${FEED_URL}0.0.47/Stark-Code-0.0.47-arm64.zip`,
    ]) {
      assert.isNull(evaluateUpdateRequest(url, feed), url);
    }
  });

  it("refuses foreign hosts, downgrades, loopback, escapes and stray queries", () => {
    const cases: Array<[string, string]> = [
      ["https://github.com/pingdotgg/t3code/releases/latest/download/latest-mac.yml", "origin"],
      ["https://objects.githubusercontent.com/x.zip", "origin"],
      ["http://updates.stark.test/stark-code/mac/x.zip", "scheme"],
      ["http://127.0.0.1:9/x.zip", "scheme"],
      ["https://updates.stark.test:8443/stark-code/mac/x.zip", "origin"],
      ["https://user@updates.stark.test/stark-code/mac/x.zip", "credentials"],
      ["https://updates.stark.test/other/x.zip", "path"],
      ["https://updates.stark.test/stark-code/mac/../../other/x.zip", "path"],
      ["https://updates.stark.test/stark-code/mac/%2e%2e/%2e%2e/x.zip", "path"],
      ["https://updates.stark.test/stark-code/mac/a%2fb.zip", "path"],
      ["https://updates.stark.test/stark-code/mac/", "path"],
      [`${FEED_URL}x.zip?noCache=1`, "query"],
      [`${FEED_URL}latest-mac.yml?redirect=https://evil.test`, "query"],
      [`${FEED_URL}x.zip#frag`, "query"],
      ["not a url", "invalid-url"],
    ];
    for (const [url, refusal] of cases) {
      assert.equal(evaluateUpdateRequest(url, feed), refusal, url);
    }
  });

  it("allows only the mock build's own loopback port", () => {
    const mock = validFeed(MOCK_POLICY, MOCK_YML);
    assert.isNull(evaluateUpdateRequest("http://localhost:3123/latest-mac.yml", mock));
    assert.equal(evaluateUpdateRequest("http://localhost:3124/latest-mac.yml", mock), "origin");
    assert.equal(evaluateUpdateRequest("http://127.0.0.1:3123/latest-mac.yml", mock), "origin");
    assert.equal(evaluateUpdateRequest(`${FEED_URL}latest-mac.yml`, mock), "scheme");
  });

  it("accepts only Squirrel's loopback hand-off as a native feed", () => {
    assert.isTrue(isSquirrelHandoffFeedUrl("http://127.0.0.1:52311"));
    for (const url of [
      "http://127.0.0.1:52311/",
      "http://localhost:52311",
      "https://127.0.0.1:52311",
      "http://127.0.0.1:99999",
      "http://127.0.0.1",
      FEED_URL,
      undefined,
    ]) {
      assert.isFalse(isSquirrelHandoffFeedUrl(url), String(url));
    }
  });
});

describe("checkUpdateInfo", () => {
  const feed = validFeed();
  const file = { url: "Stark-Code-0.0.47-arm64.zip", sha512: "digest", size: 10 };

  it("accepts a manifest whose files and legacy path stay in the feed", () => {
    assert.isNull(checkUpdateInfo({ version: "0.0.47", files: [file], path: file.url }, feed));
    assert.isNull(
      checkUpdateInfo({ version: "0.0.47", files: [file], releaseNotes: "Fixes" }, feed),
    );
  });

  it("refuses hostile manifests before anything is downloaded", () => {
    const cases: Array<[unknown, string]> = [
      [null, "not-an-object"],
      [{ files: [file] }, "version"],
      [{ version: "0.0.47", files: [] }, "files"],
      [{ version: "0.0.47", path: "https://evil.test/x.zip", sha512: "d" }, "files"],
      [{ version: "0.0.47", files: [{ ...file, url: "https://evil.test/x.zip" }] }, "file-url"],
      [{ version: "0.0.47", files: [{ ...file, url: "//evil.test/x.zip" }] }, "file-url"],
      [{ version: "0.0.47", files: [{ ...file, url: "%2e%2e/%2e%2e/x.zip" }] }, "file-url"],
      [{ version: "0.0.47", files: [{ ...file, url: "../x.zip" }] }, "file-url"],
      [{ version: "0.0.47", files: [{ ...file, sha512: "" }] }, "file-digest"],
      [{ version: "0.0.47", files: [file], path: "https://evil.test/x.zip" }, "legacy-path"],
      [{ version: "0.0.47", files: [file], path: "Other.zip" }, "legacy-path"],
      [{ version: "0.0.47", files: [file], packages: { arm64: { path: "x.7z" } } }, "packages"],
      [{ version: "0.0.47", files: [file], releaseNotes: { html: "<img>" } }, "release-notes"],
    ];
    for (const [info, problem] of cases) {
      assert.equal(checkUpdateInfo(info, feed), problem, JSON.stringify(info));
    }
  });
});

describe("manifest feed kind", () => {
  const file = { url: "Stark-Code-0.0.47-arm64.zip", sha512: "digest", size: 10 };

  it("lets a mock build follow only mock manifests and a Stark build never one", () => {
    const mock = validFeed(MOCK_POLICY, MOCK_YML);
    assert.isNull(
      checkUpdateInfo({ version: "0.0.47", files: [file], starkFeedKind: "mock" }, mock),
    );
    assert.strictEqual(checkUpdateInfo({ version: "0.0.47", files: [file] }, mock), "feed-kind");
    const stark = validFeed();
    assert.isNull(checkUpdateInfo({ version: "0.0.47", files: [file] }, stark));
    assert.strictEqual(
      checkUpdateInfo({ version: "0.0.47", files: [file], starkFeedKind: "mock" }, stark),
      "feed-kind",
    );
  });
});

describe("designatedRequirementForTeam", () => {
  it("pins the Apple anchor, the bundle id and the team, and parses back as pinned", () => {
    const text = designatedRequirementForTeam({ teamId: TEAM, bundleId: OWNERSHIP.bundleId });
    assert.strictEqual(
      text,
      `anchor apple generic and identifier "com.starkfuture.starkcode" and certificate leaf[subject.OU] = "${TEAM}"`,
    );
    assert.isTrue(
      requirementPinsIdentity(parseDesignatedRequirement(`designated => ${text}`), {
        bundleId: OWNERSHIP.bundleId,
        teamId: TEAM,
      }),
    );
    assert.throws(() => designatedRequirementForTeam({ teamId: "nope", bundleId: "x" }));
    assert.throws(() =>
      designatedRequirementForTeam({ teamId: TEAM, bundleId: 'x" or anchor apple "' }),
    );
  });
});

describe("code signatures", () => {
  it("parses designated requirements and recognises a pinned Developer ID one", () => {
    const developerId = parseDesignatedRequirement(DEVELOPER_ID_SIGNATURE);
    assert.include(developerId, {
      identifier: "com.starkfuture.starkcode",
      teamId: TEAM,
      anchor: "apple-generic",
      hasAlternatives: false,
    });
    const identity = { bundleId: "com.starkfuture.starkcode", teamId: TEAM };
    assert.isTrue(requirementPinsIdentity(developerId, identity));
    assert.isFalse(
      requirementPinsIdentity(parseDesignatedRequirement(DEVELOPMENT_SIGNATURE), identity),
    );
    assert.isFalse(
      requirementPinsIdentity(parseDesignatedRequirement(OTHER_TEAM_SIGNATURE), identity),
    );
    assert.equal(parseDesignatedRequirement(AD_HOC_SIGNATURE).anchor, "cdhash");
    assert.equal(parseDesignatedRequirement(SELF_SIGNED_SIGNATURE).anchor, "certificate");
    assert.equal(parseDesignatedRequirement(UNSIGNED_SIGNATURE).text, undefined);
    // A top-level `or` makes the clauses alternatives, so nothing is pinned.
    const weak = parseDesignatedRequirement(
      `designated => anchor apple generic and identifier "com.starkfuture.starkcode" and certificate leaf[subject.OU] = ${TEAM} or anchor apple generic`,
    );
    assert.isTrue(weak.hasAlternatives);
    assert.isFalse(requirementPinsIdentity(weak, identity));
  });

  it("disables updates for unsigned, ad-hoc, other-team and unpinned builds", () => {
    const check = (output: string, kind: "stark" | "mock") =>
      checkOwnSignature(parseCodeSignatureSummary(output), kind, OWNERSHIP);
    assert.isNull(check(DEVELOPER_ID_SIGNATURE, "stark"));
    assert.isNull(check(DEVELOPER_ID_SIGNATURE, "mock"));
    assert.isNull(check(DEVELOPMENT_SIGNATURE, "mock"));
    assert.equal(check(DEVELOPMENT_SIGNATURE, "stark"), "requirement-not-pinned");
    assert.equal(check(UNSIGNED_SIGNATURE, "mock"), "unsigned");
    assert.equal(check(AD_HOC_SIGNATURE, "mock"), "ad-hoc");
    assert.equal(check(SELF_SIGNED_SIGNATURE, "mock"), "team-mismatch");
    assert.equal(check(OTHER_TEAM_SIGNATURE, "stark"), "team-mismatch");
    assert.equal(
      checkOwnSignature(parseCodeSignatureSummary(DEVELOPER_ID_SIGNATURE), "stark", {
        ...OWNERSHIP,
        bundleId: "com.example.other",
      }),
      "identifier-mismatch",
    );
  });
});

describe("decideDesktopUpdateFeed", () => {
  const base: Parameters<typeof decideDesktopUpdateFeed>[0] = {
    platform: "darwin",
    isPackaged: true,
    disabledByEnv: false,
    activated: true,
    appUpdateYml: STARK_YML,
    appPackageJson: packageJsonWith(STARK_POLICY),
    codesignOutput: DEVELOPER_ID_SIGNATURE,
    ownership: OWNERSHIP,
  };
  const reasonOf = (overrides: Partial<typeof base>) => {
    const decision = decideDesktopUpdateFeed({ ...base, ...overrides });
    return decision.enabled ? "enabled" : `${decision.reason}:${decision.detail ?? ""}`;
  };

  it("enables a validated Stark feed only on a packaged, pinned, activated Mac build", () => {
    const decision = decideDesktopUpdateFeed(base);
    assert.isTrue(decision.enabled);
    if (decision.enabled) assert.isTrue(isValidatedStarkUpdateFeed(decision.feed));
    assert.equal(
      reasonOf({
        appUpdateYml: MOCK_YML,
        appPackageJson: packageJsonWith(MOCK_POLICY),
        codesignOutput: DEVELOPMENT_SIGNATURE,
      }),
      "enabled",
    );
  });

  it("names why updates stay off", () => {
    assert.equal(reasonOf({ platform: "linux" as never }), "unsupported-platform:");
    assert.equal(reasonOf({ isPackaged: false }), "development-build:");
    assert.equal(reasonOf({ appPackageJson: "{" }), "invalid-update-policy:");
    assert.equal(
      reasonOf({ appUpdateYml: undefined, appPackageJson: packageJsonWith(undefined) }),
      "no-update-feed:",
    );
    // Today's hosted builds: no policy, no app-update.yml.
    assert.equal(
      reasonOf({ appUpdateYml: undefined, appPackageJson: '{"name":"starkcode"}' }),
      "no-update-feed:",
    );
    assert.equal(
      reasonOf({ appPackageJson: packageJsonWith(undefined) }),
      "untrusted-update-feed:feed-not-expected",
    );
    assert.equal(reasonOf({ appUpdateYml: undefined }), "untrusted-update-feed:app-update-missing");
    assert.equal(
      reasonOf({ appUpdateYml: STARK_YML.replace("provider: generic", "provider: github") }),
      "untrusted-update-feed:provider-not-generic",
    );
    assert.equal(
      reasonOf({ ownership: { ...OWNERSHIP, updateFeedOrigins: [] } }),
      "untrusted-update-feed:origin-not-allowed",
    );
    assert.equal(reasonOf({ disabledByEnv: true }), "disabled-by-environment:");
    assert.equal(reasonOf({ activated: false }), "not-activated:");
    // Only Stark feeds wait for activation.
    assert.equal(
      reasonOf({
        activated: false,
        appUpdateYml: MOCK_YML,
        appPackageJson: packageJsonWith(MOCK_POLICY),
        codesignOutput: DEVELOPMENT_SIGNATURE,
      }),
      "enabled",
    );
    assert.equal(reasonOf({ codesignOutput: undefined }), "untrusted-signature:unreadable");
    assert.equal(reasonOf({ codesignOutput: UNSIGNED_SIGNATURE }), "unsigned-build:unsigned");
    assert.equal(reasonOf({ codesignOutput: AD_HOC_SIGNATURE }), "unsigned-build:ad-hoc");
    assert.equal(
      reasonOf({ codesignOutput: OTHER_TEAM_SIGNATURE }),
      "untrusted-signature:team-mismatch",
    );
    // The real ownership refuses every Stark feed until hosting is approved.
    assert.equal(
      reasonOf({ ownership: STARK_UPDATE_OWNERSHIP }),
      "untrusted-update-feed:origin-not-allowed",
    );
  });
});

function codesignSpawner(invocations: Array<ReadonlyArray<string>>, output: string) {
  const bytes = new TextEncoder().encode(output);
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const child = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      invocations.push([child.command, ...child.args]);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(bytes),
          stderr: Stream.empty,
          all: Stream.make(bytes),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
}

it.layer(NodeServices.layer)("resolveDesktopUpdateFeed", (it) => {
  it.effect(
    "reads the packaged files and asks codesign only when the feed is otherwise valid",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "stark-update-feed-" });
          const appUpdateYmlPath = path.join(dir, "app-update.yml");
          const appPackageJsonPath = path.join(dir, "package.json");
          yield* fs.writeFileString(appUpdateYmlPath, MOCK_YML);
          yield* fs.writeFileString(appPackageJsonPath, packageJsonWith(MOCK_POLICY));
          const input = {
            platform: "darwin" as const,
            isPackaged: true,
            disabledByEnv: false,
            activated: true,
            appUpdateYmlPath,
            appPackageJsonPath,
            appBundlePath: "/Applications/Stark Code (Alpha).app",
            ownership: OWNERSHIP,
          };

          const invocations: Array<ReadonlyArray<string>> = [];
          const enabled = yield* resolveDesktopUpdateFeed(input).pipe(
            Effect.provide(codesignSpawner(invocations, DEVELOPMENT_SIGNATURE)),
          );
          assert.isTrue(enabled.enabled);
          assert.deepStrictEqual(invocations, [
            [
              "/usr/bin/codesign",
              "--display",
              "--verbose=2",
              "-r-",
              "/Applications/Stark Code (Alpha).app",
            ],
          ]);

          // The activation switch governs Stark feeds; a mock rehearsal runs before it.
          const rehearsal = yield* resolveDesktopUpdateFeed({ ...input, activated: false }).pipe(
            Effect.provide(codesignSpawner([], DEVELOPMENT_SIGNATURE)),
          );
          assert.isTrue(rehearsal.enabled);

          const skipped: Array<ReadonlyArray<string>> = [];
          const off = yield* resolveDesktopUpdateFeed({
            ...input,
            activated: false,
            disabledByEnv: true,
          }).pipe(Effect.provide(codesignSpawner(skipped, DEVELOPMENT_SIGNATURE)));
          assert.deepStrictEqual(off, {
            enabled: false,
            reason: "disabled-by-environment",
            detail: null,
          });
          assert.deepStrictEqual(skipped, []);

          const missing = yield* resolveDesktopUpdateFeed({
            ...input,
            appUpdateYmlPath: path.join(dir, "missing.yml"),
            appPackageJsonPath: path.join(dir, "missing.json"),
          }).pipe(Effect.provide(codesignSpawner(skipped, DEVELOPMENT_SIGNATURE)));
          assert.deepStrictEqual(missing, {
            enabled: false,
            reason: "invalid-update-policy",
            detail: null,
          });
        }),
      ),
  );
});
