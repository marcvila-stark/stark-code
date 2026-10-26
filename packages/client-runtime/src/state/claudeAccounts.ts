import { WS_METHODS } from "@starkfuture/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createClaudeAccountsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude-accounts:snapshot",
      tag: WS_METHODS.claudeAccountsSnapshot,
    }),
    command: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude-accounts:command",
      tag: WS_METHODS.claudeAccountsCommand,
    }),
  };
}
