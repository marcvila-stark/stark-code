// @vitest-environment jsdom
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { collapseExpandedComposerCursor } from "../composer-logic";
import { serializeSelectedTextQuote } from "@starkfuture/shared/selectedTextQuotes";

let root: Root;
let container: HTMLDivElement;
const ref = createRef<ComposerPromptEditorHandle>();
const skills = [{ name: "plain-english", path: "/skills/plain/SKILL.md", enabled: true }];
const rects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const bounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  if (rects) Object.defineProperty(Range.prototype, "getClientRects", rects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  if (bounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", bounds);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});
function Draft({ initial, literalText = false }: { initial: string; literalText?: boolean }) {
  const [value, setValue] = useState(initial);
  const [cursor, setCursor] = useState(0);
  return (
    <ComposerPromptEditor
      value={value}
      cursor={cursor}
      editorRef={ref}
      skills={skills}
      literalText={literalText}
      contextRecords={new Map()}
      disabled={false}
      placeholder="Message"
      onPaste={() => {}}
      onChange={(next, position) => {
        setValue(next);
        setCursor(position);
      }}
    />
  );
}
const editor = () => container.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
function paste(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (kind: string) => (kind === "text/plain" ? text : ""),
      types: ["text/plain"],
      files: [],
    },
  });
  editor().dispatchEvent(event);
}
it("keeps the skill outside editable text and sends the original invocation with edits", async () => {
  await act(() => root.render(<Draft initial="$plain-english My draft" />));
  expect(editor().textContent).toBe("My draft");
  expect(container.querySelector('[aria-label="Skill: Plain English"]')).not.toBeNull();
  const cursor = collapseExpandedComposerCursor("$plain-english My ", "$plain-english My ".length);
  await act(() => ref.current?.focusAt(cursor));
  expect(ref.current?.readSelectionRange()).toEqual({ start: 18, end: 18 });
  await act(() => paste("updated "));
  expect(ref.current?.readSnapshot().value).toBe("$plain-english My updated draft");
  expect(editor().textContent).toBe("My updated draft");
});
it("removes only the attached skill, preserving the draft and a quoted passage", async () => {
  const quote = serializeSelectedTextQuote({ version: 1, source: "Pages", text: "Exact quote" });
  const body = `Keep this ${quote} please`;
  await act(() => root.render(<Draft initial={`$plain-english ${body}`} />));
  await act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Remove Plain English skill"]')!
      .click(),
  );
  expect(ref.current?.readSnapshot().value).toBe(body);
  expect(container.querySelector('[aria-label="Attached skills"]')).toBeNull();
  expect(editor().textContent).toContain("Exact quote");
});
it("leaves literal answers and shell text untouched", async () => {
  await act(() => root.render(<Draft initial="$plain-english literal" literalText />));
  expect(editor().textContent).toBe("$plain-english literal");
  expect(container.querySelector('[aria-label="Attached skills"]')).toBeNull();
});
