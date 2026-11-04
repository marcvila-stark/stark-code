import { assert, describe, it } from "@effect/vitest";
import { NodeId, RunId, ThreadId, TurnItemId } from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

import { openCodeToolTurnItem } from "./toolItems.ts";

const now = DateTime.makeUnsafe("2026-10-29T12:00:00.000Z");
const base = {
  id: TurnItemId.make("item:patch"),
  threadId: ThreadId.make("thread:patch"),
  runId: RunId.make("run:patch"),
  nodeId: NodeId.make("node:patch"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
} as const;

const patchItem = (input: Record<string, unknown>) =>
  openCodeToolTurnItem(base, {
    name: "apply_patch",
    input,
    output: "done",
    completedMetadata: {},
  });

describe("openCodeToolTurnItem", () => {
  it("names every file an apply_patch touches", () => {
    const item = patchItem({
      patchText: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-old",
        "+new",
        "*** Add File: src/b.ts",
        "+hello",
        "*** Update File: src/c.ts",
        "*** Move to: src/d.ts",
        "*** Delete File: src/e.ts",
        "*** End Patch",
      ].join("\n"),
    });
    assert.deepEqual(
      item.type === "file_change"
        ? { fileName: item.fileName, changes: item.changes, written: item.agentWrittenPaths }
        : null,
      {
        fileName: "src/a.ts",
        changes: [
          { operation: "update", path: "src/a.ts" },
          { operation: "add", path: "src/b.ts" },
          { operation: "rename", path: "src/d.ts", oldPath: "src/c.ts" },
          { operation: "delete", path: "src/e.ts" },
        ],
        written: undefined,
      },
    );
  });

  it("says an edit's files are unknown when its input names none", () => {
    const item = patchItem({ patchText: "not a patch" });
    assert.deepEqual(
      item.type === "file_change"
        ? { fileName: item.fileName, written: item.agentWrittenPaths }
        : null,
      { fileName: "apply_patch", written: [] },
    );
  });

  it("keeps the path an edit tool names", () => {
    const item = openCodeToolTurnItem(base, {
      name: "edit",
      input: { filePath: "/repo/src/a.ts", oldString: "a", newString: "b" },
      output: undefined,
      completedMetadata: {},
    });
    assert.deepEqual(
      item.type === "file_change"
        ? { fileName: item.fileName, written: item.agentWrittenPaths }
        : null,
      { fileName: "/repo/src/a.ts", written: undefined },
    );
  });
});
