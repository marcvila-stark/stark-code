// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ASSISTANT_CITATION_MAX_TEXT_LENGTH } from "@starkfuture/contracts";

const state = vi.hoisted(() => ({
  selection: undefined as (() => void) | undefined,
  dispose: vi.fn(),
}));
vi.mock("../../lib/selectionActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/selectionActions")>()),
  observeSelectionActions: ({
    onSelection,
    getActionElement,
  }: {
    onSelection: (pointer: null) => void;
    getActionElement: () => HTMLElement | null;
  }) => {
    state.selection = () => onSelection(null);
    return {
      cancel: () => undefined,
      dispose: state.dispose,
      selectionChanged: () => {
        if (!getActionElement()?.contains(document.activeElement)) onSelection(null);
      },
    };
  },
}));

import { ReaderSelectionToolbar } from "./ReaderSelectionToolbar";

let viewport: HTMLDivElement;
let source: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;
const quote = vi.fn<(text: string, label: string) => boolean>();
const rect = new DOMRect(20, 20, 240, 80);
const originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  viewport = document.createElement("div");
  source = document.createElement("div");
  source.innerHTML = "<p>First line.</p><button>Load image</button><p>Second line.</p>";
  viewport.append(source);
  host = document.createElement("div");
  document.body.append(viewport, host);
  root = createRoot(host);
  quote.mockReset().mockReturnValue(true);
  state.dispose.mockReset();
});
afterEach(async () => {
  await act(() => root.unmount());
  window.getSelection()?.removeAllRanges();
  viewport.remove();
  host.remove();
  vi.restoreAllMocks();
  if (originalRangeRect)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeRect);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
});
async function render() {
  await act(() =>
    root.render(
      <ReaderSelectionToolbar
        viewport={viewport}
        source={source}
        label="Claude native reply"
        onQuote={quote}
      />,
    ),
  );
}
async function select(
  start: Node,
  startOffset: number,
  end = start,
  endOffset = end.textContent!.length,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(() => state.selection?.());
}
const button = () =>
  document.querySelector<HTMLButtonElement>('[aria-label="Quote selection in chat"]');

it("quotes only selected displayed source text with its real generic label and clears selection after acceptance", async () => {
  await render();
  await select(
    source.querySelector("p")!.firstChild!,
    0,
    source.querySelectorAll("p")[1]!.firstChild!,
  );
  await act(() => button()!.click());
  expect(quote).toHaveBeenCalledExactlyOnceWith("First line.\nSecond line.", "Claude native reply");
  expect(source.hasAttribute("data-assistant-citation-source")).toBe(false);
  expect(window.getSelection()?.isCollapsed).toBe(true);
  expect(button()).toBeNull();
});

it("keeps selected text available when the composer rejects insertion and supports keyboard dismissal", async () => {
  quote.mockReturnValue(false);
  await render();
  await select(source.querySelector("p")!.firstChild!, 0);
  await act(() => button()!.click());
  expect(window.getSelection()?.toString()).toBe("First line.");
  expect(button()).not.toBeNull();
  await act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    ),
  );
  expect(document.activeElement).toBe(button());
  await act(() =>
    button()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    ),
  );
  expect(button()).toBeNull();
  expect(quote).toHaveBeenCalledExactlyOnceWith("First line.", "Claude native reply");
});

it("rejects text outside this reply, selections across its boundary and UI controls", async () => {
  const outside = document.createTextNode("Another panel");
  viewport.append(outside);
  await render();
  await select(outside, 0);
  expect(button()).toBeNull();
  await select(source.querySelector("p")!.firstChild!, 0, outside);
  expect(button()).toBeNull();
  await select(source.querySelector("button")!.firstChild!, 0);
  expect(button()).toBeNull();
  expect(quote).not.toHaveBeenCalled();
});

it("limits quoted context without losing the selected text or changing clipboard behavior", async () => {
  source.textContent = "x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1);
  await render();
  await select(source.firstChild!, 0);
  const shorten = document.querySelector<HTMLButtonElement>(
    '[aria-label="Selection is too long to quote"]',
  )!;
  expect(shorten.disabled).toBe(true);
  await act(() => shorten.click());
  expect(quote).not.toHaveBeenCalled();
  const copy = new Event("copy", { bubbles: true, cancelable: true });
  source.dispatchEvent(copy);
  expect(copy.defaultPrevented).toBe(false);
  expect(window.getSelection()?.toString()).toHaveLength(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1);
});
