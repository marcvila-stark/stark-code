import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  clientRpcRequiredScopes,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  type OrchestrationV2Command,
  type RelayClientInstallProgressEvent,
  RuntimeRequestId,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  ThreadId,
  WS_METHODS,
} from "@starkfuture/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  EnvironmentRpcRequestObserver,
  request,
  requestGuardedAcrossReconnect,
  RpcPermissionGuard,
  runStream,
  subscribe,
  subscribeDynamicWithSession,
} from "./client.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INSTALL_CHECKING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "checking",
};
const INSTALL_DOWNLOADING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "downloading",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    retryCount,
    supervisor,
  };
});

describe("environment RPC", () => {
  it.effect("reuses the session config stream instead of opening a duplicate subscription", () =>
    Effect.gen(function* () {
      const event: ServerConfigStreamEvent = {
        version: 1,
        type: "settingsUpdated",
        payload: { settings: DEFAULT_SERVER_SETTINGS },
      };
      let duplicateSubscriptions = 0;
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => {
          duplicateSubscriptions += 1;
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some({
          ...session(client),
          subscribeServerConfig: () => Stream.succeed(event),
        }),
      );

      const received = yield* subscribe(WS_METHODS.subscribeServerConfig, {}).pipe(
        Stream.runHead,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(received).toEqual(Option.some(event));
      expect(duplicateSubscriptions).toBe(0);
    }),
  );

  it.effect("observes unary requests until they complete", () =>
    Effect.gen(function* () {
      const observations: string[] = [];
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed({ status: "available", version: "2026.6.0" }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.cloudGetRelayClientStatus, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(
          EnvironmentRpcRequestObserver,
          EnvironmentRpcRequestObserver.of({
            observe: ({ environmentId, method }) =>
              Effect.sync(() => {
                observations.push(`start:${environmentId}:${method}`);
                return Effect.sync(() => {
                  observations.push(`finish:${environmentId}:${method}`);
                });
              }),
          }),
        ),
      );

      expect(result).toEqual({ status: "available", version: "2026.6.0" });
      expect(observations).toEqual([
        `start:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
        `finish:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
      ]);
    }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (subscriptions.length >= count) {
            return;
          }
          yield* Effect.yieldNow;
        }
        return yield* Effect.die(new Error(`Expected ${count} durable subscriptions.`));
      });

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps the producer session on an old value buffered across a session switch", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const firstValueBlocked = yield* Deferred.make<void>();
      const releaseFirstValue = yield* Deferred.make<void>();
      const firstValue = { source: "first", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const bufferedFirstValue = {
        source: "first",
        index: 2,
      } as unknown as ServerLifecycleStreamEvent;
      const secondValue = { source: "second", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable([firstValue, bufferedFirstValue])),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(secondValue)),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const { activeSession, supervisor } = yield* makeHarness();

      const resultFiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeServerLifecycle,
        () => Effect.succeed({}),
      ).pipe(
        Stream.mapEffect(([producerSession, value]) =>
          value === firstValue
            ? Deferred.succeed(firstValueBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstValue)),
                Effect.as([producerSession, value] as const),
              )
            : Effect.succeed([producerSession, value] as const),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* Deferred.await(firstSubscribed);
      yield* Deferred.await(firstValueBlocked);
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      yield* Deferred.await(secondSubscribed);
      yield* Deferred.succeed(releaseFirstValue, undefined);

      const result = yield* Fiber.join(resultFiber);
      expect(result).toEqual([
        [firstSession, firstValue],
        [firstSession, bufferedFirstValue],
        [secondSession, secondValue],
      ]);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const observedFailures: Error[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100 && observedFailures.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("retries handled domain failures within the same session when configured", () =>
    Effect.gen(function* () {
      const domainError = new Error("thread not found yet");
      const subscriptionCount = yield* Ref.make(0);
      const expectedFailureCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.getAndUpdate(subscriptionCount, (count) => count + 1).pipe(
              Effect.map((count) => (count === 0 ? Stream.fail(domainError) : Stream.never)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Ref.update(expectedFailureCount, (count) => count + 1),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(expectedFailureCount)) >= 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(subscriptionCount)).toBe(1);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);

      yield* TestClock.adjust("100 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(yield* Ref.get(subscriptionCount)).toBe(2);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);
    }),
  );

  it.effect("doubles the retry delay for repeated failures and resets it after a value", () =>
    Effect.gen(function* () {
      const domainError = new Error("thread not hydrated yet");
      const subscriptions = yield* Queue.unbounded<number>();
      const failures = yield* Queue.unbounded<void>();
      let attempts = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Effect.sync(() => {
              attempts += 1;
              return attempts;
            }).pipe(
              Effect.tap((attempt) => Queue.offer(subscriptions, attempt)),
              Effect.map((attempt) => {
                if (attempt <= 2) return Stream.fail(domainError);
                if (attempt === 3)
                  return Stream.concat(Stream.make("event"), Stream.fail(domainError));
                return Stream.never;
              }),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Queue.offer(failures, undefined),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      expect(yield* Queue.take(subscriptions)).toBe(1);
      yield* Queue.take(failures);
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(subscriptions)).toBe(2);
      yield* Queue.take(failures);
      // The second retry waits 200ms, so 100ms is not enough.
      yield* TestClock.adjust("100 millis");
      expect(Option.isNone(yield* Queue.poll(subscriptions))).toBe(true);
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(subscriptions)).toBe(3);
      // Attempt 3 delivered a value before failing, so the delay is back to 100ms.
      yield* Queue.take(failures);
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.take(subscriptions)).toBe(4);
      yield* Fiber.interrupt(subscriptionFiber);
    }),
  );

  it.effect("waits for the next session after an authorization failure", () =>
    Effect.gen(function* () {
      const subscriptions = yield* Queue.unbounded<void>();
      const failed = yield* Deferred.make<void>();
      let attempts = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Queue.offer(subscriptions, undefined).pipe(
              Effect.map(() => {
                attempts += 1;
                return attempts === 1
                  ? Stream.fail(
                      new EnvironmentAuthorizationError({
                        message: "Missing scope",
                        requiredScope: "orchestration:read",
                      }),
                    )
                  : Stream.never;
              }),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Deferred.succeed(failed, undefined).pipe(Effect.asVoid),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* Queue.take(subscriptions);
      yield* Deferred.await(failed);
      yield* TestClock.adjust("1 minute");
      expect(Option.isNone(yield* Queue.poll(subscriptions))).toBe(true);

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      yield* Queue.take(subscriptions);
      yield* Fiber.interrupt(subscriptionFiber);
      expect(attempts).toBe(2);
    }),
  );

  it.effect.each(["input", "stream"] as const)(
    "does not classify %s subscription defects as expected failures",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const client = {
          [WS_METHODS.subscribeTerminalEvents]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const exit = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalEvents,
          () =>
            Effect.sync(() => {
              inputs += 1;
            }).pipe(Effect.andThen(where === "input" ? Effect.die(defect) : Effect.succeed({}))),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                expectedFailureCount += 1;
              }),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(defect);
        }
        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);
      }),
  );

  it.effect("reports an initializer defect once after an expected failure retries", () =>
    Effect.gen(function* () {
      const defect = new Error("Synthetic retry initializer defect");
      const expectedFailure = yield* Deferred.make<void>();
      const observations: string[] = [];
      const observedDefects: unknown[] = [];
      let inputs = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          observations.push("stream");
          return Stream.fail(new Error("subscription not ready"));
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeTerminalEvents,
        () =>
          Effect.sync(() => {
            inputs += 1;
            observations.push(`input ${inputs}`);
            return inputs;
          }).pipe(
            Effect.flatMap((attempt) => (attempt === 1 ? Effect.succeed({}) : Effect.die(defect))),
          ),
        {
          onDefect: (cause) =>
            Effect.sync(() => {
              observations.push("defect");
              observedDefects.push(Cause.squash(cause));
            }),
          onExpectedFailure: () =>
            Effect.sync(() => {
              observations.push("expected failure");
            }).pipe(Effect.andThen(Deferred.succeed(expectedFailure, undefined)), Effect.asVoid),
          retryExpectedFailureAfter: "250 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(expectedFailure);
      yield* TestClock.adjust("250 millis");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.squash(exit.cause)).toBe(defect);
      }
      expect(observations).toEqual(["input 1", "stream", "expected failure", "input 2", "defect"]);
      expect(observedDefects).toEqual([defect]);
    }),
  );
});

