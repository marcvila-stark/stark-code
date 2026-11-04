// @effect-diagnostics nodeBuiltinImport:off - FileSystem does not expose the
// no-follow and non-blocking open flags a bounded preview read needs.
/**
 * Previews of the files a file-change approval would write, for the approval
 * card. Providers describe the change in their own shapes; these helpers turn
 * each into bounded `OrchestrationV2ProposedFileChange` entries.
 *
 * A preview never decides or delays the approval. Anything that cannot be read
 * or diffed falls back to a preview built from the agent's edit text (marked
 * `approximate`), or to the path alone.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { OrchestrationV2ProposedFileChange } from "@starkfuture/contracts";
import { acpToolCallDiffPatch } from "@starkfuture/provider-acp/server/adapter";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const PROPOSED_CHANGES_MAX_FILES = 20;
export const PROPOSED_PATCH_MAX_BYTES = 16 * 1024;
const PROPOSED_PATCHES_MAX_TOTAL_BYTES = 64 * 1024;
/** Files larger than this are previewed from the edit text instead of being read. */
export const PROPOSED_PREVIEW_READ_MAX_BYTES = 1024 * 1024;
const PROPOSED_PREVIEW_READ_TIMEOUT = "2 seconds";

/** The fields an approval_request item carries for its card; empty when nothing is known. */
export interface ProposedFileChangeFields {
  readonly proposedChanges?: ReadonlyArray<OrchestrationV2ProposedFileChange>;
  readonly proposedChangesOmitted?: number;
}

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

