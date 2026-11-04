import * as Data from "effect/Data";

export interface WorkspaceAgentOwner {
  readonly token: symbol;
  readonly threadId: string;
  readonly kind: "native" | "graphical";
  readonly sideChatParentThreadId?: string;
  /** Server-recorded root of a graphical parent and its delegated workers. */
  readonly delegationRootThreadId?: string;
}

// One server process owns each data home. Tokens keep an old exit callback
// from releasing a replacement agent's workspace.
const owners = new Map<string, Map<symbol, WorkspaceAgentOwner>>();
const waiters = new Map<
  string,
  Map<symbol, { readonly owner: WorkspaceAgentOwner; readonly acquired: () => void }>
>();

/** A safe, actionable refusal that callers may show without exposing arbitrary causes. */
export class WorkspaceAgentBusyError extends Data.TaggedError("WorkspaceAgentBusyError")<
  Pick<WorkspaceAgentOwner, "kind" | "threadId" | "sideChatParentThreadId">
> {
  override get message() {
    return `A ${this.kind} agent is already running in this workspace (thread ${this.threadId}). Exit it or use another Git worktree.`;
  }
}

export function claimAgentWorkspace(workspace: string, owner: WorkspaceAgentOwner): void {
  const holders = owners.get(workspace) ?? new Map<symbol, WorkspaceAgentOwner>();
  const existing = [...holders.values()].find(
    (holder) => holder.token !== owner.token && !sharesDelegation(holder, owner),
  );
  if (existing) {
    throw new WorkspaceAgentBusyError({
      kind: existing.kind,
      threadId: existing.threadId,
      ...(existing.sideChatParentThreadId === undefined
        ? {}
        : { sideChatParentThreadId: existing.sideChatParentThreadId }),
    });
  }
  holders.set(owner.token, owner);
  owners.set(workspace, holders);
}

// Delegation deliberately runs cooperative workers in the parent's folder.
// Side chats keep their queue, and native/unrelated agents remain exclusive.
function sharesDelegation(left: WorkspaceAgentOwner, right: WorkspaceAgentOwner): boolean {
  return (
    left.kind === "graphical" &&
    right.kind === "graphical" &&
    left.delegationRootThreadId !== undefined &&
    left.delegationRootThreadId === right.delegationRootThreadId
  );
}

/** The cooperation group of an active graphical caller, never a native agent. */
export function workspaceCooperationRoot(workspace: string, threadId: string): string | undefined {
  return [...(owners.get(workspace)?.values() ?? [])].find(
    (owner) => owner.kind === "graphical" && owner.threadId === threadId,
  )?.delegationRootThreadId;
}

/** Only a parent, its side chats, and sibling side chats share an automatic queue. */
export function canQueueBehindWorkspaceOwner(
  requester: Pick<WorkspaceAgentOwner, "threadId" | "sideChatParentThreadId">,
  owner: Pick<WorkspaceAgentOwner, "threadId" | "sideChatParentThreadId">,
): boolean {
  return (
    owner.sideChatParentThreadId === requester.threadId ||
    (requester.sideChatParentThreadId !== undefined &&
      (requester.sideChatParentThreadId === owner.threadId ||
        requester.sideChatParentThreadId === owner.sideChatParentThreadId))
  );
}

/** Reserve the next free slot without polling. Cancellation removes only this waiter. */
export function waitForAgentWorkspace(
  workspace: string,
  owner: WorkspaceAgentOwner,
  acquired: () => void,
): () => void {
  const existing = owners.get(workspace);
  if (
    existing === undefined ||
    [...existing.values()].every(
      (holder) => holder.token === owner.token || sharesDelegation(holder, owner),
    )
  ) {
    const holders = existing ?? new Map<symbol, WorkspaceAgentOwner>();
    holders.set(owner.token, owner);
    owners.set(workspace, holders);
    acquired();
    return () => {};
  }
  const queue = waiters.get(workspace) ?? new Map();
  queue.set(owner.token, { owner, acquired });
  waiters.set(workspace, queue);
  return () => {
    queue.delete(owner.token);
    if (queue.size === 0 && waiters.get(workspace) === queue) waiters.delete(workspace);
  };
}

export function releaseAgentWorkspace(token: symbol): void {
  for (const [workspace, holders] of owners) {
    if (!holders.delete(token) || holders.size > 0) continue;
    owners.delete(workspace);
    const queue = waiters.get(workspace);
    const next = queue?.values().next().value;
    if (next === undefined) continue;
    queue!.delete(next.owner.token);
    if (queue!.size === 0) waiters.delete(workspace);
    // Transfer before waking the waiter: a new writer cannot jump this queue.
    owners.set(workspace, new Map([[next.owner.token, next.owner]]));
    next.acquired();
  }
}
