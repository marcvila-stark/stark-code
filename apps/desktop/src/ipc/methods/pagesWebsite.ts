import {
  PagesWebsiteBounds,
  PagesWebsiteNavigation,
  PagesWebsiteSnapshot,
  PagesWebsiteState,
  PagesWebsiteViewId,
} from "@starkfuture/contracts";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { DESKTOP_HOST, getDesktopScheme } from "../../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Website from "../../starkPages/PagesWebsite.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { PAGES_WEBSITE_CHANNELS as channels } from "../pagesWebsiteChannels.ts";

const authorize = Effect.fn("desktop.pagesWebsite.authorize")(function* (
  event?: DesktopIpc.DesktopIpcInvokeEvent,
) {
  const window = yield* (yield* ElectronWindow.ElectronWindow).currentMainOrFirst;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const frame = (event as Pick<IpcMainInvokeEvent, "senderFrame"> | undefined)?.senderFrame;
  if (
    !event ||
    !frame ||
    Option.isNone(window) ||
    event.sender.id !== window.value.webContents.id ||
    frame !== window.value.webContents.mainFrame
  )
    return yield* new Website.PagesWebsiteError({ reason: "sender" });
  // The main window always loads getDesktopUrl, so only this build's app scheme is trusted.
  const trusted = yield* Effect.try(() => {
    const url = new URL(frame.url);
    return (
      !url.username &&
      !url.password &&
      url.protocol === `${getDesktopScheme(environment.isDevelopment)}:` &&
      url.host === DESKTOP_HOST
    );
  }).pipe(Effect.orElseSucceed(() => false));
  if (!trusted) return yield* new Website.PagesWebsiteError({ reason: "sender" });
  return { window: window.value, controller: yield* Website.PagesWebsite };
});
const attempt = <T>(operation: () => T) =>
  Effect.try({
    try: operation,
    catch: () => new Website.PagesWebsiteError({ reason: "unavailable" }),
  });
export const getState = DesktopIpc.makeIpcMethod({
  channel: channels.state,
  payload: Schema.Void,
  result: PagesWebsiteState,
  handler: (_input, event) =>
    Effect.gen(function* () {
      const { controller } = yield* authorize(event);
      return yield* attempt(() => controller.getState());
    }),
});
export const setBounds = DesktopIpc.makeIpcMethod({
  channel: channels.setBounds,
  payload: PagesWebsiteBounds,
  result: Schema.NullOr(PagesWebsiteSnapshot),
  handler: (input, event) =>
    Effect.gen(function* () {
      const { controller, window } = yield* authorize(event);
      return yield* Effect.tryPromise({
        try: () => controller.setBounds(window, input),
        catch: () => new Website.PagesWebsiteError({ reason: "unavailable" }),
      });
    }),
});
export const hide = DesktopIpc.makeIpcMethod({
  channel: channels.hide,
  payload: PagesWebsiteViewId,
  result: Schema.Void,
  handler: (input, event) =>
    Effect.gen(function* () {
      const { controller } = yield* authorize(event);
      yield* attempt(() => controller.hide(input));
    }),
});
export const navigate = DesktopIpc.makeIpcMethod({
  channel: channels.navigate,
  payload: PagesWebsiteNavigation,
  result: Schema.Void,
  handler: (input, event) =>
    Effect.gen(function* () {
      const { controller } = yield* authorize(event);
      yield* attempt(() => controller.navigate(input));
    }),
});
