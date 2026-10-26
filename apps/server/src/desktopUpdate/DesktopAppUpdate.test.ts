import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DesktopAppUpdate from "./DesktopAppUpdate.ts";

it.effect("never opens the desktop update control channel", () =>
  Effect.gen(function* () {
    const service = yield* DesktopAppUpdate.make();
    assert.isFalse(service.available);
    assert.include(
      (yield* service.run(() => Effect.die("progress must not run")).pipe(Effect.flip)).reason,
      "not configured",
    );
    assert.include((yield* service.commit("token").pipe(Effect.flip)).reason, "not configured");
  }),
);
