import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  formatCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/stark-code/dist/bin.mjs", "npx stark-code serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\stark\\dist\\bin.mjs",
      "npx stark-code serve",
    ],
    [
      "/home/theo/.cache/pnpm/dlx/abc/node_modules/stark-code/dist/bin.mjs",
      "pnpm dlx stark-code serve",
    ],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/stark-code/dist/bin.mjs",
      "pnpm dlx stark-code serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\stark\\dist\\bin.mjs",
      "pnpm dlx stark-code serve",
    ],
    ["/home/theo/.bun/install/cache/stark-code@0.0.31/dist/bin.mjs", "bunx stark-code serve"],
    [
      "/tmp/bunx-1000-stark-code@latest/node_modules/stark-code/dist/bin.mjs",
      "bunx stark-code serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-stark-code@latest\\node_modules\\stark\\dist\\bin.mjs",
      "bunx stark-code serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/stark-code/dist/bin.mjs",
    "/home/theo/Code/work/starkcode/apps/server/dist/bin.mjs",
    "/home/theo/.stark-code/runtime/0.0.31/node_modules/stark-code/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "stark-code serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx stark-code@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx stark-code@preview serve"],
    ["0.0.31-foo-preview.20260729.1", "npx stark-code serve"],
    ["0.0.31", "npx stark-code serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/stark-code/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/stark-code/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx stark-code@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-stark-code@latest/node_modules/stark-code/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx stark-code serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/stark-code/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "stark-code serve",
  );
});

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  /** `sudo stark-code browser setup` as this process would render it, with `stark-code` on PATH or not. */
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
  }) =>
    resolveRootCliCommand("browser setup").pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  /** A directory holding an executable `stark-code`, to stand in for one on PATH. */
  const pathWithStark = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "stark-code"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/stark-code/dist/bin.mjs";
      // sudo's secure_path already has a system Node.
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo npx stark-code browser setup",
      );
      // nvm, fnm, and tarball installs are dropped by sudo's PATH reset.
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" npx stark-code browser setup');
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/stark-code/dist/bin.mjs",
          path: yield* pathWithStark,
        }),
      ).toBe('sudo env "PATH=$PATH" stark-code browser setup');
    }).pipe(Effect.scoped),
  );

  it.effect("names this install's launcher when stark is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "stark-code");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_T3abc/starkcode",
        entry: "/tmp/.mount_T3abc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { STARK_CODE_CLI_PATH: shim },
      };
      // The desktop app's shim, quoted for the shell and run as root as is.
      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);
      // A `stark-code` the person put on PATH still wins.
      expect(yield* rootCommand({ ...desktop, path: yield* pathWithStark })).toBe(
        'sudo env "PATH=$PATH" stark-code browser setup',
      );
      // A standalone binary names itself.
      expect(
        yield* rootCommand({
          node: "/opt/stark-code/stark-code",
          entry: "/opt/stark-code/stark-code",
          executable: true,
        }),
      ).toBe("sudo /opt/stark-code/stark-code browser setup");
      // A stale shim path, then no launcher at all, fall back to plain `stark-code`.
      expect(
        yield* rootCommand({ ...desktop, env: { STARK_CODE_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" stark-code browser setup');
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for both script and executable packages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/stark-code/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/@starkfuture/stark-linux-x64/stark-code", "npx"],
        ["pnpm/dlx/hash/node_modules/stark-code/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/stark-code/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, ["node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, entry),
          Effect.provideService(HostProcess.IsExecutable, entry.endsWith("/stark-code")),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.makeTempDirectoryScoped();
      const root = yield* fs.realPath(tempRoot);
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/stark-code");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/stark-code");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"stark-code","version":"0.0.45","bin":{"stark-code":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.Arguments, ["node", entry]),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated stark-code command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcess.Platform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the native executable belongs to the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.makeTempDirectoryScoped();
      const root = yield* fs.realPath(tempRoot);
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/stark-code");
      const launcher = path.join(packageRoot, "bin/stark-code.js");
      const entry = path.join(packageRoot, "node_modules/@starkfuture/stark-linux-x64/stark-code");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"stark-code","version":"0.0.45","bin":{"stark-code":"./bin/stark-code.js"},"optionalDependencies":{"@starkfuture/stark-linux-x64":"0.0.45"}}',
      );
      yield* fs.symlink(launcher, path.join(prefix, "bin/stark-code"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.ExecutablePath, entry),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      for (const [version, expected] of [
        ["0.0.44", null],
        ["0.0.45", { kind: "npm-global", prefix }],
      ]) {
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "package.json"),
          `{"name":"@starkfuture/stark-linux-x64","version":"${version}"}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/stark-code/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".stark-code/runtime/0.0.45/stark-code",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
