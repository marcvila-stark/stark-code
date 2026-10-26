// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { DesktopBridge } from "@starkfuture/contracts";

vi.mock("~/hooks/usePreviewPanelInlineSize", () => ({
  usePreviewPanelInlineSize: () => ({ width: 540, handlers: {} }),
}));
vi.mock("./StarkPagesSidebar", () => ({
  StarkPagesSidebar: ({
    onPageChange,
  }: {
    onPageChange?: (page: { kind: "local"; slug: string; title: string }) => void;
  }) => (
    <>
      <iframe title="Workspace page" sandbox="allow-same-origin" />
      <button
        onClick={() => onPageChange?.({ kind: "local", slug: "review-page", title: "Review page" })}
      >
        Show folder page
      </button>
    </>
  ),
}));
vi.mock("./PublishedStarkPages", () => ({
  PublishedStarkPages: () => {
    const [page, setPage] = useState(false);
    return page ? (
      <iframe title="Selected published page" sandbox="allow-same-origin" />
    ) : (
      <button onClick={() => setPage(true)}>Read project home</button>
    );
  },
}));
vi.mock("./PagesWebsiteView", () => ({
  PagesWebsiteView: ({ active, onOpenLibrary }: { active: boolean; onOpenLibrary: () => void }) => {
    const [page, setPage] = useState("Home");
    return (
      <div data-native-website data-active={active}>
        <button onClick={() => setPage("Saved page")}>Visit website page</button>
        <p>{page}</p>
        <button onClick={onOpenLibrary}>Use connected library</button>
      </div>
    );
  },
}));
import { StarkPagesPanel } from "./StarkPagesPanel";

let root: Root;
let container: HTMLDivElement;
const close = vi.fn();
const openPage = vi.fn();
const render = (inline = true, active = true, tabs = false) =>
  act(() =>
    root.render(
      <StarkPagesPanel
        inline={inline}
        active={active}
        projectRoot="/project"
        agent="claude"
        canPublish={false}
        onPublishRequest={vi.fn()}
        onClose={close}
        onOpenPage={tabs ? openPage : undefined}
      />,
    ),
  );
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (!element) throw new Error(`Missing ${label}`);
  return element;
};
const click = (label: string) => act(() => button(label).click());
const chooseSource = async (label: "Company pages" | "Local pages") => {
  await click("Choose Pages source");
  const item = document.querySelector<HTMLElement>(`[role="menuitemradio"][aria-label="${label}"]`);
  if (!item) throw new Error(`Missing source: ${label}`);
  await act(() => item.click());
};
const escape = () =>
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  close.mockReset();
  openPage.mockReset();
  window.localStorage.clear();
  delete window.desktopBridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});

it("preserves the workspace iframe and scroll state through full view and responsive docking", async () => {
  await render();
  await chooseSource("Local pages");
  const frame = container.querySelector('iframe[title="Workspace page"]')! as HTMLIFrameElement;
  const frameWindow = frame.contentWindow;
  frame.contentDocument!.body.innerHTML = '<main style="height:2000px">A workspace page</main>';
  frame.contentDocument!.documentElement.scrollTop = 280;
  await click("Expand Pages");
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(frameWindow);
  expect(frame.contentDocument!.documentElement.scrollTop).toBe(280);
  expect(container.querySelector('[data-pages-expanded="true"]')).not.toBeNull();
  await render(false);
  await click("Return Pages to side panel");
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.contentDocument!.body.textContent).toBe("A workspace page");
  await render(true);
  expect(container.querySelector("iframe")).toBe(frame);
  expect(close).not.toHaveBeenCalled();
  await click("Close Pages");
  expect(close).toHaveBeenCalledOnce();
});

