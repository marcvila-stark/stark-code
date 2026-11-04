import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { environmentShell } from "../../state/shell";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  BrowserCaptureCatalog,
  BrowserCaptureDestination,
  BrowserCaptureTarget,
} from "@starkfuture/contracts";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { readProjects, useProjects, useThreadShells } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useEnvironments } from "../../state/environments";
import {
  BROWSER_CAPTURE_CONNECTION_EVENT,
  BrowserCaptureDeliveryError,
  deliverBrowserCapture,
  getDesktopBrowserCaptureBridge,
} from "../../lib/browserCapture";
import { toastManager } from "../ui/toast";

function readReadyEnvironmentIds() {
  return [...new Set(readProjects().map((project) => project.environmentId))].filter(
    (environmentId) =>
      readEnvironmentScope(environmentId, "orchestration:operate") &&
      appAtomRegistry.get(environmentShell.stateValueAtom(environmentId)).status === "live",
  );
}

export function BrowserCaptureCoordinator() {
  const bridge = getDesktopBrowserCaptureBridge();
  const projects = useProjects();
  const threads = useThreadShells(Boolean(bridge));
  const drafts = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const { routeDraftId, routeThreadRef } = useHandleNewThread();
  const permitted = useEnvironmentsWithScope(projects, "orchestration:operate");
  const { environments } = useEnvironments();
  const readyEnvironmentsAtom = useMemo(
    () =>
      Atom.make((get) =>
        [...permitted].filter(
          (environmentId) => get(environmentShell.stateValueAtom(environmentId)).status === "live",
        ),
      ),
    [permitted],
  );
  const readyEnvironments = useAtomValue(readyEnvironmentsAtom);
  const draining = useRef<Promise<void> | null>(null);
  const rerun = useRef(false);
  const catalog = useMemo<BrowserCaptureCatalog>(() => {
    const eligible = projects.filter((project) =>
      readyEnvironments.includes(project.environmentId),
    );
    const labels = new Map(
      environments.map((environment) => [environment.environmentId, environment.label]),
    );
    const environmentLabel = (id: string) =>
      (environments.find((environment) => environment.environmentId === id)?.label ?? id).slice(
        0,
        200,
      );
    const currentDraft = routeDraftId ? drafts[routeDraftId] : undefined;
    const destinations: BrowserCaptureDestination[] = [];
    for (const thread of threads.toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )) {
      const project = eligible.find(
        (item) => item.id === thread.projectId && item.environmentId === thread.environmentId,
      );
      if (!project || thread.archivedAt !== null) continue;
      const current =
        (routeThreadRef?.threadId === thread.id &&
          routeThreadRef.environmentId === thread.environmentId) ||
        (currentDraft?.promotedTo?.threadId === thread.id &&
          currentDraft.promotedTo.environmentId === thread.environmentId);
      const target: BrowserCaptureTarget = {
        kind: "thread",
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        threadId: thread.id,
      };
      destinations.push({
        target,
        label: thread.title.slice(0, 200),
        projectLabel: project.title.slice(0, 200),
        environmentLabel: (labels.get(thread.environmentId) ?? thread.environmentId).slice(0, 200),
        current,
      });
    }
    for (const [draftId, draft] of Object.entries(drafts)) {
      const project = eligible.find(
        (item) => item.id === draft.projectId && item.environmentId === draft.environmentId,
      );
      if (!project || draft.promotedTo) continue;
      destinations.push({
        target: {
          kind: "draft",
          draftId,
          environmentId: draft.environmentId,
          projectId: draft.projectId,
        },
        label: draft.title ?? "Unsent draft",
        projectLabel: project.title.slice(0, 200),
        environmentLabel: environmentLabel(draft.environmentId),
        current: routeDraftId === draftId,
      });
    }
    const ordered = destinations.toSorted(
      (left, right) => Number(right.current) - Number(left.current),
    );
    const projectKey = (environmentId: string, projectId: string) =>
      `${environmentId}\0${projectId}`;
    const priority = new Map<string, number>();
    for (const destination of ordered) {
      const key = projectKey(destination.target.environmentId, destination.target.projectId);
      if (!priority.has(key)) priority.set(key, priority.size);
    }
    const selectedProjects = eligible
      .toSorted(
        (left, right) =>
          (priority.get(projectKey(left.environmentId, left.id)) ?? Number.MAX_SAFE_INTEGER) -
          (priority.get(projectKey(right.environmentId, right.id)) ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, 200);
    const selectedProjectKeys = new Set(
      selectedProjects.map((project) => projectKey(project.environmentId, project.id)),
    );
    const publishedProjects = selectedProjects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
      label: project.title.slice(0, 200),
      environmentLabel: environmentLabel(project.environmentId),
    }));
    const encoder = new TextEncoder();
    let bytes = encoder.encode(JSON.stringify(publishedProjects)).byteLength + 64;
    const publishedDestinations: BrowserCaptureDestination[] = [];
    for (const destination of ordered) {
      if (
        !selectedProjectKeys.has(
          projectKey(destination.target.environmentId, destination.target.projectId),
        )
      )
        continue;
      const size = encoder.encode(JSON.stringify(destination)).byteLength + 1;
      // Native Messaging replies are bounded in bytes, including non-Latin labels.
      if (publishedDestinations.length >= 500 || bytes + size > 750_000) break;
      bytes += size;
      publishedDestinations.push(destination);
    }
    return { destinations: publishedDestinations, projects: publishedProjects };
  }, [projects, threads, drafts, readyEnvironments, environments, routeDraftId, routeThreadRef]);
  // Shell status changes do not republish an unchanged chat/project catalogue.
  const serializedCatalog = JSON.stringify(catalog);
  const drain = useCallback(async () => {
    if (!bridge || readReadyEnvironmentIds().length === 0) return;
    if (draining.current) {
      rerun.current = true;
      return draining.current;
    }
    const operation = (async () => {
      do {
        rerun.current = false;
        const result = await bridge.browserCapture({
          action: "pending",
          environmentIds: readReadyEnvironmentIds(),
        });
        if (!result.connected) return;
        for (const delivery of result.pending ?? []) {
          try {
            await deliverBrowserCapture(delivery);
            await bridge.browserCapture({
              action: "complete",
              receipt: {
                id: delivery.capture.id,
                state: "saved",
                message: "Added to the selected chat draft.",
              },
            });
            toastManager.add({
              type: "success",
              title: "Browser capture added to draft",
              description: "Review it in the selected chat and send when ready.",
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "The capture could not be saved.";
            await bridge.browserCapture({
              action: "complete",
              receipt: {
                id: delivery.capture.id,
                state:
                  error instanceof BrowserCaptureDeliveryError ? error.receiptState : "pending",
                message: message.slice(0, 1_000),
              },
            });
            toastManager.add({
              type: "error",
              title: "Browser capture is still pending",
              description: message,
            });
          }
        }
      } while (rerun.current);
    })()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Browser capture disconnected",
          description:
            error instanceof Error ? error.message : "Reconnect Chrome in Browser settings.",
        });
      })
      .finally(() => {
        draining.current = null;
      });
    draining.current = operation;
    return operation;
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    const refresh = () => void drain();
    const unsubscribe = bridge.onBrowserCapturePending?.(refresh);
    window.addEventListener(BROWSER_CAPTURE_CONNECTION_EVENT, refresh);
    window.addEventListener("focus", refresh);
    void drain();
    return () => {
      unsubscribe?.();
      window.removeEventListener(BROWSER_CAPTURE_CONNECTION_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [bridge, drain]);
  useEffect(() => {
    if (!bridge) return;
    void bridge
      .browserCapture({
        action: "publish",
        catalog: JSON.parse(serializedCatalog) as BrowserCaptureCatalog,
      })
      .then(() => drain())
      .catch(() => undefined);
  }, [bridge, serializedCatalog, drain]);
  return null;
}
