import { assert, describe, it } from "@effect/vitest";

import {
  judgeCandidate,
  sameUpdatePolicy,
  type CandidateFacts,
} from "./updateArtifactVerification.ts";
import { parseCodeSignatureSummary, type UpdateOwnership } from "./updateFeedPolicy.ts";

const TEAM = "T254LS2J9A";
const OWNERSHIP: UpdateOwnership = {
  bundleId: "com.starkfuture.starkcode",
  appleTeamId: TEAM,
  updateFeedOrigins: [],
  updateChannels: ["latest"],
};
const FEED = {
  kind: "mock" as const,
  url: "http://localhost:3123/",
  channels: ["latest"],
  appleTeamId: TEAM,
};
const PROFILE = "/tmp/rehearsal/profile";
const DEVELOPMENT_SIGNATURE = `Identifier=com.starkfuture.starkcode
Authority=Apple Development: Jane Doe (QWERTY1234)
TeamIdentifier=${TEAM}
designated => identifier "com.starkfuture.starkcode" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: Jane Doe (QWERTY1234)" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */`;

const facts = (overrides: Partial<CandidateFacts> = {}): CandidateFacts => ({
  offeredVersion: "0.0.46-alpha.2",
  pinnedRequirementAccepted: true,
  ownRequirementAccepted: true,
  signature: parseCodeSignatureSummary(DEVELOPMENT_SIGNATURE),
  bundleId: "com.starkfuture.starkcode",
  version: "0.0.46-alpha.2",
  policy: { ...FEED, rehearsal: { profile: PROFILE, fault: null } },
  ...overrides,
});

const judge = (candidate: CandidateFacts) =>
  judgeCandidate(candidate, { feed: FEED, ownRehearsalProfile: PROFILE, ownership: OWNERSHIP });

describe("judgeCandidate", () => {
  it("accepts the same identity, version and policy", () => {
    assert.deepStrictEqual(judge(facts()), { _tag: "Verified" });
  });

  it("refuses another signer, team, requirement or bundle as a signature problem", () => {
    const cases: Array<Partial<CandidateFacts>> = [
      { pinnedRequirementAccepted: false },
      { ownRequirementAccepted: false },
      { bundleId: "com.example.other" },
      {
        signature: parseCodeSignatureSummary(DEVELOPMENT_SIGNATURE.replaceAll(TEAM, "ABCDE12345")),
      },
      { signature: parseCodeSignatureSummary("app: code object is not signed at all") },
    ];
    for (const overrides of cases) {
      const verdict = judge(facts(overrides));
      assert.strictEqual(
        verdict._tag === "Rejected" && verdict.kind,
        "signature",
        JSON.stringify(overrides),
      );
    }
  });

  it("refuses a different version or update policy as an invalid artifact", () => {
    const cases: Array<Partial<CandidateFacts>> = [
      { version: "0.0.45" },
      { policy: null },
      {
        policy: {
          ...FEED,
          url: "http://localhost:4000/",
          rehearsal: { profile: PROFILE, fault: null },
        },
      },
      { policy: { ...FEED, rehearsal: { profile: "/Users/me", fault: null } } },
    ];
    for (const overrides of cases) {
      const verdict = judge(facts(overrides));
      assert.strictEqual(
        verdict._tag === "Rejected" && verdict.kind,
        "invalid-artifact",
        JSON.stringify(overrides),
      );
    }
  });
});

describe("sameUpdatePolicy", () => {
  it("lets a rehearsal fault differ but not the feed or the profile", () => {
    assert.isTrue(
      sameUpdatePolicy(
        { ...FEED, rehearsal: { profile: PROFILE, fault: "migration-fail" } },
        FEED,
        PROFILE,
      ),
    );
    assert.isFalse(sameUpdatePolicy({ ...FEED, channels: ["latest", "nightly"] }, FEED, null));
    assert.isTrue(sameUpdatePolicy(FEED, FEED, null));
  });
});
