import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as StarkProjectFileLoader from "./StarkProjectFileLoader.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(StarkProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "starkcode-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (cwd: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, "stark.json"), contents).pipe(Effect.orDie);
});

it.layer(layerTest)("StarkProjectFileLoader", (it) => {
  describe("load", () => {
    it.effect("loads and decodes a valid stark.json", () =>
      Effect.gen(function* () {
        const loader = yield* StarkProjectFileLoader.StarkProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect("returns none when stark.json is missing", () =>
      Effect.gen(function* () {
        const loader = yield* StarkProjectFileLoader.StarkProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* StarkProjectFileLoader.StarkProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* StarkProjectFileLoader.StarkProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "scripts": [{ "name": "Dev" }] }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
