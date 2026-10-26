import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 55, checkedAt: "2026-09-03T12:00:05.000Z" },
        { ...weekly, checkedAt },
      ],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 55, checkedAt: "2026-09-03T12:00:05.000Z" },
        { ...weekly, checkedAt },
      ],
      resetCredits,
    });
  });
  it("refreshes unchanged live quota once a minute without freshening omitted windows", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:20:00.000Z",
      update: { windows: [session] },
    });
    expect(next?.windows).toEqual([
      { ...session, checkedAt: "2026-09-03T12:20:00.000Z" },
      { ...weekly, checkedAt },
    ]);
    expect(
      applyUsageLimitsUpdate({
        previous: next,
        checkedAt: "2026-09-03T12:20:10.000Z",
        update: { windows: [session] },
      }),
    ).toBe(next);
    expect(
      applyUsageLimitsUpdate({
        previous: next,
        checkedAt: "2026-09-03T12:19:00.000Z",
        update: { windows: [{ ...session, usedPercent: 1 }] },
      }),
    ).toBe(next);
  });
  it.each([NaN, Infinity, -1])(
    "ignores invalid quota %s instead of manufacturing zero",
    (usedPercent) => {
      expect(
        applyUsageLimitsUpdate({
          previous: published,
          checkedAt,
          update: { windows: [{ ...session, usedPercent }] },
        }),
      ).toBe(published);
      expect(
        applyUsageLimitsUpdate({
          previous: undefined,
          checkedAt,
          update: { windows: [{ ...session, usedPercent }] },
        }),
      ).toBeUndefined();
    },
  );
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toEqual({
      ...published,
      refreshError: { checkedAt },
    });
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
  it("keeps newer runtime observations when a cached full probe is read again", () => {
    const newerAt = "2026-09-03T12:20:00.000Z";
    const live = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: newerAt,
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });
    const result = resolveUsageLimitsAfterProbe({ published: live, probed: published });
    expect(result?.checkedAt).toBe(newerAt);
    expect(result?.windows).toEqual([
      { ...session, usedPercent: 55, checkedAt: newerAt },
      { ...weekly, checkedAt },
    ]);
  });
});
