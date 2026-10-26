// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@starkfuture/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@starkfuture/contracts/settings";
import { nextTerminalAttachSeedState } from "@starkfuture/client-runtime/state/terminal";

const state = vi.hoisted(() => ({
  selected: true,
  clearSelection: vi.fn(),
  focus: vi.fn(),
  write: vi.fn(),
  menu: vi.fn(),
  select: undefined as (() => void) | undefined,
  input: { readOnly: false, value: "unfinished CLI command" },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: state.menu, close: vi.fn() } }),
}));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: "open" } }));
vi.mock("../state/terminal", () => ({ terminalEnvironment: { resize: "resize", write: "write" } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.write }));
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/terminalSessions", () => ({
  useAttachedTerminalSession: () => ({
    ...nextTerminalAttachSeedState(),
    status: "running",
    version: 1,
    error: null,
  }),
}));
vi.mock("../lib/selectionActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/selectionActions")>()),
  observeSelectionActions: ({ onSelection }: { onSelection: (pointer: null) => void }) => {
    state.select = () => onSelection(null);
    return { pending: false, cancel: vi.fn(), dispose: vi.fn() };
  },
}));
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: {
    create: async () => ({
      input: state.input,
      setVisible: vi.fn(),
      setTheme: vi.fn(),
      setFont: vi.fn(),
      refreshLinkActivation: vi.fn(),
      resendSize: vi.fn(),
      fit: vi.fn(),
      isAtBottom: () => true,
      scrollToBottom: vi.fn(),
      dispose: vi.fn(),
      hasSelection: () => state.selected,
      getSelection: () => "selected native output",
      getSelectionPosition: () => ({ start: { x: 0, y: 2 }, end: { x: 22, y: 2 } }),
      getSelectionEndClientRect: () => new DOMRect(20, 30, 140, 20),
      clearSelection: state.clearSelection,
      focus: state.focus,
    }),
  },
}));

import { TerminalViewport } from "./ThreadTerminalDrawer";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  state.selected = true;
  state.select = undefined;
  state.input.value = "unfinished CLI command";
  state.clearSelection.mockReset().mockImplementation(() => {
    state.selected = false;
  });
  state.focus.mockReset();
  state.write.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.menu.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["claude", "codex"])(
  "retains a rejected %s selection for retry, then clears it only after successful insertion",
  async (provider) => {
    let choose: ((action: string) => void) | undefined;
    state.menu.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        }),
    );
    const insert = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const threadRef = {
      environmentId: EnvironmentId.make("quote-test"),
      threadId: ThreadId.make("thread"),
    };
    await act(async () =>
      root.render(
        <TerminalViewport
          advancedTypography={false}
          threadRef={threadRef}
          threadId={threadRef.threadId}
          terminalId={`native-agent-${provider}`}
          terminalLabel={`${provider} native shell`}
          cwd="/work"
          providerInstanceId={ProviderInstanceId.make(provider)}
          agentShell
          onSessionExited={vi.fn()}
          onAddTerminalContext={insert}
          focusRequestId={0}
          autoFocus={false}
          visible
          resizeEpoch={0}
          drawerHeight={200}
          keybindings={[]}
        />,
      ),
    );
    expect(state.select).toBeDefined();
    await act(() => state.select?.());
    expect(state.menu.mock.calls[0]?.[0]).toEqual([
      { id: "add-to-chat", label: "Quote in chat" },
      { id: "copy", label: "Copy" },
    ]);
    await act(async () => choose?.("add-to-chat"));
    expect(insert).toHaveBeenCalledExactlyOnceWith({
      terminalId: `native-agent-${provider}`,
      terminalLabel: `${provider} native shell`,
      lineStart: 3,
      lineEnd: 3,
      text: "selected native output",
    });
    expect(state.selected).toBe(true);
    expect(state.clearSelection).not.toHaveBeenCalled();
    expect(state.focus).not.toHaveBeenCalled();

    await act(() => state.select?.());
    await act(async () => choose?.("add-to-chat"));
    expect(insert).toHaveBeenCalledTimes(2);
    expect(state.clearSelection).toHaveBeenCalledOnce();
    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.input.value).toBe("unfinished CLI command");
    expect(state.write).not.toHaveBeenCalled();
  },
);
