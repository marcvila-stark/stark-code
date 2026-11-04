import type { OrchestrationV2ProposedFileChange } from "@starkfuture/contracts";
import { fileBasename, isAbsolutePath, workspaceRelativeFilePath } from "@starkfuture/shared/path";

/** One file a pending file-change approval would write, ready for the approval card. */
export interface ProposedFileChangeView {
  /** The provider's own path, shown under Technical details. */
  readonly path: string;
  readonly oldPath?: string;
  /** Relative to the chat's folder when inside it; the provider's path otherwise. */
  readonly displayPath: string;
  readonly oldDisplayPath?: string;
  readonly operation: string;
  /** Short label for the file row: Create, Edit, Delete, Rename or Change. */
  readonly operationLabel: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
  readonly patchTruncated: boolean;
  readonly approximate: boolean;
}

export interface ProposedFileChangesSummary {
  /** What the approval would do, for the card's lead line: "Edits a.ts", "Changes 3 files". */
  readonly headline: string;
  readonly files: ReadonlyArray<ProposedFileChangeView>;
  /** Files the provider named that the preview leaves out. */
  readonly omitted: number;
  /** Why the preview is incomplete, shown beside it. Empty when it shows everything. */
  readonly warnings: ReadonlyArray<string>;
}

const VERBS: Readonly<Record<string, string>> = {
  add: "Creates",
  update: "Edits",
  delete: "Deletes",
  rename: "Renames",
};

const LABELS: Readonly<Record<string, string>> = {
  add: "Create",
  update: "Edit",
  delete: "Delete",
  rename: "Rename",
};

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function patchLines(patch: string): ReadonlyArray<string> {
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Walks a unified diff hunk by hunk, using each header's counts to tell body
 * lines from file headers, so a removed line that starts with `--` is still a
 * removal. A malformed header ends the hunk at the next `@@`.
 */
function forEachPatchLine(
  patch: string,
  visit: (kind: PatchPreviewRow["kind"] | "header", line: string, index: number) => void,
): void {
  let oldLeft = 0;
  let newLeft = 0;
  let inMalformedHunk = false;
  for (const [index, line] of patchLines(patch).entries()) {
    const inHunk = oldLeft > 0 || newLeft > 0 || inMalformedHunk;
    if (line.startsWith("@@")) {
      const match = HUNK_HEADER.exec(line);
      oldLeft = match === null ? 0 : Number(match[1] ?? "1");
      newLeft = match === null ? 0 : Number(match[2] ?? "1");
      inMalformedHunk = match === null;
      visit("hunk", line, index);
    } else if (line.startsWith("\\")) {
      visit("note", line.slice(1).trim(), index);
    } else if (!inHunk) {
      visit("header", line, index);
    } else if (line.startsWith("+")) {
      newLeft = Math.max(0, newLeft - 1);
      visit("add", line, index);
    } else if (line.startsWith("-")) {
      oldLeft = Math.max(0, oldLeft - 1);
      visit("remove", line, index);
    } else {
      oldLeft = Math.max(0, oldLeft - 1);
      newLeft = Math.max(0, newLeft - 1);
      visit("context", line, index);
    }
  }
}

function patchLineCounts(patch: string | undefined) {
  let additions = 0;
  let deletions = 0;
  if (patch !== undefined) {
    forEachPatchLine(patch, (kind) => {
      if (kind === "add") additions += 1;
      else if (kind === "remove") deletions += 1;
    });
  }
  return { additions, deletions };
}

function displayPath(path: string, cwd: string | null | undefined): string {
  const relative = workspaceRelativeFilePath(path, cwd);
  return relative === null || relative === "." ? path : relative;
}

function headlineFor(files: ReadonlyArray<ProposedFileChangeView>, omitted: number): string {
  const total = files.length + omitted;
  const [first] = files;
  if (total === 1 && first !== undefined) {
    const name = fileBasename(first.displayPath);
    if (first.operation === "rename" && first.oldDisplayPath !== undefined) {
      const oldName = fileBasename(first.oldDisplayPath);
      return oldName === name
        ? `Moves ${name} to ${first.displayPath}`
        : `Renames ${oldName} to ${name}`;
    }
    return `${VERBS[first.operation] ?? "Changes"} ${name}`;
  }
  const operation = first?.operation;
  const sameOperation =
    omitted === 0 && operation !== undefined && files.every((file) => file.operation === operation);
  const verb = sameOperation ? (VERBS[operation] ?? "Changes") : "Changes";
  return `${verb} ${plural(total, "file")}`;
}

/** Paths a file writes or moves from, so a rename is judged by both ends. */
const filePaths = (file: ProposedFileChangeView) =>
  file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];

