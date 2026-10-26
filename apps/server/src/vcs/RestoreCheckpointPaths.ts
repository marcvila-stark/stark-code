import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { VcsProcessExitError } from "@starkfuture/contracts";
import type { VcsDriver, VcsRestorePathsInput, VcsRestorePathsResult } from "./VcsDriver.ts";

/** The whole-checkout restore is deliberately unavailable through this path. */
export const restoreCheckpointPaths = Effect.fn("GitVcsDriver.checkpoints.restorePaths")(function* (
  input: VcsRestorePathsInput,
  execute: VcsDriver["Service"]["execute"],
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  const operation = "GitVcsDriver.checkpoints.restorePaths";
  const git = (args: ReadonlyArray<string>) =>
    execute({ operation, cwd: input.cwd, args, allowNonZeroExit: true });
  const root = yield* fs.realPath(input.cwd);
  const restored: string[] = [];
  const conflicts: Array<VcsRestorePathsResult["conflicts"][number]> = [];
  const source = yield* git(["rev-parse", "--verify", "--quiet", `${input.sourceRef}^{commit}`]);
  const expected = yield* git([
    "rev-parse",
    "--verify",
    "--quiet",
    `${input.expectedRef}^{commit}`,
  ]);
  if (source.exitCode !== 0 || expected.exitCode !== 0)
    return {
      restored,
      conflicts: input.paths.map((file) => ({
        path: file,
        reason: "checkpoint unavailable" as const,
      })),
    };
  const sourceOid = source.stdout.trim();
  const expectedOid = expected.stdout.trim();
  const expectedOids = new Map<string, string>([[input.expectedRef, expectedOid]]);
  const treeEntry = (ref: string, file: string) =>
    git(["--literal-pathspecs", "ls-tree", "-z", ref, "--", file]).pipe(
      Effect.map((result) => {
        const match = /^(\d+) blob ([a-f0-9]+)\t/.exec(result.stdout);
        return match ? { mode: match[1]!, oid: match[2]! } : null;
      }),
    );
  for (const candidate of new Set(input.paths)) {
    const relative = path
      .relative(path.resolve(input.cwd), path.resolve(input.cwd, candidate))
      .split(path.sep)
      .join("/");
    const absolute = path.resolve(root, relative);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative) ||
      relative.split("/").some((part) => part.toLowerCase() === ".git")
    ) {
      conflicts.push({ path: candidate, reason: "outside workspace" });
      continue;
    }
    let linked = false;
    let cursor = root;
    for (const part of relative.split("/")) {
      cursor = path.join(cursor, part);
      const link = yield* fs.readLink(cursor).pipe(Effect.option);
      if (Option.isSome(link)) {
        linked = true;
        break;
      }
    }
    const stat = yield* fs
      .stat(absolute)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
        ),
      );
    if (
      linked ||
      (stat !== null && (stat.type === "SymbolicLink" || Option.getOrElse(stat.nlink, () => 1) > 1))
    ) {
      conflicts.push({ path: relative, reason: "symlink or hard link" });
      continue;
    }
    const expectedRef = input.expectedRefs?.[relative] ?? input.expectedRef;
    if (!expectedOids.has(expectedRef)) {
      const resolved = yield* git(["rev-parse", "--verify", "--quiet", `${expectedRef}^{commit}`]);
      if (resolved.exitCode !== 0) {
        conflicts.push({ path: relative, reason: "checkpoint unavailable" });
        continue;
      }
      expectedOids.set(expectedRef, resolved.stdout.trim());
    }
    const [before, after] = yield* Effect.all([
      treeEntry(sourceOid, relative),
      treeEntry(expectedOids.get(expectedRef)!, relative),
    ]);
    if (
      before?.mode === "120000" ||
      after?.mode === "120000" ||
      (stat !== null && stat.type !== "File")
    ) {
      conflicts.push({ path: relative, reason: "symlink or hard link" });
      continue;
    }
    const current =
      stat === null ? null : (yield* git(["hash-object", "--", relative])).stdout.trim();
    if (
      current !== (after?.oid ?? null) ||
      (stat !== null && after !== null && ((stat.mode & 0o111) !== 0) !== (after.mode === "100755"))
    ) {
      conflicts.push({ path: relative, reason: "changed since" });
      continue;
    }
    // A missing folder is not recreated as a side effect of file undo.
    if (before !== null && !(yield* fs.exists(path.dirname(absolute)))) {
      conflicts.push({ path: relative, reason: "folder missing" });
      continue;
    }
    if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
    if (!input.dryRun) {
      // Check again after reading Git objects: checkpoint locks do not stop an editor.
      // The final filesystem operation is still not a cross-process compare-and-swap.
      const latestHash = (yield* fs.exists(absolute))
        ? (yield* git(["hash-object", "--", relative])).stdout.trim()
        : null;
      let latestLinked = false;
      let parent = root;
      for (const part of relative.split("/")) {
        parent = path.join(parent, part);
        if (Option.isSome(yield* fs.readLink(parent).pipe(Effect.option))) {
          latestLinked = true;
          break;
        }
      }
      const latest = yield* fs
        .stat(absolute)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
      if (
        latestLinked ||
        (latest !== null && (latest.type !== "File" || Option.getOrElse(latest.nlink, () => 1) > 1))
      ) {
        conflicts.push({ path: relative, reason: "symlink or hard link" });
        continue;
      }
      if (
        latestHash !== (after?.oid ?? null) ||
        (latest !== null &&
          after !== null &&
          ((latest.mode & 0o111) !== 0) !== (after.mode === "100755")) ||
        (latest !== null &&
          stat !== null &&
          (latest.dev !== stat.dev || Option.getOrNull(latest.ino) !== Option.getOrNull(stat.ino)))
      ) {
        conflicts.push({ path: relative, reason: "changed since" });
        continue;
      }
      if (before === null) {
        if (latest !== null) yield* fs.remove(absolute);
      } else {
        const result = yield* git([
          "--literal-pathspecs",
          "restore",
          "--source",
          sourceOid,
          "--worktree",
          "--",
          relative,
        ]);
        if (result.exitCode !== 0)
          return yield* new VcsProcessExitError({
            operation,
            command: "git restore",
            cwd: input.cwd,
            exitCode: result.exitCode,
            detail: result.stderr.trim() || "Could not restore an agent-edited path.",
          });
      }
    }
    restored.push(relative);
  }
  return { restored, conflicts } satisfies VcsRestorePathsResult;
});
