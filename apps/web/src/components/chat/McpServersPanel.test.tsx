import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type McpServerStatusEntry,
  type McpServersListResult,
} from "@starkfuture/contracts";
const state = vi.hoisted(() => ({
  query: {
    data: {
      servers: [] as McpServerStatusEntry[],
      live: true,
      canReload: true as boolean | undefined,
    } as McpServersListResult | null,
    dataUpdatedAt: 0,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  reconnect: vi.fn(),
  reload: vi.fn(),
  toggle: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  submit: vi.fn(),
  open: vi.fn(),
  canOperate: true,
  localHost: true,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    mcpServers: () => ({}),
    reconnectMcpServer: state.reconnect,
    reloadMcpServers: state.reload,
    setMcpServerEnabled: state.toggle,
    signInMcpServer: state.signIn,
    signOutMcpServer: state.signOut,
    submitMcpServerCallback: state.submit,
  },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state.query }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) =>
    scope === "orchestration:operate" ? state.canOperate : true,
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    presentation: {
      entry: {
        target: {
          _tag: "PrimaryConnectionTarget",
          httpBaseUrl: state.localHost ? "http://localhost:5733" : "https://remote.example.test",
        },
      },
    },
  }),
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.open } }),
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit";
  }) => (
    <button disabled={disabled} type={type} onClick={onClick}>
      {children}
    </button>
  ),
}));
import { McpServerRows, McpServersPanel } from "./McpServersPanel";
let renderer: ReactTestRenderer | undefined;
const server = (patch: Partial<McpServerStatusEntry> = {}) =>
  ({
    name: "Drive",
    source: "claudeai",
    status: "needs-auth",
    tools: [{ name: "search", readOnly: true, destructive: false, openWorld: true }],
    authKind: "oauth",
    locked: false,
    canSubmitCallback: true,
    canSignOut: true,
    ...patch,
  }) satisfies McpServerStatusEntry;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("window", { setInterval, clearInterval, setTimeout, clearTimeout });
  state.query.data = { servers: [server()], live: true, canReload: true, reconnectScope: "server" };
  state.query.dataUpdatedAt = 0;
  state.query.error = null;
  state.query.isPending = false;
  state.canOperate = true;
  state.localHost = true;
  state.query.refresh.mockReset();
  state.reload
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { status: "reloaded", failedServers: [] } });
  for (const fn of [state.reconnect, state.toggle, state.signIn, state.signOut, state.submit])
    fn.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.open.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps app servers locked and viewers status-only, then dispatches only an explicit row click", async () => {
  const action = vi.fn();
  const rows = (manage: boolean, entries: McpServerStatusEntry[]) => (
    <McpServerRows
      servers={entries}
      canReconnect={manage}
      canManage={manage}
      busy={false}
      onAction={action}
    />
  );
  await act(async () => {
    renderer = create(rows(true, [server({ name: "stark-code", locked: true })]));
  });
  expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  await act(async () => renderer!.update(rows(false, [server()])));
  expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  await act(async () =>
    renderer!.update(rows(true, [server({ source: "codex", status: "disabled" })])),
  );
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  expect(action).toHaveBeenCalledWith(expect.objectContaining({ name: "Drive" }), "enable");
});
it("opens a validated authorization URL on Sign in and validates a pasted callback", async () => {
  state.signIn.mockResolvedValue({
    _tag: "Success",
    value: {
      url: "https://auth.example.com/oauth",
      callbackExpected: true,
      redirectScheme: "localhost",
      callbackPort: 3333,
      state: "expected",
    },
  });
  const panel = () => (
    <McpServersPanel
      environmentId={EnvironmentId.make("env")}
      target={{ threadId: ThreadId.make("thread") }}
    />
  );
  await act(async () => {
    renderer = create(panel());
  });
  const button = (text: string) =>
    renderer!.root.findAllByType("button").find((entry) => entry.children.join("") === text)!;
  await act(async () => button("Sign in").props.onClick());
  expect(state.open).toHaveBeenCalledExactlyOnceWith("https://auth.example.com/oauth");
  expect(
    renderer!.root
      .findAllByType("p")
      .some((entry) => entry.children.join("") === "Opens auth.example.com in your browser."),
  ).toBe(true);
  const input = renderer!.root.findByType("input");
  await act(async () =>
    input.props.onChange({
      target: { value: "http://localhost:3333/callback?code=private&state=wrong" },
    }),
  );
  await act(async () =>
    renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(state.submit).not.toHaveBeenCalled();
  await act(async () =>
    input.props.onChange({
      target: { value: "http://localhost:3333/callback?code=private&state=expected" },
    }),
  );
  await act(async () =>
    renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(state.submit).toHaveBeenCalledWith({
    environmentId: "env",
    input: {
      threadId: "thread",
      name: "Drive",
      url: "http://localhost:3333/callback?code=private&state=expected",
    },
  });
  state.query.data = { servers: [server({ status: "connected" })], live: true, canReload: true };
  await act(async () => renderer!.update(panel()));
  expect(renderer!.root.findAllByType("input")).toHaveLength(0);
});

const panel = (
  threadId = "thread",
  providerKind: "claudeAgent" | "codex" = "codex",
  sessionBusy = false,
) => (
  <McpServersPanel
    environmentId={EnvironmentId.make("env")}
    target={{ threadId: ThreadId.make(threadId) }}
    providerKind={providerKind}
    sessionBusy={sessionBusy}
  />
);
const button = (text: string) => {
  const found = renderer!.root
    .findAllByType("button")
    .find((entry) => entry.children.join("") === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};
const paragraphs = () =>
  renderer!.root
    .findAllByType("p")
    .map((entry) => entry.children.join(""))
    .join("\n");

it.each([
  {
    providerKind: "claudeAgent" as const,
    label: "Reload plugins",
    description: "Applies installed Claude plugin changes for this chat.",
    result: "Claude plugins reloaded.",
  },
  {
    providerKind: "codex" as const,
    label: "Reload MCPs",
    description: "Reloads MCP configuration and connections in the running Codex session.",
    result: "Codex MCP reload requested.",
  },
])(
  "only reloads $providerKind after an explicit click; status checks remain read-only",
  async ({ providerKind, label, description, result }) => {
    await act(async () => {
      renderer = create(panel("thread", providerKind));
    });
    expect(paragraphs()).toContain(description);
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    await act(async () => button("Refresh status").props.onClick());
    expect(state.query.refresh).toHaveBeenCalledTimes(4);
    expect(state.reload).not.toHaveBeenCalled();
    expect(state.reconnect).not.toHaveBeenCalled();
    await act(async () => button(label).props.onClick());
    expect(state.reload).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env",
      input: { threadId: "thread" },
    });
    expect(paragraphs()).toContain(`${result} Connection status updates below.`);
    expect(state.query.refresh).toHaveBeenCalledTimes(5);
    expect(state.toggle).not.toHaveBeenCalled();
    expect(state.signIn).not.toHaveBeenCalled();
  },
);

it.each([
  "read-only",
  "remote",
  "no session",
  "unsupported",
  "older server",
  "status error",
  "active turn",
])("disables reload for %s", async (reason) => {
  if (reason === "read-only") state.canOperate = false;
  if (reason === "remote") state.localHost = false;
  if (reason === "no session") state.query.data = { ...state.query.data!, live: false };
  if (reason === "unsupported") state.query.data = { ...state.query.data!, canReload: false };
  if (reason === "older server") state.query.data = { ...state.query.data!, canReload: undefined };
  if (reason === "status error") state.query.error = "Status unavailable";
  await act(async () => {
    renderer = create(panel("thread", "codex", reason === "active turn"));
  });
  expect(button("Reload MCPs").props.disabled).toBe(true);
  await act(async () => button("Reload MCPs").props.onClick());
  expect(state.reload).not.toHaveBeenCalled();
});

it("keeps conversation reload out of Settings and points to the existing connections menu", async () => {
  state.query.data = { ...state.query.data!, canReload: true };
  await act(async () => {
    renderer = create(
      <McpServersPanel
        environmentId={EnvironmentId.make("env")}
        target={{
          projectId: ProjectId.make("project"),
          providerInstanceId: ProviderInstanceId.make("claude"),
        }}
      />,
    );
  });
  expect(
    renderer!.root.findAllByType("button").some((item) => item.children.join("") === "Reload MCPs"),
  ).toBe(false);
  expect(paragraphs()).toContain("+ → Connectors → Manage connections");
  expect(state.reload).not.toHaveBeenCalled();
});

it("reports partial failure and plugin errors without claiming a successful reload", async () => {
  state.reload.mockResolvedValue({
    _tag: "Success",
    value: { status: "reloaded", failedServers: ["Drive", "Tickets"], pluginErrors: 2 },
  });
  await act(async () => {
    renderer = create(panel("thread", "claudeAgent"));
  });
  await act(async () => button("Reload plugins").props.onClick());
  expect(paragraphs()).toContain("Claude plugin reload reported issues.");
  expect(paragraphs()).toContain("Failed servers: Drive, Tickets.");
  expect(paragraphs()).toContain("2 plugin errors reported.");
  expect(paragraphs()).not.toContain("Claude plugins reloaded.");
  expect(state.query.refresh).toHaveBeenCalledTimes(2);
});

it.each([
  {
    providerKind: "claudeAgent" as const,
    label: "Reload plugins",
    result: "Claude plugins reloaded.",
  },
  { providerKind: "codex" as const, label: "Reload MCPs", result: "Codex MCP reload requested." },
])(
  "waits for explicit $providerKind cache-cost confirmation and cancellation never retries",
  async ({ providerKind, label, result }) => {
    state.reload.mockResolvedValue({
      _tag: "Success",
      value: { status: "confirmation-required", failedServers: [] },
    });
    await act(async () => {
      renderer = create(panel("thread", providerKind));
    });
    await act(async () => button(label).props.onClick());
    expect(paragraphs()).toContain("increase token usage");
    expect(button(label).props.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(state.reload).toHaveBeenCalledTimes(1);
    await act(async () => button("Cancel").props.onClick());
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(paragraphs()).not.toContain("increase token usage");
    await act(async () => button(label).props.onClick());
    state.reload.mockResolvedValueOnce({
      _tag: "Success",
      value: { status: "reloaded", failedServers: [] },
    });
    await act(async () => button("Reload anyway").props.onClick());
    expect(state.reload).toHaveBeenNthCalledWith(3, {
      environmentId: "env",
      input: { threadId: "thread", force: true },
    });
    expect(paragraphs()).toContain(`${result} Connection status updates below.`);
  },
);

it("blocks duplicate same-tick clicks and other actions while reload is held", async () => {
  let finish!: (value: unknown) => void;
  state.reload.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    renderer = create(panel());
  });
  const reloadButton = button("Reload MCPs");
  await act(async () => {
    reloadButton.props.onClick();
    reloadButton.props.onClick();
    button("Sign in").props.onClick();
  });
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect(state.signIn).not.toHaveBeenCalled();
  expect(button("Reload MCPs").props.disabled).toBe(true);
  expect(button("Refresh status").props.disabled).toBe(true);
  await act(async () =>
    finish({ _tag: "Success", value: { status: "reloaded", failedServers: [] } }),
  );
  expect(button("Reload MCPs").props.disabled).toBe(false);
});

