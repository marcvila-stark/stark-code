import type {
  DesktopUpdateInstallBlocker,
  DesktopUpdateRestartAck,
  DesktopUpdateRestartPrepareRequest,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

export class DesktopRestartStorageFlushError extends Schema.TaggedError<DesktopRestartStorageFlushError>()(
  "DesktopRestartStorageFlushError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to write the app windows' storage to disk.";
  }
}

export type DesktopRestartPreservationResult =
  | {
      readonly _tag: "Saved";
      readonly referencedAttachmentIds: ReadonlyArray<string>;
      /**
       * The stored drafts and stash one window sent back, for the backup.
       * Every window shares the same storage, so one copy is the whole set.
       */
      readonly draftsJson: string | null;
      readonly stashJson: string | null;
    }
  | { readonly _tag: "Failed"; readonly blockers: ReadonlyArray<DesktopUpdateInstallBlocker> };

/** How desktop main reaches the app windows. */
export interface DesktopRestartPreservationTransport {
  readonly broadcastPrepare: (request: DesktopUpdateRestartPrepareRequest) => Effect.Effect<void>;
  readonly broadcastRelease: (requestId: string) => Effect.Effect<void>;
  /** False once the window's contents are gone. */
  readonly isAlive: (participantId: number) => boolean;
  /** Writes these windows' DOM storage (drafts live in localStorage) to disk. */
  readonly flushStorage: (
    participantIds: ReadonlyArray<number>,
  ) => Effect.Effect<void, DesktopRestartStorageFlushError>;
}

const DESKTOP_RESTART_PRESERVATION_TIMEOUT = Duration.seconds(10);

/**
 * Before an update restart, every app window saves its drafts and prompt
 * stash, reads them back, and confirms. The restart goes ahead only when
 * every registered window confirmed `saved`; a timeout, a failed save, or an
 * upload or send still running aborts it. A window registers when its
 * renderer starts listening, so a window without the listener never blocks.
 */
export class DesktopRestartPreservation extends Context.Service<
  DesktopRestartPreservation,
  {
    readonly setParticipant: (participantId: number, active: boolean) => Effect.Effect<void>;
    readonly acknowledge: (
      participantId: number,
      ack: DesktopUpdateRestartAck,
    ) => Effect.Effect<void>;
    readonly preserve: (
      request: DesktopUpdateRestartPrepareRequest,
    ) => Effect.Effect<DesktopRestartPreservationResult>;
    /** Lifts every window's save barrier after a restart that did not happen. */
    readonly release: (requestId: string) => Effect.Effect<void>;
  }
>()("@starkfuture/desktop/updates/restartPreservation/DesktopRestartPreservation") {}

interface PendingPreservation {
  readonly requestId: string;
  readonly acks: Map<number, Deferred.Deferred<DesktopUpdateRestartAck>>;
}

