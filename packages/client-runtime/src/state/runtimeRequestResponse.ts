import {
  CommandId,
  type EnvironmentId,
  type OrchestrationV2RuntimeRequest,
  type RuntimeRequestId,
} from "@starkfuture/contracts";
import type * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, type AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type {
  DismissThreadUserInputInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  RuntimeResponseDispatchOptions,
} from "../operations/commands.ts";
import { isRpcClientError } from "../rpc/client.ts";
import type { EnvironmentThreadStatus } from "./threadState.ts";

/** A reply to a pending approval or question, as the user gave it. */
export type RuntimeResponse =
  | { readonly kind: "approval"; readonly input: RespondToThreadApprovalInput }
  | { readonly kind: "user-input"; readonly input: RespondToThreadUserInputInput }
  | { readonly kind: "dismiss"; readonly input: DismissThreadUserInputInput };

/**
 * `sending` is on the wire, `awaiting_reconnect` lost its connection and is sent again on the
 * next session, `unconfirmed` gave up waiting without learning whether the server applied it.
 */
export type RuntimeResponseAttemptPhase = "sending" | "awaiting_reconnect" | "unconfirmed";

export type RuntimeResponseAttempt = RuntimeResponse & {
  readonly commandId: CommandId;
  readonly phase: RuntimeResponseAttemptPhase;
};

/**
 * Replies this client sent, by request, kept in memory for the session. A retry of the same
 * reply reuses the stored `commandId`, so the server can tell it already applied it.
 */
export const runtimeResponseAttemptsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ReadonlyMap<RuntimeRequestId, RuntimeResponseAttempt>>(new Map()).pipe(
    Atom.keepAlive,
    Atom.withLabel(`runtime-response-attempts:${environmentId}`),
  ),
);

/** How many replies to an environment wait for its connection to come back. */
export function countRuntimeResponsesAwaitingReconnect(
  attempts: ReadonlyMap<RuntimeRequestId, RuntimeResponseAttempt>,
): number {
  let count = 0;
  for (const attempt of attempts.values()) {
    if (attempt.phase === "awaiting_reconnect") count += 1;
  }
  return count;
}

/** Same request and same reply: only then may a retry reuse the earlier command's identity. */
function sameRuntimeResponse(left: RuntimeResponse, right: RuntimeResponse): boolean {
  if (left.input.threadId !== right.input.threadId) return false;
  if (left.kind === "approval" && right.kind === "approval") {
    // Two options can share a decision; the option id and reason tell them apart.
    return (
      left.input.decision === right.input.decision &&
      left.input.optionId === right.input.optionId &&
      left.input.feedback === right.input.feedback
    );
  }
  if (left.kind === "user-input" && right.kind === "user-input") {
    return (
      JSON.stringify([left.input.answers, left.input.attachmentsByQuestionId ?? null]) ===
      JSON.stringify([right.input.answers, right.input.attachmentsByQuestionId ?? null])
    );
  }
  return left.kind === "dismiss" && right.kind === "dismiss";
}

/** The reply may have been applied: the call failed after it could have reached the server. */
function mayHaveApplied(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some(
    (reason) =>
      reason._tag !== "Fail" ||
      errorTag(reason.error) === "EnvironmentRpcOutcomeUnknownError" ||
      isRpcClientError(reason.error),
  );
}

/** Completes once the registry no longer holds the environment, as after the user removed it. */
export const environmentRemoved = (
  environments: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
) =>
  SubscriptionRef.changes(environments.entries).pipe(
    Stream.filter((entries) => !entries.has(environmentId)),
    Stream.runHead,
    Effect.asVoid,
  );

/**
 * Sends a reply and records it in `runtimeResponseAttemptsAtom` while it is out. Repeating an
 * unconfirmed reply reuses its `commandId`; a different reply to the same request is a new
 * command. The record clears once the server answered either way, and stays `unconfirmed`
 * when the reply may have been applied without an answer.
 */
export function trackRuntimeResponse<T extends RuntimeResponse, A, E, R>(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  response: T,
  send: (input: T["input"], options: RuntimeResponseDispatchOptions) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
    const attempts = runtimeResponseAttemptsAtom(environmentId);
    const requestId = response.input.requestId;
    const previous = registry.get(attempts).get(requestId);
    const commandId =
      response.input.commandId ??
      (previous !== undefined && sameRuntimeResponse(previous, response)
        ? previous.commandId
        : CommandId.make(yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie)));
    const record = (phase: RuntimeResponseAttemptPhase | null) =>
      Effect.sync(() => {
        const next = new Map(registry.get(attempts));
        if (phase === null) next.delete(requestId);
        else next.set(requestId, { ...response, commandId, phase });
        registry.set(attempts, next);
      });
    yield* record("sending");
    return yield* send(
      { ...response.input, commandId },
      {
        onAwaitingReconnect: record("awaiting_reconnect"),
        abandonWhen: environmentRemoved(environments, environmentId),
      },
    ).pipe(
      Effect.onExit((exit) =>
        record(Exit.isFailure(exit) && mayHaveApplied(exit.cause) ? "unconfirmed" : null),
      ),
    );
  });
}

/**
 * Whether a request's card can take an answer now. `unconfirmed` can: answering again with the
 * same reply re-sends the earlier command.
 */
export type RuntimeRequestResponseState =
  | "ready"
  | "sending"
  | "sending_after_reconnect"
  | "unconfirmed"
  | "reconnecting"
  | "offline"
  | "disconnected"
  | "syncing"
  | "provider_gone"
  | "not_permitted";

/**
 * A card answers only over a live connection and a synchronized thread: a cached card may show
 * a request that is already settled. Message-capable questions stay answerable after the
 * provider is gone; only `not_resumable` requests are.
 */
