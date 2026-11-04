import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2TurnItem,
} from "@starkfuture/contracts";

const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

/**
 * Workspace setup is client bookkeeping; preparation failures have their own
 * error item. A retry cancels that item, which then has nothing left to say.
 */
export function turnItemIsWorkspacePreparation(item: OrchestrationV2TurnItem): boolean {
  return (
    (item.type === "command_execution" && item.input === WORKSPACE_PREPARATION_INPUT) ||
    (item.type === "error" &&
      item.status === "cancelled" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE)
  );
}

export { workspacePreparationRetryRunIds } from "@starkfuture/shared/workerRetry";
