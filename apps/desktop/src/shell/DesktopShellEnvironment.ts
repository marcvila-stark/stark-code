import { listLoginShellCandidates } from "@starkfuture/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { fromLenientJson } from "@starkfuture/shared/schemaJson";

type EnvironmentPatch = Record<string, string>;

interface ShellEnvironmentConfig {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string | undefined;
  readonly extraLoginShellEnvNames?: ReadonlyArray<string>;
}

export function safeExtraLoginShellEnvNames(names: ReadonlyArray<string>): string[] {
  return [...new Set(names)]
    .filter((name) => /^(?!AWS_)(?!.*(?:TOKEN|SECRET|KEY))[A-Z_][A-Z0-9_]*$/.test(name))
    .slice(0, 32);
}

interface WindowsProbeOptions {
  readonly loadProfile: boolean;
}

const DesktopShellEnvironmentProbe = Schema.Literals([
  "login-shell",
  "launchctl-path",
  "powershell-profile",
  "powershell-no-profile",
]);
type DesktopShellEnvironmentProbe = typeof DesktopShellEnvironmentProbe.Type;

const desktopShellEnvironmentCommandFields = {
  probe: DesktopShellEnvironmentProbe,
  executable: Schema.String,
  argumentCount: Schema.Number,
};

export class DesktopShellEnvironmentCommandError extends Schema.TaggedError<DesktopShellEnvironmentCommandError>()(
  "DesktopShellEnvironmentCommandError",
  {
    ...desktopShellEnvironmentCommandFields,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) failed.`;
  }
}

export class DesktopShellEnvironmentCommandTimeoutError extends Schema.TaggedError<DesktopShellEnvironmentCommandTimeoutError>()(
  "DesktopShellEnvironmentCommandTimeoutError",
  {
    ...desktopShellEnvironmentCommandFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) timed out after ${this.timeoutMs}ms.`;
  }
}

export class DesktopShellEnvironment extends Context.Service<
  DesktopShellEnvironment,
  {
    readonly installIntoProcess: Effect.Effect<void>;
  }
>()("@starkfuture/desktop/shell/DesktopShellEnvironment") {}

const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
  "STARK_CODE_TELEMETRY_ENABLED",
] as const;
const WINDOWS_PROFILE_ENV_NAMES = ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"] as const;
const LOCALE_ENV_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
const FALLBACK_LC_CTYPE = "en_US.UTF-8";
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;
// Version managers and company shell setup commonly need 8–10 seconds on Dock launches.
// Share a total budget across candidates so a broken profile cannot multiply that wait.
const LOGIN_SHELL_TIMEOUT = Duration.seconds(15);
const LOGIN_SHELL_TOTAL_BUDGET = Duration.seconds(20);
const WINDOWS_SHELL_TIMEOUT = Duration.seconds(5);
const LAUNCHCTL_TIMEOUT = Duration.seconds(2);
const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const MAX_PROBE_OUTPUT_CHARS = 1_048_576;

const trimNonEmpty = (value: string | null | undefined): Option.Option<string> =>
  Option.fromNullishOr(value).pipe(
    Option.map((entry) => entry.trim()),
    Option.filter((entry) => entry.length > 0),
  );

const pathDelimiter = (platform: NodeJS.Platform) => (platform === "win32" ? ";" : ":");

const readEnvPath = (env: NodeJS.ProcessEnv): Option.Option<string> =>
  trimNonEmpty(env.PATH ?? env.Path ?? env.path);

const normalizeRuntimeDir = (value: string): string => value.replace(/\/+$/u, "");

const linuxRuntimeDirCandidates = (
  env: NodeJS.ProcessEnv,
  uid: number | undefined,
): ReadonlyArray<string> => {
  const candidates: string[] = [];
  const fromEnv = trimNonEmpty(env.XDG_RUNTIME_DIR);
  if (Option.isSome(fromEnv)) {
    candidates.push(normalizeRuntimeDir(fromEnv.value));
  }
  if (uid !== undefined) {
    candidates.push(`/run/user/${uid}`);
  }
  return candidates.filter((candidate) => candidate.length > 0);
};

const pathComparisonKey = (entry: string, platform: NodeJS.Platform) => {
  const normalized = entry.trim().replace(/^"+|"+$/g, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};

const sanitizePathEntry = (entry: string, platform: NodeJS.Platform) =>
  platform === "win32" ? entry.replaceAll('"', "") : entry;

const mergePaths = (
  platform: NodeJS.Platform,
  values: ReadonlyArray<Option.Option<string>>,
): Option.Option<string> => {
  const delimiter = pathDelimiter(platform);
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (Option.isNone(value)) continue;

    for (const entry of value.value.split(delimiter)) {
      const sanitized = sanitizePathEntry(entry.trim(), platform);
      if (sanitized.length === 0) continue;

      const key = pathComparisonKey(sanitized, platform);
      if (key.length === 0 || seen.has(key)) continue;

      seen.add(key);
      entries.push(sanitized);
    }
  }

  return entries.length > 0 ? Option.some(entries.join(delimiter)) : Option.none();
};