/** Text lines without the empty entry a trailing newline leaves. */
function textLines(text: string): ReadonlyArray<string> {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u;

/** A hunk header recounted for the body lines that were kept. */
function recountHunkHeader(header: string, body: ReadonlyArray<string>): string {
  const match = HUNK_HEADER.exec(header);
  if (match === null) return header;
  let oldCount = 0;
  let newCount = 0;
  for (const line of body) {
    if (line.startsWith(" ") || line === "") {
      oldCount += 1;
      newCount += 1;
    } else if (line.startsWith("-")) oldCount += 1;
    else if (line.startsWith("+")) newCount += 1;
  }
  return `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3] ?? ""}`;
}

/**
 * Shortens a unified diff to `maxBytes`, keeping its file headers and whole
 * hunks; the hunk that does not fit is cut and its header recounted, so the
 * result still parses. Undefined when not even one hunk line fits.
 */
export function truncatePatch(patch: string, maxBytes: number): string | undefined {
  if (byteLength(patch) <= maxBytes) return patch;
  const lines = [...textLines(patch)];
  const kept: Array<string> = [];
  let size = 0;
  let index = 0;
  while (index < lines.length && !lines[index]!.startsWith("@@")) {
    size += byteLength(lines[index]!) + 1;
    kept.push(lines[index]!);
    index += 1;
  }
  const headerCount = kept.length;
  while (index < lines.length) {
    const header = lines[index]!;
    index += 1;
    const body: Array<string> = [];
    while (index < lines.length && !lines[index]!.startsWith("@@")) {
      body.push(lines[index]!);
      index += 1;
    }
    const hunkSize = [header, ...body].reduce((total, line) => total + byteLength(line) + 1, 0);
    if (size + hunkSize <= maxBytes) {
      kept.push(header, ...body);
      size += hunkSize;
      continue;
    }
    // Room for the recounted header, whose counts can be longer than the original.
    let partialSize = size + byteLength(header) + 16;
    const partial: Array<string> = [];
    for (const line of body) {
      const lineSize = byteLength(line) + 1;
      if (partialSize + lineSize > maxBytes) break;
      partial.push(line);
      partialSize += lineSize;
    }
    if (partial.some((line) => line.startsWith("+") || line.startsWith("-"))) {
      kept.push(recountHunkHeader(header, partial), ...partial);
    }
    break;
  }
  return kept.length > headerCount ? `${kept.join("\n")}\n` : undefined;
}

/**
 * Caps a preview at 20 files, 16 KB per patch and 64 KB in all. A shortened or
 * dropped patch is marked `patchTruncated`; files past the cap are counted in
 * `proposedChangesOmitted`.
 */
export function boundProposedChanges(
  changes: ReadonlyArray<OrchestrationV2ProposedFileChange>,
): ProposedFileChangeFields {
  if (changes.length === 0) return {};
  let budget = PROPOSED_PATCHES_MAX_TOTAL_BYTES;
  const proposedChanges = changes.slice(0, PROPOSED_CHANGES_MAX_FILES).map((change) => {
    if (change.patch === undefined) return change;
    const { patch: _patch, patchTruncated: _truncated, ...rest } = change;
    const patch = truncatePatch(change.patch, Math.min(PROPOSED_PATCH_MAX_BYTES, budget));
    if (patch !== undefined) budget -= byteLength(patch);
    return {
      ...rest,
      ...(patch === undefined ? {} : { patch }),
      ...(patch !== change.patch || change.patchTruncated ? { patchTruncated: true as const } : {}),
    };
  });
  const omitted = changes.length - proposedChanges.length;
  return { proposedChanges, ...(omitted > 0 ? { proposedChangesOmitted: omitted } : {}) };
}

/** A created or deleted file's whole content as one hunk. */
function wholeFilePatch(
  path: string,
  content: string,
  operation: "add" | "delete",
): string | undefined {
  const lines = textLines(content);
  if (lines.length === 0) return undefined;
  const sign = operation === "add" ? "+" : "-";
  const header =
    operation === "add"
      ? `--- /dev/null\n+++ ${path}\n@@ -0,0 +1,${lines.length} @@`
      : `--- ${path}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@`;
  const noNewline = content.endsWith("\n") ? "" : "\\ No newline at end of file\n";
  return `${header}\n${lines.map((line) => `${sign}${line}`).join("\n")}\n${noNewline}`;
}

/** A provider's hunks with file headers; undefined when the text holds no hunk. */
function withFileHeaders(oldPath: string, newPath: string, diff: string): string | undefined {
  if (diff.startsWith("--- ") || diff.startsWith("diff --git ")) return diff;
  if (!textLines(diff).some((line) => line.startsWith("@@"))) return undefined;
  return `--- ${oldPath}\n+++ ${newPath}\n${diff.endsWith("\n") ? diff : `${diff}\n`}`;
}

function changeWithPatch(
  change: Omit<OrchestrationV2ProposedFileChange, "patch">,
  patch: string | undefined,
): OrchestrationV2ProposedFileChange {
  return patch === undefined ? change : { ...change, patch };
}

type CodexFileUpdateChange = CodexSchema.V2FileChangePatchUpdatedNotification__FileUpdateChange;

/**
 * Codex v2 `fileChange` changes (from `item/started` or `patchUpdated`). An add or
 * delete carries the file's content; an update carries unified diff hunks.
 */
export function proposedChangesFromCodexItem(
  changes: ReadonlyArray<CodexFileUpdateChange>,
): ProposedFileChangeFields {
  return boundProposedChanges(
    changes.flatMap((change): ReadonlyArray<OrchestrationV2ProposedFileChange> => {
      const path = change.path.trim();
      if (path.length === 0) return [];
      switch (change.kind.type) {
        case "add":
        case "delete":
          return [
            changeWithPatch(
              { path, operation: change.kind.type },
              wholeFilePatch(path, change.diff, change.kind.type),
            ),
          ];
        case "update": {
          const movePath = change.kind.move_path?.trim();
          return [
            movePath
              ? changeWithPatch(
                  { path: movePath, operation: "rename", oldPath: path },
                  withFileHeaders(path, movePath, change.diff),
                )
              : changeWithPatch(
                  { path, operation: "update" },
                  withFileHeaders(path, path, change.diff),
                ),
          ];
        }
      }
    }),
  );
}

/** The legacy `applyPatchApproval` file map, in path order. */
export function proposedChangesFromCodexLegacy(
  fileChanges: CodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"],
): ProposedFileChangeFields {
  return proposedChangesFromCodexItem(
    Object.entries(fileChanges)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([path, change]): CodexFileUpdateChange => {
        switch (change.type) {
          case "add":
          case "delete":
            return { path, kind: { type: change.type }, diff: change.content };
          case "update":
            return {
              path,
              kind: {
                type: "update",
                ...(change.move_path ? { move_path: change.move_path } : {}),
              },
              diff: change.unified_diff,
            };
        }
      }),
  );
}