it("clears confirmation on target changes and ignores a late result from a previous target", async () => {
  state.reload.mockResolvedValueOnce({
    _tag: "Success",
    value: { status: "confirmation-required", failedServers: [] },
  });
  await act(async () => {
    renderer = create(panel());
  });
  await act(async () => button("Reload MCPs").props.onClick());
  expect(paragraphs()).toContain("increase token usage");
  await act(async () => renderer!.update(panel("next")));
  expect(paragraphs()).not.toContain("increase token usage");
  let finish!: (value: unknown) => void;
  state.reload.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => button("Reload MCPs").props.onClick());
  await act(async () => renderer!.update(panel("last")));
  expect(button("Reload MCPs").props.disabled).toBe(false);
  await act(async () =>
    finish({ _tag: "Success", value: { status: "reloaded", failedServers: ["Old target"] } }),
  );
  expect(paragraphs()).not.toContain("Old target");
  expect(paragraphs()).not.toContain("MCP reload requested.");
  expect(state.reload).toHaveBeenCalledTimes(2);
});

it("reports failed reloads and never retries automatically", async () => {
  state.reload.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => {
    renderer = create(panel());
  });
  await act(async () => button("Reload MCPs").props.onClick());
  await act(async () => {
    vi.advanceTimersByTime(6_000);
  });
  expect(paragraphs()).toContain("Could not reload MCP servers.");
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect(button("Reload MCPs").props.disabled).toBe(false);
});

