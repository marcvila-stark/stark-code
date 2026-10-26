// @vitest-environment jsdom
import type { DesktopBridge } from "@starkfuture/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PagesWebsiteView } from "./PagesWebsiteView";
const localEnvironment = vi.hoisted(() => ({ id: "desktop-local" as string | null }));
vi.mock("./pagesWebsiteEnvironment", () => ({
  usePagesWebsiteEnvironment: () => localEnvironment.id,
}));
vi.mock("./PagesWebsiteImport", () => ({
  PagesWebsiteImport: ({
    onImported,
    onClose,
  }: {
    onImported: () => void;
    onClose: () => void;
  }) => (
    <div role="dialog">
      <button onClick={onImported}>Import test sign-in</button>
      <button onClick={onClose}>Close import</button>
    </div>
  ),
}));

type Bridge = NonNullable<DesktopBridge["pagesWebsite"]>;
type State = Awaited<ReturnType<Bridge["getState"]>>;
const ready: State = {
  url: "https://pages.starkfuture.com/projects/example",
  title: "Example page",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  signInRequired: false,
};

let root: Root;
let container: HTMLDivElement;
let bridge: Bridge;
let stateEvent: Parameters<Bridge["onState"]>[0];
let quoteEvent: Parameters<NonNullable<Bridge["onQuote"]>>[0];
let escapeEvent: Parameters<NonNullable<Bridge["onEscape"]>>[0];
let frames: FrameRequestCallback[];
const quote = vi.fn(() => true);
const escape = vi.fn();
const openLibrary = vi.fn();

const render = (active = true) =>
  act(() =>
    root.render(
      <PagesWebsiteView
        active={active}
        onOpenLibrary={openLibrary}
        onEscape={escape}
        onQuote={quote}
      />,
    ),
  );
const flushFrames = () =>
  act(() => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  });
const viewId = () => vi.mocked(bridge.setBounds).mock.calls[0]![0].viewId;
const click = (label: string) =>
  act(() => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.getAttribute("aria-label") === label || element.textContent === label,
    );
    if (!button) throw new Error(`Missing ${label}`);
    button.click();
  });

beforeEach(() => {
  localEnvironment.id = "desktop-local";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(500, 120, 500, 600),
  );
  bridge = {
    getState: vi.fn().mockResolvedValue(ready),
    setBounds: vi.fn().mockResolvedValue(null),
    hide: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn((callback) => {
      stateEvent = callback;
      return vi.fn();
    }),
    onQuote: vi.fn((callback) => {
      quoteEvent = callback;
      return vi.fn();
    }),
    onEscape: vi.fn((callback) => {
      escapeEvent = callback;
      return vi.fn();
    }),
  };
  window.desktopBridge = { pagesWebsite: bridge, preview: {} } as DesktopBridge;
  quote.mockClear();
  escape.mockClear();
  openLibrary.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("hides and restores its native lease without restarting or navigating the website", async () => {
  await render();
  const owner = viewId();
  expect(bridge.setBounds).toHaveBeenLastCalledWith(
    expect.objectContaining({ viewId: owner, visible: true }),
  );
  await render(false);
  expect(bridge.hide).toHaveBeenCalledWith(owner);
  expect(bridge.setBounds).toHaveBeenLastCalledWith(
    expect.objectContaining({ viewId: owner, visible: false }),
  );
  await render();
  expect(bridge.setBounds).toHaveBeenLastCalledWith(
    expect.objectContaining({ viewId: owner, visible: true }),
  );
  expect(bridge.navigate).not.toHaveBeenCalled();
  await click("Reload Pages website");
  expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith({ viewId: owner, action: "reload" });
});

it("shows an honest sign-in fallback without starting a browser login", async () => {
  await render();
  await act(() => stateEvent({ ...ready, signInRequired: true }));
  expect(container.textContent).toContain(
    "Already signed in in your browser? Import that sign-in, or sign in below.",
  );
  expect(bridge.navigate).not.toHaveBeenCalled();
  await click("Use connected library");
  expect(openLibrary).toHaveBeenCalledOnce();
  await click("Open Pages in main browser");
  expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith({
    viewId: viewId(),
    action: "open-external",
  });
});

it("only quotes explicit selections from the current visible native lease", async () => {
  await render();
  const selected = {
    viewId: viewId(),
    text: "  A heading\r\nA line\u0001  ",
    title: ready.title,
    url: ready.url,
  };
  await act(() => quoteEvent({ ...selected, viewId: "another-chat" }));
  expect(quote).not.toHaveBeenCalled();
  await act(() => quoteEvent(selected));
  expect(quote).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: "A heading\nA line", title: ready.title, url: ready.url }),
  );
  await render(false);
  await act(() => quoteEvent(selected));
  expect(quote).toHaveBeenCalledOnce();
  await act(() => escapeEvent(selected.viewId));
  expect(escape).not.toHaveBeenCalled();
  await render();
  await act(() => escapeEvent("another-chat"));
  expect(escape).not.toHaveBeenCalled();
  await act(() => escapeEvent(selected.viewId));
  expect(escape).toHaveBeenCalledOnce();
});

