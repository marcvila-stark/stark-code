import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ServerProviderSessionCatalog, ThreadId } from "@starkfuture/contracts";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";

/** Reads only the already-live session; opening a picker never launches a provider. */
export function useComposerSessionCatalog(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  providerThreadId: string | null;
  providerInstanceId: string | null;
  open: boolean;
}) {
  const key =
    input.open && input.threadId
      ? `${input.environmentId}:${input.threadId}:${input.providerThreadId ?? ""}:${input.providerInstanceId ?? ""}`
      : null;
  const query = useEnvironmentQuery(
    key && input.threadId
      ? serverEnvironment.readSessionCatalog({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        })
      : null,
  );
  const refresh = useRef(query.refresh);
  refresh.current = query.refresh;
  const requestedAt = useRef(0);
  const cache = useRef(new Map<string, ServerProviderSessionCatalog>());
  const [accepted, setAccepted] = useState<{
    key: string;
    catalog: ServerProviderSessionCatalog;
  } | null>(null);
  useEffect(() => {
    if (!key) return;
    requestedAt.current = Date.now();
    refresh.current();
    const timer = window.setInterval(() => refresh.current(), 5_000);
    return () => window.clearInterval(timer);
  }, [key]);
  useEffect(() => {
    if (!key || !query.data || query.dataUpdatedAt < requestedAt.current) return;
    const catalog = query.data;
    if (catalog.providerSessionId) {
      cache.current.set(catalog.providerSessionId, catalog);
      if (cache.current.size > 32) cache.current.delete(cache.current.keys().next().value!);
    }
    setAccepted({
      key,
      catalog: catalog.providerSessionId ? cache.current.get(catalog.providerSessionId)! : catalog,
    });
  }, [key, query.data, query.dataUpdatedAt]);
  return { catalog: accepted?.key === key ? accepted.catalog : null, isPending: query.isPending };
}
