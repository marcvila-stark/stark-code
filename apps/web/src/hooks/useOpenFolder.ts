import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import type { ScopedProjectRef } from "@starkfuture/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { openThreadWithSideChat } from "../lib/sideChatNavigation";
import { getLatestThreadForProject } from "../lib/threadSort";
import { readThreadShells, waitForProject } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";

/** Open a known folder and keep the next New chat in that same workspace. */
export function useOpenFolder() {
  const router = useRouter();
  const newThread = useNewThreadHandler();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const sortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  return useCallback(
    async (
      projectRef: ScopedProjectRef,
      options?: {
        readonly reopenSettled?: boolean;
        readonly isCurrent?: () => boolean;
      },
    ): Promise<boolean> => {
      const request = ++generation.current;
      const isCurrent = () => request === generation.current && options?.isCurrent?.() !== false;
      const startingRoute = router.state.location.href;
      try {
        // A create receipt can precede its project event. Draft creation needs
        // the stored folder path, so never race that event with navigation.
        const project = await waitForProject(projectRef);
        if (!isCurrent() || router.state.location.href !== startingRoute) return false;
        const environmentThreads = readThreadShells().filter(
          (thread) => thread.environmentId === projectRef.environmentId,
        );
        const latest = getLatestThreadForProject(
          environmentThreads,
          projectRef.projectId,
          sortOrder,
        );
        if (latest && (options?.reopenSettled || latest.settledOverride !== "settled")) {
          await openThreadWithSideChat({
            threadRef: scopeThreadRef(latest.environmentId, latest.id),
            getThread: (id) => environmentThreads.find((thread) => thread.id === id),
            navigate: (threadRef) =>
              router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(threadRef),
              }),
          });
        } else if ((await newThread(projectRef, { isCurrent })) === null) {
          return false;
        }
        if (!isCurrent()) return false;
        useUiStateStore
          .getState()
          .setSidebarProjectScopeKey(deriveLogicalProjectKeyFromSettings(project, grouping));
        return true;
      } catch (error) {
        if (isCurrent()) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not open folder",
              description:
                error instanceof Error ? error.message : "Try choosing the folder again.",
            }),
          );
        }
        return false;
      }
    },
    [grouping, newThread, router, sortOrder],
  );
}
