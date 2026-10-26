import { WS_METHODS } from "@starkfuture/contracts";
import { createEnvironmentRpcCommand } from "@starkfuture/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const checkChangesets = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:changesets:check",
  tag: WS_METHODS.gitCheckChangesets,
});
