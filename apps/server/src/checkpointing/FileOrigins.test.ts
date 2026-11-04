import { describe, expect, it } from "vite-plus/test";

import {
  NodeId,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

import { attributeCheckpointFiles, collectTurnWriteEvidence } from "./FileOrigins.ts";

const file = (path: string) => ({ path, kind: "modified", additions: 1, deletions: 0 });

const originsOf = (input: {
  readonly files: ReadonlyArray<string>;
  readonly cwdSpellings: ReadonlyArray<string>;
  readonly repositoryRoot: string | null;
  readonly editedPaths: ReadonlyArray<string>;
  readonly possiblyEditedPaths?: ReadonlyArray<string>;
  readonly ranUnattributedWriters?: boolean;
}) =>
  Object.fromEntries(
    attributeCheckpointFiles({
      files: input.files.map(file),
      cwdSpellings: input.cwdSpellings,
      repositoryRoot: input.repositoryRoot,
      evidence: {
        editedPaths: input.editedPaths,
        possiblyEditedPaths: input.possiblyEditedPaths ?? [],
        ranUnattributedWriters: input.ranUnattributedWriters ?? false,
      },
    }).map((entry) => [entry.path, entry.origin]),
  );

describe("attributeCheckpointFiles", () => {
  it("matches absolute and relative edit paths to repository paths", () => {
    expect(
      originsOf({
        files: ["src/a.ts", "src/b.ts", "notes.md"],
        cwdSpellings: ["/repo"],
        repositoryRoot: "/repo",
        editedPaths: ["/repo/src/a.ts", "./src/../src/b.ts"],
      }),
    ).toEqual({ "src/a.ts": "agent", "src/b.ts": "agent", "notes.md": "outside" });
  });

  it("maps edits in a subfolder onto repository-root paths", () => {
    expect(
      originsOf({
        files: ["packages/app/index.ts", "index.ts", "packages/shared/util.ts"],
        cwdSpellings: ["/repo/packages/app"],
        repositoryRoot: "/repo",
        editedPaths: ["index.ts", "../shared/util.ts"],
      }),
    ).toEqual({
      "packages/app/index.ts": "agent",
      "index.ts": "outside",
      "packages/shared/util.ts": "agent",
    });
  });

  it("matches the folder through its resolved spelling", () => {
    // Git reports the root with symlinks resolved, tools report the folder as configured.
    expect(
      originsOf({
        files: ["app/plan.txt"],
        cwdSpellings: ["/var/work/app", "/private/var/work/app"],
        repositoryRoot: "/private/var/work",
        editedPaths: ["/var/work/app/plan.txt"],
      }),
    ).toEqual({ "app/plan.txt": "agent" });
  });

  it("calls files unknown when the turn ran commands that could have written them", () => {
    expect(
      originsOf({
        files: ["plan.txt", "new.txt"],
        cwdSpellings: ["/repo"],
        repositoryRoot: "/repo",
        editedPaths: ["plan.txt"],
        ranUnattributedWriters: true,
      }),
    ).toEqual({ "plan.txt": "agent", "new.txt": "unknown" });
  });

  it("calls files an unfinished edit was writing unknown", () => {
    expect(
      originsOf({
        files: ["src/a.ts", "src/b.ts", "notes.md"],
        cwdSpellings: ["/repo"],
        repositoryRoot: "/repo",
        editedPaths: ["src/b.ts"],
        possiblyEditedPaths: ["/repo/src/a.ts", "src/b.ts"],
      }),
    ).toEqual({ "src/a.ts": "unknown", "src/b.ts": "agent", "notes.md": "outside" });
  });

  it("handles Windows paths", () => {
    expect(
      originsOf({
        files: ["src/a.ts", "src/b.ts"],
        cwdSpellings: ["C:\\repo"],
        repositoryRoot: "C:/repo",
        editedPaths: ["C:\\repo\\src\\a.ts"],
      }),
    ).toEqual({ "src/a.ts": "agent", "src/b.ts": "outside" });
  });

  it("matches Windows drive letters in either case", () => {
    expect(
      originsOf({
        files: ["src/a.ts", "src/b.ts"],
        cwdSpellings: ["C:\\repo"],
        repositoryRoot: "C:/repo",
        editedPaths: ["c:\\repo\\src\\a.ts"],
      }),
    ).toEqual({ "src/a.ts": "agent", "src/b.ts": "outside" });
    expect(
      originsOf({
        files: ["app/src/a.ts"],
        cwdSpellings: ["c:\\repo\\app"],
        repositoryRoot: "C:/repo",
        editedPaths: ["src/a.ts"],
      }),
    ).toEqual({ "app/src/a.ts": "agent" });
  });
});

describe("collectTurnWriteEvidence", () => {
  const now = DateTime.makeUnsafe("2026-10-28T12:00:00.000Z");
  const base = (key: string, status: OrchestrationV2TurnItem["status"] = "completed") => ({
    id: TurnItemId.make(`item:${key}`),
    threadId: ThreadId.make("thread:evidence"),
    runId: RunId.make("run:evidence"),
    nodeId: NodeId.make("node:evidence"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  const tool = (toolName: string) =>
    ({ ...base(toolName), type: "dynamic_tool", toolName, input: {} }) as const;

  it("does not treat reading tools as writers", () => {
    expect(
      collectTurnWriteEvidence([tool("Read"), tool("Grep"), tool("Glob")]).ranUnattributedWriters,
    ).toBe(false);
  });

  it("treats commands and other tools that ran as possible writers", () => {
    expect(
      collectTurnWriteEvidence([{ ...base("bash"), type: "command_execution", input: "make" }])
        .ranUnattributedWriters,
    ).toBe(true);
    expect(collectTurnWriteEvidence([tool("mcp__files__write")]).ranUnattributedWriters).toBe(true);
  });

  it("ignores a command that waited for approval and never ran", () => {
    expect(
      collectTurnWriteEvidence([
        { ...base("declined", "waiting"), type: "command_execution", input: "rm -rf build" },
      ]).ranUnattributedWriters,
    ).toBe(false);
  });

  it("treats an edit that does not name its files as a possible writer", () => {
    // OpenCode labels an apply_patch it found no paths in with the tool's name.
    expect(
      collectTurnWriteEvidence([
        { ...base("patch"), type: "file_change", fileName: "apply_patch", agentWrittenPaths: [] },
      ]),
    ).toEqual({ editedPaths: [], possiblyEditedPaths: [], ranUnattributedWriters: true });
  });

  it("counts edits that started but did not complete as possible writers", () => {
    const edit = (key: string, status: OrchestrationV2TurnItem["status"], fileName: string) =>
      ({ ...base(key, status), type: "file_change", fileName }) as const;
    expect(
      collectTurnWriteEvidence([
        { ...edit("done", "completed", "/repo/a.ts"), agentWrittenPaths: ["/repo/a.ts"] },
        edit("failed", "failed", "/repo/b.ts"),
        // The turn stopped before these reported completion, after they may have written.
        edit("stopped", "interrupted", "/repo/c.ts"),
        edit("cancelled", "cancelled", "/repo/d.ts"),
        edit("running", "running", "/repo/e.ts"),
        // Never ran: still waiting for approval, or not started.
        edit("declined", "waiting", "/repo/f.ts"),
        edit("queued", "pending", "/repo/g.ts"),
      ]),
    ).toEqual({
      editedPaths: ["/repo/a.ts"],
      possiblyEditedPaths: ["/repo/b.ts", "/repo/c.ts", "/repo/d.ts", "/repo/e.ts"],
      ranUnattributedWriters: false,
    });
  });

  it("treats an unfinished edit that does not name its files as a possible writer", () => {
    expect(
      collectTurnWriteEvidence([
        {
          ...base("patch", "interrupted"),
          type: "file_change",
          fileName: "apply_patch",
          agentWrittenPaths: [],
        },
      ]).ranUnattributedWriters,
    ).toBe(true);
  });
});
