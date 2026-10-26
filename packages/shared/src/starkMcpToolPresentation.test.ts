import { describe, expect, it } from "vite-plus/test";

import {
  STARK_MCP_TOOL_NAMES,
  resolveStarkMcpToolPresentation,
} from "./starkMcpToolPresentation.ts";

describe("resolveStarkMcpToolPresentation", () => {
  it("recognizes every Stark tool across provider prefixes and completion suffixes", () => {
    for (const tool of STARK_MCP_TOOL_NAMES) {
      const presentation = resolveStarkMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__stark-code__",
        "mcp__stark_code__",
        "mcp__starkcode__",
        "Stark-code.",
        "stark_code/",
        "starkcode:",
        "mcp_stark-code_",
        "Stark Code ",
        "stark-code · ",
      ]) {
        expect(resolveStarkMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveStarkMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor Stark MCP tool names", () => {
    expect(resolveStarkMcpToolPresentation("mcp__stark-code__stark_thread_read")).toEqual({
      displayName: "Read a Stark thread",
      logo: "stark-code",
    });
  });

  it("pretty prints Codex Stark MCP tool names", () => {
    expect(resolveStarkMcpToolPresentation("stark-code.create_threads")).toEqual({
      displayName: "Create Stark threads",
      logo: "stark-code",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveStarkMcpToolPresentation("mcp__stark-code__stark_thread_update")).toEqual({
      displayName: "Update Stark thread metadata",
      logo: "stark-code",
    });
  });

  it("pretty prints bare Stark MCP toolkit names", () => {
    expect(resolveStarkMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "stark-code",
    });
  });

  it("pretty prints worktree Stark MCP tool names", () => {
    expect(resolveStarkMcpToolPresentation("mcp__stark-code__stark_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "stark-code",
    });
    expect(resolveStarkMcpToolPresentation("stark-code.stark_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "stark-code",
    });
  });

  it("pretty prints preview Stark MCP tool names", () => {
    expect(resolveStarkMcpToolPresentation("Stark-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "stark-code",
    });
    expect(resolveStarkMcpToolPresentation("mcp__stark-code__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "stark-code",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_stark-code_delegate_task",
      "stark_code:delegate_task",
      "starkcode/delegate_task",
      "stark-code delegate_task",
      "Stark Code delegate_task",
      "stark-code__delegate_task",
    ]) {
      expect(resolveStarkMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveStarkMcpToolPresentation("stark-code-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveStarkMcpToolPresentation("stark-code-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveStarkMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveStarkMcpToolPresentation("stark-code.not_a_real_tool")).toBeNull();
  });
});
