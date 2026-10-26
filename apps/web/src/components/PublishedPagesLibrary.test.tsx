// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { StarkPublishedPagesReadResult } from "@starkfuture/contracts";
import type { PublishedProject } from "./publishedPagesNavigation";

vi.mock("./PublishedPageCover", () => ({
  PublishedPageCover: ({ root, enabled }: { root: string; enabled: boolean }) => (
    <span aria-hidden data-cover-root={root} data-cover-enabled={String(enabled)} />
  ),
}));
import { PublishedPagesLibrary } from "./PublishedPagesLibrary";

let root: Root;
let container: HTMLDivElement;
let originalScrollIntoView: PropertyDescriptor | undefined;
const read = vi.fn();
const openPage = vi.fn();
const onOpen = vi.fn();
const onBrowse = vi.fn();
const projects: readonly PublishedProject[] = [
  { root: "design", title: "Design", fileCount: 25, url: null },
  { root: "launch", title: "Launch", fileCount: 12, url: null },
];
const response = (results: unknown[]): StarkPublishedPagesReadResult => ({
  content: [],
  isError: false,
  structuredContent: { results } as NonNullable<StarkPublishedPagesReadResult["structuredContent"]>,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const render = (props: Partial<ComponentProps<typeof PublishedPagesLibrary>> = {}) =>
  act(() =>
    root.render(
      <PublishedPagesLibrary
        projects={projects}
        busy={false}
        active
        canSearch
        onBrowse={onBrowse}
        onOpen={onOpen}
        {...props}
      />,
    ),
  );
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
const click = (label: string) => act(() => button(label).click());
async function type(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search pages and projects"]',
  )!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const resultCards = () => [
  ...container.querySelectorAll<HTMLButtonElement>('ul[aria-label="Page search results"] button'),
];
const projectCards = () => [
  ...container.querySelectorAll<HTMLButtonElement>(
    'ul[aria-label="Published projects"] button[aria-label^="Open "]',
  ),
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [read, openPage, onOpen, onBrowse]) mock.mockReset();
  read.mockResolvedValue(response([]));
  window.desktopBridge = { publishedPages: { read, openPage } } as unknown as NonNullable<
    Window["desktopBridge"]
  >;
  originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete window.desktopBridge;
  if (originalScrollIntoView)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("searches only on submit, keeps allowed roots distinct and directly opens the chosen page", async () => {
  read.mockResolvedValue(
    response([
      { root: "design", path: "notes/index.html", excerpt: { title: "Old title" } },
      {
        root: "launch",
        path: "notes/index.html",
        excerpt: { title: "Launch plan", text: "Owners and dates" },
      },
      {
        root: "design",
        path: "notes/index.html",
        excerpt: { title: "Design plan", text: "Review notes" },
      },
      { root: "other-account", path: "private/index.html", excerpt: { title: "Unrelated page" } },
      { root: "design", path: "../private/index.html" },
    ]),
  );
  await render();
  expect(read).not.toHaveBeenCalled();
  await type("plan");
  expect(read).not.toHaveBeenCalled();
  await click("Search all pages");
  expect(read).toHaveBeenCalledExactlyOnceWith({
    tool: "pages_search",
    arguments: { query: "plan", limit: 20 },
  });
  expect(resultCards()).toHaveLength(2);
  expect(container.textContent).not.toContain("Old title");
  expect(container.textContent).not.toContain("Unrelated page");
  await act(() => resultCards()[1]!.click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith({
    root: "launch",
    path: "notes/index.html",
    title: "Launch plan",
    excerpt: "Owners and dates",
    projectTitle: "Launch",
  });
  expect(onBrowse).not.toHaveBeenCalled();
  expect(openPage).not.toHaveBeenCalled();
});

it("separates opening a collection home from searching within that collection", async () => {
  await render();
  await click("Open Design");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith({
    root: "design",
    path: "index.html",
    title: "Design",
    projectTitle: "Design",
    excerpt: null,
  });
  await click("Search in Launch");
  expect(onBrowse).toHaveBeenCalledExactlyOnceWith(projects[1]);
  expect(read).not.toHaveBeenCalled();
  expect(openPage).not.toHaveBeenCalled();
  expect(container.textContent).not.toMatch(/25 (?:pages|published files)/);
});

it("paginates twelve projects at a time and resets the page when filtering", async () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    root: `project-${index + 1}`,
    title: `Project ${index + 1}`,
    fileCount: 1,
    url: null,
  }));
  await render({ projects: many });
  expect(projectCards()).toHaveLength(12);
  expect(button("Previous projects").disabled).toBe(true);
  await click("Next projects");
  expect(projectCards().map((card) => card.getAttribute("aria-label"))).toEqual([
    "Open Project 13",
    "Open Project 14",
  ]);
  expect(button("Next projects").disabled).toBe(true);
  expect(container.textContent).toContain("13–14 of 14");
  await click("Previous projects");
  expect(projectCards()).toHaveLength(12);
  await click("Next projects");
  await type("Project 1");
  expect(projectCards()).toHaveLength(6);
  expect(container.querySelector('nav[aria-label="Library pages"]')).toBeNull();
  await click("Clear Pages search");
  expect(projectCards()).toHaveLength(12);
  expect(button("Previous projects").disabled).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

it("keeps newly matched covers disabled while typing and searching, then resumes on clearing", async () => {
  const many = Array.from({ length: 13 }, (_, index) => ({
    root: `project-${index + 1}`,
    title: `Project ${index + 1}`,
    fileCount: 1,
    url: null,
  }));
  const search = deferred<StarkPublishedPagesReadResult>();
  read.mockReturnValueOnce(search.promise);
  await render({ projects: many });
  expect(container.querySelectorAll('[data-cover-enabled="true"]')).toHaveLength(12);
  expect(container.querySelector('[data-cover-root="project-13"]')).toBeNull();

  await type("Project 13");
  expect(
    container.querySelector('[data-cover-root="project-13"]')?.getAttribute("data-cover-enabled"),
  ).toBe("false");
  expect(container.querySelectorAll('[data-cover-enabled="true"]')).toHaveLength(0);
  expect(read).not.toHaveBeenCalled();
  await click("Search all pages");
  expect(container.querySelectorAll('[data-cover-enabled="true"]')).toHaveLength(0);
  await act(() => search.resolve(response([])));
  expect(container.querySelectorAll('[data-cover-enabled="true"]')).toHaveLength(0);

  await click("Clear Pages search");
  expect(container.querySelectorAll('[data-cover-enabled="true"]')).toHaveLength(12);
  await render({ projects: many, active: false });
  expect(container.querySelectorAll('[data-cover-enabled="true"]')).toHaveLength(0);
  expect(read).toHaveBeenCalledExactlyOnceWith({
    tool: "pages_search",
    arguments: { query: "Project 13", limit: 20 },
  });
});

it("ignores an earlier search after typing and preserves the newer response", async () => {
  const first = deferred<StarkPublishedPagesReadResult>();
  const second = deferred<StarkPublishedPagesReadResult>();
  read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await render();
  await type("old");
  await click("Search all pages");
  expect(button("Search all pages").disabled).toBe(true);
  await type("new");
  expect(button("Search all pages").disabled).toBe(false);
  expect(container.textContent).not.toContain("Searching across Company pages");
  await click("Search all pages");
  await act(() =>
    second.resolve(
      response([{ root: "launch", path: "new.html", excerpt: { title: "New result" } }]),
    ),
  );
  await act(() =>
    first.resolve(
      response([{ root: "design", path: "old.html", excerpt: { title: "Old result" } }]),
    ),
  );
  expect(container.textContent).toContain("New result");
  expect(container.textContent).not.toContain("Old result");
  await click("Clear Pages search");
  expect(resultCards()).toHaveLength(0);
});

it("does not show an obsolete request failure after the query changes", async () => {
  const first = deferred<StarkPublishedPagesReadResult>();
  read.mockReturnValueOnce(first.promise);
  await render();
  await type("plan");
  await click("Search all pages");
  await type("design");
  await act(() => first.reject(new Error("Old request failed")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button("Search all pages").disabled).toBe(false);
});

it("shows recoverable search errors, then an honest empty result", async () => {
  read.mockRejectedValueOnce(new Error("Private internal transport detail"));
  await render();
  await type("unknown");
  await click("Search all pages");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t search Pages");
  expect(container.textContent).not.toContain("Private internal transport detail");
  await click("Retry search");
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("No pages found");
});

it("still filters collections when search is unavailable and leaves an empty account useful", async () => {
  await render({ canSearch: false });
  await type("design");
  expect(projectCards()).toHaveLength(1);
  expect(container.querySelector('button[aria-label="Search all pages"]')).toBeNull();
  await act(() =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(read).not.toHaveBeenCalled();
  await render({ projects: [], busy: true });
  expect(container.textContent).toContain("Loading your library");
  await render({ projects: [] });
  expect(container.querySelector("form")).toBeNull();
});
