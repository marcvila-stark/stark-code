// @effect-diagnostics nodeBuiltinImport:off - Model native helper pipes without opening the microphone.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { NativeDictationAvailability, NativeDictationEvent } from "@starkfuture/contracts";
import * as DesktopDictation from "./DesktopDictation.ts";
import * as NativeDictationHost from "./NativeDictationHost.ts";

vi.mock("electron", () => ({}));

function fixture(availability = Effect.succeed<NativeDictationAvailability>({ available: true })) {
  const children: ReturnType<typeof child>[] = [];
  const events: NativeDictationEvent[] = [];
  const timers = new Map<() => void, number>();
  let quit = () => {};
  let closed = () => {};
  function child() {
    return Object.assign(new NodeEvents.EventEmitter(), {
      stdin: new NodeStream.PassThrough(),
      stdout: new NodeStream.PassThrough(),
      stderr: null,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
  }
  const host = NativeDictationHost.NativeDictationHost.of({
    availability,
    launch: vi.fn(() => {
      const process = child();
      children.push(process);
      return process as unknown as NativeDictationHost.DictationChild;
    }),
    onQuit: (listener) => {
      quit = listener;
      return () => {
        quit = () => {};
      };
    },
    schedule: (duration, callback) => {
      timers.set(callback, duration);
      return () => {
        timers.delete(callback);
      };
    },
  });
  const owner: DesktopDictation.DictationOwner = {
    id: 42,
    send: (event) => {
      events.push(event);
    },
    onClosed: (listener) => {
      closed = listener;
      return () => {
        closed = () => {};
      };
    },
  };
  const layer = DesktopDictation.layer.pipe(
    Layer.provide(Layer.succeed(NativeDictationHost.NativeDictationHost, host)),
  );
  return {
    children,
    events,
    timers,
    host,
    owner,
    layer,
    quit: () => quit(),
    close: () => closed(),
  };
}

describe("desktop dictation lifecycle", () => {
  it.effect("reports native auto-stop finalization without closing before the transcript", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* DesktopDictation.DesktopDictation;
      yield* service.start({ sessionId: "auto-stop", locale: "en-US" }, f.owner);
      const child = f.children[0]!;
      child.stdout.write('{"type":"recording"}\n');
      child.stdout.write('{"type":"recording","finalizing":true}\n');
      expect(f.events.at(-1)).toEqual({
        sessionId: "auto-stop",
        type: "recording",
        finalizing: true,
      });
      expect(child.kill).not.toHaveBeenCalled();
      expect(
        Exit.isFailure(
          yield* Effect.exit(service.start({ sessionId: "too-early", locale: "en-US" }, f.owner)),
        ),
      ).toBe(true);
      child.stdout.write('{"type":"transcript","text":"Final words."}\n');
      expect(f.events.at(-1)).toEqual({
        sessionId: "auto-stop",
        type: "transcript",
        text: "Final words.",
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("forwards real audio levels only while its owner is recording", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* DesktopDictation.DesktopDictation;
      yield* service.start({ sessionId: "levels", locale: "en-US" }, f.owner);
      const child = f.children[0]!;
      child.stdout.write('{"type":"recording"}\n');
      for (const audioLevel of [0, 0.42, 1]) {
        child.stdout.write(JSON.stringify({ type: "recording", audioLevel }) + "\n");
      }
      yield* service.stop("levels", 42);
      child.stdout.write('{"type":"recording","audioLevel":0.7}\n');
      child.stdout.write('{"type":"transcript","text":"Voice draft."}\n');
      child.stdout.write('{"type":"recording","audioLevel":0.9}\n');
      expect(f.events).toEqual([
        { sessionId: "levels", type: "recording" },
        { sessionId: "levels", type: "recording", audioLevel: 0 },
        { sessionId: "levels", type: "recording", audioLevel: 0.42 },
        { sessionId: "levels", type: "recording", audioLevel: 1 },
        { sessionId: "levels", type: "transcript", text: "Voice draft." },
      ]);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects non-finite, out-of-range, or non-numeric audio levels", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* DesktopDictation.DesktopDictation;
      for (const [index, level] of ["-0.01", "1.01", "1e999", '"0.5"', "null"].entries()) {
        const sessionId = `invalid-level-${index}`;
        yield* service.start({ sessionId, locale: "en-US" }, f.owner);
        f.children.at(-1)!.stdout.write(`{"type":"recording","audioLevel":${level}}\n`);
        expect(f.events.at(-1)).toMatchObject({ sessionId, type: "error" });
        expect(f.children.at(-1)!.kill).toHaveBeenCalledWith("SIGTERM");
      }
      expect(f.events).toHaveLength(5);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "fits five minutes of levels and a maximally escaped transcript in the output budget",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const service = yield* DesktopDictation.DesktopDictation;
        yield* service.start({ sessionId: "long", locale: "en-US" }, f.owner);
        const transcript = "\u0001".repeat(32_000);
        const output =
          '{"type":"recording"}\n' +
          '{"type":"recording","audioLevel":0.99}\n'.repeat(1_200) +
          '{"type":"recording","finalizing":true}\n' +
          JSON.stringify({ type: "transcript", text: transcript }) +
          "\n";
        expect(Buffer.byteLength(output)).toBeLessThan(256 * 1024);
        f.children[0]!.stdout.write(output);
        expect(f.events).toHaveLength(1_203);
        expect(f.events.at(-1)).toEqual({
          sessionId: "long",
          type: "transcript",
          text: transcript,
        });
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("emits only to its owner, finalizes text once, and ignores stale child output", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* DesktopDictation.DesktopDictation;
      yield* service.start({ sessionId: "first", locale: "en-US" }, f.owner);
      const first = f.children[0]!;
      first.stdout.write('{"type":"recording"}\n');
      yield* service.stop("first", 42);
      expect(first.stdin.read()?.toString()).toBe('{"type":"stop"}\n');
      first.stdout.write('{"type":"transcript","text":"Keep this draft."}\n');
      yield* service.start({ sessionId: "second", locale: "en-US" }, f.owner);
      first.stdout.write('{"type":"transcript","text":"Never insert twice."}\n');
      first.emit("close", 0);
      expect(f.events).toEqual([
        { sessionId: "first", type: "recording" },
        { sessionId: "first", type: "transcript", text: "Keep this draft." },
      ]);
      f.children[1]!.stdout.write('{"type":"transcript","text":"Second draft."}\n');
      expect(f.events.at(-1)).toEqual({
        sessionId: "second",
        type: "transcript",
        text: "Second draft.",
      });
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects repeated starts and another owner's stop/cancel", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* DesktopDictation.DesktopDictation;
      yield* service.start({ sessionId: "one", locale: "en" }, f.owner);
      for (const operation of [
        service.start({ sessionId: "two", locale: "en" }, f.owner),
        service.stop("one", 43),
        service.cancel("other", 42),
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(operation))).toBe(true);
      }
      expect(f.children).toHaveLength(1);
      expect(f.children[0]!.kill).not.toHaveBeenCalled();
      yield* service.cancel("one", 42);
      expect(f.events).toEqual([{ sessionId: "one", type: "cancelled" }]);
      expect(f.children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("cancels pending startup without launching a late microphone process", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<NativeDictationAvailability>();
      const f = fixture(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(ready))),
      );
      yield* Effect.gen(function* () {
        const service = yield* DesktopDictation.DesktopDictation;
        const pending = yield* service
          .start({ sessionId: "pending", locale: "en" }, f.owner)
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* service.cancel("pending", 42);
        yield* Deferred.succeed(ready, { available: true });
        yield* Fiber.join(pending);
        expect(f.children).toHaveLength(0);
        expect(f.events).toEqual([{ sessionId: "pending", type: "cancelled" }]);
        expect(f.timers.size).toBe(0);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("preserves the shorter stop deadline while startup is pending", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<NativeDictationAvailability>();
      const f = fixture(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(ready))),
      );
      yield* Effect.gen(function* () {
        const service = yield* DesktopDictation.DesktopDictation;
        const pending = yield* service
          .start({ sessionId: "pending", locale: "en" }, f.owner)
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* service.stop("pending", 42);
        yield* Deferred.succeed(ready, { available: true });
        yield* Fiber.join(pending);
        expect([...f.timers.values()]).toEqual([15_000]);
        expect(f.children[0]!.stdin.read()?.toString()).toBe('{"type":"stop"}\n');
        [...f.timers.keys()][0]!();
        expect(f.events.at(-1)).toMatchObject({ sessionId: "pending", type: "error" });
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("cancels on renderer navigation/destruction and on app quit", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* DesktopDictation.DesktopDictation;
      yield* service.start({ sessionId: "closed", locale: "en" }, f.owner);
      f.close();
      yield* service.start({ sessionId: "quit", locale: "en" }, f.owner);
      f.quit();
      expect(f.events).toEqual([
        { sessionId: "closed", type: "cancelled" },
        { sessionId: "quit", type: "cancelled" },
      ]);
      for (const child of f.children) expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("bounds malformed output and cleans up child failures", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* DesktopDictation.DesktopDictation;
      for (const [id, payload] of [
        ["invalid", "not json\n"],
        ["oversized", "a".repeat(256 * 1024 + 1)],
      ]) {
        yield* service.start({ sessionId: id!, locale: "en" }, f.owner);
        f.children.at(-1)!.stdout.write(payload!);
        expect(f.events.at(-1)).toMatchObject({ sessionId: id, type: "error" });
      }
      yield* service.start({ sessionId: "crash", locale: "en" }, f.owner);
      f.children.at(-1)!.emit("error", new Error("private helper internals"));
      expect(f.events.at(-1)).toEqual({
        sessionId: "crash",
        type: "error",
        message: "Dictation could not start. Try again.",
      });
      expect(f.events).toHaveLength(3);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("kills terminating children at quit even after their session has settled", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* DesktopDictation.DesktopDictation;
      yield* service.start({ sessionId: "done", locale: "en" }, f.owner);
      yield* service.cancel("done", 42);
      f.quit();
      expect(f.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
      expect(f.timers.size).toBe(0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("reports unavailable helpers without spawning and releases the reservation", () => {
    const f = fixture(Effect.succeed({ available: false, reason: "Helper missing." }));
    return Effect.gen(function* () {
      const service = yield* DesktopDictation.DesktopDictation;
      for (const sessionId of ["one", "two"]) {
        const result = yield* Effect.exit(service.start({ sessionId, locale: "en" }, f.owner));
        expect(Exit.isFailure(result)).toBe(true);
      }
      expect(f.host.launch).not.toHaveBeenCalled();
      expect(f.events).toEqual([
        { sessionId: "one", type: "error", message: "Helper missing." },
        { sessionId: "two", type: "error", message: "Helper missing." },
      ]);
      expect(f.timers.size).toBe(0);
    }).pipe(Effect.provide(f.layer));
  });
});
