import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, type McpServerStatusEntry } from "@starkfuture/contracts";
import * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as McpRecovery from "./McpRecovery.ts";

const row = (
  name: string,
  status: McpServerStatusEntry["status"],
  locked = false,
): McpServerStatusEntry => ({
  name,
  status,
  locked,
  tools: [],
  authKind: "unknown",
});
const setup = Effect.fn(function* (
  initial: readonly McpServerStatusEntry[],
  options: {
    scope?: "server" | "all";
    statusTimeoutMs?: number;
    list?: ProviderAdapter.ProviderAdapterV2McpServers["list"];
    reconnect?: (name: string) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>;
    network?: McpRecovery.NetworkState;
    inspectNetwork?: () => Effect.Effect<McpRecovery.NetworkState>;
    reload?: ProviderAdapter.ProviderAdapterV2McpServers["reload"];
  } = {},
) {
  const rows = yield* Ref.make(initial);
  const busy = yield* Ref.make(false);
  const observations = yield* Ref.make(0);
  const calls: string[] = [];
  const api: ProviderAdapter.ProviderAdapterV2McpServers = {
    reconnectScope: options.scope ?? "server",
    ...(options.statusTimeoutMs === undefined ? {} : { statusTimeoutMs: options.statusTimeoutMs }),
    list: () =>
      Ref.update(observations, (count) => count + 1).pipe(
        Effect.andThen(options.list ? options.list() : Ref.get(rows)),
      ),
    reconnect: (name) =>
      Effect.sync(() => {
        calls.push(name);
      }).pipe(Effect.andThen(options.reconnect?.(name) ?? Effect.void)),
    setEnabled: () => Effect.void,
    startSignIn: () => Effect.succeed({ callbackExpected: false, completed: true }),
    submitCallback: () => Effect.void,
    signOut: () => Effect.void,
    ...(options.reload ? { reload: options.reload } : {}),
  };
  const recovery = yield* McpRecovery.make({
    api,
    driver: ProviderDriverKind.make("claudeAgent"),
    isBusy: Ref.get(busy),
    inspectNetwork: options.inspectNetwork ?? (() => Effect.succeed(options.network ?? "unknown")),
  });
  return { recovery, rows, busy, calls, observations };
});

it.effect.each(["server", "all"] as const)(
  "retries an unavailable initial status read in the background with %s reconnect scope",
  (scope) =>
    Effect.gen(function* () {
      let unavailable = true;
      const reconnected = yield* Deferred.make<void>();
      const s = yield* setup([], {
        scope,
        reconnect: () => Deferred.succeed(reconnected, undefined).pipe(Effect.asVoid),
        list: () =>
          unavailable
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: ProviderDriverKind.make("claudeAgent"),
                  detail: "Unavailable",
                }),
              )
            : Effect.succeed([row("healthy", "connected"), row("broken", "failed")]),
      });
      assert.equal((yield* s.recovery.check.pipe(Effect.result))._tag, "Failure");
      yield* TestClock.adjust("59 seconds");
      assert.equal(yield* Ref.get(s.observations), 1);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Ref.get(s.observations), 2);
      assert.deepEqual(s.calls, []);
      unavailable = false;
      yield* TestClock.adjust("60 seconds");
      assert.isAtLeast(yield* Ref.get(s.observations), 3);
      if (scope === "server") yield* Deferred.await(reconnected);
      assert.deepEqual(s.calls, scope === "server" ? ["broken"] : []);
    }).pipe(Effect.scoped),
);

it.effect("stops retrying unavailable status once an empty server list is confirmed", () =>
  Effect.gen(function* () {
    let unavailable = true;
    const s = yield* setup([], {
      list: () =>
        unavailable
          ? Effect.fail(
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ProviderDriverKind.make("claudeAgent"),
                detail: "Unavailable",
              }),
            )
          : Effect.succeed([]),
    });
    yield* s.recovery.check.pipe(Effect.ignore);
    unavailable = false;
    yield* TestClock.adjust("60 seconds");
    assert.equal(yield* Ref.get(s.observations), 2);
    yield* TestClock.adjust("120 seconds");
    assert.equal(yield* Ref.get(s.observations), 2);
    assert.deepEqual(s.calls, []);
  }).pipe(Effect.scoped),
);

