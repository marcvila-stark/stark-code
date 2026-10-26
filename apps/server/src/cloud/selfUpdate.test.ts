import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ServerSelfUpdate from "./selfUpdate.ts";

it.effect("rejects updates before acquiring downloader or launcher dependencies", () =>
  Effect.gen(function* () {
    const service = yield* ServerSelfUpdate.make();
    const error = yield* service.update({ targetVersion: "1.2.3" }).pipe(Effect.flip);
    assert.include(error.reason, "not configured");
    assert.include(
      (yield* service.commitDesktopUpdate("token").pipe(Effect.flip)).reason,
      "not configured",
    );
  }),
);
it("does not advertise a self-update capability", () => {
  assert.isNull(
    ServerSelfUpdate.resolveServerSelfUpdateCapability({
      desktopManaged: true,
      launcherManaged: true,
    }),
  );
});
