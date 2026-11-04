import { describe, expect, it } from "vite-plus/test";

import { patchPreviewRows, summarizeProposedChanges } from "./proposedFileChanges.ts";

const editPatch = [
  "--- /work/src/a.ts",
  "+++ /work/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "---flag",
  "+++flag",
  " tail",
  "",
].join("\n");

describe("summarizeProposedChanges", () => {
  it("leads with the action on one file and counts lines, even ones that look like headers", () => {
    const summary = summarizeProposedChanges(
      [{ path: "/work/src/a.ts", operation: "update", patch: editPatch }],
      undefined,
      "/work",
    );
    expect(summary?.headline).toBe("Edits a.ts");
    expect(summary?.files).toEqual([
      {
        path: "/work/src/a.ts",
        displayPath: "src/a.ts",
        operation: "update",
        operationLabel: "Edit",
        additions: 1,
        deletions: 1,
        patch: editPatch,
        patchTruncated: false,
        approximate: false,
      },
    ]);
    expect(summary?.warnings).toEqual([]);
  });

  it("names created, deleted and renamed files", () => {
    const headline = (change: Parameters<typeof summarizeProposedChanges>[0]) =>
      summarizeProposedChanges(change, undefined, "/work")?.headline;
    expect(headline([{ path: "/work/notes.md", operation: "add" }])).toBe("Creates notes.md");
    expect(headline([{ path: "/work/old.md", operation: "delete" }])).toBe("Deletes old.md");
    expect(
      headline([{ path: "/work/src/b.ts", operation: "rename", oldPath: "/work/src/a.ts" }]),
    ).toBe("Renames a.ts to b.ts");
    expect(
      headline([{ path: "/work/lib/a.ts", operation: "rename", oldPath: "/work/src/a.ts" }]),
    ).toBe("Moves a.ts to lib/a.ts");
    expect(headline([{ path: "/work/a.ts", operation: "chmod" }])).toBe("Changes a.ts");
  });

  it("counts every file the provider named and says what the preview leaves out", () => {
    const summary = summarizeProposedChanges(
      [
        { path: "/work/a.ts", operation: "update", patch: editPatch, patchTruncated: true },
        { path: "/work/b.ts", operation: "update", patch: editPatch, approximate: true },
        { path: "/elsewhere/c.ipynb", operation: "update" },
      ],
      2,
      "/work",
    );
    expect(summary?.headline).toBe("Changes 5 files");
    expect(summary?.files.map((file) => file.displayPath)).toEqual([
      "a.ts",
      "b.ts",
      "/elsewhere/c.ipynb",
    ]);
    expect(summary?.omitted).toBe(2);
    expect(summary?.warnings).toEqual([
      "c.ipynb is outside this chat's folder.",
      "No diff for c.ipynb.",
      "Some diffs are shortened.",
      "Built from the agent's edit, so line numbers may differ.",
      "2 more files not shown.",
    ]);
  });

  it("warns when a file is outside the chat's folder or its path steps up with ..", () => {
    const warnings = (
      changes: Parameters<typeof summarizeProposedChanges>[0],
      cwd: string | null = "/work",
    ) => summarizeProposedChanges(changes, undefined, cwd)?.warnings;
    expect(warnings([{ path: "/work/b.ts", operation: "rename", oldPath: "/etc/a.ts" }])).toContain(
      "a.ts is outside this chat's folder.",
    );
    expect(
      warnings([
        { path: "/tmp/a.ts", operation: "add" },
        { path: "/tmp/b.ts", operation: "add" },
      ]),
    ).toContain("2 paths are outside this chat's folder.");
    expect(warnings([{ path: "/work/../etc/hosts", operation: "update" }])).toContain(
      'A path contains "..", so check where it points.',
    );
    // Without a folder to compare against, nothing is called outside it.
    expect(warnings([{ path: "/tmp/a.ts", operation: "add" }], null)).toEqual([
      "No diff for this file.",
    ]);
  });

  it("uses one verb when every file shares it, and nothing for no files", () => {
    expect(
      summarizeProposedChanges(
        [
          { path: "/work/a.ts", operation: "add" },
          { path: "/work/b.ts", operation: "add" },
        ],
        undefined,
        null,
      )?.headline,
    ).toBe("Creates 2 files");
    expect(summarizeProposedChanges([], undefined, "/work")).toBeNull();
    expect(summarizeProposedChanges(undefined, undefined, "/work")).toBeNull();
  });
});

describe("patchPreviewRows", () => {
  it("drops file headers, keeps hunks and caps the rows it returns", () => {
    const patch = `${editPatch}\\ No newline at end of file\n`;
    expect(patchPreviewRows(patch)).toEqual({
      rows: [
        { kind: "hunk", text: "@@ -1,3 +1,3 @@", line: 3 },
        { kind: "context", text: " keep", line: 4 },
        { kind: "remove", text: "---flag", line: 5 },
        { kind: "add", text: "+++flag", line: 6 },
        { kind: "context", text: " tail", line: 7 },
        { kind: "note", text: "No newline at end of file", line: 8 },
      ],
      hiddenRows: 0,
    });
    const capped = patchPreviewRows(patch, 2);
    expect(capped.rows).toHaveLength(2);
    expect(capped.hiddenRows).toBe(4);
  });
});
