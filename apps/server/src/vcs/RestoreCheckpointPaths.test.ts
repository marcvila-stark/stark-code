import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import { restoreCheckpointPaths } from "./RestoreCheckpointPaths.ts";

const runtime = Layer.merge(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "stark-path-restore-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.makeVcsDriverShape();
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "stark-shared-restore-" });
  const git = (args: ReadonlyArray<string>) =>
    driver.execute({ operation: "restore-test", cwd, args });
  const write = (file: string, content: string) =>
    fs.writeFileString(path.join(cwd, file), content);
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@test.com"]);
  yield* write("a file.txt", "before\n");
  yield* write("b.txt", "owner\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "before"]);
  const sourceRef = CheckpointRef.make("refs/stark-code/checkpoints/before");
  const expectedRef = CheckpointRef.make("refs/stark-code/checkpoints/after");
  yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: sourceRef });
  yield* write("a file.txt", "agent\n");
  yield* write("new.txt", "created by agent\n");
  yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: expectedRef });
  return { fs, path, cwd, driver, git, write, sourceRef, expectedRef };
});

it.effect(
  "restores and deletes only matching agent files, keeps owner/untracked changes and leaves the index byte-for-byte unchanged",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("b.txt", "owner changed it\n");
      yield* f.write("untracked.txt", "keep me\n");
      yield* f.git(["add", "b.txt"]);
      const index = yield* f.fs.readFile(f.path.join(f.cwd, ".git", "index"));
      const restore = f.driver.checkpoints.restorePaths!;
      const preview = yield* restore({ ...f, paths: ["a file.txt", "new.txt"], dryRun: true });
      assert.deepEqual(preview.restored, ["a file.txt", "new.txt"]);
      assert.equal(yield* f.fs.readFileString(f.path.join(f.cwd, "a file.txt")), "agent\n");
      const result = yield* restore({ ...f, paths: ["a file.txt", "new.txt"] });
      assert.deepEqual(result.restored, preview.restored);
      assert.equal(yield* f.fs.readFileString(f.path.join(f.cwd, "a file.txt")), "before\n");
      assert.isFalse(yield* f.fs.exists(f.path.join(f.cwd, "new.txt")));
      assert.equal(yield* f.fs.readFileString(f.path.join(f.cwd, "b.txt")), "owner changed it\n");
      assert.equal(yield* f.fs.readFileString(f.path.join(f.cwd, "untracked.txt")), "keep me\n");
      assert.deepEqual(yield* f.fs.readFile(f.path.join(f.cwd, ".git", "index")), index);
    }).pipe(Effect.scoped, Effect.provide(runtime)),
);

it.effect("keeps changed-since content and rejects traversal, symlink and hardlink paths", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write("a file.txt", "owner changed the agent file\n");
    yield* f.fs.symlink(f.path.join(f.cwd, "new.txt"), f.path.join(f.cwd, "link.txt"));
    yield* f.fs.link(f.path.join(f.cwd, "new.txt"), f.path.join(f.cwd, "hard.txt"));
    const result = yield* f.driver.checkpoints.restorePaths!({
      ...f,
      paths: ["a file.txt", "new.txt", "link.txt", "../elsewhere", ".git/config"],
    });
    assert.deepEqual(result.restored, []);
    assert.deepEqual(
      result.conflicts.map((conflict) => conflict.reason),
      [
        "changed since",
        "symlink or hard link",
        "symlink or hard link",
        "outside workspace",
        "outside workspace",
      ],
    );
    assert.equal(yield* f.fs.readFileString(f.path.join(f.cwd, "new.txt")), "created by agent\n");
  }).pipe(Effect.scoped, Effect.provide(runtime)),
);

it.effect("undo uses the pre-restore snapshot and still keeps edits made after the restore", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pre = CheckpointRef.make("refs/stark-code/checkpoints/pre-restore");
    yield* f.driver.checkpoints.captureCheckpoint({ cwd: f.cwd, checkpointRef: pre });
    const paths = ["a file.txt", "new.txt"];
    yield* f.driver.checkpoints.restorePaths!({ ...f, paths });
    const post = CheckpointRef.make("refs/stark-code/checkpoints/post-restore");
    yield* f.driver.checkpoints.captureCheckpoint({ cwd: f.cwd, checkpointRef: post });
    yield* f.write("a file.txt", "owner wrote after restore\n");
    const undo = yield* f.driver.checkpoints.restorePaths!({
      cwd: f.cwd,
      sourceRef: pre,
      expectedRef: post,
      paths,
    });
    assert.deepEqual(undo.restored, ["new.txt"]);
    assert.deepEqual(undo.conflicts, [{ path: "a file.txt", reason: "changed since" }]);
    assert.equal(
      yield* f.fs.readFileString(f.path.join(f.cwd, "a file.txt")),
      "owner wrote after restore\n",
    );
    assert.equal(yield* f.fs.readFileString(f.path.join(f.cwd, "new.txt")), "created by agent\n");
  }).pipe(Effect.scoped, Effect.provide(runtime)),
);

it.effect("keeps an executable-bit change even when file contents still match", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.chmod(f.path.join(f.cwd, "a file.txt"), 0o755);
    const result = yield* f.driver.checkpoints.restorePaths!({ ...f, paths: ["a file.txt"] });
    assert.deepEqual(result.conflicts, [{ path: "a file.txt", reason: "changed since" }]);
    assert.equal(yield* f.fs.readFileString(f.path.join(f.cwd, "a file.txt")), "agent\n");
  }).pipe(Effect.scoped, Effect.provide(runtime)),
);

it.effect(
  "rechecks after Git reads and keeps an editor write that raced the first content check",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let hashes = 0;
      const execute: typeof f.driver.execute = (input) =>
        f.driver.execute(input).pipe(
          Effect.tap(() => {
            if (input.args[0] === "hash-object" && ++hashes === 1)
              return f.write("a file.txt", "editor raced the first check\n").pipe(Effect.orDie);
            return Effect.void;
          }),
        );
      const result = yield* restoreCheckpointPaths(
        { ...f, paths: ["a file.txt"] },
        execute,
        f.fs,
        f.path,
      );
      assert.deepEqual(result.conflicts, [{ path: "a file.txt", reason: "changed since" }]);
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.cwd, "a file.txt")),
        "editor raced the first check\n",
      );
    }).pipe(Effect.scoped, Effect.provide(runtime)),
);