/** What a bounded read found at a Claude edit's target. */
export type ProposedChangeTarget =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "missing" }
  | { readonly type: "unavailable" };

const UNAVAILABLE: ProposedChangeTarget = { type: "unavailable" };

interface ClaudeTextEdit {
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().replaceAll(/[\s_-]/gu, "");
}

function stringField(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function claudeTextEdit(input: unknown): ClaudeTextEdit | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const oldString = Reflect.get(input, "old_string");
  const newString = Reflect.get(input, "new_string");
  if (typeof oldString !== "string" || typeof newString !== "string") return undefined;
  return { oldString, newString, replaceAll: Reflect.get(input, "replace_all") === true };
}

function claudeTextEdits(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): ReadonlyArray<ClaudeTextEdit> | undefined {
  if (toolName === "edit") {
    const edit = claudeTextEdit(input);
    return edit === undefined ? undefined : [edit];
  }
  const edits = input.edits;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const parsed = edits.map(claudeTextEdit);
  return parsed.every((edit) => edit !== undefined) ? parsed : undefined;
}

/** The path a Claude file tool writes, as the agent named it. */
function claudeProposedChangePath(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const normalized = normalizedToolName(toolName);
  const path = stringField(input, normalized === "notebookedit" ? "notebook_path" : "file_path");
  return path?.trim() || undefined;
}

/**
 * Applies edits the way Claude's Edit tool does: each must match, and a match
 * that is not `replace_all` must be unique. Replacement is literal, so `$`
 * patterns in the new text stay as written.
 */
function applyClaudeEdits(text: string, edits: ReadonlyArray<ClaudeTextEdit>): string | undefined {
  let next = text;
  for (const edit of edits) {
    if (edit.oldString.length === 0) return undefined;
    const first = next.indexOf(edit.oldString);
    if (first === -1) return undefined;
    if (edit.replaceAll) {
      next = next.split(edit.oldString).join(edit.newString);
      continue;
    }
    if (next.indexOf(edit.oldString, first + edit.oldString.length) !== -1) return undefined;
    next = `${next.slice(0, first)}${edit.newString}${next.slice(first + edit.oldString.length)}`;
  }
  return next;
}

/**
 * A preview from the edit text alone, one hunk per edit. Its line numbers are
 * placeholders, so callers mark it `approximate`.
 */
function editTextPatch(path: string, edits: ReadonlyArray<ClaudeTextEdit>): string | undefined {
  let oldStart = 1;
  let newStart = 1;
  const hunks: Array<string> = [];
  for (const edit of edits) {
    const removed = textLines(edit.oldString);
    const added = textLines(edit.newString);
    if (removed.length === 0 && added.length === 0) continue;
    const oldHeader = `${removed.length === 0 ? oldStart - 1 : oldStart},${removed.length}`;
    const newHeader = `${added.length === 0 ? newStart - 1 : newStart},${added.length}`;
    hunks.push(
      [
        `@@ -${oldHeader} +${newHeader} @@`,
        ...removed.map((line) => `-${line}`),
        ...added.map((line) => `+${line}`),
      ].join("\n"),
    );
    oldStart += removed.length;
    newStart += added.length;
  }
  return hunks.length === 0 ? undefined : `--- ${path}\n+++ ${path}\n${hunks.join("\n")}\n`;
}

/** An exact diff of two texts; undefined when they match or the diff search is capped. */
function exactPatch(path: string, before: string | undefined, after: string): string | undefined {
  return acpToolCallDiffPatch([{ type: "diff", path, oldText: before, newText: after }]);
}