const knownWindowsCliDirs = (env: NodeJS.ProcessEnv): ReadonlyArray<string> => [
  ...trimNonEmpty(env.APPDATA).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\npm`],
    }),
  ),
  ...trimNonEmpty(env.LOCALAPPDATA).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\Programs\\nodejs`, `${value}\\Volta\\bin`, `${value}\\pnpm`],
    }),
  ),
  ...trimNonEmpty(env.USERPROFILE).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\.local\\bin`, `${value}\\.bun\\bin`, `${value}\\scoop\\shims`],
    }),
  ),
];

const startMarker = (name: string) => `__STARK_CODE_ENV_${name}_START__`;
const endMarker = (name: string) => `__STARK_CODE_ENV_${name}_END__`;

const executableName = (command: string): string => command.split(/[\\/]/u).at(-1) ?? command;

const logShellEnvironmentCommandError = (
  error: DesktopShellEnvironmentCommandError | DesktopShellEnvironmentCommandTimeoutError,
) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      component: "desktop-shell-environment",
      error,
    }),
  );

const capturePosixEnvironmentCommand = (names: ReadonlyArray<string>) =>
  names
    .map((name) => {
      return [
        `printf '%s\\n' '${startMarker(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${endMarker(name)}'`,
      ].join("; ");
    })
    .join("; ");

const captureWindowsEnvironmentCommand = (names: ReadonlyArray<string>) =>
  [
    "$ErrorActionPreference = 'Stop'",
    ...names.flatMap((name) => {
      return [
        `Write-Output '${startMarker(name)}'`,
        `$value = [Environment]::GetEnvironmentVariable('${name}')`,
        "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
        `Write-Output '${endMarker(name)}'`,
      ];
    }),
  ].join("; ");

const extractEnvironment = (output: string, names: ReadonlyArray<string>): EnvironmentPatch => {
  const environment: EnvironmentPatch = {};

  for (const name of names) {
    const start = output.indexOf(startMarker(name));
    if (start === -1) continue;

    const valueStart = start + startMarker(name).length;
    const end = output.indexOf(endMarker(name), valueStart);
    if (end === -1) continue;

    const value = output
      .slice(valueStart, end)
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "");
    if (value.length > 0) {
      environment[name] = value;
    }
  }

  return environment;
};

const runCommandOutput = Effect.fn("desktop.shellEnvironment.runCommandOutput")(function* (input: {
  readonly probe: DesktopShellEnvironmentProbe;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout: Duration.Duration;
  readonly shell?: boolean;
}): Effect.fn.Return<string, never, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.command, input.args, {
          shell: input.shell ?? false,
          stdin: "ignore",
          stdout: "pipe",
          // Profiles can write more than a pipe buffer before reaching our capture
          // command. We do not use their stderr, so never leave it unread and blocked.
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        }),
      );
      return yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            // Keep draining noisy startup output; the environment markers come last.
            Stream.runFold(
              () => "",
              (output, chunk) => (output + chunk).slice(-MAX_PROBE_OUTPUT_CHARS),
            ),
          ),
          child.exitCode,
        ],
        { concurrency: 2 },
      );
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopShellEnvironmentCommandError({
          probe: input.probe,
          executable: executableName(input.command),
          argumentCount: input.args.length,
          cause,
        }),
    ),
    Effect.filterOrFail(
      ([, exitCode]) => exitCode === 0,
      ([, exitCode]) =>
        new DesktopShellEnvironmentCommandError({
          probe: input.probe,
          executable: executableName(input.command),
          argumentCount: input.args.length,
          cause: { exitCode },
        }),
    ),
    Effect.map(([stdout]) => stdout),
    Effect.catchTags({
      DesktopShellEnvironmentCommandError: (error) =>
        logShellEnvironmentCommandError(error).pipe(Effect.as("")),
    }),
    Effect.timeoutOption(input.timeout),
  );
  if (Option.isSome(output)) {
    return output.value;
  }

  const error = new DesktopShellEnvironmentCommandTimeoutError({
    probe: input.probe,
    executable: executableName(input.command),
    argumentCount: input.args.length,
    timeoutMs: Duration.toMillis(input.timeout),
  });
  yield* logShellEnvironmentCommandError(error);
  return "";
});

const readLoginShellEnvironment = (
  shell: string,
  names: ReadonlyArray<string>,
  timeout: Duration.Duration,
): Effect.Effect<EnvironmentPatch, never, ChildProcessSpawner.ChildProcessSpawner> =>
  names.length === 0
    ? Effect.succeed({})
    : runCommandOutput({
        probe: "login-shell",
        command: shell,
        args: ["-ilc", capturePosixEnvironmentCommand(names)],
        timeout,
      }).pipe(Effect.map((output) => extractEnvironment(output, names)));

const readLaunchctlPath = runCommandOutput({
  probe: "launchctl-path",
  command: "/bin/launchctl",
  args: ["getenv", "PATH"],
  timeout: LAUNCHCTL_TIMEOUT,
}).pipe(Effect.map(trimNonEmpty));

const readWindowsEnvironment = Effect.fn("desktop.shellEnvironment.readWindowsEnvironment")(
  function* (
    names: ReadonlyArray<string>,
    options: WindowsProbeOptions,
  ): Effect.fn.Return<EnvironmentPatch, never, ChildProcessSpawner.ChildProcessSpawner> {
    if (names.length === 0) return {};

    const args = [
      "-NoLogo",
      ...(options.loadProfile ? ([] as const) : (["-NoProfile"] as const)),
      "-NonInteractive",
      "-Command",
      captureWindowsEnvironmentCommand(names),
    ];

    for (const command of WINDOWS_SHELL_CANDIDATES) {
      const output = yield* runCommandOutput({
        probe: options.loadProfile ? "powershell-profile" : "powershell-no-profile",
        command,
        args,
        timeout: WINDOWS_SHELL_TIMEOUT,
      });
      const environment = extractEnvironment(output, names);
      if (Object.keys(environment).length > 0) {
        return environment;
      }
    }

    return {};
  },
);

const installWindowsEnvironment = Effect.fn("desktop.shellEnvironment.installWindowsEnvironment")(
  function* (
    config: ShellEnvironmentConfig,
  ): Effect.fn.Return<void, never, ChildProcessSpawner.ChildProcessSpawner> {
    // Concurrent, not sequential: these two probes are independent (only their
    // results are combined below) and each spawns its own PowerShell. Run in
    // series they sit at offset 0 of desktop.startup, before anything else, and
    // launch traces measured them at 2718ms then 2066ms — the entire 4.8s
    // startup span, of which desktop.bootstrap is ~30ms.
    const [noProfile, profile] = yield* Effect.all(
      [
        readWindowsEnvironment(["PATH"], { loadProfile: false }),
        readWindowsEnvironment(WINDOWS_PROFILE_ENV_NAMES, { loadProfile: true }),
      ],
      { concurrency: 2 },
    );
    const mergedPath = mergePaths("win32", [
      trimNonEmpty(profile.PATH),
      trimNonEmpty(knownWindowsCliDirs(config.env).join(";")),
      trimNonEmpty(noProfile.PATH),
      readEnvPath(config.env),
    ]);

    if (Option.isSome(mergedPath)) {
      config.env.PATH = mergedPath.value;
    }
    if (!config.env.FNM_DIR && profile.FNM_DIR) {
      config.env.FNM_DIR = profile.FNM_DIR;
    }
    if (!config.env.FNM_MULTISHELL_PATH && profile.FNM_MULTISHELL_PATH) {
      config.env.FNM_MULTISHELL_PATH = profile.FNM_MULTISHELL_PATH;
    }
  },
);

const installPosixEnvironment = Effect.fn("desktop.shellEnvironment.installPosixEnvironment")(
  function* (
    config: ShellEnvironmentConfig,
  ): Effect.fn.Return<
    void,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const shellEnvironment: EnvironmentPatch = {};
    const loginShellDeadline =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(LOGIN_SHELL_TOTAL_BUDGET);

    for (const shell of listLoginShellCandidates(config.platform, config.env.SHELL)) {
      const remainingMs = loginShellDeadline - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) break;
      Object.assign(
        shellEnvironment,
        yield* readLoginShellEnvironment(
          shell,
          [
            ...LOGIN_SHELL_ENV_NAMES,
            ...safeExtraLoginShellEnvNames(config.extraLoginShellEnvNames ?? ["AGENT_WORKSPACE"]),
          ],
          Duration.millis(Math.min(Duration.toMillis(LOGIN_SHELL_TIMEOUT), remainingMs)),
        ),
      );
      if (shellEnvironment.PATH) break;
    }

    const launchctlPath =
      config.platform === "darwin" && !shellEnvironment.PATH
        ? yield* readLaunchctlPath
        : Option.none<string>();
    // Native CLI installers use ~/.local/bin, which a Dock launch can miss when
    // the user's shell profile fails or times out. Keep explicit PATH choices first.
    const homeDirectory = config.homeDirectory ?? config.env.HOME;
    const localBin =
      homeDirectory?.startsWith("/") && !homeDirectory.includes(":")
        ? `${homeDirectory.replace(/\/+$/u, "")}/.local/bin`
        : undefined;
    const localBinExists = localBin
      ? yield* fileSystem.stat(localBin).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )
      : false;
    const mergedPath = mergePaths(config.platform, [
      trimNonEmpty(shellEnvironment.PATH).pipe(Option.orElse(() => launchctlPath)),
      readEnvPath(config.env),
      trimNonEmpty(localBinExists ? localBin : undefined),
    ]);

    if (Option.isSome(mergedPath)) {
      config.env.PATH = mergedPath.value;
    }
    if (!config.env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      config.env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    const shellPreferredEnvNames = [
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_CURRENT_DESKTOP",
      "XDG_SESSION_DESKTOP",
      "XDG_SESSION_TYPE",
    ] as const;
    for (const name of shellPreferredEnvNames) {
      if (shellEnvironment[name]) {
        config.env[name] = shellEnvironment[name];
      }
    }

    for (const name of [
      "DISPLAY",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "WAYLAND_DISPLAY",
      // The telemetry opt-out is documented as a shell variable; GUI launches never see it.
      "STARK_CODE_TELEMETRY_ENABLED",
    ] as const) {
      if (!config.env[name] && shellEnvironment[name]) {
        config.env[name] = shellEnvironment[name];
      }
    }

    for (const name of safeExtraLoginShellEnvNames(
      config.extraLoginShellEnvNames ?? ["AGENT_WORKSPACE"],
    )) {
      if (!config.env[name] && shellEnvironment[name]) config.env[name] = shellEnvironment[name];
    }

    // Locale variables form one precedence group: LC_ALL can override an inherited
    // LANG or LC_CTYPE, so only hydrate the group when the process has none of them.
    if (
      config.platform === "darwin" &&
      LOCALE_ENV_NAMES.every((name) => Option.isNone(trimNonEmpty(config.env[name])))
    ) {
      for (const name of LOCALE_ENV_NAMES) {
        const value = trimNonEmpty(shellEnvironment[name]);
        if (Option.isSome(value)) {
          config.env[name] = value.value;
        }
      }

      // GUI launches inherit no locale from launchd, so spawned agents land in the C
      // locale and pbcopy decodes their UTF-8 output as MacRoman. Older supported
      // macOS releases do not provide C.UTF-8, so set only LC_CTYPE to a UTF-8 locale
      // available on those releases. Leaving LANG unset keeps C-stable collation and
      // formatting, so output parsing is unaffected.
      if (LOCALE_ENV_NAMES.every((name) => Option.isNone(trimNonEmpty(config.env[name])))) {
        config.env.LC_CTYPE = FALLBACK_LC_CTYPE;
      }
    }

    if (
      config.platform === "linux" &&
      Option.isNone(trimNonEmpty(config.env.DBUS_SESSION_BUS_ADDRESS))
    ) {
      for (const runtimeDir of linuxRuntimeDirCandidates(config.env, process.getuid?.())) {
        const dbusSessionBusPath = `${runtimeDir}/bus`;
        const busExists = yield* fileSystem
          .exists(dbusSessionBusPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (busExists) {
          config.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${dbusSessionBusPath}`;
          break;
        }
      }
    }
  },
);

