// Native process I/O is kept at this boundary; audio never enters Electron.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";
import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { NativeDictationAvailability } from "@starkfuture/contracts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export type DictationChild = NodeChildProcess.ChildProcessByStdio<
  NodeStream.Writable,
  NodeStream.Readable,
  null
>;

export class NativeDictationHost extends Context.Service<
  NativeDictationHost,
  {
    readonly availability: Effect.Effect<NativeDictationAvailability>;
    readonly launch: (locale: string) => DictationChild;
    readonly onQuit: (listener: () => void) => () => void;
    readonly schedule: (delayMs: number, callback: () => void) => () => void;
  }
>()("@starkfuture/desktop/dictation/NativeDictationHost") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const helper = environment.path.join(
    ...(environment.isPackaged
      ? [environment.resourcesPath, "dictation"]
      : [environment.rootDir, "native", "dictation", "build", environment.processArch]),
    "Stark Dictation.app",
    "Contents",
    "MacOS",
    "stark-dictation",
  );
  return NativeDictationHost.of({
    availability:
      environment.platform !== "darwin"
        ? Effect.succeed({ available: false, reason: "Dictation is available in the Mac app." })
        : fs.access(helper).pipe(
            Effect.as({ available: true }),
            Effect.orElseSucceed(() => ({
              available: false,
              reason: "The dictation helper is missing. Reinstall or rebuild Stark Code.",
            })),
          ),
    launch: (locale) =>
      NodeChildProcess.spawn(helper, ["--launch", "--locale", locale], {
        stdio: ["pipe", "pipe", "ignore"],
      }),
    onQuit: (listener) => {
      Electron.app.on("before-quit", listener);
      return () => Electron.app.removeListener("before-quit", listener);
    },
    schedule: (delayMs, callback) => {
      // @effect-diagnostics-next-line globalTimers:off - This callback drives native child-process shutdown, including after Effect scope disposal.
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    },
  });
});

export const layer = Layer.effect(NativeDictationHost, make);