it.each(["all", undefined] as const)(
  "never offers targeted retries when scope is %s",
  async (scope) => {
    state.query.data = {
      live: true,
      reconnectScope: scope,
      servers: [server({ status: "failed" })],
    };
    await act(async () => {
      renderer = create(panel());
    });
    expect(
      renderer!.root.findAllByType("button").map((entry) => entry.children.join("")),
    ).not.toContain("Reconnect");
    expect(
      renderer!.root.findAllByType("button").map((entry) => entry.children.join("")),
    ).not.toContain("Reconnect failed");
    expect(state.reconnect).not.toHaveBeenCalled();
  },
);

it("retries only failed unlocked servers and blocks mutations during an active turn", async () => {
  state.query.data = {
    live: true,
    reconnectScope: "server",
    servers: [
      server({ name: "failed", status: "failed" }),
      server({ name: "healthy", status: "connected" }),
      server({ name: "starting", status: "connecting" }),
      server({ name: "locked", status: "failed", locked: true }),
    ],
  };
  const content = (sessionBusy: boolean) => (
    <McpServersPanel
      environmentId={EnvironmentId.make("env")}
      target={{ threadId: ThreadId.make("thread") }}
      sessionBusy={sessionBusy}
    />
  );
  await act(async () => {
    renderer = create(content(true));
  });
  expect(button("Reconnect").props.disabled).toBe(true);
  await act(async () => button("Reconnect failed").props.onClick());
  expect(state.reconnect).not.toHaveBeenCalled();
  await act(async () => renderer!.update(content(false)));
  await act(async () => button("Reconnect failed").props.onClick());
  expect(state.reconnect).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { threadId: "thread", name: "failed" },
  });
});

