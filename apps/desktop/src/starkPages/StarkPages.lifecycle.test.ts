// Exercise real child processes and loopback HTTP without using the user's Pages folders.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as StarkPages from "./StarkPages.ts";

const childScript = `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = process.argv[4];
fs.appendFileSync(path.join(root, 'launches.jsonl'), JSON.stringify({args:process.argv.slice(2), node:process.execPath, mode:process.env.ELECTRON_RUN_AS_NODE, path:process.env.PATH}) + '\\n');
if (process.env.MIRROR_TEST_HANG === '1') { setInterval(() => {}, 1000); }
else {
  const dir = path.join(root, 'pages', '.spage');
  const descriptor = path.join(dir, 'mirror.json');
  const token = 'a'.repeat(64);
  const server = http.createServer((req,res) => {
    res.writeHead(req.headers['x-spage-token'] === token && !req.headers.origin ? 200 : 403);
    res.end(JSON.stringify({ok:true, root, pid:process.pid}));
  });
  const listen = (port) => {
    server.once('error', e => { if(e.code === 'EADDRINUSE' && port < 4337) listen(port + 1); else process.exit(1); });
    server.listen(port, '127.0.0.1', () => {
      fs.mkdirSync(dir, {recursive:true});
      fs.writeFileSync(descriptor, JSON.stringify({port, token, pid:process.pid}));
    });
  };
  process.once('SIGTERM', () => { fs.rmSync(descriptor, {force:true}); process.exit(0); });
  listen(4317);
}
`;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "stark-mirror-lifecycle-" });
  const root = path.join(base, "project");
  const kitRoot = path.join(base, "kit");
  yield* fs.makeDirectory(root);
  for (const [name, content] of [
    [".claude-plugin/plugin.json", '{"name":"stark-workbench"}'],
    ["hooks/hooks.json", "{}"],
    ["node_modules/markdown-it/package.json", "{}"],
    [".stark-bundle.json", "{}"],
    ["packages/spage/bin/spage.js", childScript],
  ]) {
    const file = path.join(kitRoot, name!);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content!);
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const children: ChildProcessSpawner.ChildProcessHandle[] = [];
  const trackedSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
    ...spawner,
    spawn: (command) =>
      spawner.spawn(command).pipe(Effect.tap((child) => Effect.sync(() => children.push(child)))),
  });
  const shell = Layer.succeed(ElectronShell.ElectronShell, {
    openExternal: () => Effect.die("Starting Pages must not open a browser."),
    openSystemSettings: () => Effect.succeed(false),
    copyText: () => Effect.void,
  });
  const layer = (options: { hang?: boolean; timeout?: number; kit?: string } = {}) =>
    StarkPages.layer({
      kitRoot: options.kit ?? kitRoot,
      nodePath: process.execPath,
      startupTimeoutMs: options.timeout ?? 4000,
      env: { PATH: "/usr/bin:/bin", MIRROR_TEST_HANG: options.hang ? "1" : "0" },
    }).pipe(
      Layer.provide(shell),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, trackedSpawner)),
    );
  return { fs, path, root, kitRoot, children, layer };
});

it.live(
  "starts once on concurrent opens with a short PATH, reuses it, and stops the owned child",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const owner = yield* Scope.make();
      const context = yield* Layer.buildWithScope(f.layer(), owner);
      yield* Effect.gen(function* () {
        const pages = yield* StarkPages.StarkPages;
        const mirrors = yield* Effect.all(
          [pages.ensureMirror(f.root), pages.ensureMirror(f.root)],
          { concurrency: "unbounded" },
        );
        expect(mirrors[0]).not.toBeNull();
        expect(mirrors[1]).toEqual(mirrors[0]);
        expect(yield* pages.ensureMirror(f.root)).toEqual(mirrors[0]);
        expect(f.children).toHaveLength(1);
        const launches = (yield* f.fs.readFileString(f.path.join(f.root, "launches.jsonl")))
          .trim()
          .split("\n");
        expect(launches).toHaveLength(1);
        expect(JSON.parse(launches[0]!)).toMatchObject({
          args: ["serve", "--root", f.root],
          mode: "1",
          path: "/usr/bin:/bin",
          node: process.execPath,
        });
        yield* pages.shutdown;
        expect(yield* f.children[0]!.isRunning).toBe(false);
        expect(yield* f.fs.exists(f.path.join(f.root, "pages", ".spage", "mirror.json"))).toBe(
          false,
        );
        expect(yield* pages.ensureMirror(f.root)).toBeNull();
      }).pipe(Effect.provideContext(context), Effect.ensuring(Scope.close(owner, Exit.void)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reuses an external mirror and leaves it running when this app closes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const externalScope = yield* Scope.make();
    const externalContext = yield* Layer.buildWithScope(f.layer(), externalScope);
    yield* Effect.gen(function* () {
      const external = yield* StarkPages.StarkPages;
      const mirror = yield* external.ensureMirror(f.root);
      expect(mirror).not.toBeNull();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const app = yield* StarkPages.StarkPages;
          expect(yield* app.workbenchAvailable).toBe(false);
          expect(yield* app.ensureMirror(f.root)).toEqual(mirror);
          yield* app.shutdown;
        }).pipe(Effect.provide(f.layer({ kit: "/missing/bundle" }))),
      );
      expect(f.children).toHaveLength(1);
      expect(yield* f.children[0]!.isRunning).toBe(true);
      expect(yield* external.findMirror(f.root)).toEqual(mirror);
    }).pipe(
      Effect.provideContext(externalContext),
      Effect.ensuring(Scope.close(externalScope, Exit.void)),
    );
    expect(yield* f.children[0]!.isRunning).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("bounds startup and terminates a child that never becomes healthy", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const pages = yield* StarkPages.StarkPages;
      expect(yield* pages.ensureMirror(f.root)).toBeNull();
      expect(f.children).toHaveLength(1);
      expect(yield* f.children[0]!.isRunning).toBe(false);
    }).pipe(Effect.provide(f.layer({ hang: true, timeout: 200 })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("does not launch for missing folders, relative paths, or an invalid kit", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const pages = yield* StarkPages.StarkPages;
      expect(yield* pages.ensureMirror("relative/project")).toBeNull();
      expect(yield* pages.ensureMirror(f.path.join(f.root, "missing"))).toBeNull();
      expect(yield* pages.ensureMirror(f.root)).toBeNull();
      expect(f.children).toHaveLength(0);
    }).pipe(Effect.provide(f.layer({ kit: "/missing/bundle" })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("allows a retry after the bundled kit becomes available", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const manifest = f.path.join(f.kitRoot, ".claude-plugin", "plugin.json");
    yield* f.fs.remove(manifest);
    yield* Effect.gen(function* () {
      const pages = yield* StarkPages.StarkPages;
      expect(yield* pages.workbenchAvailable).toBe(false);
      expect(yield* pages.ensureMirror(f.root)).toBeNull();
      yield* f.fs.writeFileString(manifest, '{"name":"stark-workbench"}');
      expect(yield* pages.workbenchAvailable).toBe(true);
      expect(f.children).toHaveLength(0);
      expect(yield* pages.ensureMirror(f.root)).not.toBeNull();
      expect(f.children).toHaveLength(1);
    }).pipe(Effect.provide(f.layer()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
