import * as Data from "effect/Data";

export interface WorkspaceAgentOwner {
  readonly token: symbol;
  readonly threadId: string;
  readonly kind: "native" | "graphical";
}

// One server process owns each data home. Tokens keep an old exit callback
// from releasing a replacement agent's workspace.
const owners = new Map<string, WorkspaceAgentOwner>();

/** A safe, actionable refusal that callers may show without exposing arbitrary causes. */
export class WorkspaceAgentBusyError extends Data.TaggedError("WorkspaceAgentBusyError")<
  Pick<WorkspaceAgentOwner, "kind" | "threadId">
> {
  override get message() {
    return `A ${this.kind} agent is already running in this workspace (thread ${this.threadId}). Exit it or use another Git worktree.`;
  }
}

export function claimAgentWorkspace(workspace: string, owner: WorkspaceAgentOwner): void {
  const existing = owners.get(workspace);
  if (existing && existing.token !== owner.token) {
    throw new WorkspaceAgentBusyError({ kind: existing.kind, threadId: existing.threadId });
  }
  owners.set(workspace, owner);
}

export function releaseAgentWorkspace(token: symbol): void {
  for (const [workspace, owner] of owners) {
    if (owner.token === token) owners.delete(workspace);
  }
}
