import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import { resolveCommandPath } from "@starkfuture/shared/shell";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeOS from "node:os";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";

vi.mock("node:os", { spy: true });

const textEncoder = new TextEncoder();

const isDesktopShellEnvironmentCommandError = Schema.is(
  DesktopShellEnvironment.DesktopShellEnvironmentCommandError,
);
const isDesktopShellEnvironmentCommandTimeoutError = Schema.is(
  DesktopShellEnvironment.DesktopShellEnvironmentCommandTimeoutError,
);

function envOutput(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .flatMap(([name, value]) => [
      `__STARK_CODE_ENV_${name}_START__`,
      value,
      `__STARK_CODE_ENV_${name}_END__`,
    ])
    .join("\n");
}

function makeProcess(
  output: string,
  exitCode = 0,
  startupDelayMs = 0,
): ChildProcessSpawner.ChildProcessHandle {
  const startup = startupDelayMs > 0 ? Effect.sleep(startupDelayMs) : Effect.void;
  const stdout =
    output.length === 0
      ? Stream.empty
      : Stream.fromEffect(startup.pipe(Effect.as(textEncoder.encode(output))));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout,
    stderr: Stream.empty,
    all: stdout,
    exitCode: startup.pipe(Effect.as(ChildProcessSpawner.ExitCode(exitCode))),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function withProcessEnv<A, E, R>(
  env: NodeJS.ProcessEnv,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env;
      process.env = env;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env = previous;
      }),
  );
}

function runShellEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly userShell?: string;
  readonly handler: (
    command: ChildProcess.Command,
  ) => string | { output: string; exitCode: number; startupDelayMs?: number };
  readonly failure?: PlatformError.PlatformError;
  readonly onProcessReleased?: () => void;
}) {
  const layerEnvironment = Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of({
      platform: input.platform,
      homeDirectory: input.env.HOME,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  );
  const layerSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (input.failure !== undefined) return Effect.fail(input.failure);
      const result = input.handler(command);
      return Effect.acquireRelease(
        Effect.succeed(
          typeof result === "string"
            ? makeProcess(result)
            : makeProcess(result.output, result.exitCode, result.startupDelayMs),
        ),
        () => Effect.sync(() => input.onProcessReleased?.()),
      );
    }),
  );

  const program = Effect.gen(function* () {
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    yield* shellEnvironment.installIntoProcess;
  }).pipe(
    Effect.provide(
      DesktopShellEnvironment.layer.pipe(
        Layer.provide(Layer.mergeAll(layerEnvironment, NodeServices.layer, layerSpawner)),
      ),
    ),
  );

  return Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeOS, "userInfo").mockReturnValue({
        ...NodeOS.userInfo(),
        shell: input.userShell ?? null,
      }),
    ),
    () => withProcessEnv(input.env, program),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );
}

