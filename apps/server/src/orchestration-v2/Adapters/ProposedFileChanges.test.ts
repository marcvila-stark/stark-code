// @effect-diagnostics nodeBuiltinImport:off - the race hooks swap folders from
// inside the Promise-based file operations the preview read calls.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  boundProposedChanges,
  claudeProposedFileChange,
  claudeProposedFileChanges,
  nodePreviewFileOperations,
  type PreviewFileOperations,
  PROPOSED_PATCH_MAX_BYTES,
  PROPOSED_PREVIEW_READ_MAX_BYTES,
  proposedChangesFromCodexItem,
  proposedChangesFromCodexLegacy,
  readProposedChangeTarget,
  truncatePatch,
} from "./ProposedFileChanges.ts";

const FILE = "/work/src/app.ts";
const TEN_LINES = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

describe("proposedChangesFromCodexItem", () => {
  it("maps adds, deletes, updates and renames to patches with file headers", () => {
    const { proposedChanges, proposedChangesOmitted } = proposedChangesFromCodexItem([
      { path: "/work/new.md", kind: { type: "add" }, diff: "hello\nworld" },
      { path: "/work/old.md", kind: { type: "delete" }, diff: "bye\n" },
      { path: "/work/a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
      {
        path: "/work/b.ts",
        kind: { type: "update", move_path: "/work/c.ts" },
        diff: "--- /work/b.ts\n+++ /work/c.ts\n@@ -1 +1 @@\n-x\n+y\n",
      },
    ]);
    assert.isUndefined(proposedChangesOmitted);
    assert.deepEqual(proposedChanges, [
      {
        path: "/work/new.md",
        operation: "add",
        patch:
          "--- /dev/null\n+++ /work/new.md\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n",
      },
      {
        path: "/work/old.md",
        operation: "delete",
        patch: "--- /work/old.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n",
      },
      {
        path: "/work/a.ts",
        operation: "update",
        patch: "--- /work/a.ts\n+++ /work/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      },
      {
        path: "/work/c.ts",
        operation: "rename",
        oldPath: "/work/b.ts",
        patch: "--- /work/b.ts\n+++ /work/c.ts\n@@ -1 +1 @@\n-x\n+y\n",
      },
    ]);
  });

  it("keeps the path without a patch when the diff holds no hunk", () => {
    assert.deepEqual(
      proposedChangesFromCodexItem([
        { path: "/work/a.ts", kind: { type: "update" }, diff: "not a diff" },
        { path: "/work/empty.md", kind: { type: "add" }, diff: "" },
      ]).proposedChanges,
      [
        { path: "/work/a.ts", operation: "update" },
        { path: "/work/empty.md", operation: "add" },
      ],
    );
  });

  it("maps the legacy applyPatchApproval file map in path order", () => {
    assert.deepEqual(
      proposedChangesFromCodexLegacy({
        "/work/z.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-1\n+2", move_path: null },
        "/work/a.md": { type: "add", content: "new\n" },
        "/work/m.ts": {
          type: "update",
          unified_diff: "@@ -1 +1 @@\n-x\n+y\n",
          move_path: "/work/n.ts",
        },
      }).proposedChanges,
      [
        {
          path: "/work/a.md",
          operation: "add",
          patch: "--- /dev/null\n+++ /work/a.md\n@@ -0,0 +1,1 @@\n+new\n",
        },
        {
          path: "/work/n.ts",
          operation: "rename",
          oldPath: "/work/m.ts",
          patch: "--- /work/m.ts\n+++ /work/n.ts\n@@ -1 +1 @@\n-x\n+y\n",
        },
        {
          path: "/work/z.ts",
          operation: "update",
          patch: "--- /work/z.ts\n+++ /work/z.ts\n@@ -1 +1 @@\n-1\n+2\n",
        },
      ],
    );
  });
});

describe("boundProposedChanges", () => {
  it("keeps 20 files and counts the rest", () => {
    const changes = Array.from({ length: 23 }, (_, index) => ({
      path: `/work/${index}.ts`,
      operation: "update",
    }));
    const bounded = boundProposedChanges(changes);
    assert.lengthOf(bounded.proposedChanges ?? [], 20);
    assert.equal(bounded.proposedChangesOmitted, 3);
    assert.deepEqual(boundProposedChanges([]), {});
  });

  it("shortens a large patch to whole lines with a recounted hunk header", () => {
    const body = Array.from({ length: 4000 }, (_, index) => `+added line ${index}`).join("\n");
    const patch = `--- ${FILE}\n+++ ${FILE}\n@@ -1,0 +1,4000 @@\n${body}\n`;
    const [change] = boundProposedChanges([
      { path: FILE, operation: "update", patch },
    ]).proposedChanges!;
    assert.isTrue(change?.patchTruncated);
    const shortened = change?.patch ?? "";
    assert.isAtMost(Buffer.byteLength(shortened), PROPOSED_PATCH_MAX_BYTES);
    const lines = shortened.trimEnd().split("\n");
    const kept = lines.slice(3);
    assert.equal(lines[2], `@@ -1,0 +1,${kept.length} @@`);
    assert.isTrue(kept.every((line) => line.startsWith("+added line ")));
  });

  it("drops later patches once the total budget is spent", () => {
    const hunk = (index: number) =>
      `@@ -${index},1 +${index},1 @@\n-${"x".repeat(1000)}\n+${"y".repeat(1000)}`;
    const patch = `--- ${FILE}\n+++ ${FILE}\n${Array.from({ length: 7 }, (_, index) => hunk(index + 1)).join("\n")}\n`;
    const changes = Array.from({ length: 6 }, (_, index) => ({
      path: `/work/${index}.ts`,
      operation: "update",
      patch,
    }));
    const bounded = boundProposedChanges(changes).proposedChanges ?? [];
    assert.isTrue(bounded.slice(0, 4).every((change) => change.patch === patch));
    assert.isTrue(bounded[4]?.patchTruncated);
    assert.isDefined(bounded[4]?.patch);
    assert.isUndefined(bounded[5]?.patch);
    assert.isTrue(bounded[5]?.patchTruncated);
  });

  it("returns nothing when no hunk line fits", () => {
    assert.isUndefined(truncatePatch(`--- a\n+++ a\n@@ -1 +1 @@\n+${"z".repeat(200)}\n`, 64));
  });
});

describe("claudeProposedFileChange", () => {
  const text = (value: string) => ({ type: "text" as const, text: value });

  it("diffs an Edit against the file with real line numbers", () => {
    const change = claudeProposedFileChange({
      toolName: "Edit",
      toolInput: { file_path: FILE, old_string: "line 7\n", new_string: "line seven\n" },
      target: text(TEN_LINES),
    });
    assert.deepEqual(change, {
      path: FILE,
      operation: "update",
      patch: `--- ${FILE}\n+++ ${FILE}\n@@ -4,7 +4,7 @@\n line 4\n line 5\n line 6\n-line 7\n+line seven\n line 8\n line 9\n line 10\n`,
    });
  });

  it.each([
    ["the text is not in the file", "line 70", TEN_LINES],
    ["the text matches more than once", "line", TEN_LINES],
  ])("falls back to an approximate preview when %s", (_label, oldString, file) => {
    const change = claudeProposedFileChange({
      toolName: "Edit",
      toolInput: { file_path: FILE, old_string: oldString, new_string: "new" },
      target: text(file),
    });
    assert.deepEqual(change, {
      path: FILE,
      operation: "update",
      approximate: true,
      patch: `--- ${FILE}\n+++ ${FILE}\n@@ -1,1 +1,1 @@\n-${oldString}\n+new\n`,
    });
  });

  it("previews from the edit text when the file could not be read", () => {
    const change = claudeProposedFileChange({
      toolName: "MultiEdit",
      toolInput: {
        file_path: FILE,
        edits: [
          { old_string: "a\nb", new_string: "c" },
          { old_string: "d", new_string: "" },
        ],
      },
      target: { type: "unavailable" },
    });
    assert.deepEqual(change, {
      path: FILE,
      operation: "update",
      approximate: true,
      patch: `--- ${FILE}\n+++ ${FILE}\n@@ -1,2 +1,1 @@\n-a\n-b\n+c\n@@ -3,1 +1,0 @@\n-d\n`,
    });
  });

  it("applies MultiEdit edits in order", () => {
    const change = claudeProposedFileChange({
      toolName: "MultiEdit",
      toolInput: {
        file_path: FILE,
        edits: [
          { old_string: "line 2", new_string: "line two" },
          { old_string: "line two", new_string: "line 2b" },
        ],
      },
      target: text("line 1\nline 2\nline 3\n"),
    });
    assert.equal(change?.approximate, undefined);
    assert.include(change?.patch, "-line 2\n+line 2b\n");
  });

  it("replaces every match literally with replace_all", () => {
    const change = claudeProposedFileChange({
      toolName: "Edit",
      toolInput: { file_path: FILE, old_string: "cost", new_string: "$&$1", replace_all: true },
      target: text("cost\nfree\ncost\n"),
    });
    assert.include(change?.patch, "-cost\n+$&$1\n free\n-cost\n+$&$1\n");
  });

  it("creates a file from Write or an Edit with no old text when nothing is there", () => {
    assert.deepEqual(
      claudeProposedFileChange({
        toolName: "Write",
        toolInput: { file_path: "/work/notes.md", content: "hello\n" },
        target: { type: "missing" },
      }),
      {
        path: "/work/notes.md",
        operation: "add",
        patch: "--- /dev/null\n+++ /work/notes.md\n@@ -0,0 +1,1 @@\n+hello\n",
      },
    );
    assert.equal(
      claudeProposedFileChange({
        toolName: "Edit",
        toolInput: { file_path: "/work/notes.md", old_string: "", new_string: "hello\n" },
        target: { type: "missing" },
      })?.operation,
      "add",
    );
  });

  it("diffs a Write against the existing file", () => {
    const change = claudeProposedFileChange({
      toolName: "Write",
      toolInput: { file_path: FILE, content: TEN_LINES.replace("line 1\n", "") },
      target: text(TEN_LINES),
    });
    assert.equal(change?.operation, "update");
    assert.isUndefined(change?.approximate);
    assert.include(change?.patch, "@@ -1,4 +1,3 @@\n-line 1\n line 2\n");
  });

  it("marks a Write over an unreadable file as approximate", () => {
    assert.deepEqual(
      claudeProposedFileChange({
        toolName: "Write",
        toolInput: { file_path: FILE, content: "a\n" },
        target: { type: "unavailable" },
      }),
      {
        path: FILE,
        operation: "update",
        approximate: true,
        patch: `--- ${FILE}\n+++ ${FILE}\n@@ -0,0 +1,1 @@\n+a\n`,
      },
    );
  });

  it("keeps only the path for NotebookEdit and ignores other tools", () => {
    assert.deepEqual(
      claudeProposedFileChange({
        toolName: "NotebookEdit",
        toolInput: { notebook_path: "/work/a.ipynb", new_source: "print(1)" },
        target: { type: "unavailable" },
      }),
      { path: "/work/a.ipynb", operation: "update" },
    );
    assert.isUndefined(
      claudeProposedFileChange({
        toolName: "Bash",
        toolInput: { command: "ls" },
        target: { type: "unavailable" },
      }),
    );
  });
});

describe("readProposedChangeTarget", () => {
  const workspace = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "stark-proposed-" });
    const cwd = path.join(root, "repo");
    yield* fileSystem.makeDirectory(cwd);
    return { fileSystem, path, root, cwd };
  });

  it.effect("reads a regular text file inside the folder and reports a missing one", () =>
    Effect.gen(function* () {
      const { fileSystem, path, cwd } = yield* workspace;
      const file = path.join(cwd, "a.ts");
      yield* fileSystem.writeFileString(file, "export {};\n");
      assert.deepEqual(yield* readProposedChangeTarget({ path: file, cwd }), {
        type: "text",
        text: "export {};\n",
      });
      assert.deepEqual(yield* readProposedChangeTarget({ path: path.join(cwd, "b.ts"), cwd }), {
        type: "missing",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not read outside the folder, through a symlink, a second link or special files",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, root, cwd } = yield* workspace;
        const outside = path.join(root, "secret.txt");
        yield* fileSystem.writeFileString(outside, "token\n");
        const link = path.join(cwd, "link.txt");
        yield* fileSystem.symlink(outside, link);
        const hardLink = path.join(cwd, "hard.txt");
        yield* fileSystem.link(outside, hardLink);
        const large = path.join(cwd, "large.txt");
        yield* fileSystem.writeFileString(large, "x".repeat(PROPOSED_PREVIEW_READ_MAX_BYTES + 1));
        const binary = path.join(cwd, "image.bin");
        yield* fileSystem.writeFile(binary, new Uint8Array([0x89, 0x00, 0x01]));
        for (const target of [outside, link, hardLink, large, binary, cwd, "relative.ts"]) {
          assert.deepEqual(yield* readProposedChangeTarget({ path: target, cwd }), {
            type: "unavailable",
          });
        }
        assert.deepEqual(yield* readProposedChangeTarget({ path: outside, cwd: null }), {
          type: "unavailable",
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not follow a symlink that stays inside the folder", () =>
    Effect.gen(function* () {
      const { fileSystem, path, cwd } = yield* workspace;
      const folder = path.join(cwd, "src");
      const file = path.join(folder, "a.ts");
      yield* fileSystem.makeDirectory(folder);
      yield* fileSystem.writeFileString(file, "export {};\n");
      const fileLink = path.join(cwd, "alias.ts");
      yield* fileSystem.symlink(file, fileLink);
      const folderLink = path.join(cwd, "linked");
      yield* fileSystem.symlink(folder, folderLink);
      for (const target of [fileLink, path.join(folderLink, "a.ts")]) {
        assert.deepEqual(yield* readProposedChangeTarget({ path: target, cwd }), {
          type: "unavailable",
        });
      }
      assert.deepEqual(yield* readProposedChangeTarget({ path: file, cwd }), {
        type: "text",
        text: "export {};\n",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Each case stands in for another process swapping a checked folder for a
  // symlink out of the folder: left in place from the target check on, or only
  // for as long as the target is being opened.
  it.effect.each([
    { label: "from the target check on", step: "lstat" },
    { label: "while the target is opened", step: "open" },
  ] as const)("does not read through a folder replaced by a symlink $label", ({ step }) =>
    Effect.gen(function* () {
      const { fileSystem, path, root, cwd } = yield* workspace;
      const folder = path.join(cwd, "src");
      const file = path.join(folder, "a.ts");
      yield* fileSystem.makeDirectory(folder);
      yield* fileSystem.writeFileString(file, "export {};\n");
      const outside = path.join(root, "outside");
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(path.join(outside, "a.ts"), "token\n");

      let armed = false;
      let folderChecked = false;
      let swaps = 0;
      const swapOut = async () => {
        if (!armed || !folderChecked || swaps > 0) return false;
        swaps += 1;
        await NodeFSP.rename(folder, `${folder}-moved`);
        await NodeFSP.symlink(outside, folder);
        return true;
      };
      const swapBack = async () => {
        await NodeFSP.unlink(folder);
        await NodeFSP.rename(`${folder}-moved`, folder);
      };
      const fileOperations: PreviewFileOperations = {
        ...nodePreviewFileOperations,
        lstat: async (target) => {
          if (step === "lstat" && target.endsWith(`${path.sep}a.ts`)) await swapOut();
          const stat = await nodePreviewFileOperations.lstat(target);
          if (armed && target.endsWith(`${path.sep}src`)) folderChecked = true;
          return stat;
        },
        open: async (target, flags) => {
          const swapped = step === "open" && (await swapOut());
          const handle = await nodePreviewFileOperations.open(target, flags);
          if (swapped) await swapBack();
          return handle;
        },
      };

      assert.deepEqual(yield* readProposedChangeTarget({ path: file, cwd, fileOperations }), {
        type: "text",
        text: "export {};\n",
      });
      armed = true;
      assert.deepEqual(yield* readProposedChangeTarget({ path: file, cwd, fileOperations }), {
        type: "unavailable",
      });
      assert.equal(swaps, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is unavailable whatever the file system throws", () =>
    Effect.gen(function* () {
      const { fileSystem, path, cwd } = yield* workspace;
      const file = path.join(cwd, "a.ts");
      yield* fileSystem.writeFileString(file, "export {};\n");
      const failures: ReadonlyArray<Partial<PreviewFileOperations>> = [
        {
          realpath: () => {
            throw new Error("realpath failed");
          },
        },
        { lstat: () => Promise.reject("not an error") },
        { open: () => Promise.reject(Object.assign(new Error("loop"), { code: "ELOOP" })) },
      ];
      for (const failure of failures) {
        const fileOperations = { ...nodePreviewFileOperations, ...failure };
        assert.deepEqual(yield* readProposedChangeTarget({ path: file, cwd, fileOperations }), {
          type: "unavailable",
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("builds a Claude preview from the file it read", () =>
    Effect.gen(function* () {
      const { fileSystem, path, cwd } = yield* workspace;
      const file = path.join(cwd, "a.ts");
      yield* fileSystem.writeFileString(file, TEN_LINES);
      const fields = yield* claudeProposedFileChanges({
        toolName: "Edit",
        toolInput: { file_path: file, old_string: "line 9", new_string: "line nine" },
        cwd,
      });
      assert.include(fields.proposedChanges?.[0]?.patch, "@@ -6,5 +6,5 @@");
      assert.isUndefined(fields.proposedChanges?.[0]?.approximate);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("previews an Edit through a symlink from the edit text", () =>
    Effect.gen(function* () {
      const { fileSystem, path, cwd } = yield* workspace;
      const file = path.join(cwd, "a.ts");
      yield* fileSystem.writeFileString(file, TEN_LINES);
      const alias = path.join(cwd, "alias.ts");
      yield* fileSystem.symlink(file, alias);
      const fields = yield* claudeProposedFileChanges({
        toolName: "Edit",
        toolInput: { file_path: alias, old_string: "line 9", new_string: "line nine" },
        cwd,
      });
      assert.deepEqual(fields.proposedChanges, [
        {
          path: alias,
          operation: "update",
          approximate: true,
          patch: `--- ${alias}\n+++ ${alias}\n@@ -1,1 +1,1 @@\n-line 9\n+line nine\n`,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