describe("requests across reconnect", () => {
  const CONNECTED_STATE: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    phase: "connected",
  };
  const DISPATCH = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
  const respond = (
    decision: "accept" | "acceptAlways" = "accept",
  ): Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }> => ({
    type: "runtime-request.respond",
    commandId: CommandId.make("command-respond-1"),
    threadId: ThreadId.make("thread-1"),
    requestId: RuntimeRequestId.make("request-1"),
    decision,
  });
  const socketClosed = () =>
    new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) });
  type DispatchAnswer = Effect.Effect<
    { readonly sequence: number },
    RpcClientError.RpcClientError | OrchestrationV2DispatchCommandError
  >;
  const dispatchSession = (
    calls: Array<{ readonly session: string; readonly command: unknown }>,
    name: string,
    answer: () => DispatchAnswer,
  ) =>
    session({
      [DISPATCH]: (command: unknown) => {
        calls.push({ session: name, command });
        return answer();
      },
    } as unknown as WsRpcProtocolClient);
  const grants = (scopes: ReadonlyArray<AuthEnvironmentScope>) => ({
    authorize: (_environmentId: EnvironmentId, method: string, input: unknown) => {
      const missing = clientRpcRequiredScopes(method, input).find(
        (scope) => !scopes.includes(scope),
      );
      return missing === undefined
        ? Effect.void
        : Effect.fail(
            new EnvironmentAuthorizationError({
              requiredScope: missing,
              message: `This connection requires ${missing}.`,
            }),
          );
    },
  });
  const OPERATE = [AuthOrchestrationOperateScope];
  const awaitCalls = Effect.fn("TestEnvironmentRpc.awaitCalls")(function* (
    calls: ReadonlyArray<unknown>,
    count: number,
  ) {
    for (let attempt = 0; attempt < 100 && calls.length < count; attempt += 1) {
      yield* Effect.yieldNow;
    }
    if (calls.length < count) return yield* Effect.die(new Error(`Expected ${count} calls.`));
  });

  it.effect("re-sends the same command on the next session after the socket drops", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly session: string; readonly command: unknown }> = [];
      let awaiting = 0;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      const first = dispatchSession(calls, "first", () => Effect.fail(socketClosed()));
      const second = dispatchSession(calls, "second", () => Effect.succeed({ sequence: 7 }));
      yield* SubscriptionRef.set(activeSession, Option.some(first));

      const fiber = yield* requestGuardedAcrossReconnect(DISPATCH, respond(), {
        onAwaitingReconnect: Effect.sync(() => {
          awaiting += 1;
        }),
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, grants(OPERATE)),
        Effect.forkChild,
      );
      yield* awaitCalls(calls, 1);
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(second));

      expect(yield* Fiber.join(fiber)).toEqual({ sequence: 7 });
      expect(calls).toEqual([
        { session: "first", command: respond() },
        { session: "second", command: respond() },
      ]);
      expect(awaiting).toBe(1);
    }),
  );

  it.effect("re-sends when the session closes under the open call", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly session: string; readonly command: unknown }> = [];
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      // A closing session ends open calls with an interrupt from its own fiber.
      const first = dispatchSession(calls, "first", () => Effect.failCause(Cause.interrupt(-42)));
      const second = dispatchSession(calls, "second", () => Effect.succeed({ sequence: 3 }));
      yield* SubscriptionRef.set(activeSession, Option.some(first));

      const fiber = yield* requestGuardedAcrossReconnect(DISPATCH, respond()).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, grants(OPERATE)),
        Effect.forkChild,
      );
      yield* awaitCalls(calls, 1);
      yield* SubscriptionRef.set(activeSession, Option.some(second));

      expect(yield* Fiber.join(fiber)).toEqual({ sequence: 3 });
      expect(calls.map((call) => call.session)).toEqual(["first", "second"]);
    }),
  );

  it.effect("uses a replacement session published before the wait begins", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly session: string; readonly command: unknown }> = [];
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      const second = dispatchSession(calls, "second", () => Effect.succeed({ sequence: 9 }));
      const first = dispatchSession(calls, "first", () =>
        SubscriptionRef.set(activeSession, Option.some(second)).pipe(
          Effect.andThen(Effect.fail(socketClosed())),
        ),
      );
      yield* SubscriptionRef.set(activeSession, Option.some(first));

      const result = yield* requestGuardedAcrossReconnect(DISPATCH, respond()).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, grants(OPERATE)),
      );

      expect(result).toEqual({ sequence: 9 });
      expect(calls.map((call) => call.session)).toEqual(["first", "second"]);
    }),
  );

  it.effect("fails without sending when no session exists", () =>
    Effect.gen(function* () {
      const { supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);

      const error = yield* requestGuardedAcrossReconnect(DISPATCH, respond()).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, grants(OPERATE)),
        Effect.flip,
      );

      expect(error._tag).toBe("EnvironmentRpcUnavailableError");
    }),
  );

  it.effect("passes server rejections and client defects through without re-sending", () =>
    Effect.gen(function* () {
      const rejection = new OrchestrationV2DispatchCommandError({
        commandId: respond().commandId,
        commandType: "runtime-request.respond",
        message: "Runtime request request-1 is resolved.",
      });
      const defect = new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "Error decoding message",
          cause: new Error("bad frame"),
        }),
      });
      for (const failure of [rejection, defect]) {
        const calls: Array<{ readonly session: string; readonly command: unknown }> = [];
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(dispatchSession(calls, "only", () => Effect.fail(failure))),
        );

        const error = yield* requestGuardedAcrossReconnect(DISPATCH, respond()).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(RpcPermissionGuard, grants(OPERATE)),
          Effect.flip,
        );

        expect(error).toBe(failure);
        expect(calls).toHaveLength(1);
      }
    }),
  );

  it.effect("checks grants on every attempt, including settings:write for Always allow", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly session: string; readonly command: unknown }> = [];
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      const second = dispatchSession(calls, "second", () => Effect.succeed({ sequence: 1 }));
      const first = dispatchSession(calls, "first", () =>
        SubscriptionRef.set(activeSession, Option.some(second)).pipe(
          Effect.andThen(Effect.fail(socketClosed())),
        ),
      );
      yield* SubscriptionRef.set(activeSession, Option.some(first));

      const withoutSettings = yield* requestGuardedAcrossReconnect(
        DISPATCH,
        respond("acceptAlways"),
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, grants(OPERATE)),
        Effect.flip,
      );
      expect(withoutSettings).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthSettingsWriteScope,
      });
      expect(calls).toHaveLength(0);

      // The grant is revoked while the request waits to be sent again.
      let granted: ReadonlyArray<AuthEnvironmentScope> = [
        AuthOrchestrationOperateScope,
        AuthSettingsWriteScope,
      ];
      const revoking = {
        authorize: (environmentId: EnvironmentId, method: string, input: unknown) =>
          Effect.suspend(() => grants(granted).authorize(environmentId, method, input)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                granted = OPERATE;
              }),
            ),
          ),
      };
      const revoked = yield* requestGuardedAcrossReconnect(DISPATCH, respond("acceptAlways")).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, revoking),
        Effect.flip,
      );
      expect(revoked).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthSettingsWriteScope,
      });
      expect(calls.map((call) => call.session)).toEqual(["first"]);
    }),
  );

  it.effect("reports an unknown outcome when no replacement session arrives in time", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly session: string; readonly command: unknown }> = [];
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(dispatchSession(calls, "first", () => Effect.fail(socketClosed()))),
      );

      const fiber = yield* requestGuardedAcrossReconnect(DISPATCH, respond(), {
        maxWait: "5 minutes",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, grants(OPERATE)),
        Effect.flip,
        Effect.forkChild,
      );
      yield* awaitCalls(calls, 1);
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* TestClock.adjust("4 minutes");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 minute");

      expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentRpcOutcomeUnknownError");
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("stops waiting once the environment is removed or switched off", () =>
    Effect.gen(function* () {
      for (const stop of ["removed", "switched off"] as const) {
        const calls: Array<{ readonly session: string; readonly command: unknown }> = [];
        const removed = yield* Deferred.make<void>();
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(dispatchSession(calls, "first", () => Effect.fail(socketClosed()))),
        );

        const fiber = yield* requestGuardedAcrossReconnect(DISPATCH, respond(), {
          abandonWhen: Deferred.await(removed),
        }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(RpcPermissionGuard, grants(OPERATE)),
          Effect.flip,
          Effect.forkChild,
        );
        yield* awaitCalls(calls, 1);
        yield* stop === "removed"
          ? Deferred.succeed(removed, undefined)
          : SubscriptionRef.set(supervisor.state, AVAILABLE_CONNECTION_STATE);

        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentRpcOutcomeUnknownError");
        expect(calls).toHaveLength(1);
      }
    }),
  );

  it.effect("does not re-send after the caller interrupts the request", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly session: string; readonly command: unknown }> = [];
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(dispatchSession(calls, "first", () => Effect.never)),
      );

      const fiber = yield* requestGuardedAcrossReconnect(DISPATCH, respond()).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, grants(OPERATE)),
        Effect.forkChild,
      );
      yield* awaitCalls(calls, 1);
      yield* Fiber.interrupt(fiber);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(dispatchSession(calls, "second", () => Effect.succeed({ sequence: 1 }))),
      );
      yield* Effect.yieldNow;

      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(calls).toHaveLength(1);
    }),
  );
});
