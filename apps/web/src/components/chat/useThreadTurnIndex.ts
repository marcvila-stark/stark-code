import type { OrchestrationV2ThreadTurnIndexPage, ScopedThreadRef } from "@starkfuture/contracts";
import { scopedThreadKey } from "@starkfuture/client-runtime/environment";
import { useEffect, useMemo, useState } from "react";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

type IndexState = {
  key: string | null;
  items: OrchestrationV2ThreadTurnIndexPage["items"];
  totalTurns: number | null;
  beforeEntryId?: string;
  complete: boolean;
};
const empty = (key: string | null): IndexState => ({
  key,
  items: [],
  totalTurns: null,
  complete: false,
});

/** Fetches bounded previews on demand without filling the conversation with old tool output. */
export function useThreadTurnIndex(thread: ScopedThreadRef | null | undefined, enabled: boolean) {
  const key = thread ? scopedThreadKey(thread) : null;
  const [state, setState] = useState(() => empty(key));
  const current = state.key === key ? state : empty(key);
  useEffect(() => {
    if (!enabled || state.key !== key) setState(empty(key));
  }, [enabled, key, state.key]);
  const environmentId = thread?.environmentId;
  const threadId = thread?.threadId;
  const atom = useMemo(
    () =>
      enabled && environmentId && threadId && !current.complete
        ? orchestrationEnvironment.threadTurnIndex({
            environmentId,
            input: {
              threadId,
              ...(current.beforeEntryId ? { beforeEntryId: current.beforeEntryId } : {}),
            },
          })
        : null,
    [enabled, environmentId, threadId, current.beforeEntryId, current.complete],
  );
  const result = useEnvironmentQuery(atom);
  useEffect(() => {
    if (!enabled || !result.data) return;
    const page = result.data;
    setState((prior) => {
      const existing = prior.key === key ? prior.items : [];
      const incoming = new Set(page.items.map((item) => item.entryId));
      return {
        key,
        items: [...page.items, ...existing.filter((item) => !incoming.has(item.entryId))],
        totalTurns: page.totalTurns,
        ...(page.nextBeforeEntryId ? { beforeEntryId: page.nextBeforeEntryId } : {}),
        complete: page.nextBeforeEntryId === null,
      };
    });
  }, [enabled, key, result.data]);
  return {
    items: current.items,
    totalTurns: current.totalTurns,
    complete: current.complete,
    loading: enabled && key !== null && !current.complete && result.error === null,
    error: result.error,
    retry: result.refresh,
  };
}
