import { assert, describe, it } from "@effect/vitest";

import {
  assertSafeManifestFileUrl,
  designatedRequirementForTeam,
  parseBakedUpdatePolicy,
  rehearsalBuildEnv,
} from "./update-release-seams.ts";

const MOCK = {
  kind: "mock",
  url: "http://localhost:3123/",
  channels: ["latest"],
  appleTeamId: "T254LS2J9A",
};

describe("update release seams", () => {
  it("reads the policy the build bakes, with or without a rehearsal", () => {
    assert.deepStrictEqual(parseBakedUpdatePolicy({ starkcodeUpdate: MOCK }), {
      ...MOCK,
      kind: "mock",
      rehearsal: null,
    });
    const rehearsal = { profile: "/tmp/r/profile", fault: "migration-fail" as const };
    assert.deepStrictEqual(parseBakedUpdatePolicy({ starkcodeUpdate: { ...MOCK, rehearsal } }), {
      ...MOCK,
      kind: "mock",
      rehearsal,
    });
    assert.isUndefined(parseBakedUpdatePolicy({ name: "starkcode" }));
    assert.isUndefined(parseBakedUpdatePolicy({ starkcodeUpdate: { ...MOCK, owner: "x" } }));
    assert.isUndefined(
      parseBakedUpdatePolicy({
        starkcodeUpdate: { ...MOCK, rehearsal: { profile: null, fault: "x" } },
      }),
    );
  });

  it("uses the app's own requirement text and file URL rules", () => {
    assert.include(
      designatedRequirementForTeam({ teamId: "T254LS2J9A", bundleId: "com.starkfuture.starkcode" }),
      'certificate leaf[subject.OU] = "T254LS2J9A"',
    );
    assertSafeManifestFileUrl("Stark-Code-0.0.47-arm64.zip");
    for (const url of ["../x.zip", "dir/x.zip", "%2e%2e/x.zip", "https://evil.test/x.zip"]) {
      assert.throws(() => assertSafeManifestFileUrl(url), /bare file name/u, url);
    }
  });

  it("builds the rehearsal environment the build reads", () => {
    assert.deepStrictEqual(
      rehearsalBuildEnv({ profileDir: "/tmp/r/profile", fault: "migration-fail" }),
      {
        STARK_CODE_DESKTOP_UPDATE_FEED: "mock",
        STARK_CODE_DESKTOP_REHEARSAL_PROFILE: "/tmp/r/profile",
        STARK_CODE_DESKTOP_REHEARSAL_FAULT: "migration-fail",
      },
    );
  });
});
