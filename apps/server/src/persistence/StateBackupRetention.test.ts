import { assert, describe, it } from "@effect/vitest";

import { planRetention, type RetentionCandidate } from "./StateBackupRetention.ts";

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const NOW = 100 * DAY;

const backup = (
  id: string,
  ageDays: number,
  appVersion: string,
  options: Partial<RetentionCandidate> = {},
): RetentionCandidate => ({
  id,
  createdAtMs: NOW - ageDays * DAY,
  reason: "pre-install",
  appVersion,
  bytes: 10 * MB,
  ...options,
});

describe("planRetention", () => {
  it("keeps the three newest update backups and prunes the rest by age", () => {
    const plan = planRetention({
      backups: [
        backup("a", 1, "0.0.47"),
        backup("b", 2, "0.0.47"),
        backup("c", 3, "0.0.47"),
        backup("d", 31, "0.0.47"),
        backup("e", 5, "0.0.47"),
      ],
      nowMs: NOW,
      runningVersion: "0.0.47",
      databaseBytes: 10 * MB,
    });
    assert.deepStrictEqual(plan.prune, ["d"]);
    assert.includeMembers([...plan.keep], ["a", "b", "c", "e"]);
  });

  it("never prunes the protected backup, however old or large", () => {
    const plan = planRetention({
      backups: [
        backup("new-1", 1, "0.0.47"),
        backup("new-2", 2, "0.0.47"),
        backup("new-3", 3, "0.0.47"),
        backup("way-back", 90, "0.0.46", { bytes: 900 * MB }),
      ],
      nowMs: NOW,
      runningVersion: "0.0.47",
      databaseBytes: 10 * MB,
    });
    assert.strictEqual(plan.protectedId, "way-back");
    assert.deepStrictEqual(plan.prune, []);
  });

  it("applies the soft size cap oldest first, sparing kept backups", () => {
    const plan = planRetention({
      backups: [
        backup("recent-1", 1, "0.0.47", { bytes: 100 * MB }),
        backup("recent-2", 2, "0.0.47", { bytes: 100 * MB }),
        backup("recent-3", 3, "0.0.47", { bytes: 100 * MB }),
        backup("manual-new", 4, "0.0.47", { reason: "manual", bytes: 100 * MB }),
        backup("manual-old", 10, "0.0.47", { reason: "manual", bytes: 100 * MB }),
        backup("previous", 20, "0.0.46", { bytes: 100 * MB }),
      ],
      nowMs: NOW,
      runningVersion: "0.0.47",
      // Cap: max(256 MB, 3 x 50 MB).
      databaseBytes: 50 * MB,
    });
    assert.strictEqual(plan.protectedId, "previous");
    assert.deepStrictEqual(plan.prune, ["manual-new", "manual-old"]);
    assert.includeMembers([...plan.keep], ["recent-1", "recent-2", "recent-3", "previous"]);
  });
});
