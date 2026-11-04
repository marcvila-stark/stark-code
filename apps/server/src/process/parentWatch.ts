import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * A backend the desktop app started must not outlive it. When the app is
 * killed hard (SIGKILL, a crash), nothing stops its backend: the backend is
 * reparented and keeps holding the Stark home's state lock, so the next app
 * launch, `backup resume` and every other opener find the data busy.
 *
 * The parent is gone when the process was reparented (`process.ppid`
 * changed; macOS and Linux reparent orphans) or the original parent pid no
 * longer exists (Windows keeps the old `ppid`). The process then stops itself
 * with SIGTERM, the signal the desktop's own stop sends, so the normal
 * teardown runs and releases the state lock.
 */

export interface ParentProcessProbe {
  /** The current parent pid, read again on every call. */
  readonly parentPid: () => number;
  /** Whether a process with this pid exists. */
  readonly exists: (pid: number) => boolean;
}

export const nodeParentProcessProbe: ParentProcessProbe = {
  parentPid: () => process.ppid,
  exists: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      // EPERM: it exists but belongs to someone else.
      return (cause as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

/** The parent this process was started under, read when the server's module graph loads. */
export const parentPidAtStart = process.ppid;

export const isParentGone = (startedUnder: number, probe: ParentProcessProbe): boolean =>
  startedUnder <= 1 || probe.parentPid() !== startedUnder || !probe.exists(startedUnder);

/** Completes once the parent `startedUnder` is gone, checking every `interval`. */
export const awaitParentExit = (input: {
  readonly startedUnder: number;
  readonly interval: Duration.Input;
  readonly probe?: ParentProcessProbe;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const probe = input.probe ?? nodeParentProcessProbe;
    while (!isParentGone(input.startedUnder, probe)) {
      yield* Effect.sleep(input.interval);
    }
  });

/**
 * Sends this process SIGTERM, which interrupts the main fiber and runs every
 * finalizer. If the teardown has not finished after `graceMs`, it exits: the
 * OS then drops the state lock with the process.
 */
export const stopThisProcess = (graceMs: number): Effect.Effect<void> =>
  Effect.sleep(Duration.millis(graceMs)).pipe(
    Effect.andThen(Effect.sync(() => process.exit(1))),
    // Detached: the teardown this starts interrupts every scoped fiber.
    Effect.forkDetach,
    Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGTERM"))),
  );

export const DESKTOP_PARENT_CHECK_INTERVAL = Duration.seconds(2);
/** Matches the desktop's SIGTERM-to-SIGKILL wait when it stops a backend. */
export const DESKTOP_PARENT_GONE_STOP_GRACE_MS = 10_000;
