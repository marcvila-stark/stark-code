/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind } from "@starkfuture/contracts";
import {
  isOpenRouterEnvironment,
  OPENROUTER_BASE_URL,
} from "@starkfuture/shared/claudeModelPolicy";
import {
  checkOpenRouterKey,
  fetchOpenRouterModelCatalog,
  OPENROUTER_FALLBACK_CATALOG,
} from "../OpenRouterModelCatalog.ts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as ProviderLatestVersions from "@starkfuture/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@starkfuture/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@starkfuture/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@starkfuture/provider-core/server/ProviderEventLoggers";
import {
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import { claudeUsageReader } from "./claudeUsage.ts";
import { makeClaudeScopedLimitNames } from "../claudeUsageLimits.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
} from "../ClaudeProvider.ts";
import { makeManagedServerProvider } from "@starkfuture/provider-core/server/managedProvider";
import type { ManagedServerProvider } from "@starkfuture/provider-core/server/snapshot";
import * as ModelCatalog from "@starkfuture/provider-core/server/ModelCatalog";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@starkfuture/provider-core/server/driver";
import { withInstanceIdentity } from "@starkfuture/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@starkfuture/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@starkfuture/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@starkfuture/provider-core/server/snapshotSettings";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  resolveClaudeHomePath,
  usesSharedClaudeLoginHome,
  claudeAccountConfigPath,
  readClaudeOrganizationId,
} from "./ClaudeHome.ts";
import * as HostProcess from "@starkfuture/shared/HostProcess";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

