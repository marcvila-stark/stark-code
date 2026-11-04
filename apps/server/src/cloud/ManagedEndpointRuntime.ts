import type { RelayManagedEndpointRuntimeConfig } from "@starkfuture/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
      readonly failure: "unsupported-platform" | "not-installed" | "spawn-failed";
      readonly reason: string;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "running";
      readonly providerKind: "cloudflare_tunnel";
      readonly pid: number;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "unsupported";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
    };

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
    readonly recoveryRequests: Stream.Stream<RelayManagedEndpointRuntimeConfig>;
    readonly requestRecovery: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<void>;
    /** Emits when the connector registers a tunnel connection, i.e. the relay can reach us again. */
    readonly tunnelConnected: Stream.Stream<void>;
    readonly withLinkStateLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("stark-code/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

function classifyRelayClientOutput(line: string): "connected" | "warning" | "debug" {
  if (/\bRegistered tunnel connection\b/iu.test(line)) {
    return "connected";
  }
  // cloudflared uses zerolog level tokens. FTL (fatal) and PNC (panic) are more
  // severe than ERR, so they must surface at least as loudly — without them a
  // fatal connector failure would be logged at debug and hidden.
  return /\b(?:ERR|WRN|FTL|PNC)\b/u.test(line) ? "warning" : "debug";
}

/**
 * Cloudflare's edge rejects a connector whose tunnel was deleted or whose
 * token no longer matches. The edge words this differently over time
 * (`Failed to get tunnel`, `Tunnel not found`, ...), sometimes prefixed with
 * `Unauthorized:`. Treat any `Unauthorized:` registration error as a rejection,
 * plus the unprefixed messages seen so far. Transient rejections while a new
 * tunnel's token propagates are absorbed by requiring several in a row.
 */
function isRejectedRelayClientTunnelOutput(line: string): boolean {
  return (
    /\bRegister tunnel error from server side\b/iu.test(line) &&
    /error="(?:Unauthorized:[^"]*|Failed to get tunnel|Tunnel not found|Record for tunnel not found|Invalid tunnel secret)"/iu.test(
      line,
    )
  );
}

/** Connector startup failures can clear after installation or a later spawn attempt. */
function isRetryableManagedEndpointRuntimeStatus(status: unknown): boolean {
  if (typeof status !== "object" || status === null || !("status" in status)) {
    return false;
  }
  if (status.status !== "failed" || !("failure" in status)) {
    return false;
  }
  return status.failure === "not-installed" || status.failure === "spawn-failed";
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.succeed(
  CloudManagedEndpointRuntime.of({
    applyConfig: () => Effect.succeed({ status: "disabled" as const }),
    recoveryRequests: Stream.empty,
    requestRecovery: () => Effect.void,
    tunnelConnected: Stream.empty,
    withLinkStateLock: (effect) => effect,
  }),
);
export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
