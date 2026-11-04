import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type McpServersListResult,
} from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createMcpStatusMemory,
  describeMcpStatusFreshness,
  MCP_STATUS_FRESH_ON_OPEN_MS,
  mcpStatusTargetKey,
  resolveMcpStatusView,
} from "./mcpStatusMemory";

const result = (name: string): McpServersListResult => ({
  live: false,
  servers: [{ name, status: "connected", tools: [], authKind: "none", locked: false }],
});
const MINUTE = 60_000;
const opened = 100 * MINUTE;

describe("mcpStatusMemory", () => {
  it("keeps one result per environment, folder and agent", () => {
    const memory = createMcpStatusMemory();
    const environmentId = EnvironmentId.make("env");
    const claude = mcpStatusTargetKey(environmentId, {
      projectId: ProjectId.make("project"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    const codex = mcpStatusTargetKey(environmentId, {
      projectId: ProjectId.make("project"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const thread = mcpStatusTargetKey(environmentId, { threadId: ThreadId.make("thread") });
    memory.remember(claude, { result: result("claude"), receivedAt: 1 });
    memory.remember(codex, { result: result("codex"), receivedAt: 1 });

    expect(memory.recall(claude)?.result).toEqual(result("claude"));
    expect(memory.recall(codex)?.result).toEqual(result("codex"));
    expect(memory.recall(thread)).toBeNull();
  });

  it("never replaces a result with an older one", () => {
    const memory = createMcpStatusMemory();
    memory.remember("key", { result: result("newer"), receivedAt: 20 });
    memory.remember("key", { result: result("older"), receivedAt: 10 });

    expect(memory.recall("key")?.result).toEqual(result("newer"));
  });

  it("drops the least recently updated targets past its limit", () => {
    const memory = createMcpStatusMemory(2);
    memory.remember("a", { result: result("a"), receivedAt: 1 });
    memory.remember("b", { result: result("b"), receivedAt: 1 });
    memory.remember("a", { result: result("a"), receivedAt: 2 });
    memory.remember("c", { result: result("c"), receivedAt: 1 });

    expect(memory.recall("b")).toBeNull();
    expect(memory.recall("a")?.receivedAt).toBe(2);
    expect(memory.recall("c")).not.toBeNull();
  });
});

describe("resolveMcpStatusView", () => {
  const base = {
    current: null,
    currentReceivedAt: 0,
    pending: true,
    failed: false,
    remembered: null,
    freshSince: opened,
    now: opened,
  };

  it("shows the loading placeholder only when nothing is known", () => {
    expect(resolveMcpStatusView(base)).toEqual({ kind: "checking" });
    expect(resolveMcpStatusView({ ...base, pending: false, failed: true })).toEqual({
      kind: "unknown",
    });
  });

  it("shows the remembered result at once while the new inspection runs", () => {
    const view = resolveMcpStatusView({
      ...base,
      remembered: { result: result("drive"), receivedAt: opened - MINUTE },
    });

    expect(view).toEqual({
      kind: "known",
      result: result("drive"),
      remembered: true,
      refreshing: true,
      age: null,
    });
    expect(describeMcpStatusFreshness(view, false)).toBe("Refreshing…");
    expect(describeMcpStatusFreshness(view, true)).toBe("Refresh is taking longer than expected.");
  });

  it("marks a result older than a few minutes with its age", () => {
    const view = resolveMcpStatusView({
      ...base,
      remembered: { result: result("drive"), receivedAt: opened - 12 * MINUTE },
    });

    expect(view.kind === "known" && view.age).toBe("12m");
    expect(describeMcpStatusFreshness(view, false)).toBe("Refreshing… Last checked 12m ago.");
  });

  it("replaces the remembered result with the current answer and drops the marker", () => {
    const view = resolveMcpStatusView({
      ...base,
      current: result("fresh"),
      currentReceivedAt: opened + 2_000,
      pending: false,
      remembered: { result: result("drive"), receivedAt: opened - 12 * MINUTE },
    });

    expect(view).toMatchObject({ result: result("fresh"), refreshing: false, remembered: false });
    expect(describeMcpStatusFreshness(view, false)).toBeNull();
  });

  it("does not flash the marker for a result from just before the view opened", () => {
    const view = resolveMcpStatusView({
      ...base,
      current: result("fresh"),
      currentReceivedAt: opened - 10_000,
      freshSince: opened - MCP_STATUS_FRESH_ON_OPEN_MS,
    });

    expect(describeMcpStatusFreshness(view, false)).toBeNull();
  });

  it("does not mark background polls after this view has its own answer", () => {
    const view = resolveMcpStatusView({
      ...base,
      current: result("fresh"),
      currentReceivedAt: opened + 2_000,
      pending: true,
      now: opened + 4_000,
    });

    expect(view.kind === "known" && view.refreshing).toBe(false);
  });

  it("marks an explicit status check until it answers", () => {
    const input = {
      ...base,
      current: result("fresh"),
      currentReceivedAt: opened + 2_000,
      freshSince: opened + 5_000,
      now: opened + 5_000,
    };

    expect(describeMcpStatusFreshness(resolveMcpStatusView(input), false)).toBe("Refreshing…");
    expect(
      describeMcpStatusFreshness(
        resolveMcpStatusView({ ...input, currentReceivedAt: opened + 6_000, pending: false }),
        false,
      ),
    ).toBeNull();
  });

  it("says the rows are the last known state when the new inspection failed", () => {
    const view = resolveMcpStatusView({
      ...base,
      pending: false,
      failed: true,
      remembered: { result: result("drive"), receivedAt: opened - 12 * MINUTE },
    });

    expect(view.kind === "known" && view.refreshing).toBe(false);
    expect(describeMcpStatusFreshness(view, false)).toBe(
      "Showing the last known status from 12m ago.",
    );
  });
});
