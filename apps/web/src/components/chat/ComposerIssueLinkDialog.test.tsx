// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ComposerIssueLinkDialog } from "./ComposerIssueLinkDialog";
import type { ComposerIssueLink } from "./composerIssueLink";
import { isInsideComposerFloatingLayer } from "./composerEventScope";

let root: Root;
let container: HTMLDivElement;
const selected = vi.fn<(link: ComposerIssueLink) => boolean | void>();
const send = vi.fn();
const composerKey = vi.fn();
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <form onSubmit={send} onKeyDown={composerKey}>
      <ComposerIssueLinkDialog open={open} onOpenChange={setOpen} onSelect={selected} />
    </form>
  );
}
const addButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === "Add to draft",
  )!;
const input = () => document.querySelector<HTMLInputElement>('input[type="url"]')!;
async function type(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  selected.mockReset();
  send.mockReset();
  composerKey.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<Harness />));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("previews a validated issue and only adds it after an explicit action", async () => {
  expect(addButton().disabled).toBe(true);
  await type("https://github.com/starkfuture/stark-code/issues/42");
  expect(document.querySelector('[aria-label="Issue link preview"]')?.textContent).toContain(
    "starkfuture/stark-code#42",
  );
  expect(isInsideComposerFloatingLayer(document.querySelector('[data-slot="dialog-popup"]'))).toBe(
    true,
  );
  expect(
    isInsideComposerFloatingLayer(document.querySelector('[aria-label="Issue link preview"] p')),
  ).toBe(true);
  expect(selected).not.toHaveBeenCalled();
  await act(() => addButton().click());
  expect(selected.mock.calls[0]?.[0].markdown).toBe(
    "[starkfuture/stark-code#42](https://github.com/starkfuture/stark-code/issues/42)",
  );
  expect(send).not.toHaveBeenCalled();
});

it("rejects off-host URLs and prevents Enter from reaching the composer", async () => {
  await type("https://example.com/starkfuture/stark-code/issues/42");
  expect(addButton().disabled).toBe(true);
  await act(() => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  expect(selected).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(composerKey).not.toHaveBeenCalled();
});

it("keeps the draft reference available after a busy composer rejects it", async () => {
  selected.mockReturnValue(false);
  await type("https://github.com/starkfuture/stark-code/issues/42");
  await act(() => addButton().click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("composer is busy");
  expect(input().value).toContain("issues/42");
  expect(send).not.toHaveBeenCalled();
});
