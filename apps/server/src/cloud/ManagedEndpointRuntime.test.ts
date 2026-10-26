import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Runtime from "./ManagedEndpointRuntime.ts";

it.effect("does not acquire a relay executable or start a connector", () =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.make;
    assert.deepEqual(yield* runtime.applyConfig(null), { status: "disabled" });
  }),
);
