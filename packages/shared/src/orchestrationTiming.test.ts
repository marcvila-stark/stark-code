import { describe, expect, it } from "vite-plus/test";

import {
  formatDuration,
  deriveActiveWorkStartedAt,
  deriveSubagentElapsedMs,
  humanWaitMs,
  liveTurnLabel,
  workedForLabel,
  type HumanWait,
} from "./orchestrationTiming.ts";

describe("formatDuration", () => {
  it.each([
    [0, "1ms"],
    [250, "250ms"],
    [1_500, "1.5s"],
    [9_950, "10s"],
    [22_000, "22s"],
    [60_000, "1m"],
    [65_000, "1m 5s"],
    [119_500, "2m"],
    [3_599_499, "59m 59s"],
    [3_599_500, "1h"],
    [3_600_000, "1h"],
    [3_601_000, "1h 1s"],
    [3_660_000, "1h 1m"],
    [3_661_000, "1h 1m 1s"],
    [7_199_500, "2h"],
    [25_190_000, "6h 59m 50s"],
    [90_061_000, "25h 1m 1s"],
  ])("formats %d ms as %s", (durationMs, expected) => {
    expect(formatDuration(durationMs)).toBe(expected);
  });

  it.each([-1, NaN, Infinity, -Infinity])("handles invalid durations: %s", (durationMs) => {
    expect(formatDuration(durationMs)).toBe("0ms");
  });
});

describe("deriveActiveWorkStartedAt", () => {
  it.each([null, "2026-09-06T23:34:00.000Z"])(
    "does not time a superseded turn when the active turn differs",
    (sendStartedAt) => {
      expect(
        deriveActiveWorkStartedAt(
          {
            runId: "old",
            requestedAt: "2026-09-06T23:33:00.000Z",
            startedAt: null,
            completedAt: null,
          },
          { orchestrationStatus: "running", activeRunId: "new" },
          sendStartedAt,
        ),
      ).toBe(sendStartedAt);
    },
  );

  it("stops timing a turn that failed before its provider started", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: null,
          completedAt: "2026-09-06T23:33:05.000Z",
        },
        { orchestrationStatus: "error", activeRunId: null },
        null,
      ),
    ).toBeNull();
  });
  // The gap this closes. The projector stamps startedAt in the same update
  // that moves the session to "running", so during provider spin-up the turn
  // is requested with no startedAt and the session is "starting". Returning
  // null there blinks the working indicator out between "Setting up
  // worktree..." and "Working for 0s".
  it("counts from requestedAt while the provider is still starting", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: null,
          completedAt: null,
        },
        { orchestrationStatus: "starting", activeRunId: null },
        null,
      ),
    ).toBe("2026-09-06T23:33:00.000Z");
  });

  it("prefers the turn's own startedAt once the provider reports it", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: "2026-09-06T23:33:05.000Z",
          completedAt: null,
        },
        { orchestrationStatus: "running", activeRunId: "turn-1" },
        null,
      ),
    ).toBe("2026-09-06T23:33:05.000Z");
  });

  // requestedAt must not leak past the end of the work.
  it("stops counting once the turn has settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: "2026-09-06T23:33:05.000Z",
          completedAt: "2026-09-06T23:33:09.000Z",
        },
        { orchestrationStatus: "idle", activeRunId: null },
        null,
      ),
    ).toBeNull();
  });

  // A session restarting with no new turn must not resurrect the old one.
  it("does not count a settled turn while a session is starting again", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: "turn-1",
          requestedAt: "2026-09-06T23:33:00.000Z",
          startedAt: "2026-09-06T23:33:05.000Z",
          completedAt: "2026-09-06T23:33:09.000Z",
        },
        { orchestrationStatus: "starting", activeRunId: null },
        null,
      ),
    ).toBeNull();
  });

  it("falls back to the caller's send timestamp when there is no turn yet", () => {
    expect(deriveActiveWorkStartedAt(null, null, "2026-09-06T23:33:00.000Z")).toBe(
      "2026-09-06T23:33:00.000Z",
    );
  });
});

describe("deriveSubagentElapsedMs", () => {
  const startedAt = "2026-09-21T12:00:00.000Z";
  const completedAt = "2026-09-21T12:00:10.000Z";
  const now = Date.parse("2026-09-21T13:00:00.000Z");
  it.each(["idle", "completed", "failed", "cancelled", "interrupted"] as const)(
    "does not count the age of %s work with unknown completion timing",
    (status) => {
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt: null }, now)).toBeNull();
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt }, now)).toBe(10_000);
    },
  );
  it("counts a resumed activation despite a stale previous completion timestamp", () => {
    expect(deriveSubagentElapsedMs({ status: "running", startedAt, completedAt }, now)).toBe(
      3_600_000,
    );
    expect(
      deriveSubagentElapsedMs({ status: "running", startedAt: null, completedAt: null }, now),
    ).toBeNull();
  });
});

describe("approval wait time", () => {
  const approval = (startedAtMs: number, endedAtMs: number | null): HumanWait => ({
    kind: "approval",
    startedAtMs,
    endedAtMs,
  });

  it("counts overlapping waits once and runs an open wait to the window end", () => {
    expect(humanWaitMs([approval(10_000, 30_000), approval(20_000, 40_000)], 0, 60_000)).toBe(
      30_000,
    );
    expect(humanWaitMs([approval(50_000, null)], 0, 60_000)).toBe(10_000);
    expect(humanWaitMs([approval(-5_000, 5_000)], 0, 60_000)).toBe(5_000);
  });

  it("says the live turn is waiting for approval and counts only that wait", () => {
    expect(liveTurnLabel({ startedAtMs: 0, waits: [approval(75_000, null)], nowMs: 123_000 })).toBe(
      "Waiting for your approval · 48s",
    );
    expect(
      liveTurnLabel({
        startedAtMs: 0,
        waits: [{ kind: "answer", startedAtMs: 5_000, endedAtMs: null }],
        nowMs: 9_000,
      }),
    ).toBe("Waiting for your answer · 4s");
  });

  it("counts only work time once the approval is answered", () => {
    expect(
      liveTurnLabel({ startedAtMs: 0, waits: [approval(10_000, 58_000)], nowMs: 60_000 }),
    ).toBe("Working for 12s");
  });

  it("names the wait after the work time in the settled label", () => {
    expect(workedForLabel(125_000, 113_000)).toBe("Worked for 12s · waited 1m 53s for you");
    expect(workedForLabel(22_000, 0)).toBe("Worked for 22s");
    expect(workedForLabel(null, 0)).toBe("Worked");
  });
});
