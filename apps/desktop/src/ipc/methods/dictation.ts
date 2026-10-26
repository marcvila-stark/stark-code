import {
  NativeDictationAvailability,
  NativeDictationSessionId,
  NativeDictationStartInput,
} from "@starkfuture/contracts";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopDictation from "../../dictation/DesktopDictation.ts";
import { DESKTOP_HOST, getDesktopScheme } from "../../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

const owner = (event?: DesktopIpc.DesktopIpcInvokeEvent) =>
  Effect.gen(function* () {
    const window = yield* (yield* ElectronWindow.ElectronWindow).main;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const frame = (event as Pick<IpcMainInvokeEvent, "senderFrame" | "sender"> | undefined)
      ?.senderFrame;
    if (
      !event ||
      !frame ||
      Option.isNone(window) ||
      event.sender.id !== window.value.webContents.id ||
      frame !== window.value.webContents.mainFrame
    ) {
      return yield* new DesktopDictation.DictationError({ reason: "sender" });
    }
    const trusted = yield* Effect.try(() => {
      const url = new URL(frame.url);
      return (
        !url.username &&
        !url.password &&
        url.protocol === `${getDesktopScheme(environment.isDevelopment)}:` &&
        url.host === DESKTOP_HOST
      );
    }).pipe(Effect.orElseSucceed(() => false));
    if (!trusted) return yield* new DesktopDictation.DictationError({ reason: "sender" });
    const contents = window.value.webContents;
    return {
      id: contents.id,
      send: (message) => {
        if (!contents.isDestroyed()) contents.send(Channels.DICTATION_EVENT_CHANNEL, message);
      },
      onClosed: (listener) => {
        const navigate = (
          _event: unknown,
          _url: string,
          _inPlace: boolean,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame) listener();
        };
        contents.on("destroyed", listener);
        contents.on("render-process-gone", listener);
        contents.on("did-start-navigation", navigate);
        return () => {
          contents.removeListener("destroyed", listener);
          contents.removeListener("render-process-gone", listener);
          contents.removeListener("did-start-navigation", navigate);
        };
      },
    } satisfies DesktopDictation.DictationOwner;
  });

export const availability = DesktopIpc.makeIpcMethod({
  channel: Channels.DICTATION_AVAILABILITY_CHANNEL,
  payload: Schema.Void,
  result: NativeDictationAvailability,
  handler: (_input, event) =>
    Effect.gen(function* () {
      yield* owner(event);
      return yield* (yield* DesktopDictation.DesktopDictation).availability;
    }),
});
export const start = DesktopIpc.makeIpcMethod({
  channel: Channels.DICTATION_START_CHANNEL,
  payload: NativeDictationStartInput,
  result: Schema.Void,
  handler: (input, event) =>
    Effect.gen(function* () {
      const sender = yield* owner(event);
      return yield* (yield* DesktopDictation.DesktopDictation).start(input, sender);
    }),
});
export const stop = DesktopIpc.makeIpcMethod({
  channel: Channels.DICTATION_STOP_CHANNEL,
  payload: NativeDictationSessionId,
  result: Schema.Void,
  handler: (sessionId, event) =>
    Effect.gen(function* () {
      const sender = yield* owner(event);
      return yield* (yield* DesktopDictation.DesktopDictation).stop(sessionId, sender.id);
    }),
});
export const cancel = DesktopIpc.makeIpcMethod({
  channel: Channels.DICTATION_CANCEL_CHANNEL,
  payload: NativeDictationSessionId,
  result: Schema.Void,
  handler: (sessionId, event) =>
    Effect.gen(function* () {
      const sender = yield* owner(event);
      return yield* (yield* DesktopDictation.DesktopDictation).cancel(sessionId, sender.id);
    }),
});