it.effect("discovers a later native disconnect without a visible client or another turn", () =>
  Effect.gen(function* () {
    const reconnected = yield* Deferred.make<void>();
    const s = yield* setup([row("healthy", "connected"), row("later-drop", "connected")], {
      reconnect: () => Deferred.succeed(reconnected, undefined).pipe(Effect.asVoid),
    });
    yield* s.recovery.check;
    yield* Ref.set(s.rows, [row("healthy", "connected"), row("later-drop", "failed")]);
    yield* TestClock.adjust("59 seconds");
    assert.deepEqual(s.calls, []);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(reconnected);
    assert.deepEqual(s.calls, ["later-drop"]);
  }).pipe(Effect.scoped),
);

it.effect(
  "normal status reads postpone background checks and healthy servers never reconnect",
  () =>
    Effect.gen(function* () {
      const s = yield* setup([row("healthy", "connected")]);
      yield* s.recovery.check;
      yield* TestClock.adjust("45 seconds");
      yield* s.recovery.check;
      yield* TestClock.adjust("45 seconds");
      assert.equal(yield* Ref.get(s.observations), 2);
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* Ref.get(s.observations), 3);
      assert.deepEqual(s.calls, []);
    }).pipe(Effect.scoped),
);

it.effect("idle observation finds expired authentication without reconnecting it", () =>
  Effect.gen(function* () {
    const s = yield* setup([row("login", "connected")]);
    yield* s.recovery.check;
    yield* Ref.set(s.rows, [row("login", "needs-auth")]);
    yield* TestClock.adjust("60 seconds");
    assert.equal(yield* Ref.get(s.observations), 2);
    assert.deepEqual(s.calls, []);
    yield* TestClock.adjust("120 seconds");
    assert.equal(yield* Ref.get(s.observations), 2);
  }).pipe(Effect.scoped),
);

it.effect("checks all statuses but only reconnects failed, enabled, unlocked servers", () =>
  Effect.gen(function* () {
    const s = yield* setup([
      row("good", "connected"),
      row("login", "needs-auth"),
      row("off", "disabled"),
      row("pending", "connecting"),
      row("stark-code", "failed", true),
      row("broken", "failed"),
    ]);
    const result = yield* s.recovery.check;
    assert.deepEqual(s.calls, ["broken"]);
    assert.equal(result.at(-1)?.recovery?.attempts, 1);
  }).pipe(Effect.scoped),
);

it.effect("never calls a global reconnect, including manual per-server actions", () =>
  Effect.gen(function* () {
    const s = yield* setup([row("good", "connected"), row("broken", "failed")], { scope: "all" });
    const result = yield* s.recovery.check;
    assert.equal(result[1]?.recovery?.state, "manual");
    assert.equal((yield* s.recovery.api.reconnect("broken").pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(s.calls, []);
  }).pipe(Effect.scoped),
);

it.effect("observes failures during a turn and repairs only after all work is idle", () =>
  Effect.gen(function* () {
    const s = yield* setup([row("broken", "failed")]);
    yield* Ref.set(s.busy, true);
    assert.equal((yield* s.recovery.check)[0]?.recovery?.state, "waiting");
    assert.deepEqual(s.calls, []);
    assert.equal((yield* s.recovery.api.startSignIn("broken").pipe(Effect.result))._tag, "Failure");
    yield* Ref.set(s.busy, false);
    yield* s.recovery.check;
    assert.deepEqual(s.calls, ["broken"]);
  }).pipe(Effect.scoped),
);

it.effect("turn reservation and direct tool calls wait for an in-flight reconnect", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const s = yield* setup([row("broken", "failed")], {
      reconnect: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    });
    const repair = yield* s.recovery.check.pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const reserved = yield* s.recovery.withActivity(Ref.set(s.busy, true)).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.equal(yield* Ref.get(s.busy), false);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(repair);
    yield* Fiber.join(reserved);
    yield* s.recovery.check;
    assert.deepEqual(s.calls, ["broken"]);
  }).pipe(Effect.scoped),
);

it.effect.each(["vpn-off", "network-unavailable"] as const)(
  "reports known network conditions for %s",
  (state) =>
    Effect.gen(function* () {
      const s = yield* setup([row("broken", "failed")], { network: state });
      const result = yield* s.recovery.check;
      assert.equal(result[0]?.recovery?.state, state);
      assert.deepEqual(s.calls, state === "vpn-off" ? [] : ["broken"]);
    }).pipe(Effect.scoped),
);

