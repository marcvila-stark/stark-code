import type { OtlpEndpointCheckInput, OtlpEndpointCheckResult } from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class OtlpEndpointCheck extends Context.Service<
  OtlpEndpointCheck,
  {
    readonly check: (input: OtlpEndpointCheckInput) => Effect.Effect<OtlpEndpointCheckResult>;
  }
>()("stark-code/observability/OtlpEndpointCheck") {}

// Retained RPC compatibility; no telemetry endpoint is contacted.
export const layer = Layer.succeed(
  OtlpEndpointCheck,
  OtlpEndpointCheck.of({ check: () => Effect.succeed({ _tag: "Unreachable", timedOut: false }) }),
);
