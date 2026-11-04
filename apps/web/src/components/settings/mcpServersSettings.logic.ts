import type { ProviderInstanceId, ServerProvider } from "@starkfuture/contracts";
import { orderByAutomaticProviderPreference } from "@starkfuture/shared/model";

/**
 * Agents Connected tools can inspect, in the order of a new thread's automatic
 * pick (Claude first), plus the one shown: the user's choice, else the first
 * ready agent, else the first listed.
 */
export function resolveConnectedToolsAgent(
  providers: ReadonlyArray<ServerProvider>,
  chosen: ProviderInstanceId | null,
) {
  const agents = orderByAutomaticProviderPreference(
    providers.filter(
      (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
    ),
    (provider) => provider.driver,
  );
  const agent =
    agents.find((entry) => entry.instanceId === chosen) ??
    agents.find((entry) => entry.enabled && entry.status === "ready") ??
    agents[0];
  return { agents, agent };
}