it("keeps the published selection and restores the panel on Escape instead of closing Pages", async () => {
  await render();
  await click("Read project home");
  const frame = container.querySelector("iframe")!;
  await click("Expand Pages");
  await act(() => container.querySelector<HTMLElement>("[data-pages-expanded]")!.focus());
  await escape();
  expect(container.querySelector('[data-pages-expanded="true"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(container.querySelector('iframe[title="Selected published page"]')).toBe(frame);
  expect(document.activeElement).toBe(button("Expand Pages"));
  await render(false);
  expect(container.querySelector('iframe[title="Selected published page"]')).toBe(frame);
  await act(() => container.querySelector<HTMLElement>("[data-pages-expanded]")!.focus());
  await escape();
  expect(close).toHaveBeenCalledOnce();
});

it("keeps both visited sources and their reading positions, and remembers the selected source", async () => {
  await render();
  await click("Read project home");
  const published = container.querySelector<HTMLIFrameElement>(
    'iframe[title="Selected published page"]',
  )!;
  published.contentDocument!.documentElement.scrollTop = 180;
  await chooseSource("Local pages");
  const local = container.querySelector<HTMLIFrameElement>('iframe[title="Workspace page"]')!;
  local.contentDocument!.documentElement.scrollTop = 90;
  expect(published.closest("[hidden]")).not.toBeNull();
  await chooseSource("Company pages");
  expect(container.querySelector('iframe[title="Selected published page"]')).toBe(published);
  expect(published.contentDocument!.documentElement.scrollTop).toBe(180);
  expect(published.closest("[hidden]")).toBeNull();
  await chooseSource("Local pages");
  expect(container.querySelector('iframe[title="Workspace page"]')).toBe(local);
  expect(local.contentDocument!.documentElement.scrollTop).toBe(90);
  await act(() => root.render(null));
  await render();
  expect(button("Choose Pages source").textContent).toBe("Local pages");
  expect(container.querySelector('iframe[title="Workspace page"]')).not.toBeNull();
  expect(container.querySelector('iframe[title="Selected published page"]')).toBeNull();
});

it("dismisses the source menu with Escape before leaving full view", async () => {
  await render();
  await click("Expand Pages");
  await click("Choose Pages source");
  await act(() => document.querySelector<HTMLElement>('[role="menuitemradio"]')!.focus());
  await escape();
  expect(container.querySelector('[data-pages-expanded="true"]')).not.toBeNull();
  expect(close).not.toHaveBeenCalled();
  await act(() => container.querySelector<HTMLElement>("[data-pages-expanded]")!.focus());
  await escape();
  expect(container.querySelector('[data-pages-expanded="true"]')).toBeNull();
});

it("retains the selected page while another panel is active and releases modal focus", async () => {
  await render(false);
  await click("Read project home");
  const frame = container.querySelector<HTMLIFrameElement>("iframe")!;
  frame.contentDocument!.documentElement.scrollTop = 220;
  await click("Expand Pages");
  await render(false, false);
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.closest("[hidden]")).not.toBeNull();
  expect(document.querySelector('[data-pages-overlay="true"]')).toBeNull();
  const otherTool = document.createElement("button");
  document.body.append(otherTool);
  await act(() => otherTool.focus());
  expect(document.activeElement).toBe(otherTool);
  await escape();
  expect(close).not.toHaveBeenCalled();
  await render(true, true);
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.contentDocument!.documentElement.scrollTop).toBe(220);
  expect(frame.closest("[hidden]")).toBeNull();
  expect(container.querySelector('[data-pages-expanded="true"]')).toBeNull();
  expect(container.querySelector('[data-pages-overlay="true"]')).toBeNull();
  await click("Expand Pages");
  expect(container.querySelector('[data-pages-expanded="true"]')).not.toBeNull();
  otherTool.remove();
});

it("expands the current local panel without silently opening another workspace tab", async () => {
  await render(true, true, true);
  await chooseSource("Local pages");
  await click("Show folder page");
  expect(openPage).not.toHaveBeenCalled();
  await click("Expand Pages");
  expect(openPage).not.toHaveBeenCalled();
  expect(container.querySelector('[data-pages-expanded="true"]')).not.toBeNull();
  await act(() => window.dispatchEvent(new Event("starkcode:auxiliary-panel-toggle-expanded")));
  expect(container.querySelector('[data-pages-expanded="true"]')).toBeNull();
  expect(openPage).not.toHaveBeenCalled();
});

it("opens the real website on desktop and keeps it while switching between full view, local pages and the connected library", async () => {
  window.desktopBridge = { pagesWebsite: {} } as DesktopBridge;
  await render();
  const website = container.querySelector<HTMLElement>("[data-native-website]")!;
  expect(website).not.toBeNull();
  expect(container.textContent).not.toContain("Read project home");
  await click("Visit website page");
  await click("Expand Pages");
  expect(container.querySelector("[data-native-website]")).toBe(website);
  expect(website.textContent).toContain("Saved page");
  await click("Return Pages to side panel");
  await chooseSource("Local pages");
  expect(website.dataset.active).toBe("false");
  await chooseSource("Company pages");
  expect(website.dataset.active).toBe("true");
  await click("Use connected library");
  expect(website.dataset.active).toBe("false");
  await click("Read project home");
  const library = container.querySelector('iframe[title="Selected published page"]');
  await click("Show Pages website");
  expect(website.dataset.active).toBe("true");
  expect(website.textContent).toContain("Saved page");
  await click("Use connected library");
  expect(container.querySelector('iframe[title="Selected published page"]')).toBe(library);
});
