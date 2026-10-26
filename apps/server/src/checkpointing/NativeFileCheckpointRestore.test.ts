import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  makeNativeFileCheckpointRestore,
  captureNativeFileStates,
} from "./NativeFileCheckpointRestore.ts";

it.layer(NodeServices.layer)("NativeFileCheckpointRestore", (it) => {
  const fixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stark-native-undo-" });
    const cwd = path.join(root, "workspace");
    yield* fs.makeDirectory(cwd);
    return { fs, path, root, cwd, helper: yield* makeNativeFileCheckpointRestore() };
  });
  it.effect(
    "restores exact binary bytes/mode and deletes previously missing files after process-independent recovery",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, cwd, helper } = yield* fixture;
        const bytes = new Uint8Array([0, 255, 128, 1, 10]);
        yield* fs.writeFile(path.join(cwd, "binary file.bin"), bytes);
        yield* fs.chmod(path.join(cwd, "binary file.bin"), 0o755);
        const before = yield* helper.inspect(cwd, ["binary file.bin", "new.txt"]);
        const directory = path.join(root, "backup");
        yield* helper.snapshot(directory, before.files);
        yield* fs.writeFileString(path.join(cwd, "binary file.bin"), "rewound");
        yield* fs.chmod(path.join(cwd, "binary file.bin"), 0o600);
        yield* fs.writeFileString(path.join(cwd, "new.txt"), "rewind created this");
        yield* helper.complete(
          directory,
          yield* captureNativeFileStates(cwd, ["binary file.bin", "new.txt"]),
        );
        const fresh = yield* makeNativeFileCheckpointRestore();
        const undo = yield* fresh.undo(directory, cwd);
        assert.deepEqual(undo.restored, ["binary file.bin", "new.txt"]);
        assert.deepEqual(yield* fs.readFile(path.join(cwd, "binary file.bin")), bytes);
        assert.equal((yield* fs.stat(path.join(cwd, "binary file.bin"))).mode & 0o777, 0o755);
        assert.isFalse(yield* fs.exists(path.join(cwd, "new.txt")));
        assert.equal((yield* fs.stat(path.join(directory, "0.bin"))).mode & 0o077, 0);
      }),
  );
  it.effect("keeps owner edits and executable-mode changes made after the restore", () =>
    Effect.gen(function* () {
      const { fs, path, root, cwd, helper } = yield* fixture;
      for (const name of ["content", "mode"])
        yield* fs.writeFileString(path.join(cwd, name), "before");
      const directory = path.join(root, "backup");
      yield* helper.snapshot(directory, (yield* helper.inspect(cwd, ["content", "mode"])).files);
      for (const name of ["content", "mode"])
        yield* fs.writeFileString(path.join(cwd, name), "rewound");
      yield* helper.complete(directory, yield* captureNativeFileStates(cwd, ["content", "mode"]));
      yield* fs.writeFileString(path.join(cwd, "content"), "owner");
      yield* fs.chmod(path.join(cwd, "mode"), 0o700);
      const result = yield* helper.undo(directory, cwd);
      assert.deepEqual(result.restored, []);
      assert.deepEqual(
        result.conflicts.map((item) => item.reason),
        ["changed since", "changed since"],
      );
      assert.equal(yield* fs.readFileString(path.join(cwd, "content")), "owner");
    }),
  );
  it.effect("refuses traversal and linked paths before reading or restoring them", () =>
    Effect.gen(function* () {
      const { fs, path, root, cwd, helper } = yield* fixture;
      yield* fs.writeFileString(path.join(root, "outside"), "private");
      yield* fs.symlink(path.join(root, "outside"), path.join(cwd, "link"));
      yield* fs.link(path.join(root, "outside"), path.join(cwd, "hard"));
      const result = yield* helper.inspect(cwd, ["../outside", "link", "hard", ".git/config"]);
      assert.deepEqual(result.files, []);
      assert.deepEqual(
        result.conflicts.map((item) => item.reason),
        ["outside workspace", "symlink or hard link", "symlink or hard link", "outside workspace"],
      );
      assert.equal(yield* fs.readFileString(path.join(root, "outside")), "private");
    }),
  );
  it.effect(
    "normalizes the configured cwd alias and canonical absolute file paths consistently",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, cwd, helper } = yield* fixture;
        const alias = path.join(root, "workspace-alias");
        yield* fs.symlink(cwd, alias);
        yield* fs.writeFileString(path.join(cwd, "a"), "agent");
        const logical = yield* helper.inspect(alias, [path.join(alias, "a")]);
        const canonical = yield* helper.inspect(alias, [path.join(cwd, "a")]);
        assert.deepEqual(
          logical.files.map((file) => file.state),
          canonical.files.map((file) => file.state),
        );
        assert.equal(logical.files[0]?.state.path, "a");
        assert.deepEqual(logical.conflicts, []);
        assert.deepEqual(canonical.conflicts, []);
      }),
  );
  it.effect(
    "leaves crash-incomplete journals untouched because no post-restore fingerprint exists",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, cwd, helper } = yield* fixture;
        yield* fs.writeFileString(path.join(cwd, "a"), "before");
        const directory = path.join(root, "backup");
        yield* helper.snapshot(directory, (yield* helper.inspect(cwd, ["a"])).files);
        yield* fs.writeFileString(path.join(cwd, "a"), "unknown after crash");
        const result = yield* helper.undo(directory, cwd);
        assert.deepEqual(result.restored, []);
        assert.equal(yield* fs.readFileString(path.join(cwd, "a")), "unknown after crash");
      }),
  );
});
