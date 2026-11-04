import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@starkfuture/contracts";
import { resolveServerBackgroundActivitySettings } from "@starkfuture/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderHost from "./ProviderHost.ts";
import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";
import type { ManagedServerProvider } from "./snapshot.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
  readonly accountGeneration: number;
}

function withUsageLimits(
  snapshot: ServerProvider,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  if (snapshot.usageLimits === usageLimits) {
    return snapshot;
  }
  const { usageLimits: _previous, ...rest } = snapshot;
  return usageLimits ? { ...rest, usageLimits } : rest;
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly resolveMaintenance: ManagedServerProvider["resolveMaintenance"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
  readonly refreshOnInterval?: boolean;
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean;
}): Effect.fn.Return<
  ManagedServerProvider,
  ServerSettingsError,
  Scope.Scope | ProviderHost.ProviderHost
> {
  const host = yield* ProviderHost.ProviderHost;
  const refreshSemaphore = yield* Semaphore.make(1);
  // Serialize only state commits and their notifications. Account invalidation
  // must not wait for a network probe, but must follow its last publication.
  const publicationSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
    accountGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    yield* publicationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
          if (state.enrichmentGeneration !== generation) {
            return [null, state] as const;
          }
          // Enrichment derives from the snapshot it was handed; a runtime usage
          // update that landed since must not be reverted by it.
          const merged = withUsageLimits(nextSnapshot, state.snapshot.usageLimits);
          if (Equal.equals(state.snapshot, merged)) {
            return [null, state] as const;
          }
          return [merged, { ...state, snapshot: merged }] as const;
        });
        if (snapshotToPublish === null) {
          return;
        }
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
      }),
    );
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    // Enrichment resolves binaries and package-manager state, which a disabled
    // provider has no use for.
    if (!input.enrichSnapshot || !snapshot.enabled) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    if (
      !forceRefresh &&
      input.checkProviderOnSettingsChange?.(previousSettings, nextSettings) === false
    ) {
      const state = yield* publicationSemaphore.withPermits(1)(
        Ref.updateAndGet(snapshotStateRef, (current) => ({
          ...current,
          enrichmentGeneration: current.enrichmentGeneration + 1,
        })),
      );
      const nextGeneration = state.enrichmentGeneration;
      yield* Ref.set(settingsRef, nextSettings);
      yield* restartSnapshotEnrichment(nextSettings, state.snapshot, nextGeneration);
      return state.snapshot;
    }

    const accountGeneration = (yield* Ref.get(snapshotStateRef)).accountGeneration;
    const probedSnapshot = yield* input.checkProvider;
    const publication = yield* publicationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* Ref.modify(
          snapshotStateRef,
          (
            state,
          ): readonly [
            {
              readonly snapshot: ServerProvider;
              readonly generation: number;
              readonly discarded: boolean;
            },
            ProviderSnapshotState,
          ] => {
            if (state.accountGeneration !== accountGeneration) {
              return [
                {
                  snapshot: state.snapshot,
                  generation: state.enrichmentGeneration,
                  discarded: true,
                },
                state,
              ] as const;
            }
            const generation = input.enrichSnapshot
              ? state.enrichmentGeneration + 1
              : state.enrichmentGeneration;
            // A failed read keeps the last good limits only for the same account,
            // and they keep the workspace they were read for.
            const previous = state.snapshot.auth;
            const email = probedSnapshot.auth.email?.trim().toLowerCase();
            const previousEmail = previous.email?.trim().toLowerCase();
            const fingerprint = probedSnapshot.usageLimits?.credentialFingerprint;
            const previousFingerprint = state.snapshot.usageLimits?.credentialFingerprint;
            // A lost identity is not proof that the old quota belongs to this login.
            const switchedAccount =
              previous.status !== "authenticated" ||
              probedSnapshot.auth.status !== "authenticated" ||
              email !== previousEmail ||
              probedSnapshot.auth.workspaceId !== previous.workspaceId ||
              (fingerprint !== undefined &&
                previousFingerprint !== undefined &&
                fingerprint !== previousFingerprint) ||
              // A failed usage read may omit its optional fingerprint. Retain only
              // when auth still identifies the same account, or fingerprints match.
              !(
                probedSnapshot.auth.workspaceId ||
                (email &&
                  previous.workspaceId === undefined &&
                  previousFingerprint === undefined) ||
                (fingerprint && fingerprint === previousFingerprint)
              );
            const usageLimits = switchedAccount
              ? probedSnapshot.usageLimits
              : resolveUsageLimitsAfterProbe({
                  published: state.snapshot.usageLimits,
                  probed: probedSnapshot.usageLimits,
                });
            const snapshot = withUsageLimits(probedSnapshot, usageLimits);
            return [
              { snapshot, generation, discarded: false },
              { ...state, snapshot, enrichmentGeneration: generation },
            ] as const;
          },
        );
        if (!result.discarded) yield* PubSub.publish(changesPubSub, result.snapshot);
        return result;
      }),
    );
    const { snapshot: nextSnapshot, generation: nextGeneration, discarded } = publication;
    if (discarded) return nextSnapshot;
    yield* Ref.set(settingsRef, nextSettings);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  // Do not wait for the refresh semaphore: the old account's initialization
  // may still be running. Hide its identity and quota immediately and reject
  // its eventual result before beginning the new account's probe.
  const invalidateAccount = Effect.gen(function* () {
    const snapshot = yield* Ref.modify(snapshotStateRef, (state) => {
      const next: ServerProvider = {
        ...withUsageLimits(state.snapshot, undefined),
        auth: { status: "unknown" },
        status: "warning",
        message: "Checking account after organization switch…",
      };
      return [
        next,
        {
          snapshot: next,
          enrichmentGeneration: state.enrichmentGeneration + 1,
          accountGeneration: state.accountGeneration + 1,
        },
      ] as const;
    });
    yield* PubSub.publish(changesPubSub, snapshot);
  }).pipe(publicationSemaphore.withPermits(1));

  /**
   * Runtime usage updates arrive between probes. They patch only
   * `usageLimits` on whatever snapshot is published and leave the enrichment
   * generation alone, so an in-flight enrichment still lands.
   */
  const applyUsageLimits: ManagedServerProvider["applyUsageLimits"] = (update) =>
    Effect.gen(function* () {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
        const usageLimits = applyUsageLimitsUpdate({
          previous: state.snapshot.usageLimits,
          update,
          checkedAt: update.checkedAt,
        });
        // `applyUsageLimitsUpdate` hands back the same object when nothing
        // moved, which is the common case for Codex's per-tick notification.
        if (usageLimits === state.snapshot.usageLimits) {
          return [null, state] as const;
        }
        const snapshot = withUsageLimits(state.snapshot, usageLimits);
        return [snapshot, { ...state, snapshot }] as const;
      });
      if (snapshotToPublish !== null) {
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
      }
    }).pipe(publicationSemaphore.withPermits(1));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  const hasProviderStatusDemand = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      host.shouldRunBackgroundWork({ type: "provider-status" }),
      host.shouldRunBackgroundWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : host.settings.get.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* host.settings.subscribe;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    getRefreshInterval.pipe(
      Effect.flatMap((refreshInterval) =>
        // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - races the interval against a settings-change signal, not a timeout
        Effect.raceFirst(
          Effect.sleep(
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) <= 0
              ? "60 seconds"
              : refreshInterval,
          ).pipe(Effect.as(true)),
          Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((intervalElapsed) =>
            input.refreshOnInterval !== false &&
            intervalElapsed &&
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) > 0
              ? hasProviderStatusDemand.pipe(
                  Effect.flatMap((shouldRefresh) =>
                    shouldRefresh ? refreshSnapshot().pipe(Effect.asVoid) : Effect.void,
                  ),
                )
              : Effect.void,
          ),
        ),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    resolveMaintenance: input.resolveMaintenance,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    invalidateAccount,
    applyUsageLimits,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ManagedServerProvider;
});