const installShellEnvironment = (
  config: ShellEnvironmentConfig,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> => {
  if (config.platform === "win32") {
    return installWindowsEnvironment(config);
  }
  if (config.platform === "darwin" || config.platform === "linux") {
    return installPosixEnvironment(config);
  }
  return Effect.void;
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const installIntoProcess: DesktopShellEnvironment["Service"]["installIntoProcess"] = Effect.gen(
    function* () {
      const namesSchema = Schema.Array(Schema.String);
      const documentSchema = fromLenientJson(
        Schema.Struct({
          extraLoginShellEnvNames: Schema.optional(namesSchema),
          settings: Schema.optional(
            Schema.Struct({ extraLoginShellEnvNames: Schema.optional(namesSchema) }),
          ),
        }),
      );
      const document = environment.clientSettingsPath
        ? yield* fileSystem.readFileString(environment.clientSettingsPath).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(documentSchema)),
            Effect.orElseSucceed(() => null),
          )
        : null;
      yield* installShellEnvironment({
        env: process.env,
        platform: environment.platform,
        homeDirectory: environment.homeDirectory,
        extraLoginShellEnvNames: safeExtraLoginShellEnvNames(
          document?.settings?.extraLoginShellEnvNames ??
            document?.extraLoginShellEnvNames ?? ["AGENT_WORKSPACE"],
        ),
      });
    },
  ).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.withSpan("desktop.shellEnvironment.installIntoProcess"),
  );

  return DesktopShellEnvironment.of({ installIntoProcess });
});

export const layer = Layer.effect(DesktopShellEnvironment, make);
