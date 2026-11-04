import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { isClaudeHaikuModel } from "@starkfuture/shared/claudeModelPolicy";
import { createModelCapabilities } from "@starkfuture/shared/model";
import { resolveSpawnCommand } from "@starkfuture/shared/shell";
import { resolveStarkWorkbenchRoot } from "@starkfuture/shared/starkWorkbench";
import {
  filterEscalatingDefaultMode,
  query as claudeQuery,
  resolveSettings,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type ResolvedSettings,
  type ResolvedSettingSource,
  type SlashCommand as ClaudeSlashCommand,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@starkfuture/provider-core/server/snapshotProbe";
import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import {
  CLAUDE_BYPASS_OPT_IN_POLICY,
  CLAUDE_CHILD_BYPASS_POLICY,
  type ClaudeStarkPolicy,
} from "../orchestration-v2/Adapters/ApprovalRulePolicy.ts";
import { discoverClaudeSkills } from "./Drivers/ClaudeSkills.ts";
import {
  CLAUDE_PLUGIN_PERMISSION_WARNING,
  discoverClaudeBundledSkills,
} from "./Drivers/ClaudeSessionCatalog.ts";
import type { ProviderWorkspaceSnapshot } from "@starkfuture/provider-core/server/driver";
import { makeUnavailableUsageLimits } from "@starkfuture/provider-core/server/usageLimits";
import {
  type ClaudeScopedLimitNames,
  claudeUsageResponseToLimits,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  resolveClaudeModelsForVersion,
  resolveClaudeUpdateRequiredModels,
} from "./ClaudeModelCatalog.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
  // The adapter omits permissionMode for a chat that inherits the profile's own settings.
  nativePermissionInherit: true,
} as const;
function claudePresentation(settings: ClaudeSettings) {
  return {
    ...CLAUDE_PRESENTATION,
    supportedRuntimeModes: [
      "approval-required" as const,
      "auto-accept-edits" as const,
      "auto" as const,
      ...(settings.allowBypassPermissions === true ? ["full-access" as const] : []),
    ],
  };
}
function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

/**
 * Whether the SDK's account payload evidences a credential the CLI can use.
 *
 * The capability probe resolves for a logged-out CLI, so a completed probe only
 * proves Claude Code started. `tokenSource: "none"` is the CLI reporting it
 * found no token at all, and is the one shape that disproves authentication.
 * Everything else either names a credential or, on a third-party backend, omits
 * these fields by design because auth lives with AWS or gcloud instead.
 *
 * Silence is deliberately not disproof. Profile-authenticated installs report no
 * token source, and a CLI too old to send an account payload reports nothing at
 * all; treating either as logged out would sign working setups out of Settings.
 * `apiKeySource: "none"` means no API key is in use, so it is no evidence either.
 */
