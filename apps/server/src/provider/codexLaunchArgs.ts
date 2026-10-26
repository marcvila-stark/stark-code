import { CODEX_PRIVACY_ARGS } from "@starkfuture/shared/providerPrivacy";
import { tokenizeCliArgs } from "@starkfuture/shared/cliArgs";

const STARK_CODE_CODEX_LAUNCH_ARGS_ENV = "STARK_CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[STARK_CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
  ...CODEX_PRIVACY_ARGS,
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return [...execArgs, ...CODEX_PRIVACY_ARGS];
};
