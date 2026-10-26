// @vitest-environment jsdom
import { act, createRef, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { serializeSelectedTextQuote } from "@starkfuture/shared/selectedTextQuotes";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

let root: Root;
let container: HTMLDivElement;
const contextRecords: ComposerPromptEditorProps["contextRecords"] = new Map();
const base = {
  contextRecords,
  skills: [],
  disabled: false,
  placeholder: "Message",
  ariaLabel: "Message",
  onPaste: () => {},
  onChange: () => {},
};
const editorElement = () =>
  container.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const rangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
beforeEach(() => {
  // jsdom has no layout; ProseMirror still measures the selection after a real focus event.
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (rangeRects) Object.defineProperty(Range.prototype, "getClientRects", rangeRects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (rangeBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeBounds);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
});

it("shows readable quote details without interpreting markup and removes only the quote", async () => {
  const ref = createRef<ComposerPromptEditorHandle>();
  const quote = {
    version: 1 as const,
    source: "Pages · Report",
    text: "*exact*. $review @private\n<img src='https://example.com/a'>",
  };
  const source = serializeSelectedTextQuote(quote);
  await act(() =>
    root.render(
      <ComposerPromptEditorTiptap
        {...base}
        value={`My draft ${source} after`}
        cursor={0}
        editorRef={ref}
      />,
    ),
  );
  const chip = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Quote from Pages · Report. Show details"]',
  )!;
  expect(chip).not.toBeNull();
  expect(chip.textContent).toContain("*exact*. $review @private");
  expect(container.textContent).not.toContain("stark-quote:");
  await act(() => chip.click());
  expect(document.body.textContent).toContain(quote.text);
  expect(document.body.querySelector('img[src="https://example.com/a"]')).toBeNull();
  const remove = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Remove quote",
  )!;
  await act(() => remove.click());
  expect(ref.current?.readSnapshot().value).toBe("My draft  after");
});

it("rejects malformed quote atoms from HTML-only paste without breaking the draft", async () => {
  const ref = createRef<ComposerPromptEditorHandle>();
  await act(() =>
    root.render(
      <ComposerPromptEditorTiptap {...base} value="Keep my draft" cursor={0} editorRef={ref} />,
    ),
  );
  await act(() => ref.current?.focusAtEnd());
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: {
      getData: (kind: string) =>
        kind === "text/html"
          ? '<span data-composer-selected-quote="" quote="null">bad quote</span>'
          : "",
      types: ["text/html"],
      files: [],
    },
  });
  await act(() => editorElement().dispatchEvent(paste));
  expect(ref.current?.readSnapshot().value).toContain("Keep my draft");
  expect(ref.current?.readSnapshot().value).toContain("bad quote");
  expect(container.querySelector("[data-composer-selected-quote-chip]")).toBeNull();
});

it("ignores conflicting raw attributes on an otherwise valid HTML quote", async () => {
  const ref = createRef<ComposerPromptEditorHandle>();
  const quote = { version: 1 as const, source: "Pages", text: "Keep this *exact* quote" };
  const source = serializeSelectedTextQuote(quote);
  const span = document.createElement("span");
  span.setAttribute("data-composer-selected-quote", "");
  span.setAttribute("data-quote-source", source);
  span.setAttribute("source", "$review @private/file");
  span.setAttribute("quote", "null");
  await act(() =>
    root.render(<ComposerPromptEditorTiptap {...base} value="Draft " cursor={0} editorRef={ref} />),
  );
  await act(() => ref.current?.focusAtEnd());
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: {
      getData: (kind: string) => (kind === "text/html" ? span.outerHTML : ""),
      types: ["text/html"],
      files: [],
    },
  });
  await act(() => editorElement().dispatchEvent(paste));
  expect(ref.current?.readSnapshot().value).toBe(`Draft ${source}`);
  expect(container.textContent).toContain(quote.text);
  expect(container.textContent).not.toContain("$review");
});

it("keeps keyboard focus entering ! mode and leaving it with empty Backspace", async () => {
  function ShellComposer() {
    const [shell, setShell] = useState(false);
    const editorRef = useRef<ComposerPromptEditorHandle>(null);
    return (
      <ComposerPromptEditorTiptap
        {...base}
        value=""
        cursor={0}
        editorRef={editorRef}
        richTextEnabled={!shell}
        literalText={shell}
        onCommandKeyDown={(key) => {
          if (!shell && key === "!") {
            setShell(true);
            return true;
          }
          if (shell && key === "Backspace") {
            setShell(false);
            return true;
          }
          return false;
        }}
      />
    );
  }
  await act(() => root.render(<ShellComposer />));
  const rich = editorElement();
  await act(() => rich.focus());
  expect(document.activeElement).toBe(rich);
  await act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "!", bubbles: true, cancelable: true }),
    ),
  );
  const shell = editorElement();
  expect(shell).not.toBe(rich);
  expect(shell.dataset.composerRichText).toBe("false");
  expect(document.activeElement).toBe(shell);
  await act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
    ),
  );
  expect(editorElement()).not.toBe(shell);
  expect(editorElement().dataset.composerRichText).toBe("true");
  expect(document.activeElement).toBe(editorElement());
});

it("preserves the controlled command and caret across focused text-mode changes", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const render = (literalText: boolean) =>
    root.render(
      <ComposerPromptEditorTiptap
        {...base}
        value="echo hello"
        cursor={4}
        editorRef={editorRef}
        richTextEnabled={!literalText}
        literalText={literalText}
      />,
    );
  await act(() => render(false));
  await act(() => editorElement().focus());
  await act(() => render(true));
  expect(document.activeElement).toBe(editorElement());
  expect(editorRef.current!.readSnapshot()).toMatchObject({ value: "echo hello", cursor: 4 });
  await act(() => render(false));
  expect(document.activeElement).toBe(editorElement());
  expect(editorRef.current!.readSnapshot()).toMatchObject({ value: "echo hello", cursor: 4 });
});

it("does not steal focus from another control when text mode changes", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const button = document.createElement("button");
  document.body.append(button);
  try {
    const render = (literalText: boolean) =>
      root.render(
        <ComposerPromptEditorTiptap
          {...base}
          value=""
          cursor={0}
          editorRef={editorRef}
          richTextEnabled={!literalText}
          literalText={literalText}
        />,
      );
    await act(() => render(false));
    await act(() => button.focus());
    await act(() => render(true));
    expect(document.activeElement).toBe(button);
  } finally {
    button.remove();
  }
});
