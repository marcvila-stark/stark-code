import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  DesktopUpdateLifecycle,
  isLoopbackInstallerHandoff,
  layerTest,
  type NativeMacUpdater,
} from "./updateLifecycle.ts";

function makeFakeNative(feedUrl = "http://127.0.0.1:53111") {
  const downloadedListeners = new Set<() => void>();
  const errorListeners = new Set<(error: unknown) => void>();
  let checks = 0;
  let installs = 0;
  const native: NativeMacUpdater = {
    getFeedURL: () => feedUrl,
    onUpdateDownloaded: (listener) => {
      downloadedListeners.add(listener);
      return () => {
        downloadedListeners.delete(listener);
      };
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    checkForUpdates: () => {
      checks += 1;
    },
    quitAndInstall: () => {
      installs += 1;
    },
  };
  return {
    layer: Layer.merge(layerTest(native), TestClock.layer()),
    /** Squirrel finished fetching, verifying and staging the update. */
    stage: () => {
      for (const listener of downloadedListeners) listener();
    },
    fail: (error: unknown) => {
      for (const listener of errorListeners) listener(error);
    },
    checks: () => checks,
    installs: () => installs,
  };
}

describe("isLoopbackInstallerHandoff", () => {
  it("accepts only MacUpdater's own loopback proxy", () => {
    assert.isTrue(isLoopbackInstallerHandoff("http://127.0.0.1:53111"));
    assert.isTrue(isLoopbackInstallerHandoff("http://127.0.0.1:53111/"));
    for (const url of [
      "",
      "not a url",
      "http://127.0.0.1",
      "https://127.0.0.1:53111",
      "http://localhost:53111",
      "http://user:secret@127.0.0.1:53111",
      "http://127.0.0.2:53111",
      "https://updates.example.com/stark/",
    ]) {
      assert.isFalse(isLoopbackInstallerHandoff(url), url);
    }
  });
});

describe("DesktopUpdateLifecycle", () => {
  it.effect("quits to install once the installer stages the approved update", () => {
    const fake = makeFakeNative();
    return Effect.gen(function* () {
      const lifecycle = yield* DesktopUpdateLifecycle;
      const commit = yield* lifecycle
        .commit({ requestId: "r1", version: "1.2.4" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(fake.checks(), 1);
      assert.equal(fake.installs(), 0);

      fake.stage();
      assert.deepEqual(yield* Fiber.join(commit), { _tag: "Committed" });
      assert.equal(fake.installs(), 1);

      fake.stage();
      assert.equal(fake.installs(), 1);
    }).pipe(Effect.scoped, Effect.provide(fake.layer));
  });

  it.effect("never quits for a staging that arrives after the request timed out", () => {
    const fake = makeFakeNative();
    return Effect.gen(function* () {
      const lifecycle = yield* DesktopUpdateLifecycle;
      const late: string[] = [];
      yield* lifecycle.onLateStaged((version) => late.push(version));

      const commit = yield* lifecycle
        .commit({ requestId: "r2", version: "1.2.4" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(60));
      assert.deepEqual(yield* Fiber.join(commit), { _tag: "TimedOut" });

      // The caller restarted its backends and a task is running again.
      fake.stage();
      fake.stage();
      assert.equal(fake.installs(), 0);
      assert.deepEqual(late, ["1.2.4", "1.2.4"]);
    }).pipe(Effect.scoped, Effect.provide(fake.layer));
  });

  it.effect("never quits for a completion that follows an installer error", () => {
    const fake = makeFakeNative();
    return Effect.gen(function* () {
      const lifecycle = yield* DesktopUpdateLifecycle;
      const commit = yield* lifecycle
        .commit({ requestId: "r3", version: "1.2.4" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const error = new Error("Code signature at URL did not pass validation");
      fake.fail(error);
      const outcome = yield* Fiber.join(commit);
      assert.equal(outcome._tag, "Failed");
      assert.strictEqual(outcome._tag === "Failed" ? outcome.cause : null, error);

      fake.stage();
      assert.equal(fake.installs(), 0);
    }).pipe(Effect.scoped, Effect.provide(fake.layer));
  });

  it.effect("installs exactly once when a retry sees a duplicate completion", () => {
    const fake = makeFakeNative();
    return Effect.gen(function* () {
      const lifecycle = yield* DesktopUpdateLifecycle;
      const first = yield* lifecycle
        .commit({ requestId: "r4", version: "1.2.4" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      fake.fail(new Error("installer busy"));
      assert.equal((yield* Fiber.join(first))._tag, "Failed");

      // The user retried: a new approved request is live.
      const retry = yield* lifecycle
        .commit({ requestId: "r5", version: "1.2.4" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      fake.stage(); // the first attempt's completion
      fake.stage(); // the retry's own completion
      assert.deepEqual(yield* Fiber.join(retry), { _tag: "Committed" });
      assert.equal(fake.installs(), 1);
    }).pipe(Effect.scoped, Effect.provide(fake.layer));
  });

  it.effect("installs an update staged late on the next approved request", () => {
    const fake = makeFakeNative();
    return Effect.gen(function* () {
      const lifecycle = yield* DesktopUpdateLifecycle;
      const first = yield* lifecycle
        .commit({ requestId: "r6", version: "1.2.4" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(60));
      assert.equal((yield* Fiber.join(first))._tag, "TimedOut");
      fake.stage();
      assert.equal(fake.installs(), 0);

      assert.deepEqual(yield* lifecycle.commit({ requestId: "r7", version: "1.2.4" }), {
        _tag: "Committed",
      });
      assert.equal(fake.installs(), 1);
      assert.equal(fake.checks(), 1);
    }).pipe(Effect.scoped, Effect.provide(fake.layer));
  });

  it.effect("never quits for a request withdrawn by recovery", () => {
    const fake = makeFakeNative();
    return Effect.gen(function* () {
      const lifecycle = yield* DesktopUpdateLifecycle;
      const commit = yield* lifecycle
        .commit({ requestId: "r8", version: "1.2.4" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* lifecycle.withdraw("r8");
      assert.deepEqual(yield* Fiber.join(commit), { _tag: "Withdrawn" });

      fake.stage();
      assert.equal(fake.installs(), 0);

      // Withdrawn before it reached the installer: it never asks.
      yield* lifecycle.withdraw("early");
      assert.deepEqual(yield* lifecycle.commit({ requestId: "early", version: "1.2.4" }), {
        _tag: "Withdrawn",
      });
      assert.equal(fake.checks(), 1);
    }).pipe(Effect.scoped, Effect.provide(fake.layer));
  });

  it.effect("refuses before asking the installer when its feed is not the local handoff", () => {
    const fake = makeFakeNative("https://updates.example.com/stark/");
    return Effect.gen(function* () {
      const lifecycle = yield* DesktopUpdateLifecycle;
      const outcome = yield* lifecycle.commit({ requestId: "r9", version: "1.2.4" });
      assert.equal(outcome._tag, "Refused");
      fake.stage();
      assert.equal(fake.checks(), 0);
      assert.equal(fake.installs(), 0);
    }).pipe(Effect.scoped, Effect.provide(fake.layer));
  });
});
