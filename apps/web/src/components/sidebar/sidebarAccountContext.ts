import type { EnvironmentId, ProviderInstanceId } from "@starkfuture/contracts";
import { useLayoutEffect } from "react";
import { create } from "zustand";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ThreadRouteTarget } from "../../threadRoutes";

export interface SidebarAccountContext {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly unavailableReason: string | null;
  readonly getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  readonly onSelect: (instanceId: ProviderInstanceId, model: string) => void;
}

export function sidebarAccountContextKey(target: ThreadRouteTarget): string {
  return target.kind === "draft"
    ? `draft:${target.draftId}`
    : `thread:${target.threadRef.environmentId}:${target.threadRef.threadId}`;
}

export const useSidebarAccountContexts = create<{
  readonly contexts: Readonly<Record<string, SidebarAccountContext>>;
}>(() => ({ contexts: {} }));

/** Publish the actual composer/native selection so account UI never guesses from old replies. */
export function usePublishSidebarAccountContext(key: string, context: SidebarAccountContext) {
  const {
    environmentId,
    instanceId,
    entries,
    unavailableReason,
    getModelDisabledReason,
    onSelect,
  } = context;
  useLayoutEffect(() => {
    const current = {
      environmentId,
      instanceId,
      entries,
      unavailableReason,
      getModelDisabledReason,
      onSelect,
    };
    useSidebarAccountContexts.setState((state) => ({
      contexts: { ...state.contexts, [key]: current },
    }));
    return () => {
      useSidebarAccountContexts.setState((state) => {
        if (state.contexts[key] !== current) return state;
        const { [key]: _removed, ...contexts } = state.contexts;
        return { contexts };
      });
    };
  }, [
    key,
    environmentId,
    instanceId,
    entries,
    unavailableReason,
    getModelDisabledReason,
    onSelect,
  ]);
}