describe("DesktopShellEnvironment", () => {
  it.effect.each(["darwin", "linux"] as const)(
    "finds a native CLI in the user install directory after shell startup times out on %s",
    (platform) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped();
        const localBin = `${home}/.local/bin`;
        yield* fileSystem.makeDirectory(localBin, { recursive: true });
        yield* fileSystem.writeFileString(`${localBin}/claude`, "#!/bin/sh\nexit 0\n");
        yield* fileSystem.chmod(`${localBin}/claude`, 0o700);
        const env: NodeJS.ProcessEnv = { HOME: home, SHELL: "/bin/slow", PATH: "/usr/bin:/bin" };
        assert.equal(yield* resolveCommandPath("claude", { env, extendEnv: false }), null);
        const importer = yield* runShellEnvironment({
          env,
          platform,
          handler: (command) =>
            command._tag === "StandardCommand" && command.command === "/bin/launchctl"
              ? ""
              : { output: "", exitCode: 0, startupDelayMs: 60_000 },
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        yield* Fiber.join(importer);
        assert.equal(env.PATH, `/usr/bin:/bin:${localBin}`);
        assert.equal(
          yield* resolveCommandPath("claude", { env, extendEnv: false }),
          `${localBin}/claude`,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "preserves an explicitly selected CLI and deduplicates the user install directory",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped();
        const localBin = `${home}/.local/bin`;
        const customBin = `${home}/custom/bin`;
        for (const directory of [localBin, customBin]) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(`${directory}/claude`, "#!/bin/sh\nexit 0\n");
          yield* fileSystem.chmod(`${directory}/claude`, 0o700);
        }
        const env: NodeJS.ProcessEnv = { HOME: home, PATH: `/usr/bin:${localBin}` };
        yield* runShellEnvironment({
          env,
          platform: "darwin",
          handler: () => envOutput({ PATH: `${customBin}:/usr/bin` }),
        });
        assert.equal(env.PATH, `${customBin}:/usr/bin:${localBin}`);
        assert.equal(
          yield* resolveCommandPath("claude", { env, extendEnv: false }),
          `${customBin}/claude`,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "imports the environment after a real shell writes beyond both pipe buffers",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "stark-noisy-shell-",
        });
        const shell = `${directory}/login-shell`;
        yield* fileSystem.writeFileString(
          shell,
          [
            "#!/bin/sh",
            "/usr/bin/head -c 2097152 /dev/zero >&2",
            "/usr/bin/head -c 2097152 /dev/zero",
            "export AGENT_WORKSPACE='/fixture/agent-workspace'",
            'exec /bin/sh -c "$2"',
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(shell, 0o700);
        const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin:/bin", HOME: directory };
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const commands: string[] = [];
        // A failed fixture must never fall back to executing the user's real profiles.
        const fixtureSpawner = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand") {
            commands.push(command.command);
            if (command.command === shell) return realSpawner.spawn(command);
          }
          return Effect.succeed(makeProcess(""));
        });
        const service = yield* DesktopShellEnvironment.make.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixtureSpawner),
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            platform: "darwin",
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        );
        yield* withProcessEnv(env, service.installIntoProcess);
        assert.deepEqual(commands, [shell]);
        assert.equal(env.AGENT_WORKSPACE, "/fixture/agent-workspace");
        assert.equal(env.PATH, "/usr/bin:/bin");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { startupDelayMs: 8_000, inheritedWorkspace: undefined },
    { startupDelayMs: 10_000, inheritedWorkspace: undefined },
    { startupDelayMs: 10_000, inheritedWorkspace: "/parent/workspace" },
  ])("imports a slow Dock login shell without clobbering or importing credentials (%j)", (input) =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        ...(input.inheritedWorkspace ? { AGENT_WORKSPACE: input.inheritedWorkspace } : {}),
      };
      let commands = 0;
      let released = 0;
      const importer = yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () => {
          commands += 1;
          return {
            output: envOutput({
              PATH: "/local/bin:/usr/bin",
              AGENT_WORKSPACE: "/project/agent-workspace",
              AWS_SECRET_ACCESS_KEY: "never-import",
              API_TOKEN: "never-import",
            }),
            exitCode: 0,
            startupDelayMs: input.startupDelayMs,
          };
        },
        onProcessReleased: () => {
          released += 1;
        },
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(input.startupDelayMs);
      yield* Fiber.join(importer);
      assert.equal(commands, 1);
      assert.equal(released, 1);
      assert.equal(env.AGENT_WORKSPACE, input.inheritedWorkspace ?? "/project/agent-workspace");
      assert.equal(env.PATH, "/local/bin:/usr/bin");
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(env.API_TOKEN, undefined);
    }),
  );

  it.effect(
    "bounds slow POSIX candidates to one shared budget and releases each timed-out probe",
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/slow", PATH: "/usr/bin" };
        const commands: string[] = [];
        const timeouts: number[] = [];
        let released = 0;
        const logger = Logger.make(({ message }) => {
          const messages = Array.isArray(message) ? message : [message];
          for (const value of messages) {
            if (isDesktopShellEnvironmentCommandTimeoutError(value)) {
              timeouts.push(value.timeoutMs);
            }
          }
        });
        const importer = yield* runShellEnvironment({
          env,
          platform: "darwin",
          userShell: "/bin/another-slow",
          handler: (command) => {
            if (command._tag !== "StandardCommand") return "";
            commands.push(command.command);
            return command.command === "/bin/launchctl"
              ? "/launchctl/bin"
              : {
                  output: envOutput({ PATH: "/too-late", AGENT_WORKSPACE: "/too-late" }),
                  exitCode: 0,
                  startupDelayMs: 60_000,
                };
          },
          onProcessReleased: () => {
            released += 1;
          },
        }).pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.forkChild,
        );
        yield* TestClock.adjust("20 seconds");
        yield* Fiber.join(importer);
        assert.deepEqual(commands, ["/bin/slow", "/bin/another-slow", "/bin/launchctl"]);
        assert.deepEqual(timeouts, [15_000, 5_000]);
        assert.equal(released, 3);
        assert.equal(env.PATH, "/launchctl/bin:/usr/bin");
        assert.equal(env.AGENT_WORKSPACE, undefined);
      }),
  );

  it.effect(
    "imports AGENT_WORKSPACE from the login shell for Dock launches without importing credential names",
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
        let capture = "";
        yield* runShellEnvironment({
          env,
          platform: "darwin",
          handler: (command) => {
            if (command._tag !== "StandardCommand") return "";
            capture = command.args.join(" ");
            return envOutput({
              PATH: "/local/bin:/usr/bin",
              AGENT_WORKSPACE: "/project/tools/agent-workspace",
              AWS_SECRET_ACCESS_KEY: "never-import",
            });
          },
        });
        assert.equal(env.AGENT_WORKSPACE, "/project/tools/agent-workspace");
        assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
        assert.include(capture, "printenv AGENT_WORKSPACE");
        assert.notInclude(capture, "printenv AWS_SECRET_ACCESS_KEY");
        assert.deepEqual(
          DesktopShellEnvironment.safeExtraLoginShellEnvNames([
            "AGENT_WORKSPACE",
            "SAFE_NAME",
            "API_TOKEN",
            "AWS_PROFILE",
            "SSH_KEY",
            "name;whoami",
            "SAFE_NAME",
          ]),
          ["AGENT_WORKSPACE", "SAFE_NAME"],
        );
      }),
  );
  it.effect("rejects PATH output from a failed shell and tries the next candidate", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/failing", PATH: "/usr/bin" };
      const commands: string[] = [];

      yield* runShellEnvironment({
        env,
        platform: "linux",
        userShell: "/usr/local/bin/fish",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          commands.push(command.command);
          return command.command === "/bin/failing"
            ? { output: envOutput({ PATH: "/failed/bin" }), exitCode: 7 }
            : envOutput({ PATH: "/home/test/.local/bin:/usr/bin" });
        },
      }).pipe(Effect.provide(Logger.layer([])));

      assert.deepEqual(commands, ["/bin/failing", "/usr/local/bin/fish"]);
      assert.equal(env.PATH, "/home/test/.local/bin:/usr/bin");
    }),
  );

  it.effect.each(["darwin", "linux"] as const)(
    "uses the account shell when SHELL is missing on %s",
    (platform) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
        const commands: string[] = [];

        yield* runShellEnvironment({
          env,
          platform,
          userShell: "/usr/local/bin/fish",
          handler: (command) => {
            if (command._tag !== "StandardCommand") return "";
            commands.push(command.command);
            return envOutput({ PATH: "/home/test/.local/bin:/usr/bin" });
          },
        });

        assert.deepEqual(commands, ["/usr/local/bin/fish"]);
        assert.equal(env.PATH, "/home/test/.local/bin:/usr/bin");
      }),
  );

  it.effect("tries the account shell before the platform fallback when SHELL has no PATH", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/missing", PATH: "/usr/bin" };
      const commands: string[] = [];

      yield* runShellEnvironment({
        env,
        platform: "linux",
        userShell: "/usr/local/bin/fish",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          commands.push(command.command);
          return command.command === "/usr/local/bin/fish"
            ? envOutput({ PATH: "/home/test/.local/bin:/usr/bin" })
            : "";
        },
      });

      assert.deepEqual(commands, ["/bin/missing", "/usr/local/bin/fish"]);
      assert.equal(env.PATH, "/home/test/.local/bin:/usr/bin");
    }),
  );

  it.effect("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/Users/test/.local/bin:/usr/bin",
      };
      const commands: ChildProcess.Command[] = [];

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: (command) => {
          commands.push(command);
          return envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            SSH_AUTH_SOCK: "/tmp/secretive.sock",
            HOMEBREW_PREFIX: "/opt/homebrew",
          });
        },
      });

      assert.equal(commands.length, 1);
      assert.equal(commands[0]?._tag === "StandardCommand" ? commands[0].command : "", "/bin/zsh");
      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/secretive.sock");
      assert.equal(env.HOMEBREW_PREFIX, "/opt/homebrew");
    }),
  );

  it.effect("preserves inherited POSIX values when present", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/tmp/inherited.sock",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            SSH_AUTH_SOCK: "/tmp/login-shell.sock",
          }),
      });

      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/inherited.sock");
    }),
  );

  it.effect("hydrates the locale from the login shell on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            LANG: "de_DE.UTF-8",
          }),
      });

      assert.equal(env.LANG, "de_DE.UTF-8");
    }),
  );

  it.effect("preserves an inherited locale over the login shell on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            LANG: "de_DE.UTF-8",
          }),
      });

      assert.equal(env.LANG, "en_US.UTF-8");
    }),
  );

  it.effect("does not mix login-shell locale categories into an inherited locale", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            LC_ALL: "de_DE.UTF-8",
          }),
      });

      assert.equal(env.LANG, "en_US.UTF-8");
      assert.equal(env.LC_ALL, undefined);
    }),
  );

  it.effect("falls back to a UTF-8 LC_CTYPE when no locale is available on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () => envOutput({ PATH: "/opt/homebrew/bin:/usr/bin" }),
      });

      assert.equal(env.LANG, undefined);
      assert.equal(env.LC_ALL, undefined);
      assert.equal(env.LC_CTYPE, "en_US.UTF-8");
    }),
  );

  it.effect("does not apply the locale fallback on linux", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () => envOutput({ PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin" }),
      });

      assert.equal(env.LANG, undefined);
    }),
  );

  it.effect("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on linux", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () =>
          envOutput({
            PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
            SSH_AUTH_SOCK: "/tmp/secretive.sock",
            STARK_CODE_TELEMETRY_ENABLED: "false",
          }),
      });

      assert.equal(env.PATH, "/home/linuxbrew/.linuxbrew/bin:/usr/bin");
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/secretive.sock");
      assert.equal(env.STARK_CODE_TELEMETRY_ENABLED, "false");
    }),
  );

  it.effect("falls back to launchctl PATH on macOS when shell probing does not return one", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/opt/homebrew/bin/nu",
        PATH: "/usr/bin",
      };
      const commands: string[] = [];

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          commands.push(command.command);
          return command.command === "/bin/launchctl" ? "/opt/homebrew/bin:/usr/bin" : "";
        },
      });

      assert.deepEqual(commands, ["/opt/homebrew/bin/nu", "/bin/zsh", "/bin/launchctl"]);
      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
    }),
  );

  it.effect("loads PowerShell profile environment on Windows", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        PATH: "C:\\Windows\\System32",
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
        USERPROFILE: "C:\\Users\\testuser",
      };

      yield* runShellEnvironment({
        env,
        platform: "win32",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          const loadProfile = !command.args.includes("-NoProfile");
          return loadProfile
            ? envOutput({
                PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
                FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
                FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
              })
            : envOutput({ PATH: 'C:\\Custom\\Bin;C:";C:\\Windows\\System32' });
        },
      });

      assert.equal(
        env.PATH,
        [
          "C:\\Profile\\Node",
          "C:\\Windows\\System32",
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.local\\bin",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Custom\\Bin",
          "C:",
        ].join(";"),
      );
      assert.equal(env.FNM_DIR, "C:\\Users\\testuser\\AppData\\Roaming\\fnm");
      assert.equal(
        env.FNM_MULTISHELL_PATH,
        "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
      );
    }),
  );

  it.effect("prefers login-shell desktop session hints over inherited values on linux", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        XDG_CURRENT_DESKTOP: "wrong-launcher",
        XDG_SESSION_DESKTOP: "wrong-launcher",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () =>
          envOutput({
            PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
            XDG_CURRENT_DESKTOP: "KDE",
            XDG_SESSION_DESKTOP: "KDE",
            XDG_SESSION_TYPE: "wayland",
          }),
      });

      assert.equal(env.XDG_CURRENT_DESKTOP, "KDE");
      assert.equal(env.XDG_SESSION_DESKTOP, "KDE");
      assert.equal(env.XDG_SESSION_TYPE, "wayland");
    }),
  );

  it.effect("overrides stale dbus session addresses from the login shell", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/stale-bus",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () =>
          envOutput({
            PATH: "/usr/bin",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          }),
      });

      assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
    }),
  );

  it.effect("logs command failures with safe probe context and the exact cause", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/bash",
      PATH: "/usr/bin",
    };
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "spawn",
      pathOrDescriptor: "/bin/bash",
    });
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });

    return runShellEnvironment({
      env,
      platform: "linux",
      handler: () => "",
      failure: cause,
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const errors = messages
            .flatMap((message) => (Array.isArray(message) ? message : [message]))
            .filter(isDesktopShellEnvironmentCommandError);
          assert.lengthOf(errors, 1);
          assert.equal(errors[0]?.probe, "login-shell");
          assert.equal(errors[0]?.executable, "bash");
          assert.equal(errors[0]?.argumentCount, 2);
          assert.notProperty(errors[0] ?? {}, "args");
          assert.equal(errors[0]?.cause, cause);
          assert.notInclude(errors[0]?.message ?? "", cause.message);
        }),
      ),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });
});
