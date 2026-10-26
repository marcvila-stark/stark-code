// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useTurnBookmarks } from "./useTurnBookmarks";
import { TimelineTurnOutline } from "./TimelineTurnOutline";
import type { TimelineMinimapItem } from "./timelineMinimapItems";

const turnIndex = vi.hoisted(() => ({
  items: [] as Array<{
    entryId: string;
    runId: null;
    userText: string;
    assistantText: string | null;
  }>,
}));
vi.mock("./useThreadTurnIndex", () => ({
  useThreadTurnIndex: () => ({
    items: turnIndex.items,
    totalTurns: turnIndex.items.length || null,
    loading: false,
    complete: true,
    error: null,
    retry: () => {},
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  turnIndex.items = [];
  vi.unstubAllGlobals();
});

const items: TimelineMinimapItem[] = [
  { id: "first", rowIndex: 0, userText: "Inspect the app", assistantText: "Found the entry point" },
  { id: "second", rowIndex: 4, userText: "Fix navigation", assistantText: "Navigation is ready" },
];

it("opens prompt and answer previews, navigates by keyboard, and closes after a jump", async () => {
  const select = vi.fn();
  await act(() =>
    root.render(<TimelineTurnOutline items={items} currentId="first" onSelect={select} />),
  );
  expect(document.querySelector('[aria-label="Conversation turns"]')).toBeNull();
  await act(() => container.querySelector("button")!.click());
  const popup = document.querySelector('[aria-label="Conversation turns"]')!;
  expect(popup.textContent).toContain("Found the entry point");
  expect(popup.textContent).toContain("Navigation is ready");
  const turns = popup.querySelectorAll<HTMLButtonElement>("ol button");
  await act(() => turns[0]!.focus());
  await act(() =>
    turns[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  expect(document.activeElement).toBe(turns[1]);
  await act(() => turns[1]!.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(items[1]);
  expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
});

it("loads earlier turns without claiming full history or losing the focused turn", async () => {
  const select = vi.fn();
  const load = vi.fn();
  const render = (loaded: TimelineMinimapItem[], hasMoreHistory: boolean, loading = false) =>
    root.render(
      <TimelineTurnOutline
        items={loaded}
        currentId="second"
        onSelect={select}
        history={{ hasMoreHistory, loading, error: null, onLoadEarlier: load }}
      />,
    );
  await act(() => render(items, true));
  await act(() => container.querySelector("button")!.click());
  const popup = () => document.querySelector('[aria-label="Conversation turns"]')!;
  expect(popup().textContent).toContain("2 loaded turns");
  const earlier = Array.from(popup().querySelectorAll("button")).find(
    (button) => button.textContent === "Load earlier turns",
  )!;
  await act(() => earlier.click());
  expect(load).toHaveBeenCalledOnce();
  await act(() => render(items, true, true));
  expect(earlier.disabled).toBe(true);
  const current = popup().querySelector<HTMLButtonElement>('[aria-current="step"]')!;
  await act(() => current.focus());
  const prepended = [
    { id: "older", rowIndex: 0, userText: "Earlier prompt", assistantText: "Earlier answer" },
    ...items.map((item) => ({ ...item, rowIndex: item.rowIndex + 2 })),
  ];
  await act(() => render(prepended, false));
  expect(document.activeElement).toBe(current);
  expect(popup().textContent).toContain("3 turns");
  expect(popup().textContent).not.toContain("Load earlier turns");
  await act(() => current.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(prepended[2]);
});

it("persists bookmarks across remounts, scopes them to the conversation, and removes them", async () => {
  function SavedTurns({ threadKey }: { threadKey: string }) {
    const { bookmarks, toggleBookmark } = useTurnBookmarks(threadKey);
    return (
      <TimelineTurnOutline
        items={items}
        currentId="first"
        onSelect={() => {}}
        bookmarks={bookmarks}
        onToggleBookmark={toggleBookmark}
      />
    );
  }
  const open = async () => act(() => container.querySelector("button")!.click());
  await act(() => root.render(<SavedTurns threadKey="environment-a:thread-a" />));
  await open();
  await act(() =>
    document.querySelector<HTMLButtonElement>('[aria-label="Bookmark Fix navigation"]')!.click(),
  );
  expect(
    document
      .querySelector('[aria-label="Remove bookmark from Fix navigation"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  await act(() => root.render(null));
  await act(() => root.render(<SavedTurns threadKey="environment-b:thread-a" />));
  await open();
  expect(
    document.querySelector('[aria-label="Bookmark Fix navigation"]')?.getAttribute("aria-pressed"),
  ).toBe("false");
  await act(() => root.render(null));
  await act(() => root.render(<SavedTurns threadKey="environment-a:thread-a" />));
  await open();
  const saved = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.includes("Saved"),
  )!;
  await act(() => saved.click());
  const list = document.querySelector('[aria-label="Turns"]')!;
  expect(list.textContent).toContain("Fix navigation");
  expect(list.textContent).not.toContain("Inspect the app");
  await act(() =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Remove bookmark from Fix navigation"]')!
      .click(),
  );
  expect(document.querySelector('[aria-label="Conversation turns"]')?.textContent).toContain(
    "No bookmarked turns match.",
  );
  await act(() => root.render(null));
  await act(() => root.render(<SavedTurns threadKey="environment-b:thread-a" />));
  await open();
  expect(
    document.querySelector('[aria-label="Bookmark Fix navigation"]')?.getAttribute("aria-pressed"),
  ).toBe("false");
});

it("searches old indexed previews and selects a turn outside the loaded conversation", async () => {
  turnIndex.items = [
    {
      entryId: "archived",
      runId: null,
      userText: "Archived architecture",
      assistantText: "Use a bounded index",
    },
    { entryId: "first", runId: null, userText: "Outdated prompt preview", assistantText: null },
  ];
  const select = vi.fn();
  await act(() =>
    root.render(<TimelineTurnOutline items={items} currentId="second" onSelect={select} />),
  );
  await act(() => container.querySelector("button")!.click());
  const popup = document.querySelector('[aria-label="Conversation turns"]')!;
  expect(popup.textContent).toContain("Use a bounded index");
  expect(popup.textContent).toContain("Inspect the app");
  expect(popup.textContent).not.toContain("Outdated prompt preview");
  const input = popup.querySelector<HTMLInputElement>('[aria-label="Search turn previews"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "bounded",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const list = popup.querySelector("ol")!;
  expect(list.textContent).toContain("Archived architecture");
  expect(list.textContent).not.toContain("Inspect the app");
  await act(() => list.querySelector<HTMLButtonElement>("button")!.click());
  expect(select).toHaveBeenCalledWith(
    expect.objectContaining({ entryId: "archived", rowIndex: -1 }),
  );
});

it("keeps the current turn in the bounded menu window while the full index is available", async () => {
  turnIndex.items = Array.from({ length: 205 }, (_, ordinal) => ({
    entryId: `turn-${ordinal}`,
    runId: null,
    userText: `Prompt ${ordinal}`,
    assistantText: `Response ${ordinal}`,
  }));
  await act(() =>
    root.render(<TimelineTurnOutline items={[]} currentId="turn-150" onSelect={() => {}} />),
  );
  await act(() => container.querySelector("button")!.click());
  const popup = document.querySelector('[aria-label="Conversation turns"]')!;
  expect(popup.querySelectorAll("ol li")).toHaveLength(100);
  expect(popup.querySelector('[aria-current="step"]')?.textContent).toContain("Prompt 150");
  const more = Array.from(popup.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    button.textContent?.startsWith("Show more turns"),
  )!;
  await act(() => more.click());
  expect(popup.querySelectorAll("ol li")).toHaveLength(200);
  expect(popup.querySelector('[aria-current="step"]')?.textContent).toContain("Prompt 150");
});
