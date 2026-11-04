import { BrowserCaptureDesktopCommand, BrowserCaptureDesktopResult } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopBrowserCapture from "../../browserCapture/DesktopBrowserCapture.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

class BrowserCaptureUnauthorizedError extends Schema.TaggedError<BrowserCaptureUnauthorizedError>()(
  "BrowserCaptureUnauthorizedError",
  {},
) {}
export const browserCapture = DesktopIpc.makeIpcMethod({
  channel: Channels.BROWSER_CAPTURE_CHANNEL,
  payload: BrowserCaptureDesktopCommand,
  result: BrowserCaptureDesktopResult,
  handler: Effect.fn("desktop.ipc.browserCapture")(function* (command, event) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (!event || Option.isNone(main) || main.value.webContents.id !== event.sender.id)
      return yield* new BrowserCaptureUnauthorizedError();
    return yield* (yield* DesktopBrowserCapture.DesktopBrowserCapture).command(command);
  }),
});

export const installBrowserCaptureEventForwarding = Effect.fn("desktop.ipc.browserCapture.events")(
  function* () {
    const capture = yield* DesktopBrowserCapture.DesktopBrowserCapture;
    const window = yield* ElectronWindow.ElectronWindow;
    yield* capture.subscribePending(() => window.sendAll(Channels.BROWSER_CAPTURE_PENDING_CHANNEL));
  },
);
