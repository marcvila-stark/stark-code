// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type McpServersListResult,
  type McpServerStatusEntry,
} from "@starkfuture/contracts";

const state = vi.hoisted(() => ({
  query: {
    data: undefined as McpServersListResult | undefined,
    error: null as string | null,
    refresh: vi.fn(),
    isPending: false,
  },
  signIn: vi.fn(),
  open: vi.fn(),
  mutate: vi.fn(),
  manage: true,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    mcpServers: () => ({}),
    signInMcpServer: state.signIn,
    reloadMcpServers: state.mutate,
    reconnectMcpServer: state.mutate,
    setMcpServerEnabled: state.mutate,
    signOutMcpServer: state.mutate,
    submitMcpServerCallback: state.mutate,
  },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state.query }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_id: unknown, scope: string) =>
    scope === "providers:manage" ? state.manage : true,
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    presentation: {
      entry: { target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://localhost:5733" } },
    },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.open } }),
}));

import { McpHealthBanner } from "./McpHealthBanner";
import * as DateTime from "effect/DateTime";
let root: Root;
let container: HTMLDivElement;
const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const server = (
  name: string,
  status: McpServerStatusEntry["status"],
  recovery?: McpServerStatusEntry["recovery"],
): McpServerStatusEntry => ({
  name,
  status,
  locked: false,
  tools: [],
  authKind: "oauth",
  ...(recovery ? { recovery } : {}),
});
const runId = RunId.make("current");
let turnItems: OrchestrationV2ProjectedTurnItem[];
const attempted = (toolName = "Drive.find"): OrchestrationV2ProjectedTurnItem => ({
  position: 1,
  visibility: "local",
  sourceThreadId: threadRef.threadId,
  sourceItemId: TurnItemId.make("call"),
  item: {
    type: "dynamic_tool",
    id: TurnItemId.make("call"),
    threadId: threadRef.threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "failed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
    toolName,
    input: {},
  },
});
const render = (busy = false, ref = threadRef, currentRun = runId) =>
  act(() =>
    root.render(
      <McpHealthBanner
        threadRef={ref}
        sessionBusy={busy}
        runId={currentRun}
        turnItems={turnItems}
      />,
    ),
  );
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.query.data = {
    live: true,
    reconnectScope: "server",
    servers: [
      server("Drive", "needs-auth"),
      server("Internal", "failed", { state: "vpn-off", attempts: 0 }),
      server("Healthy", "connected"),
    ],
  };
  turnItems = [attempted()];
  state.query.error = null;
  state.query.refresh.mockReset();
  state.manage = true;
  state.signIn
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { url: "https://auth.example.com/oauth" } });
  state.open.mockReset().mockResolvedValue(undefined);
  state.mutate.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows only live connection issues and opens guarded sign-in with one explicit click", async () => {
  await render();
  expect(container.textContent).toContain("Drive needs sign-in for this reply.");
  expect(container.textContent).not.toContain("Internal");
  expect(container.textContent).not.toContain("Healthy");
  expect(state.signIn).not.toHaveBeenCalled();
  await act(async () => button("Sign in to Drive")!.click());
  expect(state.signIn).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { threadId: "thread", name: "Drive" },
  });
  expect(state.open).toHaveBeenCalledExactlyOnceWith("https://auth.example.com/oauth");
  expect(document.body.textContent).toContain("Waiting for sign-in to Drive");
  expect(state.mutate).not.toHaveBeenCalled();
});

it("offers review without sign-in permission and blocks changes during a turn", async () => {
  await render(true);
  expect(button("Sign in to Drive")?.disabled).toBe(true);
  await act(() => button("Sign in to Drive")!.click());
  expect(state.signIn).not.toHaveBeenCalled();
  state.manage = false;
  await render();
  expect(button("Sign in to Drive")).toBeUndefined();
  await act(() => button("Review connection")!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Connections");
  expect(state.signIn).not.toHaveBeenCalled();
});

it("does not mislabel an inactive or failed status query as a connector failure", async () => {
  state.query.data = { ...state.query.data!, live: false };
  await render();
  expect(container.textContent).toBe("");
  state.query.data = { ...state.query.data!, live: true };
  state.query.error = "Transport unavailable";
  await render();
  expect(container.textContent).toBe("");
});

it("shares status polling between banner and open panel and drops stale sign-in state on target changes", async () => {
  await render();
  expect(state.query.refresh).toHaveBeenCalledTimes(1);
  await act(() => button("Review connection")!.click());
  expect(state.query.refresh).toHaveBeenCalledTimes(1);
  expect(state.signIn).not.toHaveBeenCalled();
  await render(false, { ...threadRef, threadId: ThreadId.make("other") });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(state.query.refresh).toHaveBeenCalledTimes(2);
});

it.each(["server", "all"] as const)(
  "shows FortiClient advisory without promising a reconnect for %s scope",
  async (reconnectScope) => {
    turnItems = [attempted("Public docs.find")];
    state.query.data = {
      live: true,
      reconnectScope,
      servers: [
        server("Public docs", "failed", {
          state: "network-unavailable",
          attempts: 2,
          vpnState: "forticlient-disconnected",
        }),
      ],
    };
    await render();
    expect(container.textContent).toContain("FortiClient is disconnected.");
    expect(container.textContent).toContain(
      "This server is unreachable. Check whether it requires your VPN.",
    );
    expect(container.textContent).not.toContain("Connect it, then check again");
    expect(container.textContent).not.toContain("automatic retries continue");
    state.query.data = {
      live: true,
      reconnectScope: "server",
      servers: [server("Public docs", "failed", { state: "waiting", attempts: 2 })],
    };
    await render();
    expect(container.textContent).not.toContain("FortiClient");
    expect(container.textContent).toContain("Waiting for a safe moment to retry.");
  },
);

it("does not show unrelated disconnected plugins before a tool is attempted", async () => {
  turnItems = [];
  await render();
  expect(container.textContent).toBe("");
  expect(state.signIn).not.toHaveBeenCalled();
});

it("clears the contextual warning and its open panel on the next turn", async () => {
  await render();
  await act(() => button("Review connection")!.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await render(false, threadRef, RunId.make("next"));
  expect(container.textContent).toBe("");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps an explicit sign-in flow open when the connection recovers", async () => {
  await render();
  await act(async () => button("Sign in to Drive")!.click());
  state.query.data = { ...state.query.data!, servers: [server("Drive", "connected")] };
  await render();
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
