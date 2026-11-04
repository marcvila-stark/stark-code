import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  NodeId,
  type OrchestrationV2RuntimeRequest,
  OrchestrationV2DispatchCommandError,
  RuntimeRequestId,
  ThreadId,
} from "@starkfuture/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { RespondToThreadApprovalInput } from "../operations/commands.ts";
import {
  EnvironmentRpcOutcomeUnknownError,
  EnvironmentRpcUnavailableError,
} from "../rpc/client.ts";
import { v2Now } from "./orchestrationV2TestFixtures.ts";
import {
  countRuntimeResponsesAwaitingReconnect,
  describeRuntimeResponseFailure,
  environmentRemoved,
  resolveRuntimeRequestOutcome,
  resolveRuntimeRequestResponseState,
  runtimeRequestResponseCaption,
  runtimeResponseAttemptsAtom,
  trackRuntimeResponse,
} from "./runtimeRequestResponse.ts";

const ENVIRONMENT_ID = EnvironmentId.make("remote");
const THREAD_ID = ThreadId.make("thread");
const REQUEST_ID = RuntimeRequestId.make("approval");

const ready = {
  connectionPhase: "connected",
  threadStatus: "live",
  responseCapability: "live",
  canOperate: true,
  responding: false,
  attempt: null,
} as const;

describe("runtime request response state", () => {
  it.each([
    [{}, "ready", null],
    [{ connectionPhase: "reconnecting" }, "reconnecting", "Reconnecting — answer once connected"],
    [{ connectionPhase: "connecting" }, "reconnecting", "Reconnecting — answer once connected"],
    [{ connectionPhase: "offline" }, "offline", "Offline — answer once connected"],
    [{ connectionPhase: "error" }, "disconnected", "Not connected — answer once connected"],
    [{ connectionPhase: "available" }, "disconnected", "Not connected — answer once connected"],
    [{ threadStatus: "cached" }, "syncing", "Syncing…"],
    [{ threadStatus: "synchronizing" }, "syncing", "Syncing…"],
    [{ responding: true }, "sending", null],
    [{ attempt: "sending" }, "sending", null],
    // A reply waiting for the connection keeps saying so while the connection is down.
    [
      { attempt: "awaiting_reconnect", connectionPhase: "reconnecting" },
      "sending_after_reconnect",
      "Sending when reconnected",
    ],
    [{ attempt: "unconfirmed" }, "unconfirmed", "Couldn't confirm your answer"],
    [
      { attempt: "unconfirmed", connectionPhase: "reconnecting" },
      "reconnecting",
      "Reconnecting — answer once connected",
    ],
    [{ canOperate: false }, "not_permitted", null],
    [{ responseCapability: "not_resumable" }, "provider_gone", null],
    // Message-capable questions outlive their provider turn and stay answerable.
    [{ responseCapability: "message" }, "ready", null],
    [{ responseCapability: "message", threadStatus: "cached" }, "syncing", "Syncing…"],
  ] as const)("%o is %s", (overrides, state, caption) => {
    const resolved = resolveRuntimeRequestResponseState({
      ...ready,
      ...(overrides as {
        readonly connectionPhase?: EnvironmentConnectionPhase;
      }),
    });
    expect(resolved).toBe(state);
    expect(runtimeRequestResponseCaption(resolved)).toBe(caption);
  });
});

