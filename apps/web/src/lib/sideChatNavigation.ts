import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import type { EnvironmentThreadShell } from "@starkfuture/client-runtime/state/models";
import type { ScopedThreadRef, ThreadId } from "@starkfuture/contracts";
import { openSideChat } from "../sideChatStore";

type NavigationThread = Pick<EnvironmentThreadShell, "id" | "projectId" | "lineage"> & {
  readonly archivedAt: unknown | null;
  readonly deletedAt?: unknown | null;
};

/** Resolve at click time: a notification may outlive a link, archive or detach.
 * Both shell projections and presented sidebar shells can provide the lookup. */
export function openThreadWithSideChat<T>(input: {
  threadRef: ScopedThreadRef;
  getThread: (id: ThreadId) => NavigationThread | null | undefined;
  navigate: (threadRef: ScopedThreadRef) => T;
}): T {
  const thread = input.getThread(input.threadRef.threadId);
  const parentId =
    thread?.lineage.relationshipToParent === "side_chat" ? thread.lineage.parentThreadId : null;
  const parent = parentId === null ? null : input.getThread(parentId);
  if (
    thread &&
    thread.archivedAt === null &&
    thread.deletedAt == null &&
    parent &&
    parent.id !== thread.id &&
    parent.projectId === thread.projectId &&
    parent.archivedAt === null &&
    parent.deletedAt == null
  ) {
    const parentRef = scopeThreadRef(input.threadRef.environmentId, parent.id);
    openSideChat(parentRef, thread.id);
    return input.navigate(parentRef);
  }
  return input.navigate(input.threadRef);
}
