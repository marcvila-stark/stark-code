import { CheckpointId, RunId } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeCheckpointFileGroups,
  findRunAwaitingCheckpoint,
  groupCheckpointFilesByOrigin,
  replyChangedSomething,
} from "./threadCheckpoints.ts";

const file = (path: string, origin?: "agent" | "unknown" | "outside") => ({
  path,
  kind: "modified",
  additions: 1,
  deletions: 0,
  ...(origin === undefined ? {} : { origin }),
});

describe("checkpoint file origins", () => {
  it("shows no reply changes when only someone else changed the folder", () => {
    const groups = groupCheckpointFilesByOrigin([
      file("src/pricing.ts", "outside"),
      file("docs/notes.md", "outside"),
    ]);
    expect(replyChangedSomething(groups)).toBe(false);
    expect(describeCheckpointFileGroups(groups).map((group) => group.label)).toEqual([
      "Other changes in the folder during this turn (2 files)",
    ]);
  });

  it("labels agent edits apart from files whose source is unknown", () => {
    const groups = groupCheckpointFilesByOrigin([
      file("plan.txt", "agent"),
      file("investigator.txt", "unknown"),
    ]);
    expect(replyChangedSomething(groups)).toBe(true);
    expect(describeCheckpointFileGroups(groups).map((group) => group.label)).toEqual([
      "Agent edits (1 file)",
      "Changed while the agent ran commands, source unknown (1 file)",
    ]);
  });

  it("keeps checkpoints recorded before origins as one group of changes", () => {
    const groups = groupCheckpointFilesByOrigin([file("a.ts"), file("b.ts")]);
    expect(groups.agent.map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);
    expect(replyChangedSomething(groups)).toBe(true);
  });
});

describe("findRunAwaitingCheckpoint", () => {
  const run = (
    id: string,
    ordinal: number,
    status: "running" | "waiting" | "completed",
    checkpointId: string | null = null,
  ) => ({
    id: RunId.make(id),
    ordinal,
    status,
    checkpointId: checkpointId === null ? null : CheckpointId.make(checkpointId),
  });

  it("finds the newest run that finished its turn but has no checkpoint yet", () => {
    const runs = [run("run:1", 1, "completed", "checkpoint:1"), run("run:2", 2, "waiting")];
    expect(findRunAwaitingCheckpoint(runs, [{ runId: RunId.make("run:1") }])?.id).toBe("run:2");
  });

  it("is empty once the checkpoint lands or while the turn still runs", () => {
    expect(
      findRunAwaitingCheckpoint(
        [run("run:2", 2, "completed", "checkpoint:2")],
        [{ runId: RunId.make("run:2") }],
      ),
    ).toBeNull();
    expect(findRunAwaitingCheckpoint([run("run:2", 2, "running")], [])).toBeNull();
  });
});
