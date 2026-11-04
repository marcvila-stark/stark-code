import { describe, expect, it } from "vite-plus/test";
import {
  claimAgentWorkspace,
  canQueueBehindWorkspaceOwner,
  releaseAgentWorkspace,
  waitForAgentWorkspace,
  workspaceCooperationRoot,
} from "./WorkspaceAgentOwnership.ts";

describe("workspace agent ownership", () => {
  it("keeps a delegated family's claim until its last worker exits", () => {
    const workspace = "/test/delegated-family";
    const parent = {
      token: Symbol("parent"),
      threadId: "parent",
      kind: "graphical" as const,
      delegationRootThreadId: "parent",
    };
    const child = { ...parent, token: Symbol("child"), threadId: "child" };
    const sibling = { ...parent, token: Symbol("sibling"), threadId: "sibling" };
    const native = { token: Symbol("native"), threadId: "native", kind: "native" as const };
    const unrelated = {
      ...parent,
      token: Symbol("other"),
      threadId: "other",
      delegationRootThreadId: "other",
    };
    const side = {
      token: Symbol("side"),
      threadId: "side",
      kind: "graphical" as const,
      sideChatParentThreadId: "parent",
    };
    let sideStarted = false;
    let cancel = () => {};
    try {
      claimAgentWorkspace(workspace, parent);
      claimAgentWorkspace(workspace, child);
      claimAgentWorkspace(workspace, sibling);
      expect(workspaceCooperationRoot(workspace, child.threadId)).toBe(parent.threadId);
      expect(workspaceCooperationRoot(workspace, native.threadId)).toBeUndefined();
      expect(() => claimAgentWorkspace(workspace, native)).toThrow("graphical agent");
      expect(() => claimAgentWorkspace(workspace, unrelated)).toThrow("graphical agent");
      cancel = waitForAgentWorkspace(workspace, side, () => {
        sideStarted = true;
      });
      releaseAgentWorkspace(parent.token);
      releaseAgentWorkspace(child.token);
      expect(workspaceCooperationRoot(workspace, parent.threadId)).toBeUndefined();
      expect(workspaceCooperationRoot(workspace, sibling.threadId)).toBe(parent.threadId);
      releaseAgentWorkspace(parent.token);
      expect(sideStarted).toBe(false);
      expect(() => claimAgentWorkspace(workspace, native)).toThrow("graphical agent");
      releaseAgentWorkspace(sibling.token);
      expect(sideStarted).toBe(true);
      expect(() => claimAgentWorkspace(workspace, parent)).toThrow("graphical agent");
      releaseAgentWorkspace(side.token);
      claimAgentWorkspace(workspace, native);
    } finally {
      cancel();
      for (const owner of [parent, child, sibling, native, unrelated, side])
        releaseAgentWorkspace(owner.token);
    }
  });
  it("excludes native and graphical agents until the owner exits", () => {
    const native = Symbol("native");
    const graphical = Symbol("graphical");
    try {
      claimAgentWorkspace("/test/exclusive", { token: native, threadId: "one", kind: "native" });
      expect(() =>
        claimAgentWorkspace("/test/exclusive", {
          token: graphical,
          threadId: "two",
          kind: "graphical",
        }),
      ).toThrow("another Git worktree");
      releaseAgentWorkspace(native);
      claimAgentWorkspace("/test/exclusive", {
        token: graphical,
        threadId: "two",
        kind: "graphical",
      });
      expect(() =>
        claimAgentWorkspace("/test/exclusive", { token: native, threadId: "one", kind: "native" }),
      ).toThrow("graphical agent");
    } finally {
      releaseAgentWorkspace(native);
      releaseAgentWorkspace(graphical);
    }
  });
  it("allows separate worktrees and ignores an old owner's late cleanup", () => {
    const old = Symbol("old");
    const current = Symbol("current");
    const other = Symbol("other");
    try {
      claimAgentWorkspace("/test/tree-a", { token: old, threadId: "one", kind: "native" });
      claimAgentWorkspace("/test/tree-b", { token: other, threadId: "two", kind: "graphical" });
      releaseAgentWorkspace(old);
      claimAgentWorkspace("/test/tree-a", { token: current, threadId: "one", kind: "native" });
      releaseAgentWorkspace(old);
      expect(() =>
        claimAgentWorkspace("/test/tree-a", { token: other, threadId: "two", kind: "graphical" }),
      ).toThrow("native agent");
    } finally {
      releaseAgentWorkspace(old);
      releaseAgentWorkspace(current);
      releaseAgentWorkspace(other);
    }
  });
});

it("hands the workspace to waiting side chats in order, before a competing writer", () => {
  const parent = { token: Symbol("parent"), threadId: "parent", kind: "native" as const };
  const first = { token: Symbol("first"), threadId: "first", kind: "graphical" as const };
  const second = { token: Symbol("second"), threadId: "second", kind: "graphical" as const };
  const acquired: string[] = [];
  const workspace = "/test/side-chat-queue";
  claimAgentWorkspace(workspace, parent);
  const cancelFirst = waitForAgentWorkspace(workspace, first, () => acquired.push("first"));
  const cancelSecond = waitForAgentWorkspace(workspace, second, () => acquired.push("second"));
  try {
    expect(acquired).toEqual([]);
    releaseAgentWorkspace(parent.token);
    expect(acquired).toEqual(["first"]);
    expect(() => claimAgentWorkspace(workspace, parent)).toThrow("graphical agent");
    releaseAgentWorkspace(first.token);
    expect(acquired).toEqual(["first", "second"]);
    releaseAgentWorkspace(parent.token);
    expect(() => claimAgentWorkspace(workspace, parent)).toThrow("graphical agent");
  } finally {
    cancelFirst();
    cancelSecond();
    releaseAgentWorkspace(first.token);
    releaseAgentWorkspace(second.token);
    releaseAgentWorkspace(parent.token);
  }
});

it("removes a cancelled waiter without releasing its parent or starting it later", () => {
  const parent = { token: Symbol("parent"), threadId: "parent", kind: "graphical" as const };
  const child = { token: Symbol("child"), threadId: "child", kind: "graphical" as const };
  const workspace = "/test/cancelled-side-chat";
  let started = false;
  claimAgentWorkspace(workspace, parent);
  const cancel = waitForAgentWorkspace(workspace, child, () => {
    started = true;
  });
  cancel();
  expect(() => claimAgentWorkspace(workspace, child)).toThrow("graphical agent");
  releaseAgentWorkspace(parent.token);
  expect(started).toBe(false);
  claimAgentWorkspace(workspace, child);
  releaseAgentWorkspace(child.token);
});

it("queues only direct parent/side-chat or sibling relationships", () => {
  const main = { threadId: "main" };
  const child = { threadId: "child", sideChatParentThreadId: "main" };
  const sibling = { threadId: "sibling", sideChatParentThreadId: "main" };
  const unrelated = { threadId: "other" };
  expect(canQueueBehindWorkspaceOwner(child, main)).toBe(true);
  expect(canQueueBehindWorkspaceOwner(main, child)).toBe(true);
  expect(canQueueBehindWorkspaceOwner(child, sibling)).toBe(true);
  expect(canQueueBehindWorkspaceOwner(main, unrelated)).toBe(false);
  expect(canQueueBehindWorkspaceOwner(child, unrelated)).toBe(false);
  expect(canQueueBehindWorkspaceOwner(unrelated, child)).toBe(false);
});
