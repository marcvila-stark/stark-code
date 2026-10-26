// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { LocalPagesLibrary, localPagesFolderName, type LocalPageEntry } from "./LocalPagesLibrary";

let root: Root;
let container: HTMLDivElement;
const open = vi.fn();
const refresh = vi.fn();
const pages: LocalPageEntry[] = [
  {
    slug: "launch-decision",
    title: "Launch decision",
    type: "decision",
    status: "draft",
    mtime: "2026-10-23T10:00:00.000Z",
  },
  {
    slug: "weekly-report",
    title: "Weekly report",
    type: "report",
    status: "current",
    mtime: "2026-10-20T10:00:00.000Z",
  },
];
const render = (overrides = {}) =>
  act(() =>
    root.render(
      <LocalPagesLibrary
        projectRoot="/Users/me/work"
        pages={pages}
        loading={false}
        starting={false}
        error={null}
        onOpen={open}
        onRefresh={refresh}
        {...overrides}
      />,
    ),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  open.mockReset();
  refresh.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("explains the local folder and opens the exact selected page without fetching thumbnail content", async () => {
  await render();
  expect(container.textContent).toContain("Pages built on this Mac");
  expect(container.textContent).toContain("/Users/me/work");
  expect(container.querySelectorAll("iframe, img")).toHaveLength(0);
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Open Launch decision"]')!;
  expect(button.textContent).toContain("Decision");
  expect(button.textContent).toContain("Draft");
  await act(() => button.click());
  expect(open).toHaveBeenCalledExactlyOnceWith(pages[0]);
});

it("filters the real catalog by title, slug or page type and clears a search with no matches", async () => {
  await render();
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search local pages"]')!;
  const type = async (text: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await type("decision");
  expect(container.querySelector('[aria-label="Open Launch decision"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Open Weekly report"]')).toBeNull();
  await type("missing");
  expect(container.textContent).toContain("No matching pages");
  const clear = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Clear search",
  )!;
  await act(() => clear.click());
  expect(container.querySelector('[aria-label="Open Weekly report"]')).not.toBeNull();
});

it("distinguishes an empty folder from an unavailable catalog", async () => {
  await render({ pages: [] });
  expect(container.textContent).toContain("Your first page starts in chat");
  expect(container.textContent).toContain("Local pages stay on this Mac");
  await render({ pages: [], error: "Could not read this folder’s pages." });
  expect(container.textContent).toContain("Pages are temporarily unavailable");
  expect(container.textContent).not.toContain("Your first page starts in chat");
  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Try again",
  )!;
  await act(() => retry.click());
  expect(refresh).toHaveBeenCalledOnce();
});

it("keeps folder names understandable across native paths", () => {
  expect(localPagesFolderName("/Users/me/work/")).toBe("work");
  expect(localPagesFolderName("C:\\Users\\me\\work")).toBe("work");
});
