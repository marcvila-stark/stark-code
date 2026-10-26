import { createClaudeAccountsEnvironmentAtoms } from "@starkfuture/client-runtime/state/claude-accounts";
import { connectionAtomRuntime } from "../connection/runtime";

export const claudeAccountsEnvironment =
  createClaudeAccountsEnvironmentAtoms(connectionAtomRuntime);
