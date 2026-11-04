import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopBrowserCapture from "../../browserCapture/DesktopBrowserCapture.ts";
import { browserCapture, installBrowserCaptureEventForwarding } from "./browserCapture.ts";
import * as Channels from "../channels.ts";

describe("browser capture IPC boundary", () => {
  it.effect(
    "rejects other renderers and missing senders before calling the profile service",
    () => {
      const calls: string[] = [];
      return Effect.gen(function* () {
        assert(Exit.isFailure(yield* Effect.exit(browserCapture.handler({ action: "status" }))));
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              browserCapture.handler(
                { action: "connect", extensionId: "a".repeat(32) },
                { sender: { id: 8 } },
              ),
            ),
          ),
        );
        assert.deepEqual(calls, []);
        assert.deepEqual(
          yield* browserCapture.handler({ action: "status" }, { sender: { id: 7 } }),
          { connected: false },
        );
        assert.deepEqual(calls, ["status"]);
        assert(
          Exit.isFailure(
            yield* Effect.exit(
              browserCapture.handler(
                { action: "connect", extensionId: "invalid" },
                { sender: { id: 7 } },
              ),
            ),
          ),
        );
        assert.deepEqual(calls, ["status"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome({ webContents: { id: 7 } }),
            } as ElectronWindow.ElectronWindow["Service"]),
            Layer.succeed(DesktopBrowserCapture.DesktopBrowserCapture, {
              initialize: Effect.void,
              command: (input) =>
                Effect.sync(() => {
                  calls.push(input.action);
                  return { connected: false };
                }),
              subscribePending: () => Effect.void,
            }),
          ),
        ),
      );
    },
  );
  it.effect(
    "forwards pending notifications and releases its subscription with the application scope",
    () => {
      const sent: string[] = [];
      let listener: (() => Effect.Effect<void>) | undefined;
      let subscribed = false;
      return Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* installBrowserCaptureEventForwarding();
            assert(subscribed);
            yield* listener!();
            assert.deepEqual(sent, [Channels.BROWSER_CAPTURE_PENDING_CHANNEL]);
          }),
        );
        assert(!subscribed);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronWindow.ElectronWindow, {
              sendAll: (channel) =>
                Effect.sync(() => {
                  sent.push(channel);
                }),
            } as ElectronWindow.ElectronWindow["Service"]),
            Layer.succeed(DesktopBrowserCapture.DesktopBrowserCapture, {
              initialize: Effect.void,
              command: () => Effect.succeed({ connected: false }),
              subscribePending: (callback) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    listener = callback;
                    subscribed = true;
                  }),
                  () =>
                    Effect.sync(() => {
                      subscribed = false;
                    }),
                ),
            }),
          ),
        ),
      );
    },
  );
});
