import {
  claudeModelEnvironment,
  isOpenRouterEnvironment,
  OPENROUTER_BASE_URL,
} from "@starkfuture/shared/claudeModelPolicy";
import type { ClaudeSettings } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@starkfuture/provider-core/server/pathExpansion";
import * as HostProcess from "@starkfuture/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * Resolve the Claude config directory the CLI would use: the instance's
 * `homePath` (exported as `CLAUDE_CONFIG_DIR`), then an inherited
 * `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Empty must not
 * fall back to bare `$HOME` — that leftover from the old HOME override
 * produced a different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Pick<Partial<ClaudeSettings>, "apiBackend">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath =
    config.homePath.trim() ||
    (config.apiBackend === "openrouter" || isOpenRouterEnvironment(environment ?? {})
      ? "~/.stark-code/openrouter/default"
      : "");
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Pick<Partial<ClaudeSettings>, "apiBackend">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = claudeModelEnvironment({
    ...(baseEnv ?? process.env),
    ...(config.apiBackend === "openrouter" ? { ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL } : {}),
  });
  const gateway = config.apiBackend === "openrouter" || isOpenRouterEnvironment(resolvedBaseEnv);
  const homePath = config.homePath.trim();
  if (homePath.length === 0 && !gateway) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config, resolvedBaseEnv);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/** Whether this instance uses the normal local Claude login directory. */
export const usesSharedClaudeLoginHome = Effect.fn("usesSharedClaudeLoginHome")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Pick<Partial<ClaudeSettings>, "apiBackend">,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<boolean, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const resolvedHome = yield* resolveClaudeHomePath(config, environment);
  if (resolvedHome !== path.resolve(home, ".claude")) return false;
  if (environment.HOME?.trim() && path.resolve(environment.HOME) !== path.resolve(home))
    return false;
  return ![
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].some((name) => Boolean(environment[name]?.trim()));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath"> & Pick<Partial<ClaudeSettings>, "apiBackend">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};

const ClaudeAccountMetadata = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({ organizationUuid: Schema.optional(Schema.String) }),
  ),
});

const decodeClaudeAccountMetadata = Schema.decodeEffect(
  Schema.fromJsonString(ClaudeAccountMetadata),
);

/** Reads only non-secret organization identity; tokens remain owned by Claude Code. */
export const readClaudeOrganizationId = (accountConfigPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(accountConfigPath);
    const config = yield* decodeClaudeAccountMetadata(text);
    return config.oauthAccount?.organizationUuid?.trim() || undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

export const claudeAccountConfigPath = Effect.fn("claudeAccountConfigPath")(function* (
  configDir: string | undefined,
) {
  const path = yield* Path.Path;
  return configDir
    ? path.join(configDir, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
});
