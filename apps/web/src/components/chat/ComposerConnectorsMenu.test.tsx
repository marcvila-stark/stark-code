import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type McpServersListResult,
} from "@starkfuture/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  query: {
    data: null as McpServersListResult | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  list: vi.fn(),
  queryInput: vi.fn(),
  toggle: vi.fn(),
  allowed: true,
  localHost: true,
  electron: true,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    mcpServers: state.list,
    setMcpServerEnabled: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    state.queryInput(input);
    return input === null ? { ...state.query, data: null } : state.query;
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.toggle }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    presentation: {
      entry: {
        target: {
          _tag: "PrimaryConnectionTarget",
          httpBaseUrl: state.localHost ? "http://localhost:3773" : "https://remote.example.test",
        },
      },
    },
  }),
}));
vi.mock("../../env", () => ({
  get isElectron() {
    return state.electron;
  },
}));
vi.mock("./McpServersPanel", () => ({
  McpServersPanel: ({ target }: { target: { projectId?: string; threadId?: string } }) => (
    <section data-target={target.threadId ?? target.projectId}>Full connection controls</section>
  ),
}));
vi.mock("../ui/menu", () => ({
  MenuSubPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  MenuCheckboxItem: ({
    children,
    checked,
    disabled,
    onCheckedChange,
    "aria-label": label,
  }: {
    children: ReactNode;
    checked: boolean;
    disabled: boolean;
    onCheckedChange: (checked: boolean) => void;
    "aria-label": string;
  }) => (
    <button
      role="menuitemcheckbox"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      {children}
    </button>
  ),
  MenuSeparator: () => <hr />,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogPanel: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

import { ComposerConnectionsDialog, ComposerConnectorsMenu } from "./ComposerConnectorsMenu";

const inspectionTarget = {
  projectId: ProjectId.make("project"),
  providerInstanceId: ProviderInstanceId.make("claude"),
};
const props = {
  environmentId: EnvironmentId.make("local"),
  target: { threadId: ThreadId.make("thread") },
  inspectionTarget,
  providerKind: "claudeAgent" as const,
  providerLabel: "Claude",
};
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  state.query.data = {
    live: true,
    servers: [
      {
        name: "Pages",
        source: "project",
        status: "connected",
        tools: [],
        authKind: "oauth",
        locked: false,
      },
      {
        name: "Off",
        source: "project",
        status: "disabled",
        tools: [],
        authKind: "none",
        locked: false,
      },
      { name: "stark-code", status: "connected", tools: [], authKind: "none", locked: true },
    ],
  };
  state.query.error = null;
  state.query.refresh.mockReset();
  state.list.mockReset().mockReturnValue("mcp-query");
  state.queryInput.mockReset();
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.allowed = true;
  state.localHost = true;
  state.electron = true;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const toggles = () => renderer!.root.findAllByProps({ role: "menuitemcheckbox" });
const text = () => JSON.stringify(renderer!.toJSON());
async function render(open = true) {
  await act(async () => {
    renderer = create(<ComposerConnectorsMenu {...props} open={open} onManage={vi.fn()} />);
  });
}

it("reads only while open and never polls an idle composer", async () => {
  await render(false);
  expect(state.list).not.toHaveBeenCalled();
  expect(state.queryInput).toHaveBeenLastCalledWith(null);
  expect(state.query.refresh).not.toHaveBeenCalled();
  await act(async () => {
    renderer!.update(<ComposerConnectorsMenu {...props} open onManage={vi.fn()} />);
  });
  expect(state.list).toHaveBeenCalledWith({ environmentId: "local", input: props.target });
  expect(state.query.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(state.query.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer!.update(<ComposerConnectorsMenu {...props} open={false} onManage={vi.fn()} />);
    vi.advanceTimersByTime(30_000);
  });
  expect(state.queryInput).toHaveBeenLastCalledWith(null);
  expect(state.query.refresh).toHaveBeenCalledTimes(1);
  expect(state.toggle).not.toHaveBeenCalled();
});

it("leaves project connections unchecked until the user explicitly asks to inspect", async () => {
  const manage = vi.fn();
  await act(async () => {
    renderer = create(
      <ComposerConnectorsMenu {...props} target={inspectionTarget} open onManage={manage} />,
    );
  });
  expect(state.list).not.toHaveBeenCalled();
  expect(state.query.refresh).not.toHaveBeenCalled();
  expect(text()).toContain("Connections have not been checked.");
  expect(text()).not.toContain("0 configured");
  expect(toggles()).toHaveLength(0);
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(manage).toHaveBeenCalledExactlyOnceWith(inspectionTarget);
  expect(state.toggle).not.toHaveBeenCalled();
});

it("offers project inspection for an inactive thread without claiming no connections exist", async () => {
  state.query.data = { live: false, servers: [] };
  const manage = vi.fn();
  await act(async () => {
    renderer = create(<ComposerConnectorsMenu {...props} open onManage={manage} />);
  });
  expect(text()).toContain("Connection status unavailable · Session not running");
  expect(text()).toContain("Inspect project connections");
  expect(text()).not.toContain("0 configured");
  expect(text()).not.toContain("No connections reported");
  expect(state.list).toHaveBeenCalledWith({ environmentId: "local", input: props.target });
  expect(state.list.mock.calls.every(([input]) => input.input.threadId === "thread")).toBe(true);
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(manage).toHaveBeenCalledExactlyOnceWith(inspectionTarget);
});

it("reports an empty list only when a live provider actually returned one", async () => {
  state.query.data = { live: true, servers: [] };
  await render();
  expect(text()).toContain("0 configured · Current provider status");
  expect(text()).toContain("No connections reported");
  expect(text()).not.toContain("Session not running");
});

it.each(["remote", "browser"])(
  "does not offer project inspection from a %s client",
  async (client) => {
    if (client === "remote") state.localHost = false;
    else state.electron = false;
    const manage = vi.fn();
    await act(async () => {
      renderer = create(
        <ComposerConnectorsMenu {...props} target={inspectionTarget} open onManage={manage} />,
      );
    });
    expect(state.list).not.toHaveBeenCalled();
    expect(text()).toContain("Manage connections on the desktop host.");
    expect(text()).not.toContain("Inspect to load");
    const inspect = renderer!.root.findByType("button");
    expect(inspect.props.disabled).toBe(true);
    await act(async () => inspect.props.onClick());
    expect(manage).not.toHaveBeenCalled();
  },
);

it("toggles the selected provider target only after an explicit click and never offers a locked toggle", async () => {
  await render();
  expect(toggles()).toHaveLength(2);
  expect(state.toggle).not.toHaveBeenCalled();
  await act(async () => {
    await toggles()[0]!.props.onClick();
  });
  expect(state.toggle).toHaveBeenCalledExactlyOnceWith({
    environmentId: "local",
    input: { ...props.target, name: "Pages", enabled: false },
  });
  expect(text()).toContain("Changes apply to Claude connections for this project.");
  expect(text()).toContain("Required by Stark Code");
  expect(state.query.refresh).toHaveBeenCalledTimes(2);
});

it.each(["permission", "remote", "browser", "not-live", "status-error"])(
  "keeps %s connections read-only",
  async (reason) => {
    if (reason === "permission") state.allowed = false;
    if (reason === "remote") state.localHost = false;
    if (reason === "browser") state.electron = false;
    if (reason === "not-live") state.query.data = { ...state.query.data!, live: false };
    if (reason === "status-error") state.query.error = "Unavailable";
    await render();
    expect(toggles()).toHaveLength(0);
    expect(state.toggle).not.toHaveBeenCalled();
    if (reason === "not-live") {
      expect(text()).toContain("Session not running");
      expect(text()).not.toContain('"Connected"');
      expect(text()).toContain("Configured · status unavailable");
    }
  },
);

it("routes failed and signed-out servers to management instead of silently reconnecting or toggling", async () => {
  state.query.data = {
    ...state.query.data!,
    servers: state.query.data!.servers.map((server, index) => ({
      ...server,
      status: index === 0 ? "failed" : "needs-auth",
    })),
  };
  const manage = vi.fn();
  await act(async () => {
    renderer = create(<ComposerConnectorsMenu {...props} open onManage={manage} />);
  });
  expect(toggles()).toHaveLength(0);
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Manage Pages" }).props.onClick(),
  );
  expect(manage).toHaveBeenCalledExactlyOnceWith(props.target);
  expect(state.toggle).not.toHaveBeenCalled();
});

it("reports a rejected toggle, prevents duplicate clicks, and permits another attempt", async () => {
  let finish!: (result: { _tag: string }) => void;
  state.toggle.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  const toggle = toggles()[0]!;
  await act(async () => {
    toggle.props.onClick();
    toggle.props.onClick();
  });
  expect(state.toggle).toHaveBeenCalledOnce();
  expect(toggles().every((item) => item.props.disabled)).toBe(true);
  await act(async () => finish({ _tag: "Failure" }));
  expect(text()).toContain("Could not change this connection.");
  expect(toggles().every((item) => !item.props.disabled)).toBe(true);
  await act(async () => toggles()[0]!.props.onClick());
  expect(state.toggle).toHaveBeenCalledTimes(2);
});

it("does not leak a previous provider's late result into the newly selected provider", async () => {
  let finish!: (result: { _tag: string }) => void;
  state.toggle.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await act(async () => toggles()[0]!.props.onClick());
  state.query.data = { live: true, servers: [] };
  await act(async () => {
    renderer!.update(
      <ComposerConnectorsMenu
        {...props}
        providerKind="codex"
        providerLabel="Codex"
        target={{ threadId: ThreadId.make("codex-thread") }}
        open
        onManage={vi.fn()}
      />,
    );
  });
  await act(async () => finish({ _tag: "Failure" }));
  expect(text()).not.toContain("Could not change this connection.");
  expect(text()).toContain("Changes apply to Codex settings, including other Codex sessions.");
  expect(text()).not.toContain('"Pages"');
});

it("mounts full management only while its separate dialog is open", async () => {
  await act(async () => {
    renderer = create(<ComposerConnectionsDialog {...props} open={false} onOpenChange={vi.fn()} />);
  });
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
  await act(async () => {
    renderer!.update(<ComposerConnectionsDialog {...props} open onOpenChange={vi.fn()} />);
  });
  expect(renderer!.root.findByType("section").props["data-target"]).toBe("thread");
  expect(text()).toContain("claude mcp add");
  await act(async () => {
    renderer!.update(<ComposerConnectionsDialog {...props} open={false} onOpenChange={vi.fn()} />);
  });
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
});