it("keeps inspected project sign-in available while its snapshot is not a live chat", async () => {
  state.query.data = { live: false, servers: [server()] };
  state.signIn.mockResolvedValue({ _tag: "Success", value: { completed: true } });
  await act(async () => {
    renderer = create(
      <McpServersPanel
        environmentId={EnvironmentId.make("env")}
        target={{
          projectId: ProjectId.make("project"),
          providerInstanceId: ProviderInstanceId.make("claude"),
        }}
      />,
    );
  });
  expect(button("Sign in").props.disabled).toBe(false);
  await act(async () => button("Sign in").props.onClick());
  expect(state.signIn).toHaveBeenCalledTimes(1);
  expect(paragraphs()).not.toContain("Send a message");
});

it("rejects unsafe sign-in URLs and ignores a late auth result from a previous target", async () => {
  state.signIn.mockResolvedValueOnce({ _tag: "Success", value: { url: "javascript:alert(1)" } });
  await act(async () => {
    renderer = create(panel());
  });
  await act(async () => button("Sign in").props.onClick());
  expect(paragraphs()).toContain("unsafe sign-in URL");
  expect(state.open).not.toHaveBeenCalled();
  let resolve!: (result: unknown) => void;
  state.signIn.mockReturnValueOnce(
    new Promise((finish) => {
      resolve = finish;
    }),
  );
  await act(async () => button("Sign in").props.onClick());
  await act(async () => renderer!.update(panel("next")));
  await act(async () =>
    resolve({ _tag: "Success", value: { url: "https://auth.example.com/late" } }),
  );
  expect(state.open).not.toHaveBeenCalled();
});

it("offers a status-only retry after a slow inspection and accepts the eventual result", async () => {
  state.query.data = null;
  state.query.isPending = true;
  await act(() => {
    renderer = create(panel());
  });
  expect(paragraphs()).toContain("Checking connected tools");
  await act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(paragraphs()).toContain("Status is taking longer than expected");
  expect(state.query.refresh).not.toHaveBeenCalled();
  await act(() => button("Retry status check").props.onClick());
  expect(state.query.refresh).toHaveBeenCalledOnce();
  expect(paragraphs()).not.toContain("Status is taking longer than expected");
  expect(state.reload).not.toHaveBeenCalled();
  expect(state.reconnect).not.toHaveBeenCalled();
  state.query.data = { servers: [server({ status: "connected" })], live: true };
  state.query.isPending = false;
  await act(() => renderer!.update(panel()));
  expect(paragraphs()).not.toContain("Checking connected tools");
  expect(paragraphs()).toContain("Connected");
});

it("shows the last known tools at once on reopen while a new check runs", async () => {
  const target = "reopened-thread";
  state.query.data = { servers: [server({ status: "connected" })], live: true };
  state.query.dataUpdatedAt = Date.now();
  await act(() => {
    renderer = create(panel(target));
  });
  await act(() => renderer!.unmount());
  state.query.data = null;
  state.query.dataUpdatedAt = 0;
  state.query.isPending = true;
  await act(() => {
    renderer = create(panel(target));
  });

  expect(paragraphs()).not.toContain("Checking connected tools");
  expect(paragraphs()).toContain("Refreshing…");
  expect(paragraphs()).toContain("Connected");
  // Last known rows are for reading; actions wait for the new answer.
  expect(button("Disable for this project").props.disabled).toBe(true);

  state.query.data = { servers: [server({ status: "failed" })], live: true };
  state.query.dataUpdatedAt = Date.now() + 1;
  state.query.isPending = false;
  await act(() => renderer!.update(panel(target)));
  expect(paragraphs()).not.toContain("Refreshing…");
  expect(paragraphs()).toContain("Failed");
});