function mergeBlockers(
  blockers: ReadonlyArray<DesktopUpdateInstallBlocker>,
): ReadonlyArray<DesktopUpdateInstallBlocker> {
  const byKind = new Map<DesktopUpdateInstallBlocker["kind"], DesktopUpdateInstallBlocker>();
  for (const blocker of blockers) {
    const existing = byKind.get(blocker.kind);
    if (!existing) {
      byKind.set(blocker.kind, blocker);
      continue;
    }
    byKind.set(blocker.kind, {
      ...existing,
      count: (existing.count ?? 1) + (blocker.count ?? 1),
    });
  }
  return [...byKind.values()];
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = (
  transport: DesktopRestartPreservationTransport,
  timeout: Duration.Input = DESKTOP_RESTART_PRESERVATION_TIMEOUT,
) =>
  Effect.sync(() => {
    const participants = new Set<number>();
    let pending: PendingPreservation | null = null;

    const preserve = Effect.fn("desktop.updates.preserveRendererState")(function* (
      request: DesktopUpdateRestartPrepareRequest,
    ) {
      const windows = [...participants].filter((id) => transport.isAlive(id));
      const acks = new Map<number, Deferred.Deferred<DesktopUpdateRestartAck>>();
      for (const id of windows) acks.set(id, yield* Deferred.make<DesktopUpdateRestartAck>());
      const current: PendingPreservation = { requestId: request.requestId, acks };
      pending = current;

      return yield* Effect.gen(function* () {
        yield* transport.broadcastPrepare(request);
        const answers = yield* Effect.forEach(
          [...acks.values()],
          (ack) => Deferred.await(ack).pipe(Effect.timeoutOption(timeout)),
          { concurrency: "unbounded" },
        );

        const blockers: DesktopUpdateInstallBlocker[] = [];
        const referenced = new Set<string>();
        let unresponsive = 0;
        let draftsJson: string | null = null;
        let stashJson: string | null = null;
        for (const answer of answers) {
          if (Option.isNone(answer)) {
            unresponsive += 1;
            continue;
          }
          if (answer.value.outcome !== "saved") {
            blockers.push(
              ...(answer.value.blockers.length > 0
                ? answer.value.blockers
                : [{ kind: "unsaved-draft" as const, message: "A draft couldn't be saved." }]),
            );
            continue;
          }
          for (const id of answer.value.referencedAttachmentIds) referenced.add(id);
          draftsJson ??= answer.value.draftsJson ?? null;
          stashJson ??= answer.value.stashJson ?? null;
        }
        if (unresponsive > 0) {
          blockers.push({
            kind: "window-unresponsive",
            message: "A window didn't confirm its drafts were saved.",
            count: unresponsive,
          });
        }
        if (blockers.length > 0) {
          return { _tag: "Failed", blockers: mergeBlockers(blockers) } as const;
        }

        const flushed = yield* transport.flushStorage(windows).pipe(Effect.exit);
        if (flushed._tag === "Failure") {
          return {
            _tag: "Failed",
            blockers: [{ kind: "storage-failed", message: "Drafts couldn't be written to disk." }],
          } as const;
        }
        return {
          _tag: "Saved",
          referencedAttachmentIds: [...referenced],
          draftsJson,
          stashJson,
        } as const;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (pending === current) pending = null;
          }),
        ),
      );
    });

    return DesktopRestartPreservation.of({
      setParticipant: (participantId, active) =>
        Effect.sync(() => {
          if (active) participants.add(participantId);
          else participants.delete(participantId);
        }),
      acknowledge: (participantId, ack) =>
        Effect.sync(() => {
          if (pending === null || pending.requestId !== ack.requestId) return;
          const deferred = pending.acks.get(participantId);
          if (deferred) Deferred.doneUnsafe(deferred, Effect.succeed(ack));
        }),
      preserve,
      release: (requestId) => transport.broadcastRelease(requestId),
    });
  });

export const layer = Layer.effect(
  DesktopRestartPreservation,
  Effect.gen(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    return yield* make({
      broadcastPrepare: (request) =>
        electronWindow.sendAll(IpcChannels.UPDATE_RESTART_PREPARE_CHANNEL, request),
      broadcastRelease: (requestId) =>
        electronWindow.sendAll(IpcChannels.UPDATE_RESTART_RELEASE_CHANNEL, requestId),
      isAlive: (participantId) => {
        try {
          const contents = Electron.webContents.fromId(participantId);
          return contents !== undefined && !contents.isDestroyed();
        } catch {
          return false;
        }
      },
      flushStorage: (participantIds) =>
        Effect.try({
          try: () => {
            const sessions = new Set<Electron.Session>();
            for (const id of participantIds) {
              const contents = Electron.webContents.fromId(id);
              if (contents && !contents.isDestroyed()) sessions.add(contents.session);
            }
            for (const session of sessions) session.flushStorageData();
          },
          catch: (cause) => new DesktopRestartStorageFlushError({ cause }),
        }),
    });
  }),
);

export const layerTest = (
  transport: DesktopRestartPreservationTransport,
  timeout: Duration.Input = DESKTOP_RESTART_PRESERVATION_TIMEOUT,
) => Layer.effect(DesktopRestartPreservation, make(transport, timeout));
