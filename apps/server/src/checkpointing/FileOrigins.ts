import type {
  OrchestrationV2CheckpointFileOrigin,
  OrchestrationV2CheckpointFileSummary,
  OrchestrationV2TurnItem,
} from "@starkfuture/contracts";

/**
 * Turn items that can write files without saying which ones. A subagent counts because its
 * own tool items may not be stored with the run that started it.
 */
const UNATTRIBUTED_WRITER_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "hook_run",
  "subagent",
]);

/**
 * Tool names, compared case-insensitively, that only read. Claude reports Read, Glob, Grep and
 * similar as generic tools, so a turn that only looked at files must not count as a writer.
 */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "ls",
  "todowrite",
  "toolsearch",
  "webfetch",
  "websearch",
  "view_image",
]);

/** Item states in which a tool never ran, so it cannot have written anything. */
const NOT_STARTED_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "idle",
  "pending",
  "waiting",
]);

/**
 * The files an edit item says it wrote, or null when its provider could not name them. An
 * adapter reports an empty `agentWrittenPaths` for an edit whose paths it does not know (for
 * example a patch it found no file headers in); its `fileName` is then only a label.
 */
export function fileChangeWrittenPaths(
  item: Extract<OrchestrationV2TurnItem, { type: "file_change" }>,
): ReadonlyArray<string> | null {
  if (item.agentWrittenPaths?.length) return item.agentWrittenPaths;
  if (item.changes?.length) {
    return item.changes.flatMap((change) =>
      change.oldPath ? [change.path, change.oldPath] : [change.path],
    );
  }
  return item.agentWrittenPaths === undefined ? [item.fileName] : null;
}

/** What a turn's own tool items say about the files it may have written. */
export interface TurnWriteEvidence {
  /** Paths the turn's completed edits wrote, absolute or relative to the turn's folder. */
  readonly editedPaths: ReadonlyArray<string>;
  /**
   * Paths of edits that started but did not report completion (still running, failed,
   * cancelled, or cut off when the turn stopped), which may have written them anyway.
   */
  readonly possiblyEditedPaths: ReadonlyArray<string>;
  /** True when the turn ran commands or other tools that can write files without reporting them. */
  readonly ranUnattributedWriters: boolean;
}

/** Collects write evidence from every item of one run, including its subagents' items. */
export function collectTurnWriteEvidence(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): TurnWriteEvidence {
  const editedPaths = new Set<string>();
  const possiblyEditedPaths = new Set<string>();
  let ranUnattributedWriters = false;
  for (const item of items) {
    if (item.type === "file_change") {
      if (NOT_STARTED_STATUSES.has(item.status)) continue;
      const paths = fileChangeWrittenPaths(item);
      if (paths === null) ranUnattributedWriters = true;
      else {
        const target = item.status === "completed" ? editedPaths : possiblyEditedPaths;
        for (const path of paths) target.add(path);
      }
      continue;
    }
    if (
      item.type === "dynamic_tool" &&
      READ_ONLY_TOOL_NAMES.has(item.toolName?.toLowerCase() ?? "")
    )
      continue;
    if (UNATTRIBUTED_WRITER_TYPES.has(item.type) && !NOT_STARTED_STATUSES.has(item.status)) {
      ranUnattributedWriters = true;
    }
  }
  return {
    editedPaths: [...editedPaths],
    possiblyEditedPaths: [...possiblyEditedPaths],
    ranUnattributedWriters,
  };
}

function isAbsolutePath(path: string) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * Splits a path on either separator into segments, resolving `.` and `..`, so paths compare as
 * strings. A Windows drive letter is upper-cased, since `c:\repo` and `C:/repo` are one folder.
 */
function segmentsOf(path: string) {
  const segments: string[] = [];
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const [first] = segments;
  if (first !== undefined && /^[a-z]:$/.test(first)) segments[0] = first.toUpperCase();
  return segments;
}

/** The path below `base`, or null when `path` is not inside it. */
function pathBelow(base: ReadonlyArray<string>, path: ReadonlyArray<string>) {
  if (path.length <= base.length) return null;
  for (let index = 0; index < base.length; index += 1) {
    if (base[index] !== path[index]) return null;
  }
  return path.slice(base.length);
}

/**
 * Marks each checkpoint file with who changed it during the turn.
 *
 * Checkpoint paths are relative to the repository root, while edit tools report paths that are
 * absolute or relative to the turn's folder, which can be a subfolder of the repository. The
 * folder is passed in every spelling it has (for example, with symlinks resolved), because Git
 * reports the root with symlinks resolved and tools usually report the folder as configured.
 */
export function attributeCheckpointFiles(input: {
  readonly files: ReadonlyArray<OrchestrationV2CheckpointFileSummary>;
  readonly cwdSpellings: ReadonlyArray<string>;
  readonly repositoryRoot: string | null;
  readonly evidence: TurnWriteEvidence;
}): ReadonlyArray<OrchestrationV2CheckpointFileSummary> {
  const cwds = input.cwdSpellings.map(segmentsOf);
  const root = input.repositoryRoot === null ? null : segmentsOf(input.repositoryRoot);
  // Where the turn's folder sits inside the repository.
  const prefix =
    (root === null ? undefined : cwds.map((cwd) => pathBelow(root, cwd)).find(Boolean)) ?? [];
  /** The repository-relative spellings of the given tool-reported paths. */
  const repositoryPaths = (paths: ReadonlyArray<string>) => {
    const resolved = new Set<string>();
    for (const path of paths) {
      const segments = segmentsOf(path);
      if (!isAbsolutePath(path)) {
        resolved.add(segmentsOf([...prefix, path].join("/")).join("/"));
        continue;
      }
      const belowCwd = cwds.map((cwd) => pathBelow(cwd, segments)).find(Boolean);
      if (belowCwd) {
        resolved.add([...prefix, ...belowCwd].join("/"));
        continue;
      }
      const belowRoot = root === null ? null : pathBelow(root, segments);
      if (belowRoot) resolved.add(belowRoot.join("/"));
    }
    return resolved;
  };
  const edited = repositoryPaths(input.evidence.editedPaths);
  const possiblyEdited = repositoryPaths(input.evidence.possiblyEditedPaths);
  const otherOrigin: OrchestrationV2CheckpointFileOrigin = input.evidence.ranUnattributedWriters
    ? "unknown"
    : "outside";
  return input.files.map((file) => {
    const path = segmentsOf(file.path).join("/");
    return {
      ...file,
      origin: edited.has(path) ? "agent" : possiblyEdited.has(path) ? "unknown" : otherOrigin,
    };
  });
}
