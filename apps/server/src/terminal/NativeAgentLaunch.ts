import { CODEX_PRIVACY_ARGS, PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import {
  claudeHelperModelEnvironment,
  isClaudeHaikuModel,
  isOpenRouterEnvironment,
  openRouterModelId,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
} from "@starkfuture/shared/claudeModelPolicy";
import { BRAND } from "@starkfuture/shared/branding";
import { STARK_PAGES_ENV } from "@starkfuture/shared/starkPages";
import {
  claudePluginArguments,
  starkWorkbenchEnvironment,
} from "@starkfuture/shared/starkWorkbench";
import { ClaudeSettings, CodexSettings } from "@starkfuture/contracts";
import { tokenizeCliArgs } from "@starkfuture/shared/cliArgs";
import { expandHomePath } from "@starkfuture/provider-core/server/pathExpansion";
import * as Schema from "effect/Schema";
import { supervisedNativeCodexArgs } from "@starkfuture/shared/nativeCodexLaunch";
import { prepareNativeCodexCaptureArgs } from "./NativeAgentSettings.ts";
export { NativeAgentLaunchRefused } from "@starkfuture/shared/nativeCodexLaunch";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

// Native Claude owns its permission UI. Keep its in-process agents out of
// Bypass even when the owner has opted into that mode for the parent session.
const nativeChildGuard = `let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{try{const hook=JSON.parse(input);if(["default","manual","acceptEdits","auto","plan","dontAsk"].includes(hook.permission_mode))return;if(hook.permission_mode==="bypassPermissions"&&!hook.agent_id&&typeof hook.tool_name==="string"&&!/^(Agent|Task)$/.test(hook.tool_name))return;}catch{}process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Child agents cannot use Bypass permissions. Switch to Manual, Accept edits or Auto before starting an agent, and remove Bypass from custom agent definitions."}}));});`;
const quotePosix = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function nativeChildGuardCommand(platform: NodeJS.Platform, nodeExecutable: string): string {
  // Exit 2 blocks the tool if the guard runtime itself cannot start.
  const executable = platform === "win32" ? nodeExecutable.replaceAll("\\", "/") : nodeExecutable;
  return `ELECTRON_RUN_AS_NODE=1 ${quotePosix(executable)} -e ${quotePosix(nativeChildGuard)} || exit 2`;
}

/** Launch the interactive CLI directly, without SDK or app-server transport flags. */
export function nativeAgentLaunch(input: {
  readonly driver: string;
  readonly config: unknown;
  readonly home: string;
  readonly platform?: NodeJS.Platform;
  readonly nodeExecutable?: string;
  readonly workbenchRoot?: string;
  readonly environment?: Record<string, string | undefined>;
  readonly replyCaptureCommand?: string;
}): { shell: string; args: string[] } {
  const settings =
    input.driver === "codex"
      ? decodeCodexSettings(input.config)
      : input.driver === "claudeAgent"
        ? decodeClaudeSettings(input.config)
        : null;
  if (settings === null) throw new Error("Native shell mode supports Claude and Codex.");
  const userArgs = [...tokenizeCliArgs(settings.launchArgs)];
  const delimiter = userArgs.indexOf("--");
  // Enforced flags must precede the end-of-options delimiter, whose remaining
  // arguments are prompt text rather than CLI options.
  const promptArgs = delimiter < 0 ? [] : userArgs.slice(delimiter);
  let args = delimiter < 0 ? userArgs : userArgs.slice(0, delimiter);
  if (input.driver === "claudeAgent") {
    const claudeSettings = decodeClaudeSettings(input.config);
    const openRouter =
      claudeSettings.apiBackend === "openrouter" ||
      isOpenRouterEnvironment(input.environment ?? {});
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      const model =
        arg === "--model" || arg === "--fallback-model" || arg === "--advisor"
          ? args[index + 1]
          : /^--(?:model|fallback-model|advisor)=/.test(arg)
            ? arg.slice(arg.indexOf("=") + 1)
            : undefined;
      if (model && openRouter) {
        const routed = openRouterModelId(model);
        if (arg?.includes("=")) args[index] = `${arg.slice(0, arg.indexOf("=") + 1)}${routed}`;
        else args[index + 1] = routed;
      }
      if (model && isClaudeHaikuModel(model)) {
        throw new Error(
          "Haiku is disabled in Stark Code. Choose Sonnet, Opus or Fable in Claude launch arguments.",
        );
      }
    }
    if (openRouter && !args.some((arg) => arg === "--model" || arg.startsWith("--model="))) {
      args.push("--model", OPENROUTER_DEFAULT_MODEL);
    }
    const bypassRequested = args.some(
      (arg, index) =>
        /^--(?:allow-)?dangerously-skip-permissions(?:=|$)/.test(arg) ||
        arg === "--permission-mode=bypassPermissions" ||
        (arg === "--permission-mode" && args[index + 1] === "bypassPermissions"),
    );
    if (bypassRequested && claudeSettings.allowBypassPermissions !== true) {
      throw new Error(
        "Enable Allow Bypass permissions in this Claude account's settings before launching with unsafe permission flags.",
      );
    }
  }
  if (BRAND.requireApprovalsByDefault && input.driver === "codex") {
    args = supervisedNativeCodexArgs(userArgs);
  }
  const hasPermissionPolicy = args.some((arg) =>
    input.driver === "codex"
      ? /^(?:-a$|--ask-for-approval(?:=|$)|--yolo$|--dangerously-bypass-approvals-and-sandbox$)/.test(
          arg,
        )
      : /^(?:--permission-mode(?:=|$)|--dangerously-skip-permissions$)/.test(arg),
  );
  // Keep explicit user configuration; a normal native launch asks for approvals.
  if (!hasPermissionPolicy && !(BRAND.requireApprovalsByDefault && input.driver === "codex")) {
    args.push(
      ...(input.driver === "codex"
        ? ["--ask-for-approval", "on-request"]
        : ["--permission-mode", "default"]),
    );
  }
  if (input.driver === "claudeAgent") {
    if (
      input.workbenchRoot &&
      !claudePluginArguments(settings.launchArgs).paths.includes(input.workbenchRoot)
    ) {
      args.push("--plugin-dir", input.workbenchRoot);
    }
    args.push(
      "--settings",
      JSON.stringify({
        disableAllHooks: false,
        hooks: {
          ...(input.replyCaptureCommand
            ? {
                Stop: [
                  {
                    hooks: [
                      {
                        // Attention must clear before a new prompt can begin.
                        // The separate reply hook stays asynchronous.
                        type: "command",
                        shell: "bash",
                        command: `${input.replyCaptureCommand} --attention-only`,
                        async: false,
                        timeout: 5,
                      },
                      {
                        type: "command",
                        shell: "bash",
                        command: input.replyCaptureCommand,
                        async: true,
                        timeout: 5,
                      },
                    ],
                  },
                ],
                Notification: [
                  {
                    matcher: "permission_prompt|elicitation_dialog",
                    hooks: [
                      {
                        type: "command",
                        shell: "bash",
                        command: input.replyCaptureCommand,
                        timeout: 5,
                      },
                    ],
                  },
                ],
                UserPromptSubmit: [
                  {
                    hooks: [
                      {
                        type: "command",
                        shell: "bash",
                        command: input.replyCaptureCommand,
                        timeout: 5,
                      },
                    ],
                  },
                ],
              }
            : {}),
          PreToolUse: [
            {
              // Custom agent definitions can override a safe parent's mode.
              // Inspect child tool calls too, not just parent Agent launches.
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  shell: "bash",
                  onFailure: "block",
                  command: nativeChildGuardCommand(
                    input.platform ?? "linux",
                    input.nodeExecutable ?? "node",
                  ),
                },
              ],
            },
          ],
        },
        ...(decodeClaudeSettings(input.config).allowBypassPermissions === true
          ? {}
          : { permissions: { disableBypassPermissionsMode: "disable" } }),
        env: {
          ...PROVIDER_PRIVACY_ENV,
          ...claudeHelperModelEnvironment({
            ...input.environment,
            ...(decodeClaudeSettings(input.config).apiBackend === "openrouter"
              ? { ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL }
              : {}),
          }),
          ...STARK_PAGES_ENV,
          ...(input.workbenchRoot
            ? starkWorkbenchEnvironment(input.workbenchRoot, input.nodeExecutable ?? "node")
            : {}),
        },
      }),
    );
  }
  if (input.driver === "codex") args.push(...CODEX_PRIVACY_ARGS);
  if (input.driver !== "codex" || !BRAND.requireApprovalsByDefault) args.push(...promptArgs);
  if (input.driver === "codex" && input.replyCaptureCommand) {
    args = prepareNativeCodexCaptureArgs(args, input.replyCaptureCommand);
  }
  return {
    shell: expandHomePath(settings.binaryPath, input.home),
    args,
  };
}
