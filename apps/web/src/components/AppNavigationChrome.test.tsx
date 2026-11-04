// @vitest-environment jsdom
import { act, cloneElement, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pathname: "/draft/fresh",
  params: { draftId: "fresh" } as Record<string, string>,
  composer: null as Record<string, unknown> | null,
  draft: {
    environmentId: "local",
    projectId: "scratch",
    worktreePath: null,
    title: undefined as string | undefined,
  },
  configs: new Map(),
  history: {
    location: { state: { __TSR_index: 0 } },
    subscribe: () => () => {},
    back: vi.fn(),
    forward: vi.fn(),
  },
}));
const signal = vi.hoisted(() => {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: () => version,
    notify: () => {
      version += 1;
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("@tanstack/react-router", () => ({
  useParams: ({ select }: { select: (params: Record<string, string>) => unknown }) => {
    useSyncExternalStore(signal.subscribe, signal.read);
    return select(state.params);
  },
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) => {
    useSyncExternalStore(signal.subscribe, signal.read);
    return select({ pathname: state.pathname });
  },
  useRouter: () => ({ history: state.history }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) => {
    useSyncExternalStore(signal.subscribe, signal.read);
    return select({
      getDraftSession: () => state.draft,
      getComposerDraft: () => state.composer,
    });
  },
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => null,
  useThreadShells: () => [],
  useProjects: () => [],
  useServerConfigs: () => state.configs,
}));
vi.mock("../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("./sidebar/SidebarChrome", () => ({ SidebarAccounts: () => null }));
vi.mock("./ui/sidebar", () => ({
  useSidebar: () => ({ toggleSidebar: vi.fn(), open: true, isMobile: false, openMobile: false }),
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));

import { AppTopBar } from "./AppNavigationChrome";
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.pathname = "/draft/fresh";
  state.params = { draftId: "fresh" };
  state.composer = null;
  state.draft.title = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("labels a fresh projectless draft New chat before a composer record exists", async () => {
  await act(() => root.render(<AppTopBar />));
  expect(host.textContent).toBe("New chat");
  expect(host.textContent).not.toContain("Home");
});

it("shows the typed draft title and returns to New chat when the message is cleared", async () => {
  state.composer = {
    prompt: "Review the release",
    activeProvider: "codex",
    shellMode: false,
    images: [],
    persistedAttachments: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  };
  await act(() => root.render(<AppTopBar />));
  expect(host.textContent).toBe("Review the release");
  state.composer = { ...state.composer, prompt: "" };
  await act(() => signal.notify());
  expect(host.textContent).toBe("New chat");
});

it("uses Home only on the home route, not while a chat record is loading", async () => {
  state.pathname = "/local/chat";
  state.params = { environmentId: "local", threadId: "chat" };
  await act(() => root.render(<AppTopBar />));
  expect(host.textContent).toBe("Chat");
  state.pathname = "/";
  state.params = {};
  await act(() => signal.notify());
  expect(host.textContent).toBe("Home");
});

it("keeps an explicit capture draft title while its composer loads and changes", async () => {
  state.draft.title = "Image research fixture";
  await act(() => root.render(<AppTopBar />));
  expect(host.textContent).toBe("Image research fixture");

  state.composer = {
    prompt: "",
    activeProvider: "codex",
    shellMode: false,
    images: [{}],
    persistedAttachments: [{}],
    files: [],
    terminalContexts: [],
    previewAnnotations: [{}],
    reviewComments: [],
    threadContexts: [],
  };
  await act(() => signal.notify());
  expect(host.textContent).toBe("Image research fixture");
  expect(host.textContent).not.toContain("2 attachments");

  state.composer = { ...state.composer, prompt: "A different user message." };
  await act(() => signal.notify());
  expect(host.textContent).toBe("Image research fixture");
});