it("keeps a newer native failure instead of replacing it with a stale initial snapshot", async () => {
  let resolveInitial!: (state: State) => void;
  vi.mocked(bridge.getState).mockReturnValue(
    new Promise((resolve) => {
      resolveInitial = resolve;
    }),
  );
  await render();
  await act(() => stateEvent({ ...ready, error: "Pages is temporarily unavailable." }));
  await act(() => resolveInitial(ready));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Pages is temporarily unavailable.",
  );
  expect(bridge.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
  await click("Try again");
  await act(() => stateEvent(ready));
  await flushFrames();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(bridge.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
});

it("waits for a proven local environment and never creates an unscoped website view", async () => {
  localEnvironment.id = null;
  await render();
  expect(bridge.setBounds).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Waiting for this computer to connect");
  await click("Import sign-in from browser");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  localEnvironment.id = "desktop-local";
  await render();
  expect(bridge.setBounds).toHaveBeenLastCalledWith(
    expect.objectContaining({ environmentId: "desktop-local", visible: true }),
  );
});

it("uncovers the import dialog and returns to Pages home after import instead of reloading an auth form", async () => {
  await render();
  const owner = viewId();
  await click("Import sign-in from browser");
  expect(bridge.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
  await click("Import test sign-in");
  expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith({ viewId: owner, action: "home" });
  await click("Close import");
  expect(bridge.setBounds).toHaveBeenLastCalledWith(
    expect.objectContaining({ visible: true, environmentId: "desktop-local" }),
  );
});

it("keeps a frozen document under an overlapping menu and clears it when the menu closes", async () => {
  await render();
  const image = { viewId: viewId(), dataUrl: "data:image/png;base64,aGVsbG8=" };
  vi.mocked(bridge.setBounds).mockResolvedValue(image);
  const menu = document.createElement("div");
  menu.dataset.slot = "menu-popup";
  await act(() => document.body.append(menu));
  await flushFrames();
  expect(bridge.setBounds).toHaveBeenLastCalledWith(
    expect.objectContaining({ visible: false, captureSnapshot: true }),
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe(image.dataUrl);
  const calls = vi.mocked(bridge.setBounds).mock.calls.length;
  await flushFrames();
  expect(vi.mocked(bridge.setBounds).mock.calls).toHaveLength(calls);
  await act(() => menu.remove());
  await flushFrames();
  expect(container.querySelector("img")).toBeNull();
  expect(bridge.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
  expect(bridge.navigate).not.toHaveBeenCalled();
});

it("discards a capture arriving after the panel is closed", async () => {
  await render();
  const image = { viewId: viewId(), dataUrl: "data:image/png;base64,aGVsbG8=" };
  let finish!: (value: typeof image) => void;
  vi.mocked(bridge.setBounds).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const menu = document.createElement("div");
  menu.dataset.slot = "menu-popup";
  await act(() => document.body.append(menu));
  await flushFrames();
  await render(false);
  await act(() => finish(image));
  expect(container.querySelector("img")).toBeNull();
  await act(() => menu.remove());
  await render();
  expect(container.querySelector("img")).toBeNull();
});
