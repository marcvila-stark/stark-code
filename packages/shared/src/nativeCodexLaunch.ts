import { BRAND } from "./branding.ts";
import { tokenizeCliArgs } from "./cliArgs.ts";

export class NativeAgentLaunchRefused extends Error {
  readonly _tag = "NativeAgentLaunchRefused";
  readonly flag: string;
  readonly reason: string;

  constructor(flag: string, reason: string) {
    super(
      `Stark requires supervised Codex. Remove ${flag} from this account's launch arguments (Settings > Providers > this account). ${reason}`,
    );
    this.name = "NativeAgentLaunchRefused";
    this.flag = flag;
    this.reason = reason;
  }
}

const valueFlags = new Set([
  "-m",
  "--model",
  "-p",
  "--profile",
  "--enable",
  "--disable",
  "--local-provider",
  "-c",
  "--config",
  "-a",
  "--ask-for-approval",
  "-s",
  "--sandbox",
]);
const keptFlags = new Set([
  "--search",
  "--no-alt-screen",
  "--strict-config",
  "--oss",
  "--no-daemon",
]);
const expandedShortFlags = new Set(["a", "s", "c", "p", "C", "m", "i"]);
const forbiddenConfigKeys = [
  "approval_policy",
  "sandbox_mode",
  "sandbox_workspace_write",
  "approvals_reviewer",
  "default_permissions",
  "permissions",
  "profile",
];

function expandedTokens(tokens: readonly string[]) {
  return tokens.flatMap((token) => {
    if (token.startsWith("--") && token.includes("=")) {
      const equals = token.indexOf("=");
      return [token.slice(0, equals), token.slice(equals + 1)];
    }
    if (
      token.startsWith("-") &&
      !token.startsWith("--") &&
      token.length > 2 &&
      expandedShortFlags.has(token[1]!)
    )
      return [token.slice(0, 2), token.slice(2).replace(/^=/, "")];
    return [token];
  });
}

/** Personal models/profiles/plugins remain usable; launch policy is app-owned. */
export function supervisedNativeCodexArgs(tokens: readonly string[]): string[] {
  const args = expandedTokens(tokens);
  const retained: string[] = [];
  let sandbox = "read-only";
  let hasNoDaemon = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--")
      throw new NativeAgentLaunchRefused(
        flag,
        "Prompt text and subcommands cannot be account launch arguments.",
      );
    if (keptFlags.has(flag)) {
      if (flag === "--no-daemon") {
        if (hasNoDaemon) continue;
        hasNoDaemon = true;
      }
      retained.push(flag);
      continue;
    }
    if (!valueFlags.has(flag))
      throw new NativeAgentLaunchRefused(
        flag,
        flag.startsWith("-")
          ? "This option is not allowed in supervised native shell mode."
          : "Prompt text and subcommands cannot be account launch arguments.",
      );
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("-"))
      throw new NativeAgentLaunchRefused(flag, "This option requires a value.");
    index++;
    const display = `${flag} ${value}`;
    if (flag === "-a" || flag === "--ask-for-approval") {
      if (!["on-request", "untrusted"].includes(value))
        throw new NativeAgentLaunchRefused(display, "Approval requests must stay supervised.");
      // New Codex CLIs retired untrusted; both safe aliases become on-request.
      continue;
    }
    if (flag === "-s" || flag === "--sandbox") {
      if (!["read-only", "workspace-write"].includes(value))
        throw new NativeAgentLaunchRefused(
          display,
          "Use read-only or explicitly opt into workspace-write.",
        );
      sandbox = value;
      continue;
    }
    if (flag === "-c" || flag === "--config") {
      const equals = value.indexOf("=");
      const key = value
        .slice(0, equals)
        .trim()
        .split(".")
        .map((part) => part.trim().replace(/^["']|["']$/g, ""))
        .join(".")
        .toLowerCase();
      if (equals < 1 || key.length === 0)
        throw new NativeAgentLaunchRefused(display, "Config overrides must use key=value.");
      if (forbiddenConfigKeys.some((blocked) => key === blocked || key.startsWith(`${blocked}.`)))
        throw new NativeAgentLaunchRefused(
          display,
          "Stark controls this supervision, sandbox, or profile setting.",
        );
    }
    retained.push(flag, value);
  }
  retained.push(
    "--ask-for-approval",
    "on-request",
    "--sandbox",
    sandbox,
    "-c",
    'approvals_reviewer="user"',
    "-c",
    "sandbox_workspace_write.network_access=false",
  );
  if (!hasNoDaemon) retained.push("--no-daemon");
  return retained;
}

/** Use the launch validator when account arguments are saved, before persistence. */
export function validateNativeCodexLaunchArgs(launchArgs?: string): void {
  if (BRAND.requireApprovalsByDefault) supervisedNativeCodexArgs(tokenizeCliArgs(launchArgs));
}
