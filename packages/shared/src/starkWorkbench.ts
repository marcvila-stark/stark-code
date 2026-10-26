import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { tokenizeCliArgs } from "./cliArgs.ts";

export const STARK_WORKBENCH_ROOT_ENV = "STARK_WORKBENCH_ROOT";
export const STARK_WORKBENCH_NODE_ENV = "STARK_WORKBENCH_NODE";
export const STARK_WORKBENCH_RESOURCE = "stark-workbench";
const decodePluginManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

export class StarkWorkbenchUnavailableError extends Schema.TaggedError<StarkWorkbenchUnavailableError>()(
  "StarkWorkbenchUnavailableError",
  { root: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `The bundled Stark Workbench kit is missing or invalid at ${this.root}. Rebuild or reinstall Stark Code.`;
  }
}

/** Validate the app-owned resource before passing it to Claude or running spage. */
export const validateStarkWorkbenchRoot = Effect.fn("validateStarkWorkbenchRoot")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!path.isAbsolute(root)) return yield* new StarkWorkbenchUnavailableError({ root });
    const manifest = yield* decodePluginManifest(
      yield* fs.readFileString(path.join(root, ".claude-plugin/plugin.json")),
    );
    if (manifest.name !== "stark-workbench")
      return yield* new StarkWorkbenchUnavailableError({ root });
    for (const relative of [
      "packages/spage/bin/spage.js",
      "hooks/hooks.json",
      "node_modules/markdown-it/package.json",
      ".stark-bundle.json",
    ]) {
      if (!(yield* fs.exists(path.join(root, relative))))
        return yield* new StarkWorkbenchUnavailableError({ root });
    }
    return root;
  },
  (effect, root) =>
    effect.pipe(Effect.mapError((cause) => new StarkWorkbenchUnavailableError({ root, cause }))),
);

export const resolveStarkWorkbenchRoot = Effect.fn("resolveStarkWorkbenchRoot")(function* (
  environment: Readonly<Record<string, string | undefined>>,
) {
  const root = environment[STARK_WORKBENCH_ROOT_ENV];
  return root ? yield* validateStarkWorkbenchRoot(root) : undefined;
});

export function starkWorkbenchEnvironment(root: string, nodeExecutable: string) {
  return {
    [STARK_WORKBENCH_ROOT_ENV]: root,
    [STARK_WORKBENCH_NODE_ENV]: nodeExecutable,
    STARK_WORKBENCH_MANAGED_MIRROR: "1",
  } as const;
}

/** Keep every user plugin; a flag map would discard repeated --plugin-dir values. */
export function claudePluginArguments(launchArgs: string | undefined) {
  const tokens = tokenizeCliArgs(launchArgs);
  const args: string[] = [];
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--") break;
    if (token.startsWith("--plugin-dir=")) {
      const value = token.slice("--plugin-dir=".length);
      if (value) paths.push(value);
    } else if (token === "--plugin-dir") {
      while (tokens[index + 1] && !tokens[index + 1]!.startsWith("-")) paths.push(tokens[++index]!);
    } else {
      args.push(token);
    }
  }
  return { args, paths: [...new Set(paths)] };
}
