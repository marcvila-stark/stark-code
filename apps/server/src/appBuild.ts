// @effect-diagnostics nodeBuiltinImport:off - The packaged app's package.json is read synchronously from the bundle this process runs in.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import packageJson from "../package.json" with { type: "json" };

/**
 * The Stark Code build this process belongs to: the app version and commit
 * that backups, restores and the recovery hold name.
 *
 * The server package keeps its own version (`apps/server/package.json`),
 * which is not the app's. A packaged desktop app runs this server, and its
 * bundled `stark-code` CLI through the launcher in `<Stark home>/bin`, from
 * inside its asar archive. That archive's top-level package.json is the one
 * the release build stages (`name: "starkcode"`, the app `version`,
 * `starkcodeCommitHash`), and the server sits at `apps/server/{dist,src}`
 * under it, so the bundle root is three levels above this module.
 *
 * The bundle wins over `STARK_CODE_APP_VERSION`: the desktop app sets that
 * variable for its backend, and shells the backend starts inherit it, so a
 * CLI run from such a shell after the app was replaced would otherwise name
 * the old app. Development has no staged package.json and falls back to the
 * variable, then to the server package version; its commit is always null.
 */
export interface AppBuild {
  readonly version: string;
  /** The full commit hash baked into a packaged build; null in development. */
  readonly commit: string | null;
  readonly source: "bundle" | "environment" | "server-package";
}

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

const StagedPackageJson = Schema.Struct({
  name: Schema.Literal("starkcode"),
  version: Schema.String,
  starkcodeCommitHash: Schema.optional(Schema.String),
});
const decodeStagedPackageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(StagedPackageJson),
);

/** The packaged app root (the asar archive) for a module in `apps/server/{dist,src}`. */
export const bundleRootFor = (moduleDirectory: string) =>
  NodePath.resolve(moduleDirectory, "..", "..", "..");

/** The version and commit the release build staged at `bundleRoot`, or null outside a packaged app. */
export function readBundledAppBuild(
  bundleRoot: string,
): { readonly version: string; readonly commit: string | null } | null {
  let text: string;
  try {
    text = NodeFS.readFileSync(NodePath.join(bundleRoot, "package.json"), "utf8");
  } catch {
    return null;
  }
  return Option.match(decodeStagedPackageJson(text), {
    onNone: () => null,
    onSome: (staged) => {
      const version = staged.version.trim();
      if (version.length === 0) return null;
      const commit = staged.starkcodeCommitHash?.trim() ?? "";
      return {
        version,
        commit: COMMIT_HASH_PATTERN.test(commit) ? commit.toLowerCase() : null,
      };
    },
  });
}

export function resolveAppBuild(input: {
  readonly bundled: ReturnType<typeof readBundledAppBuild>;
  readonly environmentVersion: string | undefined;
  readonly packageVersion: string;
}): AppBuild {
  if (input.bundled !== null) return { ...input.bundled, source: "bundle" };
  const environmentVersion = input.environmentVersion?.trim() ?? "";
  if (environmentVersion.length > 0) {
    return { version: environmentVersion, commit: null, source: "environment" };
  }
  return { version: input.packageVersion, commit: null, source: "server-package" };
}

/** The commit to record next to `version`: this bundle's, only when `version` is this bundle's. */
export const commitFor = (build: AppBuild, version: string): string | null =>
  build.source === "bundle" && build.version === version ? build.commit : null;

/** Where the staged package.json is looked for; tests point it at a fake bundle. */
export class AppBundleRoot extends Context.Reference<string>("stark-code/appBuild/AppBundleRoot", {
  defaultValue: () => bundleRootFor(import.meta.dirname),
}) {}

/** This process's app build. */
export const current: Effect.Effect<AppBuild> = Effect.gen(function* () {
  const bundleRoot = yield* AppBundleRoot;
  const environmentVersion = yield* Config.option(Config.String("STARK_CODE_APP_VERSION")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  return resolveAppBuild({
    bundled: readBundledAppBuild(bundleRoot),
    environmentVersion: Option.getOrUndefined(environmentVersion),
    packageVersion: packageJson.version,
  });
});
