// @effect-diagnostics nodeBuiltinImport:off -- disposable Git fixture setup uses native filesystem and git
import { beforeEach, afterEach } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChangesetCheck from "./ChangesetCheck.js";
let cwd: string;
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
async function put(path: string, text: string) {
  await NodeFSP.mkdir(NodePath.join(cwd, path, ".."), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(cwd, path), text);
}
const check = (baseRef?: string) =>
  Effect.gen(function* () {
    const service = yield* ChangesetCheck.ChangesetCheck;
    return yield* service.check({ cwd, ...(baseRef ? { baseRef } : {}) });
  }).pipe(Effect.provide(ChangesetCheck.layer.pipe(Layer.provide(NodeServices.layer))));
const write = (path: string, text: string) => Effect.promise(() => put(path, text));
beforeEach(async () => {
  cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stark-changeset-"));
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await put("packages/public/package.json", JSON.stringify({ name: "@starkfuture/public" }));
  await put(
    "packages/private/package.json",
    JSON.stringify({ name: "@starkfuture/private", private: true }),
  );
  await put(".changeset/old.md", '---\n"@starkfuture/public": patch\n---\nOld change\n');
  git("add", ".");
  git("commit", "-qm", "base");
});
afterEach(async () => {
  await NodeFSP.rm(cwd, { recursive: true, force: true });
});
it.effect("does not execute the repository's filesystem monitor during a read check", () =>
  Effect.gen(function* () {
    yield* write("packages/public/new.ts", "export const x = 1;");
    git("config", "core.fsmonitor", "echo invoked > fsmonitor-ran");
    expect((yield* check()).packages).toHaveLength(1);
    const invoked = yield* Effect.promise(() =>
      NodeFSP.access(NodePath.join(cwd, "fsmonitor-ran")).then(
        () => true,
        () => false,
      ),
    );
    expect(invoked).toBe(false);
  }),
);
it.effect(
  "reports missing notes only for changed publishable packages; old notes do not count",
  () =>
    Effect.gen(function* () {
      yield* write("packages/public/new.ts", "export const x = 1;");
      yield* write("packages/private/new.ts", "export const x = 1;");
      expect((yield* check()).packages).toEqual([
        {
          name: "@starkfuture/public",
          directory: "packages/public",
          changesets: [],
          staged: false,
          stagedCovered: false,
        },
      ]);
    }),
);
it.effect("does not claim an unstaged changeset covers staged code", () =>
  Effect.gen(function* () {
    yield* write("packages/public/new.ts", "export const x = 1;");
    git("add", "packages/public/new.ts");
    yield* write(
      ".changeset/new.md",
      '---\n"@starkfuture/public": minor\n---\nNew optional contract.\n',
    );
    expect((yield* check()).packages[0]).toMatchObject({
      changesets: [".changeset/new.md"],
      staged: true,
      stagedCovered: false,
    });
    git("add", ".changeset/new.md");
    expect((yield* check()).packages[0]?.stagedCovered).toBe(true);
  }),
);
it.effect("uses indexed note contents instead of an unstaged correction", () =>
  Effect.gen(function* () {
    yield* write("packages/public/new.ts", "1");
    yield* write(".changeset/new.md", '---\n"@starkfuture/private": patch\n---\nOther\n');
    git("add", ".");
    yield* write(".changeset/new.md", '---\n"@starkfuture/public": patch\n---\nCorrection\n');
    expect((yield* check()).packages[0]).toMatchObject({
      changesets: [".changeset/new.md"],
      stagedCovered: false,
    });
  }),
);
it.effect("compares committed changes with a local branch without mutating the worktree", () =>
  Effect.gen(function* () {
    git("branch", "baseline");
    yield* write("packages/public/new.ts", "1");
    git("add", ".");
    git("commit", "-qm", "change");
    expect((yield* check()).packages).toEqual([]);
    const before = git("status", "--porcelain");
    expect((yield* check("baseline")).packages[0]?.changesets).toEqual([]);
    expect(git("status", "--porcelain")).toBe(before);
  }),
);
it.effect("rejects option-like refs and out-of-root symlinks", () =>
  Effect.gen(function* () {
    expect(Exit.isFailure(yield* Effect.exit(check("--upload-pack=bad")))).toBe(true);
    yield* Effect.promise(async () => {
      await NodeFSP.rm(NodePath.join(cwd, "packages/public/package.json"));
      await NodeFSP.symlink("/etc/hosts", NodePath.join(cwd, "packages/public/package.json"));
    });
    expect(Exit.isFailure(yield* Effect.exit(check()))).toBe(true);
  }),
);
it.effect("reports malformed and empty notes instead of false coverage", () =>
  Effect.gen(function* () {
    yield* write("packages/public/new.ts", "1");
    yield* write(".changeset/bad.md", '---\n"@starkfuture/public": banana\n---\nBad\n');
    yield* write(".changeset/empty.md", '---\n"@starkfuture/public": patch\n---\n');
    const result = yield* check();
    expect(result.packages[0]?.changesets).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  }),
);
it.effect("does not hide staged public changes with a private unstaged manifest", () =>
  Effect.gen(function* () {
    yield* write("packages/public/new.ts", "1");
    git("add", ".");
    yield* write("packages/public/package.json", '{"name":"@starkfuture/public","private":true}');
    expect((yield* check()).packages[0]?.staged).toBe(true);
  }),
);
it.effect("checks removed publishable packages using their baseline manifest", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      NodeFSP.rm(NodePath.join(cwd, "packages/public"), { recursive: true }),
    );
    expect((yield* check()).packages[0]?.name).toBe("@starkfuture/public");
  }),
);

it.effect("includes staged edits hidden by a working-tree restore", () =>
  Effect.gen(function* () {
    yield* write(
      "packages/public/package.json",
      '{"name":"@starkfuture/public","version":"2.0.0"}',
    );
    git("add", "packages/public/package.json");
    yield* write("packages/public/package.json", '{"name":"@starkfuture/public"}');
    yield* write(".changeset/new.md", '---\n"@starkfuture/public": patch\n---\nStaged note\n');
    git("add", ".changeset/new.md");
    yield* Effect.promise(() => NodeFSP.rm(NodePath.join(cwd, ".changeset/new.md")));
    expect((yield* check()).packages[0]).toMatchObject({
      name: "@starkfuture/public",
      staged: true,
      stagedCovered: true,
      changesets: [],
    });
  }),
);
