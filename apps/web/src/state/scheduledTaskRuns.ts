import {
  createRunNowClickIds,
  supportsScheduledTaskRuns,
} from "@starkfuture/client-runtime/scheduled-task-runs";
import type { EnvironmentId } from "@starkfuture/contracts";

import { randomUUID } from "../lib/utils";
import { useServerConfigs } from "./entities";

/** Run now command ids, shared by every place this client can run a task from. */
export const scheduledTaskRunNowClickIds = createRunNowClickIds(randomUUID);

/** Whether the environment keeps run history, so Runs can be offered for its tasks. */
export function useEnvironmentKeepsRunHistory(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    supportsScheduledTaskRuns(configs.get(environmentId)?.environment.capabilities)
  );
}