describe("runtime request outcome", () => {
  const request = (
    overrides: Partial<OrchestrationV2RuntimeRequest> & { readonly lost?: unknown } = {},
  ) =>
    ({
      id: REQUEST_ID,
      nodeId: NodeId.make("node"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: { type: "live" },
      createdAt: v2Now,
      resolvedAt: null,
      ...overrides,
    }) as OrchestrationV2RuntimeRequest;
  const lost = { cause: "server_restart", lostAt: v2Now } as const;

  it.each([
    ["pending", request(), "pending"],
    ["resolved", request({ status: "resolved", decision: "accept" }), "answered"],
    ["expired", request({ status: "expired" }), "expired"],
    ["cancelled", request({ status: "cancelled" }), "cancelled"],
    ["lost", request({ status: "expired", lost }), "lost"],
    ["lost on shutdown", request({ status: "cancelled", lost }), "lost"],
    [
      "lost after the answer was recorded",
      request({ status: "cancelled", decision: "accept", lost }),
      "delivery_uncertain",
    ],
    ["resolved but undelivered", request({ status: "resolved", lost }), "delivery_uncertain"],
  ] as const)("reads a live %s request", (_name, entry, outcome) => {
    expect(
      resolveRuntimeRequestOutcome({
        threadStatus: "live",
        runtimeRequests: [entry],
        requestId: REQUEST_ID,
      }),
    ).toBe(outcome);
  });

  it("does not trust a cached projection or one without the request", () => {
    const answered = [request({ status: "resolved" })];
    for (const threadStatus of ["cached", "synchronizing", "empty"] as const) {
      expect(
        resolveRuntimeRequestOutcome({
          threadStatus,
          runtimeRequests: answered,
          requestId: REQUEST_ID,
        }),
      ).toBe("unloaded");
    }
    expect(
      resolveRuntimeRequestOutcome({
        threadStatus: "live",
        runtimeRequests: [],
        requestId: REQUEST_ID,
      }),
    ).toBe("unloaded");
    expect(
      resolveRuntimeRequestOutcome({
        threadStatus: "live",
        runtimeRequests: null,
        requestId: REQUEST_ID,
      }),
    ).toBe("unloaded");
  });
});

const rejection = new OrchestrationV2DispatchCommandError({
  commandId: CommandId.make("command"),
  commandType: "runtime-request.respond",
  message: "Runtime request approval is resolved.",
});

describe("runtime response failures", () => {
  it("says an answer was not sent when there was no connection", () => {
    expect(
      describeRuntimeResponseFailure({
        error: new EnvironmentRpcUnavailableError({
          environmentId: ENVIRONMENT_ID,
          message: "Remote is not connected.",
        }),
        outcome: "unloaded",
      }),
    ).toEqual({
      tone: "error",
      title: "Not connected",
      message: "Your answer was not sent. Try again once the connection is back.",
    });
  });

  it("explains a rejection from a live projection instead of hiding it", () => {
    expect(describeRuntimeResponseFailure({ error: rejection, outcome: "answered" })).toEqual({
      tone: "info",
      title: "Already answered",
      message: "This request was already answered.",
    });
    expect(describeRuntimeResponseFailure({ error: rejection, outcome: "expired" }).title).toBe(
      "Request expired",
    );
    expect(describeRuntimeResponseFailure({ error: rejection, outcome: "lost" }).message).toBe(
      "This request was lost when Stark Code or the agent stopped, so your answer was not delivered.",
    );
    expect(
      describeRuntimeResponseFailure({ error: rejection, outcome: "delivery_uncertain" }).title,
    ).toBe("Answer may not have reached the agent");
  });

  it("keeps the server's reason when the projection cannot explain it", () => {
    for (const outcome of ["unloaded", "pending"] as const) {
      expect(describeRuntimeResponseFailure({ error: rejection, outcome })).toEqual({
        tone: "error",
        title: "Your answer was not accepted",
        message: "Runtime request approval is resolved.",
      });
    }
  });

  it("shows the server's permission refusals in its own words", () => {
    for (const message of [
      "This request's choices have not arrived yet. Answer it from its card.",
      "The agent offered no choices for this request, so no answer can be sent. It closes when the agent stops waiting.",
    ]) {
      expect(
        describeRuntimeResponseFailure({
          error: new OrchestrationV2DispatchCommandError({
            commandId: CommandId.make("command"),
            commandType: "runtime-request.respond",
            message,
            detail: message,
          }),
          outcome: "pending",
          kind: "approval",
        }),
      ).toEqual({ tone: "error", title: "Your answer was not accepted", message });
    }
  });

  it("reports an unconfirmed answer and a missing grant", () => {
    expect(
      describeRuntimeResponseFailure({
        error: new EnvironmentRpcOutcomeUnknownError({
          environmentId: ENVIRONMENT_ID,
          message: "Remote did not reconnect in time to confirm the request.",
        }),
        outcome: "unloaded",
      }),
    ).toMatchObject({ tone: "warning", title: "Couldn't confirm your answer" });
    expect(
      describeRuntimeResponseFailure({
        error: new EnvironmentAuthorizationError({
          requiredScope: "settings:write",
          message: "This connection requires settings:write.",
        }),
        outcome: "pending",
        kind: "approval",
      }),
    ).toEqual({
      tone: "error",
      title: "Not allowed",
      message: "This connection requires settings:write.",
    });
  });
});

describe("tracked runtime responses", () => {
  const crypto = Crypto.make({
    randomBytes: (size) => new Uint8Array(size).map((_, index) => index + uuidSeed),
    digest: (_algorithm, data) => Effect.succeed(data),
  });
  let uuidSeed = 0;
  const makeEnvironments = Effect.fn("TestRuntimeResponses.makeEnvironments")(function* () {
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([[ENVIRONMENT_ID, {} as ConnectionCatalogEntry]]),
    );
    return {
      entries,
      service: { entries } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"],
    };
  });
  const approval = (
    decision: "accept" | "decline",
    optionId?: string,
  ): { readonly kind: "approval"; readonly input: RespondToThreadApprovalInput } => ({
    kind: "approval",
    input: {
      threadId: THREAD_ID,
      requestId: REQUEST_ID,
      decision,
      ...(optionId === undefined ? {} : { optionId }),
    },
  });
  const outcomeUnknown = new EnvironmentRpcOutcomeUnknownError({
    environmentId: ENVIRONMENT_ID,
    message: "Remote did not reconnect in time to confirm the request.",
  });

  it.effect("keeps an unconfirmed answer and re-sends the same answer under its command id", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const { service } = yield* makeEnvironments();
      const sent: Array<string | undefined> = [];
      const attempt = () =>
        registry.get(runtimeResponseAttemptsAtom(ENVIRONMENT_ID)).get(REQUEST_ID);
      const run = (
        decision: "accept" | "decline",
        result: Effect.Effect<
          number,
          EnvironmentRpcOutcomeUnknownError | OrchestrationV2DispatchCommandError
        >,
        optionId?: string,
      ) => {
        uuidSeed += 1;
        return trackRuntimeResponse(
          registry,
          ENVIRONMENT_ID,
          approval(decision, optionId),
          (input) => Effect.sync(() => sent.push(input.commandId)).pipe(Effect.andThen(result)),
        ).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, service),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.exit,
        );
      };

      yield* run("accept", Effect.fail(outcomeUnknown));
      expect(attempt()).toMatchObject({ kind: "approval", phase: "unconfirmed" });
      yield* run("accept", Effect.succeed(1));
      expect(sent[1]).toBe(sent[0]);
      expect(attempt()).toBeUndefined();

      yield* run("accept", Effect.fail(outcomeUnknown));
      // A different answer is a different command.
      yield* run("decline", Effect.fail(rejection));
      expect(sent[3]).not.toBe(sent[2]);
      expect(attempt()).toBeUndefined();

      // So is another option with the same decision.
      yield* run("accept", Effect.fail(outcomeUnknown), "once:0");
      yield* run("accept", Effect.fail(outcomeUnknown), "turn:0");
      expect(sent[5]).not.toBe(sent[4]);
    }),
  );

  it.effect(
    "shows a reply waiting for the connection and stops waiting once the environment is removed",
    () =>
      Effect.gen(function* () {
        const registry = AtomRegistry.make();
        const { entries, service } = yield* makeEnvironments();
        const waiting = yield* Deferred.make<void>();
        uuidSeed += 1;
        const fiber = yield* trackRuntimeResponse(
          registry,
          ENVIRONMENT_ID,
          approval("accept"),
          (_input, options) =>
            Effect.gen(function* () {
              yield* options.onAwaitingReconnect ?? Effect.void;
              yield* Deferred.succeed(waiting, undefined);
              yield* options.abandonWhen ?? Effect.never;
              return yield* outcomeUnknown;
            }),
        ).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, service),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.exit,
          Effect.forkChild,
        );
        yield* Deferred.await(waiting);
        expect(
          registry.get(runtimeResponseAttemptsAtom(ENVIRONMENT_ID)).get(REQUEST_ID)?.phase,
        ).toBe("awaiting_reconnect");
        expect(
          countRuntimeResponsesAwaitingReconnect(
            registry.get(runtimeResponseAttemptsAtom(ENVIRONMENT_ID)),
          ),
        ).toBe(1);

        yield* SubscriptionRef.set(entries, new Map());
        yield* Fiber.join(fiber);
        expect(
          registry.get(runtimeResponseAttemptsAtom(ENVIRONMENT_ID)).get(REQUEST_ID)?.phase,
        ).toBe("unconfirmed");
        expect(
          countRuntimeResponsesAwaitingReconnect(
            registry.get(runtimeResponseAttemptsAtom(ENVIRONMENT_ID)),
          ),
        ).toBe(0);
      }),
  );

  it.effect("completes the removal signal only once the environment is gone", () =>
    Effect.gen(function* () {
      const { entries, service } = yield* makeEnvironments();
      const removed = yield* environmentRemoved(service, ENVIRONMENT_ID).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(removed.pollUnsafe()).toBeUndefined();
      yield* SubscriptionRef.set(entries, new Map());
      yield* Fiber.join(removed);
    }),
  );
});