/**
 * The proposed change for a Claude Edit, MultiEdit, Write or NotebookEdit call,
 * given what a bounded read found at its target. NotebookEdit keeps only its
 * path. Undefined for other tools or a call without a path.
 */
export function claudeProposedFileChange(input: {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly target: ProposedChangeTarget;
}): OrchestrationV2ProposedFileChange | undefined {
  const toolName = normalizedToolName(input.toolName);
  const path = claudeProposedChangePath(input.toolName, input.toolInput);
  if (path === undefined) return undefined;
  const { target } = input;
  switch (toolName) {
    case "notebookedit":
      return { path, operation: "update" };
    case "write": {
      const content = stringField(input.toolInput, "content");
      const operation = target.type === "missing" ? "add" : "update";
      if (content === undefined) return { path, operation };
      if (target.type === "missing")
        return changeWithPatch({ path, operation }, exactPatch(path, undefined, content));
      const exact = target.type === "text" ? exactPatch(path, target.text, content) : undefined;
      if (exact !== undefined) return { path, operation, patch: exact };
      if (target.type === "text" && target.text === content) return { path, operation };
      return changeWithPatch(
        { path, operation, approximate: true },
        editTextPatch(path, [{ oldString: "", newString: content, replaceAll: false }]),
      );
    }
    case "edit":
    case "multiedit": {
      const edits = claudeTextEdits(toolName, input.toolInput);
      if (edits === undefined) return { path, operation: "update" };
      const created = target.type === "missing" && edits.length === 1 && edits[0]!.oldString === "";
      if (created) {
        return changeWithPatch(
          { path, operation: "add" },
          exactPatch(path, undefined, edits[0]!.newString),
        );
      }
      if (target.type === "text") {
        const after = applyClaudeEdits(target.text, edits);
        const exact = after === undefined ? undefined : exactPatch(path, target.text, after);
        if (exact !== undefined) return { path, operation: "update", patch: exact };
      }
      return changeWithPatch(
        { path, operation: "update", approximate: true },
        editTextPatch(path, edits),
      );
    }
    default:
      return undefined;
  }
}

function errorCode(cause: unknown): unknown {
  return typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;
}

/** The file system calls a preview read makes; tests substitute them to stage races. */
export interface PreviewFileOperations {
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<NodeFS.BigIntStats>;
  readonly open: (path: string, flags: number) => Promise<NodeFSP.FileHandle>;
}

export const nodePreviewFileOperations: PreviewFileOperations = {
  realpath: (path) => NodeFSP.realpath(path),
  lstat: (path) => NodeFSP.lstat(path, { bigint: true }),
  open: (path, flags) => NodeFSP.open(path, flags),
};

// O_NONBLOCK keeps a FIFO from blocking the open; O_NOFOLLOW rejects a target
// that became a symlink after it was checked.
const PREVIEW_OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NONBLOCK ?? 0) |
  (NodeFS.constants.O_NOFOLLOW ?? 0);

/**
 * The names leading from a folder to `path`, when `path` lies below the folder
 * as the agent spelled it or as it resolves. Lexical only: nothing on the way
 * has been checked yet.
 */
function namesBelow(
  folders: ReadonlyArray<string>,
  path: string,
): ReadonlyArray<string> | undefined {
  for (const folder of folders) {
    const relative = NodePath.relative(folder, path);
    if (relative === "" || NodePath.isAbsolute(relative)) continue;
    const names = relative.split(NodePath.sep);
    if (names[0] !== "..") return names;
  }
  return undefined;
}