function claudeAuthStatus(
  capabilities: Pick<
    ClaudeCapabilitiesProbe,
    "email" | "subscriptionType" | "tokenSource" | "apiKeySource" | "apiProvider"
  >,
): "authenticated" | "unauthenticated" {
  if (capabilities.apiProvider !== undefined && capabilities.apiProvider !== "firstParty") {
    return "authenticated";
  }
  if (capabilities.tokenSource !== "none") return "authenticated";
  // An `ANTHROPIC_API_KEY` install reports no token source but is authenticated
  // all the same, so the key and account fields still get a say.
  const hasApiKey = Boolean(capabilities.apiKeySource) && capabilities.apiKeySource !== "none";
  return hasApiKey || capabilities.email || capabilities.subscriptionType
    ? "authenticated"
    : "unauthenticated";
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  readonly workbenchRoot?: string;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    tools: [],
    allowedTools: [],
    ...(input.workbenchRoot
      ? { plugins: [{ type: "local" as const, path: input.workbenchRoot }] }
      : {}),
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config.
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // This is a noninteractive health check, so IDE discovery cannot add any
      // useful capability data. Skipping it also avoids Claude spawning a
      // Windows `tasklist | findstr` process tree on every periodic refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  /**
   * The organization UUID from the login's `.claude.json`. The driver reads it
   * in the same cached probe, so it describes the same login as the rest.
   */
  readonly workspaceId?: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /** Where the CLI found an API key, when it authenticates with one. */
  readonly apiKeySource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly bundledSkills?: ReadonlyArray<ServerProviderSkill>;
  /**
   * Subscription windows from the SDK's `get_usage` control request, or
   * `undefined` when the request itself failed. Absent windows on an
   * otherwise successful response mean the account has none (API key).
   */
  readonly usage?: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  /** Time of the usage request, retained when the capabilities cache is reused. */
  readonly usageCheckedAt?: string;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  includeUsage = true,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    const workbenchRoot = yield* resolveStarkWorkbenchRoot(claudeEnvironment).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment: claudeEnvironment,
          cwd,
          ...(workbenchRoot ? { workbenchRoot } : {}),
        }),
      });
      const init = await q.initializationResult();
      return { q, init, workbenchRoot, claudeEnvironment };
    });
  }).pipe(
    Effect.timeout(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.tapError((error) =>
      Effect.logWarning("Claude capability initialization did not complete.", {
        // CLI errors can include credentials or private server URLs. Keep only
        // the bounded failure category; this is not evidence of an expired login.
        reason: error._tag === "TimeoutError" ? "timeout" : "initialization_failed",
        timeoutMs: CAPABILITIES_PROBE_TIMEOUT_MS,
      }),
    ),
    Effect.flatMap(({ q, init, workbenchRoot, claudeEnvironment }) =>
      Effect.gen(function* () {
        const slashCommands = parseClaudeInitializationCommands(init.commands);
        const commandNames = new Set(slashCommands.map((command) => command.name));
        // Disk metadata enriches only names actually accepted by the CLI's
        // initialization. Trust/disable decisions never come from the scan.
        const bundledSkills = workbenchRoot
          ? (yield* discoverClaudeBundledSkills(claudeSettings, cwd, claudeEnvironment)).filter(
              (skill) => commandNames.has(skill.name),
            )
          : undefined;
        // Usage has its own deadline so a slow optional request cannot discard initialization.
        // Only the rate limits are read, so skip the local transcript scan that fills
        // `behaviors`: with a few GB of transcripts it outlasts the deadline.
        const usageResult = includeUsage
          ? yield* Effect.tryPromise(() =>
              q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
            ).pipe(Effect.timeout(DEFAULT_TIMEOUT_MS), Effect.result)
          : undefined;
        const usage =
          usageResult && Result.isSuccess(usageResult)
            ? {
                rate_limits_available: usageResult.success.rate_limits_available,
                rate_limits: usageResult.success.rate_limits,
              }
            : undefined;
        const account = init.account as
          | {
              readonly email?: string;
              readonly subscriptionType?: string;
              readonly tokenSource?: string;
              readonly apiKeySource?: string;
              readonly apiProvider?: string;
            }
          | undefined;
        return {
          email: account?.email,
          subscriptionType: account?.subscriptionType,
          tokenSource: account?.tokenSource,
          apiKeySource: account?.apiKeySource,
          apiProvider: account?.apiProvider,
          slashCommands: slashCommands.map((command): ServerProviderSlashCommand =>
            workbenchRoot && command.name.startsWith("stark-workbench:")
              ? {
                  ...command,
                  source: "plugin",
                  sourceName: "stark-workbench",
                  permissionWarning: CLAUDE_PLUGIN_PERMISSION_WARNING,
                }
              : command,
          ),
          ...(bundledSkills ? { bundledSkills } : {}),
          ...(usage ? { usage } : {}),
          ...(includeUsage ? { usageCheckedAt: DateTime.formatIso(yield* DateTime.now) } : {}),
        } satisfies ClaudeCapabilitiesProbe;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.result,
    Effect.map((result) => (Result.isSuccess(result) ? result.success : undefined)),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

/** Read commands from the same cwd Claude uses for a workspace session. */
export const probeClaudeWorkspaceSnapshot = Effect.fn("probeClaudeWorkspaceSnapshot")(function* (
  claudeSettings: ClaudeSettings,
  machineSnapshot: ServerProvider,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ProviderWorkspaceSnapshot, never, FileSystem.FileSystem | Path.Path> {
  if (!claudeSettings.enabled) return machineSnapshot;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, environment);
  const capabilities = yield* probeClaudeCapabilities(claudeSettings, environment, cwd, false);
  return {
    ...machineSnapshot,
    skills: [...skills, ...(capabilities?.bundledSkills ?? [])],
    slashCommands: dedupeSlashCommands([
      COMPACT_SLASH_COMMAND,
      ...(capabilities?.slashCommands ?? []),
    ]),
    slashCommandsPending: !capabilities,
  };
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  /** Shared with the adapter so turn events reuse the scoped-bucket names this probe saw. */
  scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
  /** Banked resets for a subscription login, given the CLI version for the user agent. */
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    modelCatalog.models.map((entry) => entry.model),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  ).filter((model) => !isClaudeHaikuModel(model.slug));

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: claudePresentation(claudeSettings),
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in Stark Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: claudePresentation(claudeSettings),
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: claudePresentation(claudeSettings),
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: claudePresentation(claudeSettings),
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    resolveClaudeModelsForVersion(modelCatalog, parsedVersion),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  ).filter((model) => !isClaudeHaikuModel(model.slug));
  const updateRequiredModels = resolveClaudeUpdateRequiredModels(modelCatalog, parsedVersion);
  const versionUpgradeMessage = formatClaudeVersionUpgradeMessage(modelCatalog, parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const skills = [
    ...(yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment)),
    ...(capabilities?.bundledSkills ?? []),
  ];
  const slashCommands = [COMPACT_SLASH_COMMAND, ...(capabilities?.slashCommands ?? [])];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: claudePresentation(claudeSettings),
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  if (claudeAuthStatus(capabilities) === "unauthenticated") {
    return buildServerProvider({
      presentation: claudePresentation(claudeSettings),
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Claude Code is not authenticated. Run `claude auth login` and try again.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);
  const usageCheckedAt = capabilities.usageCheckedAt ?? checkedAt;
  const usageLimits = !capabilities.usage
    ? makeUnavailableUsageLimits({ checkedAt: usageCheckedAt, reason: "probeFailed" })
    : scopedLimitNames
      ? yield* recordClaudeUsageResponse(scopedLimitNames, {
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
        })
      : claudeUsageResponseToLimits({ response: capabilities.usage, checkedAt: usageCheckedAt })
          .limits;
  return buildServerProvider({
    presentation: claudePresentation(claudeSettings),
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    updateRequiredModels,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(capabilities.workspaceId ? { workspaceId: capabilities.workspaceId } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
      usageLimits,
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    ).filter((model) => !isClaudeHaikuModel(model.slug));

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: claudePresentation(claudeSettings),
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in Stark Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: claudePresentation(claudeSettings),
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

// ── Configured permission settings ──────────────────────────────────

/** Environment variables that move where Claude reads its settings from. */
const CLAUDE_SETTINGS_LOCATION_ENV = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
] as const;

/**
 * What the selected Claude profile's settings files say about permissions for a launch in
 * `cwd`: the configuration the next Claude process starts from. It is never proof of what a
 * live session does (Claude may have changed mode, the admin's policyHelper is not run, and
 * session grants are not in files), so it is labelled "configured", never "effective".
 */
export type ClaudeConfiguredPermissions = {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId | null;
  readonly cwd: string;
  /** Stark's own rules on top of Claude's, each with the label the UI shows. */
  readonly starkPolicies: ReadonlyArray<ClaudeStarkPolicy>;
  /** Live session rules: the SDK in use exposes no typed way to read them. */
  readonly liveRules: { readonly status: "unknown"; readonly reason: string };
} & (
  | {
      readonly status: "configured";
      readonly label: "configured";
      /** `permissions.defaultMode` after Claude's trust filter for repo-committed settings. */
      readonly defaultMode: PermissionMode | null;
      readonly defaultModeSource: ResolvedSettingSource | null;
      readonly bypassDisabled: boolean;
      /** The highest-precedence settings source that set `disableBypassPermissionsMode`. */
      readonly bypassDisabledSource: ResolvedSettingSource | null;
      readonly hooksDisabled: boolean;
      /** The highest-precedence settings source that set `disableAllHooks`. */
      readonly hooksDisabledSource: ResolvedSettingSource | null;
      readonly rules: { readonly allow: number; readonly ask: number; readonly deny: number };
      /** The same rules by the settings source that holds them, low to high precedence. */
      readonly ruleSources: ReadonlyArray<{
        readonly source: ResolvedSettingSource;
        readonly allow: number;
        readonly ask: number;
        readonly deny: number;
      }>;
      readonly additionalDirectories: ReadonlyArray<string>;
      /** The highest-precedence settings source that adds folders. */
      readonly additionalDirectoriesSource: ResolvedSettingSource | null;
    }
  | { readonly status: "unknown"; readonly reason: string }
);

const CLAUDE_LIVE_RULES_UNKNOWN = {
  status: "unknown",
  reason: "Not reported by Claude SDK 0.3.276.",
} as const;

/** The highest-precedence settings source that sets the value `pick` reads. */
function settingSource(
  resolved: ResolvedSettings,
  pick: (settings: ResolvedSettings["sources"][number]["settings"]) => unknown,
): ResolvedSettingSource | null {
  for (let index = resolved.sources.length - 1; index >= 0; index--) {
    const source = resolved.sources[index]!;
    if (pick(source.settings) !== undefined) return source.source;
  }
  return null;
}

/**
 * Reads the configured permissions of one Claude provider instance, keyed by instance, cwd
 * and session. Claude resolves settings in this process, so only an instance that reads its
 * settings from the same places as the server can be answered; any other is "unknown".
 */
export const readClaudeConfiguredPermissions = Effect.fn("readClaudeConfiguredPermissions")(
  function* (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerSessionId: ProviderSessionId | null;
    readonly cwd: string;
    readonly settings: Pick<ClaudeSettings, "homePath" | "allowBypassPermissions">;
    readonly environment?: NodeJS.ProcessEnv;
    /** The server's own environment, which Claude's in-process resolver reads. */
    readonly serverEnvironment?: NodeJS.ProcessEnv;
    readonly resolve?: typeof resolveSettings;
  }) {
    const key = {
      providerInstanceId: input.providerInstanceId,
      providerSessionId: input.providerSessionId,
      cwd: input.cwd,
      starkPolicies: [
        input.settings.allowBypassPermissions === true
          ? CLAUDE_CHILD_BYPASS_POLICY
          : CLAUDE_BYPASS_OPT_IN_POLICY,
      ],
      liveRules: CLAUDE_LIVE_RULES_UNKNOWN,
    };
    const instanceEnvironment = yield* makeClaudeEnvironment(input.settings, input.environment);
    const serverEnvironment = input.serverEnvironment ?? process.env;
    if (
      CLAUDE_SETTINGS_LOCATION_ENV.some(
        (name) => (instanceEnvironment[name] ?? "") !== (serverEnvironment[name] ?? ""),
      )
    ) {
      return {
        ...key,
        status: "unknown",
        reason:
          "This Claude account keeps its settings in its own folder, which Stark cannot read.",
      } satisfies ClaudeConfiguredPermissions;
    }
    const resolve = input.resolve ?? resolveSettings;
    return yield* Effect.tryPromise(() => resolve({ cwd: input.cwd })).pipe(
      Effect.map((resolved): ClaudeConfiguredPermissions => {
        const filtered = filterEscalatingDefaultMode(resolved);
        const permissions = filtered.permissions;
        const defaultMode = permissions?.defaultMode ?? null;
        return {
          ...key,
          status: "configured",
          label: "configured",
          defaultMode,
          defaultModeSource:
            defaultMode === null
              ? null
              : settingSource(resolved, (settings) => settings.permissions?.defaultMode),
          bypassDisabled: permissions?.disableBypassPermissionsMode === "disable",
          bypassDisabledSource: settingSource(
            resolved,
            (settings) => settings.permissions?.disableBypassPermissionsMode,
          ),
          hooksDisabled: filtered.disableAllHooks === true,
          hooksDisabledSource: settingSource(resolved, (settings) => settings.disableAllHooks),
          rules: {
            allow: permissions?.allow?.length ?? 0,
            ask: permissions?.ask?.length ?? 0,
            deny: permissions?.deny?.length ?? 0,
          },
          ruleSources: resolved.sources.flatMap(({ source, settings }) => {
            const counts = {
              allow: settings.permissions?.allow?.length ?? 0,
              ask: settings.permissions?.ask?.length ?? 0,
              deny: settings.permissions?.deny?.length ?? 0,
            };
            return counts.allow + counts.ask + counts.deny === 0 ? [] : [{ source, ...counts }];
          }),
          additionalDirectories: permissions?.additionalDirectories ?? [],
          additionalDirectoriesSource: settingSource(
            resolved,
            (settings) => settings.permissions?.additionalDirectories,
          ),
        };
      }),
      Effect.orElseSucceed((): ClaudeConfiguredPermissions => ({
        ...key,
        status: "unknown",
        reason: "Claude's settings could not be read.",
      })),
    );
  },
);

export { probeClaudeCapabilities };
