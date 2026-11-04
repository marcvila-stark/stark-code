import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as DesktopRemoteUpdates from "./DesktopRemoteUpdates.ts";

it.effect("does not subscribe to server-requested installs", () =>
  Effect.gen(function* () {
    // Needs no updater, telemetry or window service: nothing can reach an install.
    const exit = yield* Effect.exit(DesktopRemoteUpdates.listen);
    assert.isTrue(Exit.isSuccess(exit));
  }),
);
