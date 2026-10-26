import type { ThreadId } from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  {
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly requestCatchUp: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("stark-code/relay/AgentAwarenessRelay") {}
export const make = Effect.succeed(
  AgentAwarenessRelay.of({
    publishThread: () => Effect.void,
    drain: Effect.void,
    requestCatchUp: () => Effect.void,
    start: () => Effect.void,
  }),
);
export const layer = Layer.effect(AgentAwarenessRelay, make);
