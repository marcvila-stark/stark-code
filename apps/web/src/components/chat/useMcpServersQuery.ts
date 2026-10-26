import type { EnvironmentId, McpServersListInput } from "@starkfuture/contracts";
import { useEffect, useEffectEvent } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

type Subscriber = { refresh: () => void; interval: number };
type Poller = { subscribers: Set<Subscriber>; timer: ReturnType<typeof setInterval> | undefined };
const pollers = new Map<string, Poller>();
const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/** The chip, warning and open panel share one poller and one query for their target. */
export function useMcpServersQuery(
  environmentId: EnvironmentId,
  target: McpServersListInput,
  interval = 10_000,
) {
  const query = useEnvironmentQuery(serverEnvironment.mcpServers({ environmentId, input: target }));
  // Refreshing an in-flight atom restarts its RPC. A slow inspection must be
  // allowed to finish, even when another visible subscriber polls faster.
  const refresh = useEffectEvent(() => {
    if (isVisible() && !query.isPending) query.refresh();
  });
  const key = JSON.stringify([
    environmentId,
    target.threadId,
    target.providerInstanceId,
    target.projectId,
  ]);
  useEffect(() => {
    const subscriber = { refresh: () => refresh(), interval };
    const existing = pollers.get(key);
    const subscribers = existing?.subscribers ?? new Set<Subscriber>();
    subscribers.add(subscriber);
    const schedule = () => {
      const old = pollers.get(key);
      if (old) clearInterval(old.timer);
      if (!subscribers.size) {
        pollers.delete(key);
        return;
      }
      const timer = isVisible()
        ? setInterval(
            () => subscribers.values().next().value?.refresh(),
            Math.min(...Array.from(subscribers, (entry) => entry.interval)),
          )
        : undefined;
      pollers.set(key, { subscribers, timer });
    };
    const visibilityChanged = () => {
      schedule();
      if (isVisible() && subscribers.values().next().value === subscriber) subscriber.refresh();
    };
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", visibilityChanged);
    schedule();
    if (!existing) subscriber.refresh();
    return () => {
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visibilityChanged);
      subscribers.delete(subscriber);
      schedule();
    };
  }, [key, interval]);
  return query;
}
