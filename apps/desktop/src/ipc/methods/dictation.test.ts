import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopDictation from "../../dictation/DesktopDictation.ts";
import { availability, start, cancel, stop } from "./dictation.ts";

vi.mock("electron", () => ({}));

describe("dictation IPC", () => {
  const frame = { url: "starkcode://app/" };
  const window = { webContents: { id: 42, mainFrame: frame } };
  const startSession = vi.fn(() => Effect.void);
  const checkAvailability = vi.fn(() => ({ available: true }));
  const service = {
    availability: Effect.sync(checkAvailability),
    start: startSession,
    stop: () => Effect.void,
    cancel: () => Effect.void,
  };
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>, isDevelopment = false) =>
    effect.pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        main: Effect.succeedSome(window),
      } as never),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        isDevelopment,
        devServerUrl: isDevelopment
          ? Option.some(new URL("http://localhost:5173/"))
          : Option.none(),
      } as never),
      Effect.provideService(DesktopDictation.DesktopDictation, service),
    );
  it.effect("accepts the main app frame and rejects guests, iframes, and absent senders", () =>
    Effect.gen(function* () {
      const trusted = { sender: { id: 42 }, senderFrame: frame };
      expect(yield* run(availability.handler(undefined, trusted))).toEqual({ available: true });
      startSession.mockClear();
      yield* run(start.handler({ sessionId: "trusted", locale: "en-US" }, trusted));
      expect(startSession).toHaveBeenCalledTimes(1);
      for (const event of [
        undefined,
        { sender: { id: 43 }, senderFrame: frame },
        { sender: { id: 42 }, senderFrame: { url: "starkcode://app/" } },
      ]) {
        for (const effect of [
          availability.handler(undefined, event as never),
          start.handler({ sessionId: "one", locale: "en-US" }, event as never),
          stop.handler("one", event as never),
          cancel.handler("one", event as never),
        ]) {
          expect(Exit.isFailure(yield* Effect.exit(run(effect)))).toBe(true);
        }
      }
      expect(startSession).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("rejects a main frame navigated away from the app before native capture starts", () =>
    Effect.gen(function* () {
      startSession.mockClear();
      const trustedFrame = { sender: { id: 42 }, senderFrame: frame };
      for (const url of [
        "https://example.com/",
        "starkcode://other/",
        "starkcode://name@app/",
        "http://localhost:5173/",
      ]) {
        frame.url = url;
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              run(start.handler({ sessionId: "untrusted", locale: "en" }, trustedFrame)),
            ),
          ),
        ).toBe(true);
      }
      expect(startSession).not.toHaveBeenCalled();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          frame.url = "starkcode://app/";
        }),
      ),
    ),
  );
  it.effect("serves dictation only from the actual renderer scheme for its environment", () =>
    Effect.gen(function* () {
      const sender = { sender: { id: 42 }, senderFrame: frame };
      for (const isDevelopment of [false, true]) {
        startSession.mockClear();
        checkAvailability.mockClear();
        const scheme = isDevelopment ? "starkcode-dev" : "starkcode";
        frame.url = `${scheme}://app/#/workspace/chat`;
        expect(yield* run(availability.handler(undefined, sender), isDevelopment)).toEqual({
          available: true,
        });
        yield* run(
          start.handler({ sessionId: "renderer", locale: "en-US" }, sender),
          isDevelopment,
        );
        expect(checkAvailability).toHaveBeenCalledOnce();
        expect(startSession).toHaveBeenCalledOnce();
        for (const url of [
          `${isDevelopment ? "starkcode" : "starkcode-dev"}://app/`,
          "http://localhost:5173/",
          `${scheme}://other/`,
          `${scheme}://app:5173/`,
          `${scheme}://name@app/`,
        ]) {
          frame.url = url;
          for (const operation of [
            availability.handler(undefined, sender),
            start.handler({ sessionId: "foreign", locale: "en-US" }, sender),
          ]) {
            expect(Exit.isFailure(yield* Effect.exit(run(operation, isDevelopment)))).toBe(true);
          }
        }
        expect(checkAvailability).toHaveBeenCalledOnce();
        expect(startSession).toHaveBeenCalledOnce();
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          frame.url = "starkcode://app/";
        }),
      ),
    ),
  );
  it.effect("validates bounded identifiers and locale before launching native speech", () =>
    Effect.gen(function* () {
      const trusted = { sender: { id: 42 }, senderFrame: frame };
      for (const input of [
        { sessionId: "../bad", locale: "en" },
        { sessionId: "one", locale: "en; rm -rf" },
        { sessionId: "a".repeat(129), locale: "en" },
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(run(start.handler(input, trusted))))).toBe(true);
      }
    }),
  );
});
