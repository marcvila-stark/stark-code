import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

it.effect("keeps packaged desktop updates disabled without configuring a feed or polling", () => {
  const harness = makeHarness({
    env: { STARK_CODE_DISABLE_AUTO_UPDATE: "false", STARK_CODE_DESKTOP_MOCK_UPDATES: "true" },
  });
  return Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.configure;
    const state = yield* updates.getState;
    assert.isFalse(state.enabled);
    assert.equal(state.status, "disabled");
    assert.deepEqual(harness.feedUrls(), []);
    assert.equal(harness.listenerCount(), 0);
    assert.equal(harness.checkCount(), 0);
    const result = yield* updates.check("menu");
    assert.isFalse(result.checked);
    assert.equal(harness.checkCount(), 0);
  }).pipe(Effect.provide(harness.layer));
});