it.effect(
  "a disconnected FortiClient is advisory and does not suppress unverified-route recovery",
  () =>
    Effect.gen(function* () {
      const network = yield* Ref.make<McpRecovery.NetworkState>({
        state: "network-unavailable",
        vpnState: "forticlient-disconnected",
      });
      const s = yield* setup([row("public-service", "failed")], {
        inspectNetwork: () => Ref.get(network),
      });
      const first = yield* s.recovery.check;
      assert.deepEqual(s.calls, ["public-service"]);
      assert.deepEqual(first[0]?.recovery, {
        state: "network-unavailable",
        attempts: 1,
        vpnState: "forticlient-disconnected",
      });
      yield* Ref.set(network, "unknown");
      yield* TestClock.adjust("30 seconds");
      const next = yield* s.recovery.check;
      assert.deepEqual(s.calls, ["public-service", "public-service"]);
      assert.isUndefined(next[0]?.recovery?.vpnState);
      yield* Ref.set(s.rows, [row("public-service", "connected")]);
      assert.isUndefined((yield* s.recovery.check)[0]?.recovery);
    }).pipe(Effect.scoped),
);

it.effect("rechecks immediately before reconnect and preserves an already recovered server", () =>
  Effect.gen(function* () {
    let reads = 0;
    let reconnects = 0;
    const recovery = yield* McpRecovery.make({
      driver: ProviderDriverKind.make("claudeAgent"),
      isBusy: Effect.succeed(false),
      inspectNetwork: () => Effect.succeed("unknown"),
      api: {
        reconnectScope: "server",
        list: () => Effect.sync(() => [row("service", ++reads === 1 ? "failed" : "connected")]),
        reconnect: () =>
          Effect.sync(() => {
            reconnects += 1;
          }),
        setEnabled: () => Effect.void,
        startSignIn: () => Effect.succeed({ callbackExpected: false }),
        submitCallback: () => Effect.void,
        signOut: () => Effect.void,
      },
    });
    yield* recovery.check;
    assert.equal(reconnects, 0);
  }).pipe(Effect.scoped),
);

it.effect("backs off progressively without exhausting and stops on authentication failure", () =>
  Effect.gen(function* () {
    const s = yield* setup([row("broken", "failed")]);
    yield* s.recovery.check;
    yield* s.recovery.check;
    assert.equal(s.calls.length, 1);
    yield* TestClock.adjust("30 seconds");
    yield* s.recovery.check;
    assert.equal(s.calls.length, 2);
    yield* Ref.set(s.rows, [row("broken", "needs-auth")]);
    yield* TestClock.adjust("31 seconds");
    yield* s.recovery.check;
    assert.equal(s.calls.length, 2);
    yield* Ref.set(s.rows, [row("broken", "failed")]);
    yield* s.recovery.check;
    yield* TestClock.adjust("60 seconds");
    const result = yield* s.recovery.check;
    assert.equal(s.calls.length, 3);
    assert.equal(result[0]?.recovery?.state, "waiting");
    yield* TestClock.adjust("120 seconds");
    yield* s.recovery.check;
    assert.equal(s.calls.length, 4);
  }).pipe(Effect.scoped),
);

it.effect("failed status reads never turn a cached failure into a reconnect", () =>
  Effect.gen(function* () {
    let fail = false;
    let reconnects = 0;
    const recovery = yield* McpRecovery.make({
      driver: ProviderDriverKind.make("claudeAgent"),
      isBusy: Effect.succeed(false),
      inspectNetwork: () => Effect.succeed("unknown"),
      api: {
        reconnectScope: "server",
        list: () =>
          fail
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: ProviderDriverKind.make("claudeAgent"),
                  detail: "Unavailable",
                }),
              )
            : Effect.succeed([row("broken", "failed")]),
        reconnect: () =>
          Effect.sync(() => {
            reconnects += 1;
          }),
        setEnabled: () => Effect.void,
        startSignIn: () => Effect.succeed({ callbackExpected: false }),
        submitCallback: () => Effect.void,
        signOut: () => Effect.void,
      },
    });
    yield* recovery.check;
    fail = true;
    yield* TestClock.adjust("40 seconds");
    assert.equal((yield* recovery.check.pipe(Effect.result))._tag, "Failure");
    assert.equal(reconnects, 1);
  }).pipe(Effect.scoped),
);

it.effect("an RPC timeout never releases new work while the provider is still reconnecting", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const s = yield* setup([row("broken", "failed")], {
      reconnect: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    });
    const check = yield* s.recovery.check.pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("8 seconds");
    assert.equal((yield* Fiber.join(check))[0]?.recovery?.state, "reconnecting");
    let ran = false;
    const start = s.recovery.withActivity(
      Effect.sync(() => {
        ran = true;
      }),
    );
    const queued = yield* start.pipe(Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    assert.equal(ran, false);
    yield* s.recovery.check;
    assert.equal(s.calls.length, 1);
    yield* Deferred.succeed(finish, undefined);
    yield* Effect.yieldNow;
    yield* Fiber.join(queued);
    assert.equal(ran, true);
  }).pipe(Effect.scoped),
);

