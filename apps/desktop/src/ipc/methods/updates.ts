import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateRestartAckSchema,
  DesktopUpdateStateSchema,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: DesktopUpdateChannelSchema,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* (channel) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.setChannel(channel);
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.install")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.install;
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.check("web-ui");
  }),
});

export const cancelUpdateDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CANCEL_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.cancelDownload")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.cancelDownload;
  }),
});

export const setUpdatePostponed = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_POSTPONED_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setPostponed")(function* (postponed) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.setPostponed(postponed);
  }),
});

/** A window starts (true) or stops (false) answering restart preparation requests. */
export const registerUpdateRestartParticipant = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_RESTART_REGISTER_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updates.registerRestartParticipant")(function* (active, event) {
    if (!event) return;
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.setRestartParticipant(event.sender.id, active);
  }),
});

export const acknowledgeUpdateRestart = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_RESTART_ACK_CHANNEL,
  payload: DesktopUpdateRestartAckSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updates.acknowledgeRestart")(function* (ack, event) {
    if (!event) return;
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.acknowledgeRestart(event.sender.id, ack);
  }),
});
