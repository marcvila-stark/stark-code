import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import { ProviderAdapterRuntimeRequestResponseError } from "@starkfuture/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";

function projectionWithRuntimeRequest(
  runtimeRequest?: OrchestrationV2RuntimeRequest,
): OrchestrationV2ThreadProjection {
  return {
    runtimeRequests: runtimeRequest === undefined ? [] : [runtimeRequest],
  } as unknown as OrchestrationV2ThreadProjection;
}

function resolvedRuntimeRequest(
  requestId: RuntimeRequestId,
  providerSessionId: ProviderSessionId,
): OrchestrationV2RuntimeRequest {
  return {
    id: requestId,
    nodeId: NodeId.make(`node-${requestId}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "resolved",
    responseCapability: {
      type: "live",
      providerSessionId,
    },
    createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
    resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
  };
}

function layerRuntimeRequestTest(
  projection: OrchestrationV2ThreadProjection,
  getSession: ProviderSessionManager.ProviderSessionManagerV2Shape["get"],
) {
  return RuntimeRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );
}

it.effect("forwards orchestrator-resolved runtime requests to the live adapter", () => {
  const threadId = ThreadId.make("thread-runtime-request-resolved");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-resolved");
  const requestId = RuntimeRequestId.make("request-resolved");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const getSession = vi.fn(() =>
    Effect.succeed(
      Option.some({
        respondToRuntimeRequest,
      } as never),
    ),
  );
  const projection = {
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("node-runtime-request-resolved"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "resolved",
        responseCapability: {
          type: "live",
          providerSessionId,
        },
        createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
        resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = RuntimeRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    yield* service.respond({
      threadId,
      providerSessionId,
      requestId,
      decision: "accept",
    });

    assert.equal(getSession.mock.calls.length, 1);
    assert.equal(respondToRuntimeRequest.mock.calls.length, 1);
    assert.deepEqual(respondToRuntimeRequest.mock.calls[0]?.[0], {
      requestId,
      decision: "accept",
    });
  }).pipe(Effect.provide(layerTest));
});

it.effect("rejects expired runtime requests before invoking the live adapter", () => {
  const threadId = ThreadId.make("thread-runtime-request-expired");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-expired");
  const requestId = RuntimeRequestId.make("request-expired");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const getSession = vi.fn(() =>
    Effect.succeed(
      Option.some({
        respondToRuntimeRequest,
      } as never),
    ),
  );
  const projection = {
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("node-runtime-request-expired"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "expired",
        responseCapability: {
          type: "live",
          providerSessionId,
        },
        createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
        resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = RuntimeRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const error = yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "request-not-ready");
    assert.equal(
      error.message,
      `Runtime request ${requestId} on thread ${threadId} is not ready for response execution.`,
    );
    assert.isUndefined(error.cause);
    assert.equal(getSession.mock.calls.length, 0);
    assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect("classifies runtime request response validation failures", () => {
  const threadId = ThreadId.make("thread-runtime-request-validation");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-validation");
  const otherProviderSessionId = ProviderSessionId.make(
    "provider-session-runtime-request-validation-other",
  );
  const requestId = RuntimeRequestId.make("request-validation");
  const unexpectedGetSession = vi.fn(() => Effect.succeed(Option.none()));
  const layerMissing = layerRuntimeRequestTest(
    projectionWithRuntimeRequest(),
    unexpectedGetSession,
  );
  const layerNotResumable = layerRuntimeRequestTest(
    projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, otherProviderSessionId)),
    unexpectedGetSession,
  );
  const layerInactive = layerRuntimeRequestTest(
    projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, providerSessionId)),
    () => Effect.succeed(Option.none()),
  );
  const respond = Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    return yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);
  });

  return Effect.gen(function* () {
    const missing = yield* respond.pipe(Effect.provide(layerMissing));
    assert.equal(missing.reason, "request-missing");
    assert.equal(
      missing.message,
      `Runtime request ${requestId} no longer exists on thread ${threadId}.`,
    );
    assert.isUndefined(missing.cause);

    const notResumable = yield* respond.pipe(Effect.provide(layerNotResumable));
    assert.equal(notResumable.reason, "request-not-resumable");
    assert.equal(
      notResumable.message,
      `Runtime request ${requestId} on thread ${threadId} is not resumable on provider session ${providerSessionId}.`,
    );
    assert.isUndefined(notResumable.cause);

    const inactive = yield* respond.pipe(Effect.provide(layerInactive));
    assert.equal(inactive.reason, "provider-session-not-active");
    assert.equal(
      inactive.message,
      `Provider session ${providerSessionId} is not active for runtime request ${requestId} on thread ${threadId}.`,
    );
    assert.isUndefined(inactive.cause);
    assert.equal(unexpectedGetSession.mock.calls.length, 0);
  });
});

it.effect("preserves genuine provider session lookup failures as the cause", () => {
  const threadId = ThreadId.make("thread-runtime-request-lookup-failure");
  const providerSessionId = ProviderSessionId.make(
    "provider-session-runtime-request-lookup-failure",
  );
  const requestId = RuntimeRequestId.make("request-lookup-failure");
  const lookupFailure = new ProviderSessionManager.ProviderSessionLookupError({
    providerSessionId,
    cause: "lookup failed",
  });
  const layerTest = layerRuntimeRequestTest(
    projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, providerSessionId)),
    () => Effect.fail(lookupFailure),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const error = yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);

    assert.instanceOf(error, RuntimeRequestService.RuntimeRequestResponseExecutionError);
    assert.equal(error.reason, "unexpected-failure");
    assert.equal(
      error.message,
      `Failed to respond to runtime request ${requestId} on thread ${threadId} via provider session ${providerSessionId}.`,
    );
    assert.strictEqual(error.cause, lookupFailure);
  }).pipe(Effect.provide(layerTest));
});

it.effect(
  "never sends a second response once the provider closed the request or took the answer",
  () => {
    const threadId = ThreadId.make("thread-runtime-request-closed");
    const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-closed");
    const requestId = RuntimeRequestId.make("request-closed");
    const respondToRuntimeRequest = vi.fn(
      (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
    );
    const getSession = vi.fn(() =>
      Effect.succeed(Option.some({ respondToRuntimeRequest } as never)),
    );
    // D0 contract: OrchestrationV2RuntimeRequest.delivery.
    const withDelivery = (state: "not_needed" | "delivered") =>
      projectionWithRuntimeRequest({
        ...resolvedRuntimeRequest(requestId, providerSessionId),
        delivery: { state, attempts: 1 },
      } as OrchestrationV2RuntimeRequest);
    const respond = Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      return yield* service.respond({ threadId, providerSessionId, requestId, decision: "accept" });
    });

    return Effect.gen(function* () {
      // Codex resolved the request on its own before the user's answer went out.
      assert.equal(
        yield* respond.pipe(
          Effect.provide(layerRuntimeRequestTest(withDelivery("not_needed"), getSession)),
        ),
        "not_needed",
      );
      // An earlier attempt already handed this answer over.
      assert.equal(
        yield* respond.pipe(
          Effect.provide(layerRuntimeRequestTest(withDelivery("delivered"), getSession)),
        ),
        "delivered",
      );
      assert.equal(getSession.mock.calls.length, 0);
      assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
      // Without a recorded outcome the answer goes out, once.
      assert.equal(
        yield* respond.pipe(
          Effect.provide(
            layerRuntimeRequestTest(
              projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, providerSessionId)),
              getSession,
            ),
          ),
        ),
        "delivered",
      );
      assert.equal(respondToRuntimeRequest.mock.calls.length, 1);
    });
  },
);

it("tells an answer Stark never handed over from one whose handover failed", () => {
  const error = (reason: RuntimeRequestService.RuntimeRequestResponseExecutionError["reason"]) =>
    new RuntimeRequestService.RuntimeRequestResponseExecutionError({
      reason,
      threadId: ThreadId.make("thread-delivery"),
      providerSessionId: ProviderSessionId.make("provider-session-delivery"),
      requestId: RuntimeRequestId.make("request-delivery"),
    }).delivery;
  assert.equal(error("request-missing"), "not_delivered");
  assert.equal(error("request-not-ready"), "not_delivered");
  assert.equal(error("request-not-resumable"), "not_delivered");
  assert.equal(error("provider-session-not-active"), "not_delivered");
  assert.equal(error("unexpected-failure"), "uncertain");
  // An adapter that proved nothing was waiting never handed the answer over.
  const requestId = RuntimeRequestId.make("request-delivery");
  const adapterError = (nothingWaiting: boolean) =>
    new RuntimeRequestService.RuntimeRequestResponseExecutionError({
      reason: "unexpected-failure",
      threadId: ThreadId.make("thread-delivery"),
      providerSessionId: ProviderSessionId.make("provider-session-delivery"),
      requestId,
      cause: new ProviderAdapterRuntimeRequestResponseError({
        driver: ProviderDriverKind.make("codex"),
        requestId,
        ...(nothingWaiting ? { nothingWaiting } : {}),
      }),
    }).delivery;
  assert.equal(adapterError(true), "not_delivered");
  assert.equal(adapterError(false), "uncertain");
});
