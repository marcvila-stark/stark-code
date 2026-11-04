import { assert, describe, it } from "@effect/vitest";

import { DESKTOP_UPDATE_DISABLED_REASONS } from "./updateFeedPolicy.ts";
import { describeDisabledUpdates, toFeedGateDecision } from "./updateFeedGate.ts";

describe("describeDisabledUpdates", () => {
  it("names why updates are off for every reason, never claiming to be up to date", () => {
    for (const reason of DESKTOP_UPDATE_DISABLED_REASONS) {
      const described = describeDisabledUpdates(reason);
      assert.match(described.message, /^Automatic updates are off: /u, reason);
      assert.notMatch(described.message, /up to date/iu, reason);
    }
  });

  it("says a build with a valid feed is waiting for the owner's switch", () => {
    assert.deepStrictEqual(describeDisabledUpdates("not-activated"), {
      code: "not-activated",
      message:
        "Automatic updates are off: they aren't switched on for this release yet. Install new versions from a Stark Future download.",
    });
    assert.strictEqual(describeDisabledUpdates("untrusted-update-feed").code, "feed-invalid");
    assert.strictEqual(describeDisabledUpdates("untrusted-signature").code, "foreign-signature");
    assert.strictEqual(describeDisabledUpdates("disabled-by-environment").code, "turned-off");
  });

  it("hands the updater a disabled decision without the feed's detail", () => {
    assert.deepStrictEqual(
      toFeedGateDecision({ enabled: false, reason: "no-update-feed", detail: null }),
      { _tag: "Disabled", reason: describeDisabledUpdates("no-update-feed") },
    );
  });
});