const sameNode = (left: NodeFS.BigIntStats, right: NodeFS.BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino;

/**
 * Reads the target only through the turn's folder. Node has no `openat`, so the
 * walk cannot hold directory descriptors. Instead every directory from the
 * folder down must be a real directory, not a symlink, before the target is
 * checked and still the same directory after the read, and the opened file must
 * be the single-link regular file that was checked. A directory replaced by a
 * symlink in between is caught. One race remains: a directory swapped for a
 * symlink before the target check and swapped back before the second walk can
 * still put a file from elsewhere in the preview.
 */
async function readTargetText(
  path: string,
  cwd: string,
  fileOperations: PreviewFileOperations,
): Promise<ProposedChangeTarget> {
  // Whether anything is there is all a preview learns about a path it does not read.
  try {
    await fileOperations.lstat(path);
  } catch (cause) {
    return errorCode(cause) === "ENOENT" ? { type: "missing" } : UNAVAILABLE;
  }
  const root = await fileOperations.realpath(cwd);
  const names = namesBelow([cwd, root], path);
  if (names === undefined) return UNAVAILABLE;
  const directories = [root];
  for (const name of names.slice(0, -1)) {
    directories.push(NodePath.join(directories.at(-1)!, name));
  }
  const target = NodePath.join(directories.at(-1)!, names.at(-1)!);
  const walk = () => Promise.all(directories.map((directory) => fileOperations.lstat(directory)));
  const walked = await walk();
  if (!walked.every((stat) => stat.isDirectory())) return UNAVAILABLE;
  const checked = await fileOperations.lstat(target);
  // A second link could be a name inside the folder for a file outside it.
  if (
    !checked.isFile() ||
    checked.nlink !== 1n ||
    checked.size > BigInt(PROPOSED_PREVIEW_READ_MAX_BYTES)
  ) {
    return UNAVAILABLE;
  }
  const handle = await fileOperations.open(target, PREVIEW_OPEN_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameNode(opened, checked) || opened.mode !== checked.mode) return UNAVAILABLE;
    // The cap holds while reading too: a file that grew past it is not previewed.
    const buffer = Buffer.alloc(PROPOSED_PREVIEW_READ_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > PROPOSED_PREVIEW_READ_MAX_BYTES) return UNAVAILABLE;
    const rewalked = await walk();
    if (!rewalked.every((stat, index) => sameNode(stat, walked[index]!))) return UNAVAILABLE;
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) return UNAVAILABLE;
    return { type: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the text a Claude edit would change, for its preview only. Only a
 * regular UTF-8 file of at most 1 MB with a single link, inside the turn's
 * folder and reached without a symlink, is read; a path that does not exist is
 * `missing`; anything else, including any error or a slow file system, is
 * `unavailable`. Never fails.
 */
export const readProposedChangeTarget = (input: {
  readonly path: string;
  readonly cwd: string | null;
  readonly fileOperations?: PreviewFileOperations;
}): Effect.Effect<ProposedChangeTarget> =>
  input.cwd === null || !NodePath.isAbsolute(input.path) || !NodePath.isAbsolute(input.cwd)
    ? Effect.succeed(UNAVAILABLE)
    : Effect.tryPromise(() =>
        readTargetText(input.path, input.cwd!, input.fileOperations ?? nodePreviewFileOperations),
      ).pipe(
        Effect.timeoutOption(PROPOSED_PREVIEW_READ_TIMEOUT),
        Effect.map(Option.getOrElse(() => UNAVAILABLE)),
        Effect.orElseSucceed(() => UNAVAILABLE),
      );

/**
 * The bounded preview for a Claude file tool call. Reads its target only for
 * Edit, MultiEdit and Write. Never fails; a defect leaves the preview empty.
 */
export const claudeProposedFileChanges = (input: {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd: string | null;
}): Effect.Effect<ProposedFileChangeFields> => {
  const path = claudeProposedChangePath(input.toolName, input.toolInput);
  if (path === undefined) return Effect.succeed({});
  const readsTarget = normalizedToolName(input.toolName) !== "notebookedit";
  return (
    readsTarget ? readProposedChangeTarget({ path, cwd: input.cwd }) : Effect.succeed(UNAVAILABLE)
  ).pipe(
    Effect.map((target) => {
      const change = claudeProposedFileChange({ ...input, target });
      return change === undefined ? {} : boundProposedChanges([change]);
    }),
    Effect.catchCause(() => Effect.succeed({})),
  );
};
