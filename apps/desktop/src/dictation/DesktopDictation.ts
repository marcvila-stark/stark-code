import type {
  NativeDictationAvailability,
  NativeDictationEvent,
  NativeDictationStartInput,
} from "@starkfuture/contracts";
import { NativeDictationEvent as EventSchema } from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NativeDictationHost from "./NativeDictationHost.ts";

export class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  reason: Schema.Literals(["sender", "unavailable", "busy", "owner", "launch"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "sender":
        return "Dictation is only available to the main Stark Code window.";
      case "unavailable":
        return "Dictation is unavailable. Reinstall or rebuild Stark Code.";
      case "busy":
        return "Another dictation is already running.";
      case "owner":
        return "This dictation belongs to another composer.";
      case "launch":
        return "Dictation could not start. Try again.";
    }
  }
}

/** The IPC boundary supplies only the validated main renderer and its lifecycle. */
export interface DictationOwner {
  readonly id: number;
  readonly send: (event: NativeDictationEvent) => void;
  readonly onClosed: (listener: () => void) => () => void;
}

export class DesktopDictation extends Context.Service<
  DesktopDictation,
  {
    readonly availability: Effect.Effect<NativeDictationAvailability>;
    readonly start: (
      input: NativeDictationStartInput,
      owner: DictationOwner,
    ) => Effect.Effect<void, DictationError>;
    readonly stop: (sessionId: string, ownerId: number) => Effect.Effect<void, DictationError>;
    readonly cancel: (sessionId: string, ownerId: number) => Effect.Effect<void, DictationError>;
  }
>()("@starkfuture/desktop/dictation/DesktopDictation") {}

interface Session {
  readonly id: string;
  readonly owner: DictationOwner;
  child?: NativeDictationHost.DictationChild;
  closed: boolean;
  stopping: boolean;
  buffer: string;
  bytes: number;
  clearTimer?: () => void;
  detach?: () => void;
}
const decodeEvent = Schema.decodeUnknownOption(EventSchema);
const MAX_OUTPUT_BYTES = 256 * 1024;

const make = Effect.gen(function* () {
  const host = yield* NativeDictationHost.NativeDictationHost;
  let active: Session | undefined;
  const children = new Set<NativeDictationHost.DictationChild>();
  const killTimers = new Map<NativeDictationHost.DictationChild, () => void>();

  const terminate = (child: NativeDictationHost.DictationChild) => {
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    killTimers.set(
      child,
      host.schedule(1500, () => child.kill("SIGKILL")),
    );
  };
  const finish = (session: Session, event: NativeDictationEvent) => {
    if (session.closed) return;
    session.closed = true;
    if (active === session) active = undefined;
    session.clearTimer?.();
    session.detach?.();
    if (session.child) terminate(session.child);
    // The owning window may have disappeared; never broadcast a transcript.
    try {
      session.owner.send(event);
    } catch {
      /* Renderer is gone. */
    }
  };
  const fail = (session: Session, message: string) =>
    finish(session, { sessionId: session.id, type: "error", message });
  const cancelActive = () => {
    if (active) finish(active, { sessionId: active.id, type: "cancelled" });
  };
  const shutdown = () => {
    cancelActive();
    for (const clearTimer of killTimers.values()) clearTimer();
    killTimers.clear();
    for (const child of children) child.kill("SIGKILL");
  };
  const removeQuit = host.onQuit(shutdown);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      removeQuit();
      shutdown();
    }),
  );

  const start = Effect.fn("desktop.dictation.start")(function* (
    input: NativeDictationStartInput,
    owner: DictationOwner,
  ) {
    if (active) return yield* new DictationError({ reason: "busy" });
    // Reserve ownership before the asynchronous availability check. Cancelling
    // during startup must prevent a late child from acquiring the microphone.
    const session: Session = {
      id: input.sessionId,
      owner,
      closed: false,
      stopping: false,
      buffer: "",
      bytes: 0,
    };
    active = session;
    session.detach = owner.onClosed(() =>
      finish(session, { sessionId: session.id, type: "cancelled" }),
    );
    session.clearTimer = host.schedule(330_000, () =>
      fail(session, "Dictation timed out. Try a shorter recording."),
    );
    const available = yield* host.availability;
    if (session.closed) return;
    if (!available.available) {
      finish(session, {
        sessionId: session.id,
        type: "error",
        message: available.reason ?? "Dictation is unavailable.",
      });
      return yield* new DictationError({ reason: "unavailable" });
    }
    yield* Effect.try({
      try: () => {
        const child = host.launch(input.locale);
        session.child = child;
        children.add(child);
        child.stdout.setEncoding("utf8");
        child.stdin.on("error", () => fail(session, "Dictation stopped unexpectedly. Try again."));
        child.once("error", () => fail(session, "Dictation could not start. Try again."));
        child.once("close", () => {
          children.delete(child);
          killTimers.get(child)?.();
          killTimers.delete(child);
          fail(session, "Dictation stopped before returning text. Try again.");
        });
        child.stdout.on("data", (chunk: string) => {
          if (session.closed) return;
          session.bytes += Buffer.byteLength(chunk);
          if (session.bytes > MAX_OUTPUT_BYTES) {
            fail(session, "The dictation response was too large. Try a shorter recording.");
            return;
          }
          session.buffer += chunk;
          let end: number;
          while (!session.closed && (end = session.buffer.indexOf("\n")) !== -1) {
            const line = session.buffer.slice(0, end);
            session.buffer = session.buffer.slice(end + 1);
            let raw: unknown;
            try {
              raw = JSON.parse(line);
            } catch {
              fail(session, "Dictation returned an invalid response. Try again.");
              return;
            }
            const event = decodeEvent(
              typeof raw === "object" && raw !== null ? { ...raw, sessionId: session.id } : raw,
            );
            if (Option.isNone(event)) {
              fail(session, "Dictation returned an invalid response. Try again.");
              return;
            }
            if (event.value.type === "recording") {
              if (!session.stopping) {
                try {
                  session.owner.send(event.value);
                } catch {
                  finish(session, { sessionId: session.id, type: "cancelled" });
                }
              }
            } else finish(session, event.value);
          }
        });
        if (session.stopping) child.stdin.write('{"type":"stop"}\n');
      },
      catch: () => {
        fail(session, "Dictation could not start. Try again.");
        return new DictationError({ reason: "launch" });
      },
    });
  });
  const owned = (sessionId: string, ownerId: number) => {
    if (active && (active.id !== sessionId || active.owner.id !== ownerId))
      throw new DictationError({ reason: "owner" });
    return active;
  };
  return DesktopDictation.of({
    availability: host.availability,
    start,
    stop: (sessionId, ownerId) =>
      Effect.try({
        try: () => {
          const session = owned(sessionId, ownerId);
          if (!session || session.stopping) return;
          session.stopping = true;
          session.clearTimer?.();
          session.clearTimer = host.schedule(15_000, () =>
            fail(session, "Dictation could not finish. Try again."),
          );
          session.child?.stdin.write('{"type":"stop"}\n');
        },
        catch: () => new DictationError({ reason: "owner" }),
      }),
    cancel: (sessionId, ownerId) =>
      Effect.try({
        try: () => {
          const session = owned(sessionId, ownerId);
          if (session) finish(session, { sessionId, type: "cancelled" });
        },
        catch: () => new DictationError({ reason: "owner" }),
      }),
  });
});

export const layer = Layer.effect(DesktopDictation, make);
