// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { StarkPublishedPageDocument, StarkPublishedPagesStatus } from "@starkfuture/contracts";

vi.mock("./PublishedPageContent", () => ({
  PublishedPageContent: ({
    document,
    onNavigate,
  }: {
    document: StarkPublishedPageDocument;
    onNavigate: (path: string) => void;
  }) => (
    <article>
      {document.source}
      <button onClick={() => onNavigate("related/index.html")}>Related page</button>
    </article>
  ),
}));
vi.mock("./StarkPagesSidebar", () => ({ StarkPagesSidebar: () => <div>Local page</div> }));
import { StarkPageTabContent } from "./StarkPageTabContent";

let root: Root;
let container: HTMLDivElement;
let status: StarkPublishedPagesStatus;
let ticks: Set<() => void>;
const openPage = vi.fn();
const connect = vi.fn();
const getStatus = vi.fn();
const onNavigate = vi.fn();
const page = {
  kind: "published" as const,
  root: "team/release",
  path: "launch/index.html",
  title: "Launch plan",
};
const document: StarkPublishedPageDocument = {
  root: page.root,
  path: page.path,
  source: "A private launch plan",
  mimeType: "text/html",
  assets: [],
  warnings: [],
  publicUrl: null,
};
const render = (active = true, target = page) =>
  act(() =>
    root.render(
      <StarkPageTabContent
        page={target}
        active={active}
        projectRoot="/project"
        agent="claude"
        canPublish={false}
        onPublishRequest={vi.fn()}
        onNavigate={onNavigate}
      />,
    ),
  );
const button = (label: string) => {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
};
const click = (label: string) => act(() => button(label).click());
const tick = () =>
  act(async () => {
    for (const check of ticks) check();
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ticks = new Set();
  status = { state: "connected", message: null };
  for (const mock of [openPage, connect, onNavigate, getStatus]) mock.mockReset();
  getStatus.mockImplementation(async () => status);
  openPage.mockResolvedValue(document);
  connect.mockImplementation(async () => (status = { state: "connecting", message: null }));
  window.desktopBridge = {
    publishedPages: { status: getStatus, openPage, connect },
  } as unknown as NonNullable<Window["desktopBridge"]>;
  vi.spyOn(window, "setInterval").mockImplementation(((callback: () => void) => {
    ticks.add(callback);
    return callback;
  }) as unknown as typeof window.setInterval);
  vi.spyOn(window, "clearInterval").mockImplementation(((callback: () => void) => {
    ticks.delete(callback);
  }) as unknown as typeof window.clearInterval);
  container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  expect(ticks.size).toBe(0);
  delete window.desktopBridge;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("restores the saved connection before offering sign-in in a full page tab", async () => {
  let finish!: (value: StarkPublishedPagesStatus) => void;
  getStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  expect(container.textContent).toContain("Restoring Pages connection");
  expect(container.textContent).not.toContain("Continue in browser");
  expect(openPage).not.toHaveBeenCalled();
  await act(() => finish({ state: "connected", message: null }));
  expect(container.textContent).toContain("A private launch plan");
  expect(connect).not.toHaveBeenCalled();
});

it("offers a connection retry for storage errors and a browser only when signed out", async () => {
  status = { state: "error", message: "Could not restore the saved connection." };
  await render();
  expect(container.textContent).toContain("Retry connection");
  expect(container.textContent).not.toContain("Continue in browser");
  connect.mockImplementationOnce(async () => (status = { state: "connected", message: null }));
  await click("Retry connection");
  await tick();
  expect(container.textContent).toContain("A private launch plan");
  status = { state: "signed-out", message: "Your Pages sign-in has expired." };
  await tick();
  expect(container.textContent).toContain("Continue in browser");
  expect(container.textContent).not.toContain("Retry connection");
});

it("retains a page across tab switches and opens related pages only from the active view", async () => {
  await render();
  expect(openPage).toHaveBeenCalledExactlyOnceWith({
    root: page.root,
    path: page.path,
    refresh: false,
  });
  const content = container.querySelector("article");
  await click("Related page");
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith({
    kind: "published",
    root: page.root,
    path: "related/index.html",
    title: "related",
  });
  await render(false);
  await click("Related page");
  expect(onNavigate).toHaveBeenCalledTimes(1);
  await render(true);
  expect(container.querySelector("article")).toBe(content);
  expect(openPage).toHaveBeenCalledOnce();
});

it("keeps the page during a failed refresh and retries without a second tab", async () => {
  await render();
  openPage.mockRejectedValueOnce(new Error("Page unavailable"));
  await click("Refresh page");
  expect(container.textContent).toContain("Page unavailable");
  expect(container.textContent).toContain("A private launch plan");
  openPage.mockResolvedValueOnce({ ...document, source: "Updated plan" });
  await click("Retry page");
  expect(container.textContent).toContain("Updated plan");
  expect(container.textContent).not.toContain("Page unavailable");
  expect(onNavigate).not.toHaveBeenCalled();
});

it("clears a hidden private page on sign-out and discards its late refresh", async () => {
  await render();
  let finish!: (value: StarkPublishedPageDocument) => void;
  openPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Refresh page");
  await render(false);
  status = { state: "signed-out", message: null };
  await tick();
  await act(() => finish(document));
  await render(true);
  expect(container.textContent).not.toContain("A private launch plan");
  expect(container.textContent).toContain("Continue in browser");
  expect(connect).not.toHaveBeenCalled();
  await click("Continue in browser");
  expect(connect).toHaveBeenCalledOnce();
  status = { state: "connected", message: null };
  await tick();
  expect(container.textContent).toContain("A private launch plan");
  expect(openPage).toHaveBeenCalledTimes(3);
});

it("does not read signed-out Pages or display content returned for another page", async () => {
  status = { state: "signed-out", message: null };
  await render();
  expect(openPage).not.toHaveBeenCalled();
  status = { state: "connected", message: null };
  openPage.mockResolvedValueOnce({ ...document, root: "other/private" });
  await tick();
  expect(container.textContent).toContain("Pages returned a different page");
  expect(container.textContent).not.toContain("A private launch plan");
});

it.each([
  { ...page, path: "next/index.html", title: "Next plan" },
  { ...page, root: "another/project", title: "Other project plan" },
])("clears the old document and browser link when navigating to $root/$path", async (next) => {
  openPage.mockResolvedValueOnce({
    ...document,
    publicUrl: "https://pages.starkfuture.com/old-plan",
  });
  await render();
  expect(button("Open in browser")).toBeTruthy();

  let finishOld!: (value: StarkPublishedPageDocument) => void;
  openPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  await click("Refresh page");
  expect(container.textContent).toContain("A private launch plan");

  let finishNext!: (value: StarkPublishedPageDocument) => void;
  openPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishNext = resolve;
      }),
  );
  await render(true, next);
  expect(container.textContent).not.toContain("A private launch plan");
  expect(container.textContent).not.toContain("Open in browser");
  expect(container.textContent).toContain("Opening page");
  await act(() => finishOld({ ...document, source: "Late previous page" }));
  expect(container.textContent).not.toContain("Late previous page");

  await act(() =>
    finishNext({ ...document, root: next.root, path: next.path, source: "The new destination" }),
  );
  expect(container.textContent).toContain("The new destination");
  expect(container.textContent).not.toContain("Open in browser");
});
