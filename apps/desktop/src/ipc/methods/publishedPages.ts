import {
  StarkPublishedPagesStatus,
  StarkPublishedPagesOpenInput,
  StarkPublishedPageDocument,
  StarkPublishedPagesTool,
  StarkPublishedPagesReadInput,
  StarkPublishedPagesReadResult,
} from "@starkfuture/contracts";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as PublishedPages from "../../starkPages/PublishedPages.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { PUBLISHED_PAGES_CHANNELS } from "../publishedPagesChannels.ts";

/** A mirror iframe, preview webview, or remote page may never access the app's Pages identity. */
const trustedPagesSender = (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) =>
  Effect.gen(function* () {
    const window = yield* (yield* ElectronWindow.ElectronWindow).currentMainOrFirst;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const frame = (event as Pick<IpcMainInvokeEvent, "senderFrame" | "sender"> | undefined)
      ?.senderFrame;
    if (
      !event ||
      !frame ||
      Option.isNone(window) ||
      event.sender.id !== window.value.webContents.id ||
      frame !== window.value.webContents.mainFrame
    )
      return false;
    return yield* Effect.try(() => {
      const url = new URL(frame.url);
      if (url.username || url.password) return false;
      return (
        (url.protocol === "starkcode:" && url.hostname === "app") ||
        (environment.isDevelopment &&
          Option.isSome(environment.devServerUrl) &&
          url.origin === environment.devServerUrl.value.origin)
      );
    }).pipe(Effect.orElseSucceed(() => false));
  });

const authorized = Effect.fn("desktop.publishedPages.authorize")(function* (
  event?: DesktopIpc.DesktopIpcInvokeEvent,
) {
  if (!(yield* trustedPagesSender(event)))
    return yield* new PublishedPages.PublishedPagesRequestError({ reason: "invalid" });
  return yield* PublishedPages.PublishedPages;
});

export const status = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.status,
  payload: Schema.Void,
  result: StarkPublishedPagesStatus,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).status();
    }),
});
export const connect = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.connect,
  payload: Schema.Void,
  result: StarkPublishedPagesStatus,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).connect();
    }),
});
export const disconnect = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.disconnect,
  payload: Schema.Void,
  result: StarkPublishedPagesStatus,
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).disconnect();
    }),
});
export const listTools = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.listTools,
  payload: Schema.Void,
  result: Schema.Array(StarkPublishedPagesTool),
  handler: (_input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).listTools();
    }),
});
export const read = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.read,
  payload: StarkPublishedPagesReadInput,
  result: StarkPublishedPagesReadResult,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).read(input);
    }),
});

export const openPage = DesktopIpc.makeIpcMethod({
  channel: PUBLISHED_PAGES_CHANNELS.openPage,
  payload: StarkPublishedPagesOpenInput,
  result: StarkPublishedPageDocument,
  handler: (input, event) =>
    Effect.gen(function* () {
      return yield* (yield* authorized(event)).openPage(input);
    }),
});