/** A `..` segment hides where a path really points, so the card asks for a look. */
const climbsUp = (path: string) => path.replaceAll("\\", "/").split("/").includes("..");

function warningsFor(
  files: ReadonlyArray<ProposedFileChangeView>,
  omitted: number,
  cwd: string | null | undefined,
): ReadonlyArray<string> {
  const warnings: string[] = [];
  const outside = cwd
    ? files
        .flatMap(filePaths)
        .filter((path) => isAbsolutePath(path) && workspaceRelativeFilePath(path, cwd) === null)
    : [];
  if (outside.length > 0) {
    warnings.push(
      outside.length === 1
        ? `${fileBasename(outside[0]!)} is outside this chat's folder.`
        : `${plural(outside.length, "path")} are outside this chat's folder.`,
    );
  }
  if (files.some((file) => filePaths(file).some(climbsUp))) {
    warnings.push('A path contains "..", so check where it points.');
  }
  const withoutDiff = files.filter((file) => file.patch === undefined);
  if (withoutDiff.length > 0) {
    warnings.push(
      files.length === 1
        ? "No diff for this file."
        : withoutDiff.length === 1
          ? `No diff for ${fileBasename(withoutDiff[0]!.displayPath)}.`
          : `No diff for ${plural(withoutDiff.length, "file")}.`,
    );
  }
  if (files.some((file) => file.patchTruncated)) {
    warnings.push(files.length === 1 ? "Diff shortened." : "Some diffs are shortened.");
  }
  if (files.some((file) => file.approximate)) {
    warnings.push("Built from the agent's edit, so line numbers may differ.");
  }
  if (omitted > 0) warnings.push(`${plural(omitted, "more file")} not shown.`);
  return warnings;
}

/**
 * Turns an approval's proposed changes into what its card shows: a headline,
 * one row per file with paths relative to the chat's folder and +/− counts,
 * and the warnings that say what the preview leaves out. Null when the
 * approval names no files.
 */
export function summarizeProposedChanges(
  changes: ReadonlyArray<OrchestrationV2ProposedFileChange> | undefined,
  omitted: number | undefined,
  cwd: string | null | undefined,
): ProposedFileChangesSummary | null {
  if (changes === undefined || changes.length === 0) return null;
  const files = changes.map((change): ProposedFileChangeView => {
    const oldDisplayPath =
      change.oldPath === undefined ? undefined : displayPath(change.oldPath, cwd);
    return {
      path: change.path,
      ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
      displayPath: displayPath(change.path, cwd),
      ...(oldDisplayPath === undefined ? {} : { oldDisplayPath }),
      operation: change.operation,
      operationLabel: LABELS[change.operation] ?? "Change",
      ...patchLineCounts(change.patch),
      ...(change.patch === undefined ? {} : { patch: change.patch }),
      patchTruncated: change.patchTruncated === true,
      approximate: change.approximate === true,
    };
  });
  const hidden = omitted ?? 0;
  return {
    headline: headlineFor(files, hidden),
    files,
    omitted: hidden,
    warnings: warningsFor(files, hidden, cwd),
  };
}

export interface PatchPreviewRow {
  readonly kind: "hunk" | "add" | "remove" | "context" | "note";
  readonly text: string;
  /** The row's line in the patch, which also keys it in a list. */
  readonly line: number;
}

/**
 * A patch as plain rows for a text preview, without its file headers. Rows
 * past `maxRows` are counted in `hiddenRows` so the caller can offer more.
 */
export function patchPreviewRows(
  patch: string,
  maxRows = Number.POSITIVE_INFINITY,
): { readonly rows: ReadonlyArray<PatchPreviewRow>; readonly hiddenRows: number } {
  const rows: PatchPreviewRow[] = [];
  let hiddenRows = 0;
  forEachPatchLine(patch, (kind, text, index) => {
    if (kind === "header") return;
    if (rows.length < maxRows) rows.push({ kind, text, line: index + 1 });
    else hiddenRows += 1;
  });
  return { rows, hiddenRows };
}
