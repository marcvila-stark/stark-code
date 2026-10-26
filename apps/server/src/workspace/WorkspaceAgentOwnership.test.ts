import { describe, expect, it } from "vite-plus/test";
import { claimAgentWorkspace, releaseAgentWorkspace } from "./WorkspaceAgentOwnership.ts";

describe("workspace agent ownership", () => {
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
