// @effect-diagnostics nodeBuiltinImport:off - Exercise the installed packager's real file copier.
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { StarkWorkbenchUnavailableError } from "@starkfuture/shared/starkWorkbench";
import {
  DESKTOP_EXTRA_RESOURCES,
  PackagedStarkWorkbenchMissingError,
  validatePackagedStarkWorkbench,
} from "./build-desktop-artifact.ts";

// Resolve the same electron-builder dependency the desktop build uses, including
// its internal resource filter. A hand-written glob matcher misses its exclusions.
const desktopRequire = NodeModule.createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const builderRequire = NodeModule.createRequire(desktopRequire.resolve("electron-builder"));
const resourceCopier = builderRequire("app-builder-lib/out/fileMatcher") as {
  FileMatcher: new (
    from: string,
    to: string,
    expand: (pattern: string) => string,
    patterns: string[],
  ) => unknown;
  copyFiles: (matchers: unknown[]) => Promise<void>;
};

const makeFixture = Effect.fn("test.makePackagedWorkbench")(function* (
  platform: "mac" | "linux" | "win",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stark-packaged-workbench-" });
  const stageDistDir = path.join(root, "dist");
  const resources =
    platform === "mac"
      ? path.join(stageDistDir, "mac-arm64", "Stark Code.app", "Contents", "Resources")
      : path.join(stageDistDir, `${platform}-unpacked`, "resources");
  const resource = DESKTOP_EXTRA_RESOURCES[0];
  const source = path.join(root, resource.from);
  const files = {
    "stark-workbench/.claude-plugin/plugin.json": '{"name":"stark-workbench"}',
    "stark-workbench/.stark-bundle.json": "{}",
    "stark-workbench/hooks/hooks.json": "{}",
    "stark-workbench/packages/spage/bin/spage.js": "module.exports = require('markdown-it');",
    "stark-workbench/node_modules/markdown-it/package.json": '{"main":"index.js"}',
    "stark-workbench/node_modules/markdown-it/index.js": "module.exports = 'rendering works';",
    "stark-workbench/node_modules/@stark/runtime/package.json": '{"name":"@stark/runtime"}',
    "not-part-of-kit/private.txt": "do not ship",
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(source, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  }
  yield* Effect.tryPromise(() =>
    resourceCopier.copyFiles([
      new resourceCopier.FileMatcher(source, path.join(resources, resource.to), (value) => value, [
        ...resource.filter,
      ]),
    ]),
  );
  return { root, stageDistDir, resources, platform, productName: "Stark Code" };
});

it.effect.each(["mac", "linux", "win"] as const)(
  "preserves a runnable Workbench kit in the %s packaged resources",
  (platform) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeFixture(platform);
        const roots = yield* validatePackagedStarkWorkbench(fixture);
        assert.lengthOf(roots, 1);
        const kit = roots[0]!;
        const packagedRequire = NodeModule.createRequire(
          path.join(kit, "packages/spage/bin/spage.js"),
        );
        assert.equal(packagedRequire("./spage.js"), "rendering works");
        assert.isTrue(yield* fs.exists(path.join(kit, "node_modules/@stark/runtime/package.json")));
        assert.isFalse(yield* fs.exists(path.join(fixture.resources, "not-part-of-kit")));
        yield* fs.remove(path.join(kit, "node_modules"), { recursive: true });
        assert.instanceOf(
          yield* Effect.flip(validatePackagedStarkWorkbench(fixture)),
          StarkWorkbenchUnavailableError,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a package without an unpacked Workbench payload", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stageDistDir = yield* fs.makeTempDirectoryScoped({ prefix: "stark-no-workbench-" });
      assert.instanceOf(
        yield* Effect.flip(
          validatePackagedStarkWorkbench({
            stageDistDir,
            platform: "mac",
            productName: "Stark Code",
          }),
        ),
        PackagedStarkWorkbenchMissingError,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
