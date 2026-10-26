import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeClaudeUsagePublisher } from "./ClaudeDriver.ts";

const update = {
  checkedAt: "2026-10-17T12:00:00.000Z",
  windows: [{ id: "seven_day", kind: "weekly" as const, label: "Weekly", usedPercent: 67 }],
};

describe("Claude process usage ownership", () => {
  it.effect(
    "drops old-process usage after invalidation and accepts a newly captured publisher",
    () =>
      Effect.gen(function* () {
        const published: number[] = [];
        const publisher = yield* makeClaudeUsagePublisher((value) =>
          Effect.sync(() => {
            published.push(value.windows[0]!.usedPercent!);
          }),
        );
        const oldProcess = yield* publisher.capture;
        yield* oldProcess(update);
        yield* publisher.invalidate;
        yield* oldProcess({ ...update, windows: [{ ...update.windows[0]!, usedPercent: 90 }] });
        const newProcess = yield* publisher.capture;
        yield* newProcess({ ...update, windows: [{ ...update.windows[0]!, usedPercent: 15 }] });
        assert.deepEqual(published, [67, 15]);
      }),
  );

  it.effect("finishes an accepted publication before invalidation can complete", () =>
    Effect.gen(function* () {
      const publishing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const invalidating = yield* Deferred.make<void>();
      const events: string[] = [];
      const publisher = yield* makeClaudeUsagePublisher(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(publishing, undefined);
          yield* Deferred.await(release);
          events.push("published");
        }),
      );
      const oldProcess = yield* publisher.capture;
      const publish = yield* oldProcess(update).pipe(Effect.forkChild);
      yield* Deferred.await(publishing);
      const invalidate = yield* Effect.gen(function* () {
        yield* Deferred.succeed(invalidating, undefined);
        yield* publisher.invalidate;
        events.push("invalidated");
      }).pipe(Effect.forkChild);
      yield* Deferred.await(invalidating);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(publish);
      yield* Fiber.join(invalidate);
      yield* oldProcess(update);
      assert.deepEqual(events, ["published", "invalidated"]);
    }),
  );
});
