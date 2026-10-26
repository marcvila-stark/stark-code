// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { StarkPublishedPageDocument, StarkPublishedPagesStatus } from "@starkfuture/contracts";

vi.mock("./PublishedPageCover", () => ({ PublishedPageCover: () => <span aria-hidden /> }));

vi.mock("./PublishedPageContent", () => ({
  PublishedPageContent: ({
    document,
    onNavigate,
  }: {
    document: StarkPublishedPageDocument;
    onNavigate: (path: string) => void;
  }) => (
    <div>
      {document.source}
      <button onClick={() => onNavigate("next/index.html")}>Related page</button>
    </div>
  ),
}));
import { PublishedStarkPages } from "./PublishedStarkPages";

let root: Root;
let container: HTMLDivElement;
let status: StarkPublishedPagesStatus;
let ticks: Set<() => void>;
const read = vi.fn();
const openPage = vi.fn();
const openLink = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const listTools = vi.fn();
const getStatus = vi.fn();
const projects = {
  content: [],
  isError: false,
  structuredContent: {
    projects: [
      {
        root: "release-notes",
        base_url: "https://pages.starkfuture.com/release-notes/",
        file_count: 12,
      },
      { root: "design", base_url: "https://pages.starkfuture.com/design/", file_count: 4 },
    ],
  },
};
const searchResults = {
  content: [],
  isError: false,
  structuredContent: {
    results: [
      {
        root: "release-notes",
        path: "launch/index.html",
        excerpt: { title: "Launch plan", text: "Schedule and owners" },
      },
      {
        root: "release-notes",
        path: "release/index.html",
        excerpt: { title: "Release notes", text: "What changed" },
      },
    ],
  },
};
const document: StarkPublishedPageDocument = {
  root: "release-notes",
  path: "launch/index.html",
  source: "A styled launch plan",
  mimeType: "text/html",
  assets: [],
  warnings: [],
  publicUrl: "https://pages.starkfuture.com/release-notes/launch/",
};
const button = (label: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const click = (label: string) => act(() => button(label).click());
const menuItem = (label: string) => {
  const found = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing menu item: ${label}`);
  return found;
};
const openActions = async () => {
  if (button("Page actions").getAttribute("aria-expanded") !== "true") await click("Page actions");
};
const chooseAction = async (label: string) => {
  await openActions();
  await act(() => menuItem(label).click());
};
const input = async (label: string, value: string) => {
  const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const shown = () => container.textContent;
const tick = () =>
  act(async () => {
    for (const callback of ticks) callback();
  });
const render = (expanded = false) =>
  act(() => root.render(<PublishedStarkPages expanded={expanded} />));
async function selectProject() {
  status = { state: "connected", message: null };
  await render();
  await click("Search in release notes");
}
async function searchPages() {
  await input("Search pages", "launch");
  await click("Search");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = { state: "signed-out", message: null };
  ticks = new Set();
  for (const mock of [read, openPage, openLink, connect, disconnect, listTools, getStatus])
    mock.mockReset();
  getStatus.mockImplementation(async () => status);
  connect.mockImplementation(
    async () => (status = { state: "connecting", message: "Finish sign-in in your browser." }),
  );
  disconnect.mockImplementation(async () => (status = { state: "signed-out", message: null }));
  listTools.mockResolvedValue(
    ["pages_list_projects", "pages_search"].map((name) => ({
      name,
      title: name,
      description: "",
      inputSchema: { type: "object", properties: {} },
    })),
  );
  read.mockImplementation(async ({ tool }: { tool: string }) =>
    tool === "pages_list_projects" ? projects : searchResults,
  );
  openPage.mockResolvedValue(document);
  window.desktopBridge = {
    publishedPages: { status: getStatus, connect, disconnect, listTools, read, openPage },
    openStarkPagesLink: openLink,
  } as unknown as NonNullable<Window["desktopBridge"]>;
  const setInterval = window.setInterval.bind(window);
  const clearInterval = window.clearInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
    if (delay !== 2000) return setInterval(callback, delay);
    ticks.add(callback);
    return callback;
  }) as unknown as typeof window.setInterval);
  vi.spyOn(window, "clearInterval").mockImplementation(((id: number | (() => void)) => {
    if (typeof id === "function") ticks.delete(id);
    else clearInterval(id);
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

it("restores a saved connection before offering browser sign-in", async () => {
  let finish!: (value: StarkPublishedPagesStatus) => void;
  getStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  expect(shown()).toContain("Restoring Pages connection");
  expect(shown()).not.toContain("Continue in browser");
  expect(shown()).not.toContain("Sign in");
  expect(connect).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await act(() => finish({ state: "connected", message: null }));
  expect(shown()).toContain("release notes");
  expect(shown()).not.toContain("Restoring Pages connection");
  expect(connect).not.toHaveBeenCalled();
});

it("retries a restore failure without asking the user to sign in again", async () => {
  getStatus.mockRejectedValueOnce(new Error("IPC unavailable"));
  await render();
  expect(shown()).toContain("Retry connection");
  expect(shown()).not.toContain("Continue in browser");
  let finish!: (value: StarkPublishedPagesStatus) => void;
  connect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Retry connection");
  expect(shown()).toContain("Connecting to Company pages");
  expect(shown()).not.toContain("Continue in browser");
  await act(() => finish({ state: "connected", message: null }));
  expect(shown()).toContain("release notes");
  expect(shown()).not.toContain("Could not check");
});

it("opens browser sign-in only on a click, then presents searchable projects and disconnects", async () => {
  await render();
  expect(connect).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await click("Continue in browser");
  expect(shown()).toContain("Finish sign-in");
  expect(read).not.toHaveBeenCalled();
  status = { state: "connected", message: null };
  await tick();
  expect(read).toHaveBeenCalledExactlyOnceWith({ tool: "pages_list_projects", arguments: {} });
  expect(shown()).toContain("release notes");
  await input("Search pages and projects", "design");
  expect(shown()).not.toContain("release notes");
  expect(shown()).toContain("design");
  await input("Search pages and projects", "absent");
  expect(shown()).toContain("No projects match");
  await chooseAction("Disconnect Pages");
  expect(shown()).not.toContain("design");
  expect(shown()).toContain("Continue in browser");
});

it("opens project home or scoped search results, follows page links and returns to the same results", async () => {
  await selectProject();
  expect(read).toHaveBeenCalledTimes(1);
  expect(button("Search").disabled).toBe(true);
  await searchPages();
  expect(read).toHaveBeenLastCalledWith({
    tool: "pages_search",
    arguments: { root: "release-notes", query: "launch", limit: 20 },
  });
  const panel = container.querySelector<HTMLElement>('section[aria-label="Published Pages"]')!;
  panel.scrollTop = 140;
  await click("Launch planSchedule and ownerslaunch/index.html");
  expect(panel.scrollTop).toBe(0);
  expect(openPage).toHaveBeenLastCalledWith({
    root: "release-notes",
    path: "launch/index.html",
    refresh: false,
  });
  expect(shown()).toContain("A styled launch plan");
  await chooseAction("Open in browser");
  expect(openLink).toHaveBeenCalledExactlyOnceWith(document.publicUrl);
  await click("Related page");
  expect(openPage).toHaveBeenLastCalledWith({
    root: "release-notes",
    path: "next/index.html",
    refresh: false,
  });
  await click("Back to pages");
  expect(panel.scrollTop).toBe(140);
  expect(shown()).toContain("2 results for “launch”");
  expect(container.querySelector<HTMLInputElement>('[aria-label="Search pages"]')?.value).toBe(
    "launch",
  );
  await click("Open project home");
  expect(openPage).toHaveBeenLastCalledWith({
    root: "release-notes",
    path: "index.html",
    refresh: false,
  });
  await chooseAction("All projects");
  expect(shown()).toContain("Your library");
});

it("keeps the filtered library and its scroll position when returning through page actions", async () => {
  status = { state: "connected", message: null };
  await render();
  await input("Search pages and projects", "release");
  const panel = container.querySelector<HTMLElement>('section[aria-label="Published Pages"]')!;
  panel.scrollTop = 180;
  await click("Search in release notes");
  await chooseAction("Open project in browser");
  expect(openLink).toHaveBeenCalledExactlyOnceWith("https://pages.starkfuture.com/release-notes/");
  await click("Open project home");
  await chooseAction("All projects");
  expect(panel.scrollTop).toBe(180);
  expect(
    container.querySelector<HTMLInputElement>('[aria-label="Search pages and projects"]')?.value,
  ).toBe("release");
  expect(shown()).toContain("release notes");
  expect(shown()).not.toContain("design");
});

it("discards a late read after Back and a late search after selecting another project", async () => {
  await selectProject();
  let finishPage: (value: StarkPublishedPageDocument) => void = () => {};
  openPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPage = resolve;
      }),
  );
  await click("Open project home");
  expect(shown()).toContain("Opening page");
  await click("Back to pages");
  await act(() => finishPage(document));
  expect(shown()).not.toContain("A styled launch plan");
  let finishSearch: (value: typeof searchResults) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSearch = resolve;
      }),
  );
  await searchPages();
  await click("Back to library");
  await click("Search in design");
  await act(() => finishSearch(searchResults));
  expect(shown()).not.toContain("Launch plan");
  expect(shown()).toContain("Search by title or topic");
});

it("keeps empty lists useful and supports retrying catalog, search and page failures", async () => {
  status = { state: "connected", message: null };
  read.mockRejectedValueOnce(new Error("Temporarily unavailable"));
  await render();
  expect(shown()).toContain("Temporarily unavailable");
  await click("Retry projects");
  await click("Search in release notes");
  read.mockResolvedValueOnce({ content: [], isError: false, structuredContent: { results: [] } });
  await searchPages();
  expect(shown()).toContain("No pages match “launch”");
  read.mockRejectedValueOnce(new Error("Search failed"));
  await click("Search");
  await click("Retry search");
  expect(shown()).toContain("Launch plan");
  openPage.mockRejectedValueOnce(new Error("Page unavailable"));
  await click("Launch planSchedule and ownerslaunch/index.html");
  expect(shown()).toContain("Page unavailable");
  await click("Retry page");
  expect(openPage).toHaveBeenLastCalledWith({
    root: "release-notes",
    path: "launch/index.html",
    refresh: true,
  });
  expect(shown()).toContain("A styled launch plan");
});

it("clears an in-flight private page when sign-in expires and ignores its late result", async () => {
  await selectProject();
  let finish: (value: StarkPublishedPageDocument) => void = () => {};
  openPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Open project home");
  status = { state: "signed-out", message: null };
  await tick();
  await act(() => finish(document));
  expect(shown()).toContain("Continue in browser");
  expect(shown()).not.toContain("A styled launch plan");
});

it("cancels browser sign-in without starting a page read", async () => {
  await render();
  await click("Continue in browser");
  await click("Cancel sign-in");
  expect(disconnect).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(shown()).toContain("Continue in browser");
});

it("shows an empty account without exposing technical tool fields", async () => {
  status = { state: "connected", message: null };
  read.mockResolvedValueOnce({ content: [], isError: false, structuredContent: { projects: [] } });
  await render();
  expect(shown()).toContain("No published projects are available for this account yet.");
  expect(container.querySelector('[aria-label="Published Pages action"]')).toBeNull();
  expect(container.querySelector("form")).toBeNull();
  await chooseAction("Refresh projects");
  expect(shown()).toContain("release notes");
});

it("refreshes a cached page without hiding it during loading or a failed refresh", async () => {
  await selectProject();
  await click("Open project home");
  let finish: (value: StarkPublishedPageDocument) => void = () => {};
  openPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await chooseAction("Refresh page");
  expect(openPage).toHaveBeenLastCalledWith({
    root: "release-notes",
    path: "index.html",
    refresh: true,
  });
  expect(shown()).toContain("A styled launch plan");
  expect(shown()).toContain("Refreshing page");
  await openActions();
  expect(menuItem("Refresh page").getAttribute("aria-disabled")).toBe("true");
  await act(() => finish({ ...document, source: "The refreshed plan" }));
  expect(shown()).toContain("The refreshed plan");
  expect(shown()).not.toContain("A styled launch plan");
  openPage.mockRejectedValueOnce(new Error("Refresh unavailable"));
  await chooseAction("Refresh page");
  expect(shown()).toContain("Refresh unavailable");
  expect(shown()).toContain("The refreshed plan");
  await openActions();
  expect(menuItem("Refresh page").getAttribute("aria-disabled")).not.toBe("true");
});

it("keeps the selected page and search results when entering and leaving the full view", async () => {
  await selectProject();
  await searchPages();
  await click("Launch planSchedule and ownerslaunch/index.html");
  const reads = read.mock.calls.length;
  const content = button("Related page");
  await render(true);
  expect(shown()).toContain("A styled launch plan");
  await render(false);
  expect(shown()).toContain("A styled launch plan");
  expect(openPage).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(reads);
  expect(button("Related page")).toBe(content);
  await click("Back to pages");
  expect(shown()).toContain("2 results for “launch”");
});

it("opens explicit page tabs while keeping the library search and reading position", async () => {
  status = { state: "connected", message: null };
  const onOpenPage = vi.fn();
  await act(() => root.render(<PublishedStarkPages onOpenPage={onOpenPage} />));
  await click("Search in release notes");
  await searchPages();
  const panel = container.querySelector<HTMLElement>('section[aria-label="Published Pages"]')!;
  panel.scrollTop = 140;
  await click("Launch planSchedule and ownerslaunch/index.html");
  expect(onOpenPage).toHaveBeenCalledExactlyOnceWith({
    kind: "published",
    root: "release-notes",
    path: "launch/index.html",
    title: "Launch plan",
  });
  expect(openPage).not.toHaveBeenCalled();
  expect(shown()).toContain("2 results for “launch”");
  expect(panel.scrollTop).toBe(140);
  await click("Open project home");
  expect(onOpenPage).toHaveBeenLastCalledWith({
    kind: "published",
    root: "release-notes",
    path: "index.html",
    title: "Project home",
  });
});

it("opens gallery homes and global search results directly as page tabs", async () => {
  status = { state: "connected", message: null };
  const onOpenPage = vi.fn();
  await act(() => root.render(<PublishedStarkPages onOpenPage={onOpenPage} />));
  await click("Open design");
  expect(onOpenPage).toHaveBeenCalledExactlyOnceWith({
    kind: "published",
    root: "design",
    path: "index.html",
    title: "design",
  });
  expect(openPage).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
  onOpenPage.mockClear();
  await input("Search pages and projects", "launch");
  await click("Search all pages");
  expect(read).toHaveBeenLastCalledWith({
    tool: "pages_search",
    arguments: { query: "launch", limit: 20 },
  });
  const result = container.querySelector<HTMLButtonElement>(
    'ul[aria-label="Page search results"] button',
  )!;
  expect(result.textContent).toContain("Launch plan");
  await act(() => result.click());
  expect(onOpenPage).toHaveBeenCalledExactlyOnceWith({
    kind: "published",
    root: "release-notes",
    path: "launch/index.html",
    title: "Launch plan",
  });
  expect(openPage).not.toHaveBeenCalled();
  expect(container.querySelector('ul[aria-label="Page search results"]')).not.toBeNull();
});

it("opens a gallery home in the reader and returns to the same filtered library", async () => {
  status = { state: "connected", message: null };
  await render();
  await input("Search pages and projects", "release");
  const panel = container.querySelector<HTMLElement>('section[aria-label="Published Pages"]')!;
  panel.scrollTop = 120;
  await click("Open release notes");
  expect(openPage).toHaveBeenCalledExactlyOnceWith({
    root: "release-notes",
    path: "index.html",
    refresh: false,
  });
  expect(shown()).toContain("A styled launch plan");
  await click("Back to pages");
  expect(panel.scrollTop).toBe(120);
  expect(
    container.querySelector<HTMLInputElement>('input[aria-label="Search pages and projects"]')
      ?.value,
  ).toBe("release");
  expect(button("Open release notes")).toBeDefined();
  expect(shown()).not.toContain("A styled launch plan");
});

it("drops an in-flight global search on sign-out and starts the next connection with a clean library", async () => {
  status = { state: "connected", message: null };
  await render();
  let finish!: (value: typeof searchResults) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await input("Search pages and projects", "launch");
  await click("Search all pages");
  status = { state: "signed-out", message: null };
  await tick();
  await act(() => finish(searchResults));
  expect(shown()).toContain("Continue in browser");
  expect(shown()).not.toContain("Launch plan");
  status = { state: "connected", message: null };
  await tick();
  expect(
    container.querySelector<HTMLInputElement>('input[aria-label="Search pages and projects"]')
      ?.value,
  ).toBe("");
  expect(container.querySelector('ul[aria-label="Page search results"]')).toBeNull();
  expect(shown()).not.toContain("Launch plan");
});
