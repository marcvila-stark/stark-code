import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/** Dedicated Settings status clients have their own bounded lifetime. */
export function makeIdleStatusResources<A, E>(input: {
  readonly scope: Scope.Scope;
  readonly acquire: (cwd: string) => Effect.Effect<A, E, Scope.Scope>;
  readonly maxActive?: number;
  readonly idleMs?: number;
}) {
  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const lock = yield* Semaphore.make(1);
    const entries = new Map<
      string,
      {
        value: A;
        scope: Scope.Closeable;
        touched: number;
        generation: number;
        timer?: Fiber.Fiber<void>;
      }
    >();
    const close = (cwd: string) =>
      Effect.gen(function* () {
        const entry = entries.get(cwd);
        if (entry === undefined) return;
        entries.delete(cwd);
        if (entry.timer !== undefined) yield* Fiber.interrupt(entry.timer);
        yield* Scope.close(entry.scope, Exit.void);
      });
    yield* Scope.addFinalizer(
      input.scope,
      Effect.gen(function* () {
        for (const cwd of entries.keys()) yield* close(cwd);
      }),
    );
    return {
      invalidate: (cwd: string) => lock.withPermit(close(cwd)),
      get: (cwd: string): Effect.Effect<A, E> =>
        lock.withPermit(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              let entry = entries.get(cwd);
              if (entry === undefined) {
                if (entries.size >= (input.maxActive ?? 4)) {
                  const oldest = [...entries].sort(
                    (left, right) => left[1].touched - right[1].touched,
                  )[0];
                  if (oldest !== undefined) yield* close(oldest[0]);
                }
                const scope = yield* Scope.make();
                const result = yield* Effect.exit(
                  restore(input.acquire(cwd).pipe(Effect.provideService(Scope.Scope, scope))),
                );
                if (Exit.isFailure(result)) {
                  yield* Scope.close(scope, result);
                  return yield* Effect.failCause(result.cause);
                }
                entry = {
                  value: result.value,
                  scope,
                  touched: clock.currentTimeMillisUnsafe(),
                  generation: 0,
                };
                entries.set(cwd, entry);
              }
              if (entry.timer !== undefined) yield* Fiber.interrupt(entry.timer);
              entry.touched = clock.currentTimeMillisUnsafe();
              const generation = ++entry.generation;
              entry.timer = yield* Effect.sleep(input.idleMs ?? 1_800_000).pipe(
                Effect.andThen(
                  lock.withPermit(
                    Effect.gen(function* () {
                      const current = entries.get(cwd);
                      if (current?.generation !== generation) return;
                      entries.delete(cwd);
                      yield* Scope.close(current.scope, Exit.void);
                    }),
                  ),
                ),
                Effect.forkIn(input.scope),
              );
              return entry.value;
            }),
          ),
        ),
    };
  });
}
