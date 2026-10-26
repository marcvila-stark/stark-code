// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/usePreviewPanelInlineSize", () => ({
  usePreviewPanelInlineSize: () => ({ width: 420, handlers: {} }),
}));
import { ConversationToolsPanel } from "./ConversationToolsPanel";

function Draft() {
  const [value, setValue] = useState("");
  return (
    <textarea
      aria-label="Side question"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}
let root: Root;
let container: HTMLDivElement;
const close = vi.fn();
const render = (active = true, inline = true) =>
  act(() =>
    root.render(
      <ConversationToolsPanel active={active} inline={inline} onClose={close}>
        <Draft />
      </ConversationToolsPanel>,
    ),
  );
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (label: string) => act(() => button(label).click());
const escape = () =>
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  close.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("preserves a side-question draft across tool switches, resizing, expansion and restore", async () => {
  await render();
  const draft = container.querySelector("textarea")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      draft,
      "Explain this decision",
    );
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Expand side chat");
  await render(false, false);
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.closest("[hidden]")).not.toBeNull();
  expect(document.querySelector('[data-auxiliary-panel-overlay="true"]')).toBeNull();
  const otherTool = document.createElement("button");
  document.body.append(otherTool);
  await act(() => otherTool.focus());
  expect(document.activeElement).toBe(otherTool);
  await escape();
  expect(close).not.toHaveBeenCalled();
  await render(true, false);
  expect(draft.value).toBe("Explain this decision");
  expect(draft.closest("[hidden]")).toBeNull();
  await click("Return side chat to side panel");
  await render(true, true);
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Explain this decision");
  otherTool.remove();
});

it("restores on Escape, closes the narrow panel on a second Escape, and ignores expand requests while inactive", async () => {
  await render(true, false);
  await act(() => window.dispatchEvent(new Event("starkcode:auxiliary-panel-toggle-expanded")));
  expect(button("Return side chat to side panel")).not.toBeNull();
  const panel = container.querySelector<HTMLElement>("[data-conversation-tools-expanded]")!;
  await act(() => panel.focus());
  await escape();
  expect(button("Expand side chat")).not.toBeNull();
  expect(close).not.toHaveBeenCalled();
  await act(() => panel.focus());
  await escape();
  expect(close).toHaveBeenCalledOnce();
  await render(false, false);
  await act(() => window.dispatchEvent(new Event("starkcode:auxiliary-panel-toggle-expanded")));
  await render(true, true);
  expect(button("Expand side chat")).not.toBeNull();
});
