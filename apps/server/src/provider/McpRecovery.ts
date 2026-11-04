import type { McpServerStatusEntry, ProviderDriverKind } from "@starkfuture/contracts";
import * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

type Recovery = NonNullable<McpServerStatusEntry["recovery"]>;
type Episode = {
  attempts: number;
  nextAt: number;
  healthySince?: number;
  state: Recovery["state"];
  vpnState?: Recovery["vpnState"];
};
export type NetworkState =
  | "vpn-off"
  | "network-unavailable"
  | "unknown"
  | { readonly state: "network-unavailable"; readonly vpnState: "forticlient-disconnected" };

/** Session-owned maintenance. The same permit reserves turn starts and direct MCP calls.
 * Status reads never invoke a tool. Only an explicitly targeted reconnect may run here. */
export const make = Effect.fn("McpRecovery.make")(function* (input: {
  readonly api: ProviderAdapter.ProviderAdapterV2McpServers;
  readonly driver: ProviderDriverKind;
  readonly isBusy: Effect.Effect<boolean>;
  readonly inspectNetwork: (server: McpServerStatusEntry) => Effect.Effect<NetworkState>;
}) {
  const gate = yield* Semaphore.make(1);
  const observationGate = yield* Semaphore.make(1);
  const scope = yield* Scope.Scope;
  const episodes = new Map<string, Episode>();
  let snapshot: readonly McpServerStatusEntry[] = [];
  let checking = false;
  let closed = false;
  let maintenancePending = false;
  let maintenanceSettled: Deferred.Deferred<void> | undefined;
  let activeRequests = 0;
  let nextIdleObservationAt = 0;
  let statusUnavailable = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );
  const busyError = () =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: input.driver,
      detail: "Wait for the agent's active tool calls to finish before changing MCP connections.",
    });
  const decorate = () =>
    snapshot.map((server) => {
      const episode = episodes.get(server.name);
      return server.status !== "failed" || !episode
        ? server
        : {
            ...server,
            recovery: {
              state: episode.state,
              attempts: episode.attempts,
              ...(episode.vpnState ? { vpnState: episode.vpnState } : {}),
            },
          };
    });
  const read = Effect.gen(function* () {
    // Visible clients already read status frequently. Background sessions still
    // need an occasional observation after a native transport changes state.
    nextIdleObservationAt = (yield* Clock.currentTimeMillis) + 60_000;
    const rows = yield* input.api.list().pipe(Effect.timeout(input.api.statusTimeoutMs ?? 3_000));
    const now = yield* Clock.currentTimeMillis;
    snapshot = rows;
    statusUnavailable = false;
    const names = new Set(rows.map((row) => row.name));
    for (const name of episodes.keys()) if (!names.has(name)) episodes.delete(name);
    for (const row of rows) {
      const episode = episodes.get(row.name);
      if (row.status === "connected" && episode) {
        episode.healthySince ??= now;
        // A briefly successful reconnect must not grant an infinite retry budget.
        if (now - episode.healthySince >= 60_000) episodes.delete(row.name);
      } else if (row.status === "failed") {
        if (episode?.healthySince !== undefined && now - episode.healthySince >= 60_000)
          episodes.set(row.name, { attempts: 0, nextAt: 0, state: "waiting" });
        else if (episode) delete episode.healthySince;
        else episodes.set(row.name, { attempts: 0, nextAt: 0, state: "waiting" });
      }
    }
    return rows;
  }).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        // Discovery can fail before there is a snapshot to drive the idle loop.
        // Retry the observation without treating unknown connections as failed.
        statusUnavailable = true;
      }),
    ),
  );
  const refresh = read.pipe(Effect.ignore);
  const checkLocked = Effect.gen(function* () {
    if (closed) return decorate();
    // A status failure is not evidence that every server failed. Leave the last
    // observation intact and never reconnect from a stale snapshot.
    const fresh = yield* read.pipe(Effect.result);
    if (fresh._tag === "Failure")
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: input.driver,
        detail: "MCP health could not be refreshed. No connections were changed.",
      });
    const busy = activeRequests > 0 || (yield* input.isBusy);
    if (maintenancePending) return decorate();
    const now = yield* Clock.currentTimeMillis;
    for (const server of fresh.success) {
      if (server.status !== "failed" || server.locked) continue;
      const episode = episodes.get(server.name);
      if (!episode) continue;
      if (busy) {
        episode.state = input.api.reconnectScope === "server" ? "waiting" : "manual";
        continue;
      }
      if (episode.nextAt > now) continue;
      const observation = yield* input.inspectNetwork(server);
      const network = typeof observation === "string" ? observation : observation.state;
      if (typeof observation === "string") delete episode.vpnState;
      else episode.vpnState = observation.vpnState;
      if (network === "vpn-off") {
        episode.state = network;
        episode.nextAt = now + 30_000;
        continue;
      }
      if (input.api.reconnectScope !== "server") {
        // Global-only providers still need useful network/VPN diagnostics.
        // Checking a failed endpoint does not authorize restarting healthy MCPs.
        episode.state = network === "network-unavailable" ? network : "manual";
        episode.nextAt = now + 60_000;
        continue;
      }
      // Recheck immediately before mutating; another provider action may have
      // restored a connection or requested login since the first observation.
      const confirmed = yield* read.pipe(Effect.result);
      if (confirmed._tag === "Failure") break;
      const current = confirmed.success.find((row) => row.name === server.name);
      if (!current || current.status !== "failed" || current.locked || (yield* input.isBusy))
        continue;
      episode.attempts += 1;
      episode.state = "reconnecting";
      // A new failure starts promptly, then retries at 30s, 1m, 2m and at
      // most once per five minutes. Missing VPN software is not a stop signal.
      const retryDelay = Math.min(300_000, 30_000 * 2 ** Math.min(episode.attempts - 1, 4));
      episode.nextAt = now + retryDelay;
      const settled = yield* Deferred.make<void>();
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          maintenancePending = true;
          maintenanceSettled = settled;
          yield* restore(input.api.reconnect(server.name)).pipe(
            Effect.ignore,
            Effect.ensuring(
              Effect.gen(function* () {
                episode.nextAt = (yield* Clock.currentTimeMillis) + retryDelay;
                episode.state = network === "network-unavailable" ? network : "waiting";
                maintenancePending = false;
                maintenanceSettled = undefined;
              }).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
            ),
            Effect.forkIn(scope),
          );
        }),
      );
      yield* Deferred.await(settled).pipe(Effect.timeoutOption("8 seconds"));
      episode.state = maintenancePending
        ? "reconnecting"
        : network === "network-unavailable"
          ? network
          : "waiting";
      yield* refresh;
      // Bound the pause before a pending turn; additional failed servers are
      // checked on the next observation, never in a long all-server reload.
      break;
    }
    return decorate();
  });
  // Providers without a targeted reconnect only observe here. Their status reads
  // may be slow, but must not hold the permit for turn starts or direct tools.
  const check = checkLocked.pipe(
    (input.api.reconnectScope === "server" ? gate : observationGate).withPermits(1),
  );
  const trigger = Effect.suspend(() => {
    if (closed || checking) return Effect.void;
    checking = true;
    return check.pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          checking = false;
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });
  // This reads native connection metadata, never a model/tool or reload. Normal
  // UI reads postpone the idle check; failed connections keep the faster retry
  // observation cadence while actual reconnects retain their own backoff.
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("15 seconds");
      if (closed) return;
      const hasFailure = snapshot.some((row) => row.status === "failed" && !row.locked);
      const observeIdle =
        (yield* Clock.currentTimeMillis) >= nextIdleObservationAt &&
        (statusUnavailable ||
          snapshot.some((row) => row.status === "connected" || row.status === "connecting"));
      if (hasFailure || observeIdle) yield* trigger;
    }
  }).pipe(Effect.forkScoped);
  const idle = <A, E>(operation: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      if (closed || maintenancePending || activeRequests > 0 || (yield* input.isBusy))
        return yield* busyError();
      return yield* ownedRequest(operation);
    }).pipe(gate.withPermits(1));
  // A disconnected UI stops waiting, not the provider's underlying request.
  // Keep that work owned by the session so recovery cannot overlap it.
  const ownedRequest = <A, E>(operation: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const settled = yield* Deferred.make<A, E>();
        const finished = yield* Deferred.make<void>();
        maintenancePending = true;
        maintenanceSettled = finished;
        yield* restore(operation).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(settled, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              maintenancePending = false;
              maintenanceSettled = undefined;
            }).pipe(Effect.andThen(Deferred.succeed(finished, undefined))),
          ),
          Effect.forkIn(scope),
        );
        return yield* restore(Deferred.await(settled));
      }),
    );
  const api: ProviderAdapter.ProviderAdapterV2McpServers = {
    ...input.api,
    list: () => check,
    reconnect: (name) =>
      idle(
        Effect.gen(function* () {
          if (input.api.reconnectScope !== "server")
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: input.driver,
              detail: "This provider cannot reconnect one MCP without reloading healthy servers.",
            });
          const rows = yield* input.api.list();
          if (!rows.some((row) => row.name === name && row.status === "failed" && !row.locked))
            return;
          episodes.delete(name);
          yield* input.api.reconnect(name);
          yield* refresh;
        }),
      ),
    ...(input.api.reload ? { reload: (options) => idle(input.api.reload!(options)) } : {}),
    setEnabled: (name, enabled) => idle(input.api.setEnabled(name, enabled)),
    startSignIn: (name) => idle(input.api.startSignIn(name)),
    submitCallback: (name, url) => idle(input.api.submitCallback(name, url)),
    signOut: (name) => idle(input.api.signOut(name)),
  };
  const withActivity = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      while (true) {
        const result = yield* Effect.gen(function* () {
          if (closed) return yield* busyError();
          if (maintenanceSettled) return { wait: maintenanceSettled } as const;
          return { value: yield* operation } as const;
        }).pipe(gate.withPermits(1));
        if ("value" in result) return result.value;
        // Release the gate while waiting so status reads can show "reconnecting".
        // Closing the session interrupts this wait along with the owned request.
        yield* Deferred.await(result.wait);
      }
    });
  const withToolActivity = <A, E>(operation: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let reserved = false;
        yield* restore(
          withActivity(
            Effect.sync(() => {
              activeRequests += 1;
              reserved = true;
            }),
          ),
        ).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (reserved) activeRequests -= 1;
            }),
          ),
        );
        const settled = yield* Deferred.make<A, E>();
        yield* restore(operation).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(settled, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              activeRequests -= 1;
            }),
          ),
          Effect.forkIn(scope),
        );
        return yield* restore(Deferred.await(settled));
      }),
    );
  return {
    api,
    trigger,
    check,
    withActivity,
    withToolActivity,
    hasPendingWork: Effect.sync(() => maintenancePending || activeRequests > 0),
    // Used only inside the manager's atomic idle-entry removal guard.
    hasPendingWorkNow: () => maintenancePending || activeRequests > 0,
  };
});
export type McpRecovery = Effect.Success<ReturnType<typeof make>>;