/** A live CLI keeps its login even when the provider's active organization changes. */
export const makeClaudeUsagePublisher = Effect.fn("makeClaudeUsagePublisher")(function* (
  publish: ManagedServerProvider["applyUsageLimits"],
) {
  const generation = yield* Ref.make(0);
  const lock = yield* Semaphore.make(1);
  return {
    capture: Effect.gen(function* () {
      const capturedGeneration = yield* Ref.get(generation);
      return (update: Parameters<typeof publish>[0]) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if ((yield* Ref.get(generation)) === capturedGeneration) yield* publish(update);
          }),
        );
    }),
    // Serialize invalidation with the entire publication, not just the check.
    invalidate: lock.withPermits(1)(Ref.update(generation, (current) => current + 1)),
  };
});

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  usage: claudeUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const catalogService = yield* ModelCatalog.ModelCatalog;
      const processEnv = { ...(yield* mergeProviderInstanceEnvironment(environment)) };
      const openRouter = config.apiBackend === "openrouter" || isOpenRouterEnvironment(processEnv);
      if (openRouter) {
        processEnv.ANTHROPIC_BASE_URL = OPENROUTER_BASE_URL;
        // Do not silently borrow a credential from the process that launched Stark Code.
        processEnv.ANTHROPIC_AUTH_TOKEN =
          environment?.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")?.value ?? "";
      }
      const openRouterCatalog = yield* Cache.make({
        capacity: 1,
        timeToLive: Duration.minutes(15),
        lookup: () =>
          fetchOpenRouterModelCatalog().pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.catch(() => Effect.succeed(OPENROUTER_FALLBACK_CATALOG)),
          ),
      });
      const modelCatalog = openRouter
        ? Cache.get(openRouterCatalog, "models")
        : catalogService.current(DRIVER_KIND).pipe(Effect.map(resolveClaudeModelCatalog));
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = {
        ...config,
        ...(openRouter && !config.homePath.trim()
          ? { homePath: `~/.stark-code/openrouter/${instanceId}` }
          : {}),
        enabled,
        binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      } satisfies ClaudeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
      );
      const configDir = yield* resolveClaudeHomePath(effectiveConfig, processEnv);
      const accountConfigPath = yield* claudeAccountConfigPath(
        effectiveConfig.homePath.trim() || processEnv.CLAUDE_CONFIG_DIR?.trim()
          ? configDir
          : undefined,
      );
      const sharedLoginHome = yield* usesSharedClaudeLoginHome(effectiveConfig, processEnv);
      const stampInstanceIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: displayName ?? (openRouter ? "OpenRouter" : undefined),
        accentColor,
        continuationGroupKey,
      });
      const stampIdentity = (snapshot: Parameters<typeof stampInstanceIdentity>[0]) => ({
        ...stampInstanceIdentity(snapshot),
        ...(openRouter
          ? {
              apiBackend: "openrouter" as const,
              auth: { status: snapshot.auth.status, type: "apiKey", label: "OpenRouter API key" },
              usageLimits: undefined,
              ...(snapshot.setup
                ? {
                    setup: {
                      ...snapshot.setup,
                      canAuthenticate: false,
                      documentationUrl:
                        "https://openrouter.ai/docs/guides/guides/claude-code-integration",
                    },
                  }
                : {}),
            }
          : {}),
        usesSharedClaudeLogin:
          !openRouter &&
          sharedLoginHome &&
          snapshot.auth.status === "authenticated" &&
          snapshot.auth.type !== "apiKey" &&
          snapshot.auth.type !== "bedrock",
      });

      const scopedLimitNames = yield* makeClaudeScopedLimitNames;
      const usagePublisher = yield* makeClaudeUsagePublisher((update) =>
        openRouter ? Effect.void : snapshot.applyUsageLimits(update),
      );
      const orchestrationAdapter = yield* createClaudeAdapterV2(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config: effectiveConfig,
        },
        { scopedLimitNames, captureUsageLimits: usagePublisher.capture },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Claude orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
      );

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          Effect.all([
            probeClaudeCapabilities(effectiveConfig, processEnv, cwd, !openRouter),
            openRouter ? Effect.succeed(undefined) : readClaudeOrganizationId(accountConfigPath),
          ]).pipe(
            Effect.map(([capabilities, workspaceId]) =>
              capabilities && workspaceId ? { ...capabilities, workspaceId } : capabilities,
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
        effectiveConfig,
        cwd,
        processEnv,
      );

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest after the background fetch lands.
      const checkProvider = catalogService.refreshInBackground.pipe(
        Effect.andThen(
          modelCatalog.pipe(
            Effect.flatMap((catalog) =>
              checkClaudeProviderStatus(
                effectiveConfig,
                () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
                processEnv,
                cwd,
                catalog,
                scopedLimitNames,
              ),
            ),
            Effect.flatMap((snapshot) => {
              if (
                !openRouter ||
                !snapshot.enabled ||
                !snapshot.installed ||
                snapshot.version === null
              )
                return Effect.succeed(snapshot);
              return checkOpenRouterKey(processEnv.ANTHROPIC_AUTH_TOKEN ?? "").pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.map((keyStatus) => ({
                  ...snapshot,
                  auth: {
                    status:
                      keyStatus === "valid"
                        ? ("authenticated" as const)
                        : keyStatus === "unavailable"
                          ? ("unknown" as const)
                          : ("unauthenticated" as const),
                  },
                  status:
                    keyStatus === "valid"
                      ? ("ready" as const)
                      : keyStatus === "unavailable"
                        ? ("warning" as const)
                        : ("error" as const),
                  message:
                    keyStatus === "valid"
                      ? undefined
                      : keyStatus === "missing"
                        ? "Add an OpenRouter API key in Agents & accounts."
                        : keyStatus === "invalid"
                          ? "OpenRouter rejected this API key. Replace it in Agents & accounts."
                          : "Could not reach OpenRouter to verify the API key. Try again when connected.",
                })),
              );
            }),
            Effect.map(stampIdentity),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          modelCatalog.pipe(
            Effect.flatMap((catalog) => makePendingClaudeProvider(settings.provider, catalog)),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot: {
          ...snapshot,
          // A fresh probe of the same account must keep its live CLI publisher.
          // Only a real login/organization change retires that process's usage.
          invalidateAccount: usagePublisher.invalidate.pipe(
            Effect.andThen(snapshot.invalidateAccount ?? Effect.void),
          ),
        },
        invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache),
        snapshotForCwd: (cwd: string) =>
          snapshot.getSnapshot.pipe(
            Effect.flatMap((machineSnapshot) =>
              probeClaudeWorkspaceSnapshot(effectiveConfig, machineSnapshot, cwd, processEnv),
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
