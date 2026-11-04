import {
  type OrchestrationV2RuntimeRequestDeliveryState,
  ProviderApprovalDecision,
  type ProviderApprovalOptionId,
  ProviderSessionId,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

/**
 * How an answer that reached the respond effect ended, short of a failure:
 * the provider took it, or it had already closed the request (Codex
 * `serverRequest/resolved`) or taken this answer, so nothing was sent again.
 */
export type RuntimeRequestResponseOutcome = Extract<
  OrchestrationV2RuntimeRequestDeliveryState,
  "delivered" | "not_needed"
>;

const isAdapterResponseError = Schema.is(
  ProviderAdapter.ProviderAdapterRuntimeRequestResponseError,
);

export class RuntimeRequestResponseExecutionError extends Schema.TaggedError<RuntimeRequestResponseExecutionError>()(
  "RuntimeRequestResponseExecutionError",
  {
    reason: Schema.Literals([
      "request-missing",
      "request-not-ready",
      "request-not-resumable",
      "provider-session-not-active",
      "unexpected-failure",
    ]),
    threadId: ThreadId,
    providerSessionId: ProviderSessionId,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "request-missing":
        return `Runtime request ${this.requestId} no longer exists on thread ${this.threadId}.`;
      case "request-not-ready":
        return `Runtime request ${this.requestId} on thread ${this.threadId} is not ready for response execution.`;
      case "request-not-resumable":
        return `Runtime request ${this.requestId} on thread ${this.threadId} is not resumable on provider session ${this.providerSessionId}.`;
      case "provider-session-not-active":
        return `Provider session ${this.providerSessionId} is not active for runtime request ${this.requestId} on thread ${this.threadId}.`;
      case "unexpected-failure":
        return `Failed to respond to runtime request ${this.requestId} on thread ${this.threadId} via provider session ${this.providerSessionId}.`;
    }
  }

  /**
   * What a failed attempt says about delivery. Every refusal before the
   * adapter call sent nothing, and so does an adapter that proved nothing was
   * waiting; any other adapter failure may or may not have reached the
   * provider.
   */
  get delivery(): Extract<
    OrchestrationV2RuntimeRequestDeliveryState,
    "not_delivered" | "uncertain"
  > {
    return this.reason !== "unexpected-failure" ||
      (isAdapterResponseError(this.cause) && this.cause.nothingWaiting === true)
      ? "not_delivered"
      : "uncertain";
  }

  /** The reason the request shows for that delivery, in the user's words. */
  get deliveryReason(): string {
    switch (this.reason) {
      case "request-missing":
        return "The request no longer exists, so the answer was not sent.";
      case "request-not-ready":
        return "The request was no longer waiting for this answer, so it was not sent.";
      case "request-not-resumable":
        return "The session that asked cannot take answers any more, so the answer was not sent.";
      case "provider-session-not-active":
        return "The agent's session ended before the answer was sent.";
      case "unexpected-failure":
        return this.delivery === "not_delivered"
          ? "Nothing was waiting for this answer any more, so nothing ran."
          : "Sending the answer failed; it may or may not have reached the agent.";
    }
  }
}

const isRuntimeRequestResponseExecutionError = Schema.is(RuntimeRequestResponseExecutionError);

export interface RuntimeRequestServiceV2Shape {
  readonly respond: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly requestId: RuntimeRequestId;
    readonly decision?: ProviderApprovalDecision;
    readonly optionId?: ProviderApprovalOptionId;
    readonly feedback?: string;
    readonly answers?: ProviderUserInputAnswers;
  }) => Effect.Effect<RuntimeRequestResponseOutcome, RuntimeRequestResponseExecutionError>;
}

export class RuntimeRequestServiceV2 extends Context.Service<
  RuntimeRequestServiceV2,
  RuntimeRequestServiceV2Shape
>()("stark-code/orchestration-v2/RuntimeRequestService/RuntimeRequestServiceV2") {}

export const layer: Layer.Layer<
  RuntimeRequestServiceV2,
  never,
  ProjectionStore.ProjectionStoreV2 | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effect(
  RuntimeRequestServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

    return RuntimeRequestServiceV2.of({
      respond: (input) =>
        Effect.gen(function* () {
          const request = yield* projections.getRuntimeRequest(input.threadId, input.requestId);
          if (request === undefined) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-missing",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          // The provider closed the request itself (Codex serverRequest/resolved),
          // or an earlier attempt already handed this answer over: a second
          // response must never go out.
          const recorded = request.delivery?.state;
          if (recorded === "not_needed" || recorded === "delivered") return recorded;
          // Dispatch validates the request while it is pending, then persists the
          // resolved projection before this effect is executed.
          if (request.status !== "resolved") {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-ready",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          if (
            request.responseCapability.type !== "live" ||
            request.responseCapability.providerSessionId !== input.providerSessionId
          ) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-resumable",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          const session = yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "provider-session-not-active",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          yield* session.value.respondToRuntimeRequest({
            requestId: input.requestId,
            ...(input.decision === undefined ? {} : { decision: input.decision }),
            ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
            ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
            ...(input.answers === undefined ? {} : { answers: input.answers }),
          });
          return "delivered" as const;
        }).pipe(
          Effect.mapError((cause) =>
            isRuntimeRequestResponseExecutionError(cause)
              ? cause
              : new RuntimeRequestResponseExecutionError({
                  reason: "unexpected-failure",
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  requestId: input.requestId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
