import { RuntimeRequestId } from "@starkfuture/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { type PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

// The diff renderer draws into a shadow root; the card's logic only decides which parsed file it gets.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string } }) => (
    <span aria-label="Rendered diff">{fileDiff.name}</span>
  ),
}));
// Browser worker startup is verified in the live client; these tests exercise card state.
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const patch = (path: string, from: string, to: string) =>
  `--- ${path}\n+++ ${path}\n@@ -1,2 +1,2 @@\n keep\n-${from}\n+${to}\n`;

const codexPatch: PendingApproval = {
  requestId: RuntimeRequestId.make("codex-patch"),
  requestKind: "file-change",
  createdAt: "2026-10-29T00:00:00Z",
  detail: "Codex wants to edit files",
  responseCapability: "live",
  proposedChanges: [
    { path: "/work/src/a.ts", operation: "update", patch: patch("/work/src/a.ts", "a", "b") },
    {
      path: "/work/src/b.ts",
      operation: "update",
      patch: patch("/work/src/b.ts", "x", "y"),
      approximate: true,
    },
    { path: "/work/notes.ipynb", operation: "update" },
  ],
  proposedChangesOmitted: 1,
};

const render = (approval: PendingApproval) =>
  act(() => {
    renderer = create(
      <ComposerPendingApprovalPanel approval={approval} pendingCount={1} cwd="/work" />,
    );
  });
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const labelled = (label: string) =>
  renderer!.root.findAll(
    (node) => typeof node.type === "string" && node.props["aria-label"] === label,
  );
const fileButton = (path: string) =>
  renderer!.root.find((node) => node.type === "button" && text(node).includes(path));

it("leads with the action, lists the files and shows the first file's diff", () => {
  render(codexPatch);
  const all = text(renderer!.root);
  expect(text(labelled("Proposed change")[0]!)).toBe("Changes 4 files");
  expect(all.indexOf("Changes 4 files")).toBeLessThan(all.indexOf("src/a.ts"));
  expect(text(labelled("Files to change")[0]!)).toContain("src/b.ts");
  expect(text(labelled("Rendered diff")[0]!)).toBe("/work/src/a.ts");
  expect(text(labelled("Preview warnings")[0]!)).toBe(
    "No diff for notes.ipynb. Built from the agent's edit, so line numbers may differ. 1 more file not shown.",
  );
  // The provider prompt and absolute paths wait behind Technical details.
  expect(all).not.toContain("Codex wants to edit files");
  expect(labelled("Technical details")).toHaveLength(0);
});

it("keeps a file name whole on a narrow card: the directory shortens, then the counts wrap", () => {
  const path = "/work/docs/guides/permissions/approval-flows/reference/approval-card-checklist.md";
  render({
    ...codexPatch,
    proposedChanges: [{ path, operation: "update", patch: patch(path, "a", "b") }],
    proposedChangesOmitted: 0,
  });
  const row = labelled("Files to change")[0]!.findByType("button");
  expect(row.props.className).toContain("flex-wrap");
  const name = row.find(
    (node) => typeof node.type === "string" && node.props.style?.minWidth !== undefined,
  );
  expect(name.props.style.minWidth).toBe("min(26ch, 100%)");
  expect(text(name)).toBe(
    "docs/guides/permissions/approval-flows/reference/approval-card-checklist.md",
  );
});

it("switches the diff to the file the user picks and keeps details one click away", () => {
  render(codexPatch);
  act(() => fileButton("src/b.ts").props.onClick());
  expect(text(labelled("Rendered diff")[0]!)).toBe("/work/src/b.ts");
  expect(fileButton("src/b.ts").props["aria-pressed"]).toBe(true);

  act(() => fileButton("notes.ipynb").props.onClick());
  expect(labelled("Rendered diff")).toHaveLength(0);

  const disclosure = renderer!.root.find(
    (node) => node.type === "button" && node.props["aria-expanded"] === false,
  );
  act(() => disclosure.props.onClick());
  const details = text(labelled("Technical details")[0]!);
  expect(details).toContain("Codex wants to edit files");
  expect(details).toContain("/work/src/b.ts (line numbers are approximate)");
  expect(details).toContain("/work/notes.ipynb (no diff)");
  expect(details).toContain("1 more file not listed by the preview.");
});

it("keeps the plain card when the approval names no files or cannot be answered", () => {
  const {
    proposedChanges: _proposedChanges,
    proposedChangesOmitted: _proposedChangesOmitted,
    ...withoutFiles
  } = codexPatch;
  render(withoutFiles);
  expect(labelled("Proposed change")).toHaveLength(0);
  expect(text(labelled("File change")[0]!)).toBe("Codex wants to edit files");

  act(() => renderer?.unmount());
  render({ ...codexPatch, responseCapability: "not_resumable" });
  expect(labelled("Proposed change")).toHaveLength(0);
  expect(text(labelled("File change")[0]!)).toContain("Provider process is gone");
});
