import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LocalStarkPage } from "@starkfuture/contracts";
import type { IpcMainInvokeEvent } from "electron";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";
import * as StarkPages from "../../starkPages/StarkPages.ts";

const Root = Schema.String.check(Schema.isMaxLength(4096));
const authorizedCatalog = Effect.fn("desktop.starkPages.authorizedCatalog")(function* (
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
    return false;
  return yield* Effect.try(() => {
    const url = new URL(frame.url);
    return (
      !url.username &&
      !url.password &&
      ((url.protocol === "starkcode:" && url.hostname === "app") ||
        (environment.isDevelopment &&
          Option.isSome(environment.devServerUrl) &&
          url.origin === environment.devServerUrl.value.origin))
    );
  }).pipe(Effect.orElseSucceed(() => false));
});
export const listPages = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STARK_PAGES_LIST_CHANNEL,
  payload: Root,
  result: Schema.NullOr(Schema.Array(LocalStarkPage)),
  handler: Effect.fn("desktop.ipc.starkPages.listPages")(function* (root, event) {
    if (!(yield* authorizedCatalog(event))) return null;
    return yield* (yield* StarkPages.StarkPages).listPages(root);
  }),
});
export const workbenchAvailable = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STARK_WORKBENCH_AVAILABLE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.starkPages.workbenchAvailable")(function* () {
    return yield* (yield* StarkPages.StarkPages).workbenchAvailable;
  }),
});
export const ensureMirror = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STARK_PAGES_ENSURE_MIRROR_CHANNEL,
  payload: Root,
  result: Schema.NullOr(Schema.Struct({ root: Schema.String, port: Schema.Int })),
  handler: Effect.fn("desktop.ipc.starkPages.ensureMirror")(function* (root) {
    return yield* (yield* StarkPages.StarkPages).ensureMirror(root);
  }),
});
export const findMirror = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STARK_PAGES_MIRROR_CHANNEL,
  payload: Root,
  result: Schema.NullOr(Schema.Struct({ root: Schema.String, port: Schema.Int })),
  handler: Effect.fn("desktop.ipc.starkPages.findMirror")(function* (root) {
    return yield* (yield* StarkPages.StarkPages).findMirror(root);
  }),
});
export const openFollow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STARK_PAGES_OPEN_EXTERNAL_CHANNEL,
  payload: Schema.Struct({ projectRoot: Root, url: Schema.Unknown }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.starkPages.openFollow")(function* (input) {
    return yield* (yield* StarkPages.StarkPages).openFollow(input);
  }),
});
export const openLink = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STARK_PAGES_OPEN_LINK_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.starkPages.openLink")(function* (url) {
    return yield* (yield* StarkPages.StarkPages).openLink(url);
  }),
});
