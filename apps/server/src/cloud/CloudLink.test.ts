import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as CloudLink from "./CloudLink.ts";

it.effect("does not load saved credentials or revive a managed link", () =>
  Effect.gen(function* () {
    const link = yield* CloudLink.CloudLink;
    const state = yield* link.linkState();
    assert.isFalse(state.linked);
    assert.isNull(state.relayUrl);
    assert.isFalse(state.publishAgentActivity);
    assert.isFalse(yield* link.startManagedTunnelIfOriginConfirmed("http://localhost:3773"));
    assert.isFalse(yield* link.recoverManagedTunnel("http://localhost:3773"));
    assert.isFalse(yield* link.releaseManagedTunnelOnShutdown());
  }).pipe(Effect.provide(CloudLink.layer)),
);