export function resolveRuntimeRequestResponseState(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly threadStatus: EnvironmentThreadStatus;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly canOperate: boolean;
  readonly responding: boolean;
  readonly attempt: RuntimeResponseAttemptPhase | null | undefined;
}): RuntimeRequestResponseState {
  if (input.attempt === "awaiting_reconnect") return "sending_after_reconnect";
  if (input.responding || input.attempt === "sending") return "sending";
  if (!input.canOperate) return "not_permitted";
  if (input.responseCapability === "not_resumable") return "provider_gone";
  switch (input.connectionPhase) {
    case "connected":
      break;
    case "connecting":
    case "reconnecting":
      return "reconnecting";
    case "offline":
      return "offline";
    case "available":
    case "error":
    case "unsupported":
      return "disconnected";
  }
  if (input.threadStatus !== "live") return "syncing";
  return input.attempt === "unconfirmed" ? "unconfirmed" : "ready";
}

export function canAnswerRuntimeRequest(state: RuntimeRequestResponseState): boolean {
  return state === "ready" || state === "unconfirmed";
}

export function isSendingRuntimeResponse(state: RuntimeRequestResponseState): boolean {
  return state === "sending" || state === "sending_after_reconnect";
}

/** Text shown beside a card's actions. Permission and provider loss keep their cards' own text. */
export function runtimeRequestResponseCaption(state: RuntimeRequestResponseState): string | null {
  switch (state) {
    case "reconnecting":
      return "Reconnecting — answer once connected";
    case "offline":
      return "Offline — answer once connected";
    case "disconnected":
      return "Not connected — answer once connected";
    case "syncing":
      return "Syncing…";
    case "sending_after_reconnect":
      return "Sending when reconnected";
    case "unconfirmed":
      return "Couldn't confirm your answer";
    case "ready":
    case "sending":
    case "provider_gone":
    case "not_permitted":
      return null;
  }
}

/**
 * What became of a request. Only a live projection that contains the request is evidence; a
 * cached or synchronizing one is `unloaded`. `lost` comes from the server's recovery marker on
 * the request; servers that do not send it report only the status.
 */
export type RuntimeRequestOutcome =
  | "pending"
  | "answered"
  | "delivery_uncertain"
  | "expired"
  | "cancelled"
  | "lost"
  | "unloaded";

export function resolveRuntimeRequestOutcome(input: {
  readonly threadStatus: EnvironmentThreadStatus;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest> | null | undefined;
  readonly requestId: RuntimeRequestId;
}): RuntimeRequestOutcome {
  if (input.threadStatus !== "live") return "unloaded";
  const request = input.runtimeRequests?.find((candidate) => candidate.id === input.requestId);
  if (request === undefined) return "unloaded";
  const lost = "lost" in request && request.lost != null;
  // A lost request that kept its answer was decided but may never have reached the agent.
  const answerKept = request.decision !== undefined || request.answers !== undefined;
  switch (request.status) {
    case "pending":
      return "pending";
    case "resolved":
      return lost ? "delivery_uncertain" : "answered";
    case "expired":
      return lost ? (answerKept ? "delivery_uncertain" : "lost") : "expired";
    case "cancelled":
      return lost ? (answerKept ? "delivery_uncertain" : "lost") : "cancelled";
  }
}

export interface RuntimeResponseFailureNotice {
  readonly tone: "info" | "warning" | "error";
  readonly title: string;
  readonly message: string;
}

function errorTag(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
    ? error.message
    : null;
}

/**
 * What to tell the user after a reply failed. Every failure gets a notice: a request missing
 * from the pending list is only explained by a live projection's `outcome`, never assumed
 * answered.
 */
export function describeRuntimeResponseFailure(input: {
  readonly error: unknown;
  readonly outcome: RuntimeRequestOutcome;
  readonly kind?: RuntimeResponse["kind"];
}): RuntimeResponseFailureNotice {
  const reply = input.kind === "dismiss" ? "dismissal" : "answer";
  const tag = errorTag(input.error);
  if (tag === "EnvironmentRpcUnavailableError") {
    return {
      tone: "error",
      title: "Not connected",
      message: `Your ${reply} was not sent. Try again once the connection is back.`,
    };
  }
  if (tag === "EnvironmentAuthorizationError") {
    return {
      tone: "error",
      title: "Not allowed",
      message: errorMessage(input.error) ?? "This connection cannot answer this request.",
    };
  }
  switch (input.outcome) {
    case "answered":
      return {
        tone: "info",
        title: "Already answered",
        message: "This request was already answered.",
      };
    case "delivery_uncertain":
      return {
        tone: "warning",
        title: "Answer may not have reached the agent",
        message:
          "This request has an answer, but Stark Code or the agent stopped before the agent received it.",
      };
    case "lost":
      return {
        tone: "warning",
        title: "Request lost",
        message: `This request was lost when Stark Code or the agent stopped, so your ${reply} was not delivered.`,
      };
    case "expired":
      return {
        tone: "warning",
        title: "Request expired",
        message: `This request expired before your ${reply} arrived.`,
      };
    case "cancelled":
      return {
        tone: "warning",
        title: "Request cancelled",
        message: `This request was cancelled before your ${reply} arrived.`,
      };
    case "pending":
    case "unloaded":
      break;
  }
  const message = errorMessage(input.error);
  if (
    tag === "EnvironmentRpcOutcomeUnknownError" ||
    isRpcClientError(input.error) ||
    message === null
  ) {
    return {
      tone: "warning",
      title: `Couldn't confirm your ${reply}`,
      message: `It shows as answered once reconnected if it went through. Retry sends the same ${reply} again.`,
    };
  }
  return { tone: "error", title: `Your ${reply} was not accepted`, message };
}
