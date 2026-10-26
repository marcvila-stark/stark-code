import { it } from "@effect/vitest";
import { ThreadId } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

it.effect("does not acquire credentials or publish agent activity", () =>
  Effect.gen(function* () {
    const relay = yield* AgentAwarenessRelay.make;
    yield* relay.publishThread(ThreadId.make("thread-private"));
    yield* relay.requestCatchUp();
    yield* relay.drain;
    yield* relay.start();
  }),
);
