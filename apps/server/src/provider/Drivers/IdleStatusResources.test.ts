import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makeIdleStatusResources } from "./IdleStatusResources.ts";

describe("Settings status client lifetime", () => {
  it.effect("reuses live status clients, evicts the oldest, and closes idle resources", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened: string[] = [];
        const closed: string[] = [];
        const resources = yield* makeIdleStatusResources({
          scope: yield* Effect.scope,
          maxActive: 2,
          idleMs: 1000,
          acquire: (cwd) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                opened.push(cwd);
                return cwd;
              }),
              () =>
                Effect.sync(() => {
                  closed.push(cwd);
                }),
            ),
        });
        assert.equal(yield* resources.get("one"), "one");
        assert.equal(yield* resources.get("one"), "one");
        assert.deepEqual(opened, ["one"]);
        yield* resources.get("two");
        yield* resources.get("three");
        assert.deepEqual(closed, ["one"]);
        yield* TestClock.adjust("1001 millis");
        assert.deepEqual([...closed].sort(), ["one", "three", "two"]);
        yield* resources.get("two");
        assert.deepEqual(opened, ["one", "two", "three", "two"]);
      }),
    ),
  );
});
