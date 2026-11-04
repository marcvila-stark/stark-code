import { RunId } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import { advanceTurnFollow, describeDiffPanelScope, emptyDiffMessage } from "./DiffPanel.logic";

const file = (path: string, origin?: "agent" | "unknown" | "outside") => ({
  path,
  kind: "modified",
  additions: 1,
  deletions: 1,
  ...(origin === undefined ? {} : { origin }),
});

describe("describeDiffPanelScope", () => {
  it("says folder views include edits made outside the chat", () => {
    expect(describeDiffPanelScope({ kind: "unstaged" })).toBe(
      "Every uncommitted change in this folder, including edits made outside this chat.",
    );
    expect(describeDiffPanelScope({ kind: "branch", baseRef: "main" })).toBe(
      "Changes compared with main, including uncommitted edits made outside this chat.",
    );
  });

  it("splits a turn's files by who changed them", () => {
    expect(
      describeDiffPanelScope({
        kind: "turn",
        turnCount: 2,
        files: [file("plan.txt", "agent"), file("notes.md", "outside")],
      }),
    ).toBe(
      "Everything that changed in this folder while turn 2 ran. Agent edits (1 file) · Other changes in the folder during this turn (1 file).",
    );
  });

  it("makes no origin claim for checkpoints recorded before origins existed", () => {
    expect(describeDiffPanelScope({ kind: "turn", turnCount: 3, files: [file("a.ts")] })).toBe(
      "Everything that changed in this folder while turn 3 ran.",
    );
  });
});

describe("emptyDiffMessage", () => {
  it("tells an empty turn apart from a missing patch", () => {
    expect(emptyDiffMessage({ isTurn: true, hasNoNetChanges: true })).toBe(
      "No changes in this turn.",
    );
    expect(emptyDiffMessage({ isTurn: true, hasNoNetChanges: false })).toBe(
      "No patch available for this selection.",
    );
  });
});

describe("advanceTurnFollow", () => {
  const older = RunId.make("run:1");
  const latest = RunId.make("run:2");
  const awaited = RunId.make("run:3");
  // Viewing the latest turn while the next run's checkpoint is captured.
  const armed = advanceTurnFollow({
    pending: null,
    capturingRunId: awaited,
    selectedRunId: latest,
    checkpointRunIds: [latest, older],
  });

  it("switches to the awaited turn once its checkpoint lands", () => {
    expect(armed.select).toBeNull();
    expect(
      advanceTurnFollow({
        pending: armed.pending,
        capturingRunId: null,
        selectedRunId: latest,
        checkpointRunIds: [awaited, latest, older],
      }),
    ).toEqual({ pending: null, select: awaited });
  });

  it("keeps a turn the user picked while the checkpoint was captured", () => {
    // An older turn is not the latest, so nothing is captured for the selection any more.
    const picked = advanceTurnFollow({
      pending: armed.pending,
      capturingRunId: null,
      selectedRunId: older,
      checkpointRunIds: [latest, older],
    });
    expect(
      advanceTurnFollow({
        pending: picked.pending,
        capturingRunId: null,
        selectedRunId: older,
        checkpointRunIds: [awaited, latest, older],
      }),
    ).toEqual({ pending: null, select: null });
  });

  it("stops following when a folder view is picked", () => {
    expect(
      advanceTurnFollow({
        pending: armed.pending,
        capturingRunId: null,
        selectedRunId: null,
        checkpointRunIds: [awaited, latest, older],
      }),
    ).toEqual({ pending: null, select: null });
  });
});
