// @effect-diagnostics nodeBuiltinImport:off - Backup and restore need fsync, rename and link semantics the Effect FileSystem does not expose.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";

/**
 * The file operations backup and restore depend on for durability. Tests
 * replace single operations to inject ENOSPC, a failed fsync or a failed
 * rename at a precise step.
 */
export interface StateFileOperations {
  readonly availableBytes: (directory: string) => number;
  readonly mkdir: (directory: string, mode: number) => void;
  readonly copyFile: (from: string, to: string) => void;
  readonly writeFile: (path: string, data: string | Uint8Array, mode: number) => void;
  readonly rename: (from: string, to: string) => void;
  /** fsyncs a file or a directory. */
  readonly fsync: (path: string) => void;
  readonly chmod: (path: string, mode: number) => void;
  readonly remove: (path: string) => void;
}

const fsyncPath = (path: string) => {
  const fd = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
};

export const nodeStateFileOperations: StateFileOperations = {
  availableBytes: (directory) => {
    const stats = NodeFS.statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  },
  mkdir: (directory, mode) => {
    NodeFS.mkdirSync(directory, { recursive: true, mode });
    NodeFS.chmodSync(directory, mode);
  },
  copyFile: (from, to) => NodeFS.copyFileSync(from, to, NodeFS.constants.COPYFILE_EXCL),
  writeFile: (path, data, mode) => NodeFS.writeFileSync(path, data, { mode, flag: "wx" }),
  rename: (from, to) => NodeFS.renameSync(from, to),
  fsync: fsyncPath,
  chmod: (path, mode) => NodeFS.chmodSync(path, mode),
  remove: (path) => NodeFS.rmSync(path, { recursive: true, force: true }),
};

export class StateFileOps extends Context.Reference<StateFileOperations>(
  "stark-code/persistence/StateFileOps",
  { defaultValue: () => nodeStateFileOperations },
) {}

export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;

export const sha256File = (path: string): string => {
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    while ((read = NodeFS.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return hash.digest("hex");
};

export const sha256Text = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

export const fileSize = (path: string): number => NodeFS.statSync(path).size;

export const exists = (path: string): boolean => NodeFS.existsSync(path);

export const readTextIfExists = (path: string): string | null => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
};

export const listDirectory = (directory: string): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(directory);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
};

export const isDirectory = (path: string): boolean => {
  try {
    return NodeFS.statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Replaces `path` with `contents` so a crash leaves either the old or the new
 * file: write a temporary sibling, fsync it, rename it over, fsync the parent.
 */
export const writeFileDurably = (
  ops: StateFileOperations,
  path: string,
  contents: string,
  mode = FILE_MODE,
) => {
  const directory = NodePath.dirname(path);
  const temporary = NodePath.join(
    directory,
    `.${NodePath.basename(path)}.${process.pid}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`,
  );
  ops.writeFile(temporary, contents, mode);
  try {
    ops.fsync(temporary);
    ops.rename(temporary, path);
  } catch (cause) {
    ops.remove(temporary);
    throw cause;
  }
  ops.fsync(directory);
};

/** Removes `path` and fsyncs its parent, so the removal survives a crash. */
export const removeDurably = (ops: StateFileOperations, path: string) => {
  if (!exists(path)) return;
  ops.remove(path);
  ops.fsync(NodePath.dirname(path));
};
