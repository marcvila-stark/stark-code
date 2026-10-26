// Native child callbacks need process-group signalling and file-stream backpressure.
// Timers must outlive an interrupted Effect scope long enough to kill the group.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as NodeStringDecoder from "node:string_decoder";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import { PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import { STARK_PAGES_ENV } from "@starkfuture/shared/starkPages";
import { createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  createTerminalSpawnEnv,
  defaultShellResolver,
  resolveShellCandidates,
  shouldExcludeTerminalEnvKey,
} from "../terminal/shellCandidates.ts";

const DISPLAY_BYTES = 1_048_576;
const FILE_BYTES = 64 * 1_048_576;
const MODEL_CHARS = 30_000;
const MODEL_HEAD_CHARS = 2_000;

function utf8Prefix(bytes: Buffer, limit: number): string {
  let end = Math.min(bytes.length, limit);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export class UserShellCommandRunnerError extends Schema.TaggedError<UserShellCommandRunnerError>()(
  "UserShellCommandRunnerError",
  {
    reason: Schema.Literals([
      "no-folder",
      "folder-not-found",
      "spawn",
      "output-storage",
      "already-running",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-folder":
        return "This thread has no folder.";
      case "folder-not-found":
        return "Failed to start: folder not found.";
      case "spawn":
        return "Failed to start the shell command.";
      case "output-storage":
        return "Failed to save the shell command output.";
      case "already-running":
        return "This shell command is already running.";
    }
  }
}

export interface UserShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly outputOmitted: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly fullOutputPath?: string;
}

export class UserShellCommandRunner extends Context.Service<
  UserShellCommandRunner,
  {
    readonly run: (input: {
      readonly threadId: string;
      readonly commandId: string;
      readonly command: string;
      readonly cwd: string | null;
      readonly timeoutMs?: number;
      readonly env?: Record<string, string | undefined>;
      readonly onOutput?: (delta: string) => Effect.Effect<void>;
    }) => Effect.Effect<UserShellCommandResult, UserShellCommandRunnerError>;
    readonly cancel: (commandId: string) => Effect.Effect<void>;
    readonly saveOutput: (input: {
      readonly threadId: string;
      readonly commandId: string;
      readonly output: string;
    }) => Effect.Effect<
      {
        readonly output: string;
        readonly outputOmitted: boolean;
        readonly fullOutputPath?: string;
      },
      UserShellCommandRunnerError
    >;
  }
>()("stark-code/shell/UserShellCommandRunner") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const baseEnv = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const clock = yield* Clock.Clock;
  const active = new Map<string, () => void>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const stop of active.values()) stop();
    }),
  );

  const outputPath = (threadId: string, commandId: string) => {
    const attachmentId = createDeterministicAttachmentId(threadId, `user-shell:${commandId}`);
    // The asset transport stores thread-owned attachments in one flat directory.
    // A normal attachment id lets web and remote clients download shell logs too.
    return attachmentId ? path.join(config.attachmentsDir, `${attachmentId}-log.log`) : null;
  };
  const saveOutput = Effect.fn("UserShellCommandRunner.saveOutput")(function* (input: {
    readonly threadId: string;
    readonly commandId: string;
    readonly output: string;
  }) {
    const bytes = Buffer.from(input.output);
    if (bytes.length <= DISPLAY_BYTES) return { output: input.output, outputOmitted: false };
    const fullOutputPath = outputPath(input.threadId, input.commandId);
    if (!fullOutputPath)
      return yield* new UserShellCommandRunnerError({ reason: "output-storage" });
    yield* fs
      .makeDirectory(config.attachmentsDir, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new UserShellCommandRunnerError({ reason: "output-storage", cause }),
        ),
      );
    yield* fs
      .writeFile(fullOutputPath, bytes.subarray(0, FILE_BYTES), { mode: 0o600 })
      .pipe(
        Effect.mapError(
          (cause) => new UserShellCommandRunnerError({ reason: "output-storage", cause }),
        ),
      );
    return {
      output: utf8Prefix(bytes, DISPLAY_BYTES),
      outputOmitted: true,
      fullOutputPath,
    };
  });

  const run = Effect.fn("UserShellCommandRunner.run")(function* (
    input: Parameters<UserShellCommandRunner["Service"]["run"]>[0],
  ) {
    if (active.has(input.commandId))
      return yield* new UserShellCommandRunnerError({ reason: "already-running" });
    // Register before the first asynchronous step. Stop and duplicate detection
    // must also cover a command waiting for its folder or output directory.
    let interrupted = false;
    let cancelPreflight: (() => void) | undefined;
    let cancelChild: (() => void) | undefined;
    const stop = () => {
      interrupted = true;
      cancelPreflight?.();
      cancelChild?.();
    };
    active.set(input.commandId, stop);
    const registeredAt = clock.currentTimeMillisUnsafe();

    return yield* Effect.gen(function* () {
      if (input.cwd === null)
        return yield* new UserShellCommandRunnerError({ reason: "no-folder" });
      const fullOutputPath = outputPath(input.threadId, input.commandId);
      if (!fullOutputPath)
        return yield* new UserShellCommandRunnerError({ reason: "output-storage" });
      const prepare = Effect.gen(function* () {
        const stat = yield* fs
          .stat(input.cwd!)
          .pipe(
            Effect.mapError(
              (cause) => new UserShellCommandRunnerError({ reason: "folder-not-found", cause }),
            ),
          );
        if (stat.type !== "Directory")
          return yield* new UserShellCommandRunnerError({ reason: "folder-not-found" });
        yield* fs
          .makeDirectory(config.attachmentsDir, { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) => new UserShellCommandRunnerError({ reason: "output-storage", cause }),
            ),
          );
        return true;
      });
      const cancelled = Effect.callback<boolean>((resume) => {
        const cancel = () => resume(Effect.succeed(false));
        cancelPreflight = cancel;
        if (interrupted) cancel();
        return Effect.sync(() => {
          if (cancelPreflight === cancel) cancelPreflight = undefined;
        });
      });
      const ready = yield* Effect.raceFirst(prepare, cancelled);
      if (!ready || interrupted)
        return {
          stdout: "",
          stderr: "",
          output: "",
          outputOmitted: false,
          exitCode: null,
          signal: null,
          durationMs: clock.currentTimeMillisUnsafe() - registeredAt,
          timedOut: false,
          interrupted: true,
        };
      const env = createTerminalSpawnEnv(
        baseEnv,
        Object.fromEntries(
          Object.entries(input.env ?? {}).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        platform,
        home,
      );
      for (const key of Object.keys(env)) if (shouldExcludeTerminalEnvKey(key)) delete env[key];
      Object.assign(env, PROVIDER_PRIVACY_ENV, STARK_PAGES_ENV, {
        PAGER: "cat",
        GIT_PAGER: "cat",
        TERM: "dumb",
      });
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      const candidates = resolveShellCandidates(
        () => defaultShellResolver(platform, env),
        platform,
        env,
      );
      let pendingDelta = "";
      const flush = Effect.gen(function* () {
        const delta = pendingDelta;
        pendingDelta = "";
        if (delta.length > 0 && input.onOutput) yield* input.onOutput(delta);
      });
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* Effect.forkScoped(
            Effect.forever(Effect.sleep("100 millis").pipe(Effect.andThen(flush))),
          );
          const result = yield* Effect.callback<
            UserShellCommandResult,
            UserShellCommandRunnerError
          >((resume) => {
            const started = clock.currentTimeMillisUnsafe();
            let child: NodeChildProcess.ChildProcess | undefined;
            let settled = false;
            let childClosed = false;
            let fileClosed = false;
            let timedOut = false;
            let escalated = false;
            let groupChecks = 0;
            let exitCode: number | null = null;
            let exitSignal: string | null = null;
            let displayBytes = 0;
            let fileBytes = 0;
            let outputOmitted = false;
            let output = "";
            let stdout = "";
            let stderr = "";
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let escalation: ReturnType<typeof setTimeout> | undefined;
            let groupCheck: ReturnType<typeof setTimeout> | undefined;
            const decoders = {
              stdout: new NodeStringDecoder.StringDecoder("utf8"),
              stderr: new NodeStringDecoder.StringDecoder("utf8"),
            };
            const file = NodeFS.createWriteStream(fullOutputPath, { mode: 0o600 });
            const signalGroup = (signal: NodeJS.Signals) => {
              if (!child?.pid) return;
              if (platform === "win32") {
                if (signal === "SIGKILL")
                  NodeChildProcess.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true,
                  }).on("error", () => {});
                else child.kill();
              } else {
                try {
                  process.kill(-child.pid, signal);
                } catch {
                  /* Captured group already exited. */
                }
              }
            };
            const groupExists = () => {
              if (!child?.pid || platform === "win32") return false;
              try {
                process.kill(-child.pid, 0);
                return true;
              } catch {
                return false;
              }
            };
            const clearDeadline = () => {
              if (timeout) clearTimeout(timeout);
            };
            const finish = () => {
              if (settled || !childClosed || !fileClosed) return;
              if ((interrupted || timedOut) && groupExists()) {
                // A shell can exit before an output-detached descendant. Keep the
                // captured group's escalation alive and do not report Stop done early.
                if (!escalated) return;
                if (groupChecks++ < 20) {
                  groupCheck = setTimeout(finish, 20);
                  return;
                }
              }
              settled = true;
              cancelChild = undefined;
              clearDeadline();
              if (escalation && !groupExists()) clearTimeout(escalation);
              if (groupCheck) clearTimeout(groupCheck);
              const cleanStdout = NodeUtil.stripVTControlCharacters(stdout);
              const cleanStderr = NodeUtil.stripVTControlCharacters(stderr);
              const modelCut = stdout.length + stderr.length > MODEL_CHARS;
              const note = `\n[output truncated: full output saved at ${fullOutputPath}]`;
              resume(
                Effect.succeed({
                  stdout: modelCut ? cleanStdout.slice(0, MODEL_HEAD_CHARS) + note : cleanStdout,
                  stderr: modelCut ? cleanStderr.slice(0, MODEL_HEAD_CHARS) + note : cleanStderr,
                  output,
                  outputOmitted,
                  exitCode,
                  signal: exitSignal,
                  durationMs: clock.currentTimeMillisUnsafe() - started,
                  timedOut,
                  interrupted,
                  fullOutputPath,
                }),
              );
            };
            const terminate = () => {
              if (!child?.pid) return;
              signalGroup("SIGTERM");
              if (platform !== "win32" && !groupExists()) return;
              if (!escalation) {
                escalation = setTimeout(() => {
                  escalated = true;
                  signalGroup("SIGKILL");
                  finish();
                }, 3_000);
                // Keep cleanup alive even if its caller or server scope exits.
                // Otherwise an output-detached descendant could survive Stop.
              }
            };
            const fail = (reason: "spawn" | "output-storage", cause: unknown) => {
              if (settled) return;
              settled = true;
              cancelChild = undefined;
              terminate();
              clearDeadline();
              if (groupCheck) clearTimeout(groupCheck);
              file.destroy();
              resume(Effect.fail(new UserShellCommandRunnerError({ reason, cause })));
            };
            const recordText = (kind: "stdout" | "stderr", text: string) => {
              if (kind === "stdout") stdout = (stdout + text).slice(0, MODEL_CHARS + 1);
              else stderr = (stderr + text).slice(0, MODEL_CHARS + 1);
              const bytes = Buffer.from(text);
              const retainedBytes = Math.min(
                bytes.length,
                Math.max(0, DISPLAY_BYTES - displayBytes),
              );
              const preview = utf8Prefix(bytes, retainedBytes);
              displayBytes += retainedBytes;
              output += preview;
              pendingDelta += preview;
              if (retainedBytes < bytes.length) outputOmitted = true;
            };
            const onData = (kind: "stdout" | "stderr", chunk: Buffer) => {
              if (settled) return;
              recordText(kind, decoders[kind].write(chunk));
              const stored = chunk.subarray(0, Math.max(0, FILE_BYTES - fileBytes));
              fileBytes += stored.length;
              if (stored.length > 0 && !file.write(stored)) {
                child?.stdout?.pause();
                child?.stderr?.pause();
              }
              if (stored.length < chunk.length) outputOmitted = true;
            };
            file.once("error", (cause) => fail("output-storage", cause));
            file.once("close", () => {
              fileClosed = true;
              finish();
            });
            file.on("drain", () => {
              child?.stdout?.resume();
              child?.stderr?.resume();
            });
            const spawnCandidate = (index: number) => {
              if (settled) return;
              if (interrupted) {
                childClosed = true;
                file.end();
                return;
              }
              const candidate = candidates[index];
              if (!candidate) {
                fail("spawn", new Error("No supported shell is available."));
                return;
              }
              const isCmd =
                platform === "win32" && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(candidate.shell);
              const args =
                platform === "win32"
                  ? isCmd
                    ? ["/d", "/s", "/c", input.command]
                    : ["-NoLogo", "-NonInteractive", "-Command", input.command]
                  : ["-l", "-c", input.command];
              try {
                child = NodeChildProcess.spawn(candidate.shell, args, {
                  cwd: input.cwd!,
                  env,
                  detached: platform !== "win32",
                  stdio: ["ignore", "pipe", "pipe"],
                  windowsHide: true,
                });
              } catch (cause) {
                fail("spawn", cause);
                return;
              }
              const current = child;
              current.once("error", (cause) => {
                if (
                  (cause as NodeJS.ErrnoException).code === "ENOENT" &&
                  index + 1 < candidates.length
                ) {
                  spawnCandidate(index + 1);
                  return;
                }
                fail("spawn", cause);
              });
              current.stdout?.on("data", (chunk) => onData("stdout", chunk));
              current.stderr?.on("data", (chunk) => onData("stderr", chunk));
              current.once("close", (code, signal) => {
                if (settled || current !== child) return;
                childClosed = true;
                exitCode = code;
                exitSignal = signal;
                recordText("stdout", decoders.stdout.end());
                recordText("stderr", decoders.stderr.end());
                clearDeadline();
                // Success is settled on file close, after all flush/close errors.
                // A storage error here must still reject instead of hanging forever.
                file.end();
              });
            };
            cancelChild = terminate;
            spawnCandidate(0);
            if (!settled && !childClosed)
              timeout = setTimeout(() => {
                timedOut = true;
                terminate();
              }, input.timeoutMs ?? 600_000);
            return Effect.sync(() => {
              if (!settled) {
                interrupted = true;
                terminate();
                file.destroy();
              }
              clearDeadline();
            });
          });
          yield* Fiber.interrupt(worker);
          yield* flush;
          return result;
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (active.get(input.commandId) === stop) active.delete(input.commandId);
          if (cancelChild !== undefined) {
            interrupted = true;
            cancelChild();
          }
          cancelPreflight = undefined;
        }),
      ),
    );
  });
  return UserShellCommandRunner.of({
    run,
    cancel: (commandId) => Effect.sync(() => active.get(commandId)?.()),
    saveOutput,
  });
});

export const layer = Layer.effect(UserShellCommandRunner, make);