it.effect("a cancelled caller cannot release maintenance during a native tool request", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const s = yield* setup([row("broken", "failed")]);
    const caller = yield* s.recovery
      .withToolActivity(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(caller);
    yield* s.recovery.check;
    assert.equal(s.calls.length, 0);
    assert.equal(yield* s.recovery.hasPendingWork, true);
    yield* Deferred.succeed(finish, undefined);
    yield* Effect.yieldNow;
    yield* s.recovery.check;
    assert.equal(s.calls.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("gives a new failure a fresh budget after a sustained healthy spell", () =>
  Effect.gen(function* () {
    const s = yield* setup([row("service", "failed")]);
    yield* s.recovery.check;
    yield* TestClock.adjust("30 seconds");
    yield* s.recovery.check;
    assert.equal(s.calls.length, 2);
    yield* Ref.set(s.rows, [row("service", "connected")]);
    yield* s.recovery.check;
    yield* TestClock.adjust("70 seconds");
    yield* Ref.set(s.rows, [row("service", "failed")]);
    const result = yield* s.recovery.check;
    assert.equal(s.calls.length, 3);
    assert.equal(result[0]?.recovery?.attempts, 1);
  }).pipe(Effect.scoped),
);

it.effect("a slow observation cannot delay turn or tool starts when recovery is manual", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<readonly McpServerStatusEntry[]>();
    const s = yield* setup([], {
      scope: "all",
      statusTimeoutMs: 15_000,
      list: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    });
    const status = yield* s.recovery.api.list().pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("8 seconds");
    yield* s.recovery.withActivity(Effect.void);
    yield* s.recovery.withToolActivity(Effect.void);
    assert.isFalse(yield* Deferred.isDone(finish));
    yield* Deferred.succeed(finish, [row("healthy", "connected"), row("broken", "failed")]);
    const result = yield* Fiber.join(status);
    assert.equal(result._tag, "Success");
    if (result._tag === "Success") {
      assert.equal(result.success[0]?.status, "connected");
      assert.equal(result.success[1]?.recovery?.state, "manual");
    }
    assert.deepEqual(s.calls, []);
  }).pipe(Effect.scoped),
);

it.effect.each([
  { timeoutMs: 3_000, override: false },
  { timeoutMs: 15_000, override: true },
])(
  "bounds a stalled status read at $timeoutMs ms without reconnecting",
  ({ timeoutMs, override }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const s = yield* setup([], {
        ...(override ? { scope: "all" as const, statusTimeoutMs: timeoutMs } : {}),
        list: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const status = yield* s.recovery.api
        .list()
        .pipe(
          Effect.result,
          Effect.ensuring(Deferred.succeed(settled, undefined)),
          Effect.forkChild,
        );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(timeoutMs - 1);
      assert.isFalse(yield* Deferred.isDone(settled));
      yield* TestClock.adjust(1);
      assert.equal((yield* Fiber.join(status))._tag, "Failure");
      assert.deepEqual(s.calls, []);
    }).pipe(Effect.scoped),
);

it.effect("keeps independent Codex requests concurrent but makes global reload exclusive", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const releaseReload = yield* Deferred.make<void>();
    const reloadEntered = yield* Deferred.make<void>();
    const s = yield* setup([row("service", "connected")], {
      scope: "all",
      reload: () =>
        Deferred.succeed(reloadEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseReload)),
          Effect.as({ status: "reloaded" as const, failedServers: [] }),
        ),
    });
    const first = yield* s.recovery
      .withToolActivity(
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(firstEntered);
    yield* s.recovery.withToolActivity(Deferred.succeed(secondEntered, undefined));
    assert.isTrue(yield* Deferred.isDone(secondEntered));
    assert.equal(
      (yield* s.recovery.api.reload!({ force: false }).pipe(Effect.result))._tag,
      "Failure",
    );
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    const reload = yield* s.recovery.api.reload!({ force: false }).pipe(Effect.forkChild);
    yield* Deferred.await(reloadEntered);
    let started = false;
    const next = yield* s.recovery
      .withActivity(
        Effect.sync(() => {
          started = true;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.isFalse(started);
    yield* Deferred.succeed(releaseReload, undefined);
    yield* Fiber.join(reload);
    yield* Fiber.join(next);
    assert.isTrue(started);
  }).pipe(Effect.scoped),
);
