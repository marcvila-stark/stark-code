import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@starkfuture/client-runtime/connection";
import {
  describeRuntimeResponseFailure,
  resolveRuntimeRequestOutcome,
  resolveRuntimeRequestResponseState,
  runtimeResponseAttemptsAtom,
  type RuntimeResponse,
  type RuntimeResponseAttempt,
} from "@starkfuture/client-runtime/state/runtime-request-response";
import type { EnvironmentThreadStatus } from "@starkfuture/client-runtime/state/threads";
import type {
  EnvironmentId,
  OrchestrationV2RuntimeRequest,
  RuntimeRequestId,
} from "@starkfuture/contracts";
import { Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "./components/ui/toast";

const NO_RUNTIME_RESPONSE_ATTEMPTS = Atom.make<
  ReadonlyMap<RuntimeRequestId, RuntimeResponseAttempt>
>(new Map()).pipe(Atom.withLabel("web-runtime-response-attempts:empty"));

/** Replies this client sent to an environment's pending requests, by request. */
export function useRuntimeResponseAttempts(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? NO_RUNTIME_RESPONSE_ATTEMPTS
      : runtimeResponseAttemptsAtom(environmentId),
  );
}

/** Response state of a request card, or null without a request. */
export function runtimeRequestCardState(input: {
  readonly request: {
    readonly requestId: RuntimeRequestId;
    readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  } | null;
  readonly attempts: ReadonlyMap<RuntimeRequestId, RuntimeResponseAttempt>;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly threadStatus: EnvironmentThreadStatus;
  readonly canOperate: boolean;
  readonly responding: boolean;
}) {
  return input.request === null
    ? null
    : resolveRuntimeRequestResponseState({
        connectionPhase: input.connectionPhase,
        threadStatus: input.threadStatus,
        responseCapability: input.request.responseCapability,
        canOperate: input.canOperate,
        responding: input.responding,
        attempt: input.attempts.get(input.request.requestId)?.phase,
      });
}

/**
 * Tells the user what became of a reply that failed, judged by the thread as it is now. Thread
 * errors drop transport failures, so this always goes to a toast.
 */
export function toastRuntimeResponseFailure(input: {
  readonly error: unknown;
  readonly kind: RuntimeResponse["kind"];
  readonly requestId: RuntimeRequestId;
  readonly threadStatus: EnvironmentThreadStatus;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest> | null | undefined;
}) {
  const notice = describeRuntimeResponseFailure({
    error: input.error,
    kind: input.kind,
    outcome: resolveRuntimeRequestOutcome(input),
  });
  toastManager.add(
    stackedThreadToast({ type: notice.tone, title: notice.title, description: notice.message }),
  );
}
