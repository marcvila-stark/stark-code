import {
  CheckpointFileRestoreError,
  OrchestrationV2NativeFileState,
  type CheckpointRestorePreview,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

const MAX_BYTES = 64 * 1024 * 1024;
const NativeBackup = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      state: OrchestrationV2NativeFileState,
      backup: Schema.optional(Schema.String),
    }),
  ),
  after: Schema.optional(Schema.Array(OrchestrationV2NativeFileState)),
});
const encodeBackup = Schema.encodeEffect(Schema.fromJsonString(NativeBackup));
const decodeBackup = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeBackup));
type State = OrchestrationV2NativeFileState;
type Conflict = CheckpointRestorePreview["conflicts"][number];
type ReadFile = { state: State; bytes?: Uint8Array; ino: number | null };
export const sameNativeFileState = (a: State, b: State) =>
  a.path === b.path && a.sha256 === b.sha256 && a.mode === b.mode;

/** Native rewind is all-or-nothing: a single unsafe path prevents calling the SDK. */
export const makeNativeFileCheckpointRestore = Effect.fn("makeNativeFileCheckpointRestore")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const fail = (message: string) => new CheckpointFileRestoreError({ message });
    const read = Effect.fn("NativeFileCheckpointRestore.read")(function* (
      cwd: string,
      candidate: string,
    ): Effect.fn.Return<ReadFile, CheckpointFileRestoreError> {
      const root = yield* fs
        .realPath(cwd)
        .pipe(Effect.mapError(() => fail("The restore folder is unavailable.")));
      // macOS exposes /var and /private/var as aliases. Accept paths under
      // either the configured cwd or its canonical root, then operate only
      // beneath the canonical root and check every descendant for links.
      const logicalRoot = path.resolve(cwd);
      const logicalRelative = path.relative(logicalRoot, path.resolve(logicalRoot, candidate));
      const escaped = (value: string) =>
        path.isAbsolute(value) || value === ".." || value.startsWith(`..${path.sep}`);
      let relative = (
        escaped(logicalRelative)
          ? path.relative(root, path.resolve(root, candidate))
          : logicalRelative
      )
        .split(path.sep)
        .join("/");
      if (escaped(relative)) {
        const absoluteCandidate = path.resolve(logicalRoot, candidate);
        const parent = yield* fs
          .realPath(path.dirname(absoluteCandidate))
          .pipe(Effect.orElseSucceed(() => undefined));
        if (parent)
          relative = path
            .relative(root, path.join(parent, path.basename(absoluteCandidate)))
            .split(path.sep)
            .join("/");
      }
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith("../") ||
        relative.split("/").some((part) => part.toLowerCase() === ".git")
      )
        return yield* fail("outside workspace");
      let cursor = root;
      for (const part of relative.split("/")) {
        cursor = path.join(cursor, part);
        if (Option.isSome(yield* fs.readLink(cursor).pipe(Effect.option)))
          return yield* fail("symlink or hard link");
      }
      const file = path.join(root, relative);
      const stat = yield* fs
        .stat(file)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(null)
              : Effect.fail(fail("File metadata is unavailable.")),
          ),
        );
      if (!stat) return { state: { path: relative, sha256: null, mode: 0 }, ino: null };
      if (stat.type !== "File" || Option.getOrElse(stat.nlink, () => 1) > 1)
        return yield* fail("symlink or hard link");
      if (stat.size > BigInt(MAX_BYTES)) return yield* fail("file exceeds the 64 MiB undo limit");
      const bytes = yield* fs
        .readFile(file)
        .pipe(Effect.mapError(() => fail("File contents are unavailable.")));
      const sha256 = Hex.encode(
        yield* crypto
          .digest("SHA-256", bytes)
          .pipe(Effect.mapError(() => fail("Could not fingerprint the file."))),
      );
      return {
        state: { path: relative, sha256, mode: stat.mode & 0o777 },
        bytes,
        ino: Option.getOrNull(stat.ino),
      };
    });
    const inspect = Effect.fn("NativeFileCheckpointRestore.inspect")(function* (
      cwd: string,
      paths: readonly string[],
    ) {
      const files: ReadFile[] = [];
      const conflicts: Conflict[] = [];
      let bytes = 0;
      for (const candidate of [...new Set(paths)].slice(0, 4096)) {
        const result = yield* Effect.result(read(cwd, candidate));
        if (result._tag === "Failure") {
          conflicts.push({ path: candidate, reason: result.failure.message });
          continue;
        }
        bytes += result.success.bytes?.length ?? 0;
        if (bytes > MAX_BYTES) {
          conflicts.push({
            path: result.success.state.path,
            reason: "restore exceeds the 64 MiB undo limit",
          });
          continue;
        }
        files.push(result.success);
      }
      if (paths.length > 4096)
        conflicts.push({
          path: "(remaining files)",
          reason: "restore exceeds the file count limit",
        });
      return { files, conflicts };
    });
    const save = Effect.fn("NativeFileCheckpointRestore.save")(function* (
      directory: string,
      backup: typeof NativeBackup.Type,
    ) {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const text = yield* encodeBackup(backup);
      const temporary = path.join(directory, "manifest.tmp");
      yield* fs.writeFileString(temporary, text, { mode: 0o600 });
      yield* fs.rename(temporary, path.join(directory, "manifest.json"));
    });
    return {
      inspect,
      snapshot: Effect.fn("NativeFileCheckpointRestore.snapshot")(function* (
        directory: string,
        files: readonly ReadFile[],
      ) {
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const saved: Array<(typeof NativeBackup.Type.files)[number]> = [];
        for (const [index, file] of files.entries()) {
          const backup = `${index}.bin`;
          if (file.bytes)
            yield* fs.writeFile(path.join(directory, backup), file.bytes, { mode: 0o600 });
          saved.push({ state: file.state, ...(file.bytes ? { backup } : {}) });
        }
        yield* save(directory, { files: saved });
      }),
      complete: Effect.fn("NativeFileCheckpointRestore.complete")(function* (
        directory: string,
        after: readonly State[],
      ) {
        const backup = yield* fs
          .readFileString(path.join(directory, "manifest.json"))
          .pipe(Effect.flatMap(decodeBackup));
        yield* save(directory, { ...backup, after });
      }),
      undo: Effect.fn("NativeFileCheckpointRestore.undo")(function* (
        directory: string,
        cwd: string,
      ) {
        const backup = yield* fs
          .readFileString(path.join(directory, "manifest.json"))
          .pipe(Effect.flatMap(decodeBackup));
        const restored: string[] = [];
        const conflicts: Conflict[] = [];
        for (const file of backup.files) {
          const expected = backup.after?.find((item) => item.path === file.state.path);
          const current = yield* Effect.result(read(cwd, file.state.path));
          if (
            !expected ||
            current._tag === "Failure" ||
            !sameNativeFileState(current.success.state, expected)
          ) {
            conflicts.push({
              path: file.state.path,
              reason: current._tag === "Failure" ? current.failure.message : "changed since",
            });
            continue;
          }
          const absolute = path.resolve(cwd, file.state.path);
          if (file.state.sha256 !== null && !(yield* fs.exists(path.dirname(absolute)))) {
            conflicts.push({ path: file.state.path, reason: "folder missing" });
            continue;
          }
          const bytes =
            file.backup && /^\d+\.bin$/.test(file.backup)
              ? yield* fs.readFile(path.join(directory, file.backup))
              : undefined;
          if (
            file.state.sha256 !== null &&
            (!bytes || Hex.encode(yield* crypto.digest("SHA-256", bytes)) !== file.state.sha256)
          )
            return yield* fail("The native undo backup is incomplete.");
          // Revalidate after reading backup bytes; an editor can run independently
          // of the workspace mutex. Parent-directory replacement still has an external CAS limit.
          const latest = yield* read(cwd, file.state.path);
          if (!sameNativeFileState(latest.state, expected) || latest.ino !== current.success.ino) {
            conflicts.push({ path: file.state.path, reason: "changed since" });
            continue;
          }
          if (file.state.sha256 === null) {
            if (latest.state.sha256 !== null) yield* fs.remove(absolute);
          } else if (bytes) {
            const id = yield* crypto.randomUUIDv4();
            const temporary = path.join(path.dirname(absolute), `.stark-file-undo-${id}`);
            yield* fs.writeFile(temporary, bytes, { mode: file.state.mode, flag: "wx" });
            yield* fs.chmod(temporary, file.state.mode);
            yield* fs
              .rename(temporary, absolute)
              .pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)));
          }
          restored.push(file.state.path);
        }
        return { restored, conflicts };
      }),
    };
  },
);

/** Safe post-turn metadata is additive; unavailable paths remain non-restorable. */
export const captureNativeFileStates = Effect.fn("captureNativeFileStates")(function* (
  cwd: string,
  paths: readonly string[],
) {
  const helper = yield* makeNativeFileCheckpointRestore();
  return (yield* helper.inspect(cwd, paths)).files.map((file) => file.state);
});
