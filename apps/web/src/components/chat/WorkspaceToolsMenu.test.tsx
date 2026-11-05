// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { WorkspaceToolsMenu } from "./WorkspaceToolsMenu";

let root: Root;
let container: HTMLDivElement;
const showPages = vi.fn();
const showConversation = vi.fn();
const showAdvanced = vi.fn();
const showTerminal = vi.fn();
const showBrowser = vi.fn();

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label="Tools"]')!;
const item = (label: string) => {
  const element = document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="${label}"]`);
  if (!element) throw new Error(`Missing tool: ${label}`);
  return element;
};
const open = () => act(() => trigger().click());
const render = () =>
  act(() =>
    root.render(
      <WorkspaceToolsMenu
        actions={[
          { id: "pages", label: "Pages", active: true, onSelect: showPages },
          { id: "conversation", label: "Side chat", onSelect: showConversation },
          {
            id: "terminal",
            label: "Terminal",
            description: "Unavailable while reconnecting",
            disabled: true,
            onSelect: showTerminal,
          },
          { id: "browser", label: "New browser tab", onSelect: showBrowser },
        ]}
        moreGroups={[
          {
            label: "Advanced",
            actions: [{ id: "native", label: "Open Codex CLI", onSelect: showAdvanced }],
          },
        ]}
      />,
    ),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps everyday tools visible and reveals advanced tools only on request", async () => {
  await render();
  await open();
  expect(
    Array.from(document.querySelectorAll('[role="menuitem"]')).map((element) =>
      element.getAttribute("aria-label"),
    ),
  ).toEqual(["Pages", "Side chat", "Terminal", "New browser tab", "More tools"]);
  expect(document.querySelector('[aria-label="Open Codex CLI"]')).toBeNull();
  await act(() => item("More tools").click());
  await act(() => item("Open Codex CLI").click());
  expect(showAdvanced).toHaveBeenCalledOnce();
  expect(showPages).not.toHaveBeenCalled();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await open();
  await act(() => item("Side chat").click());
  expect(showConversation).toHaveBeenCalledOnce();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

it("opens a browser tab directly from the main menu and closes the menu", async () => {
  await render();
  await open();
  expect(document.querySelector('[aria-label="Open Codex CLI"]')).toBeNull();
  await act(() => item("New browser tab").click());
  expect(showBrowser).toHaveBeenCalledOnce();
  expect(showAdvanced).not.toHaveBeenCalled();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

it("keeps unavailable tools visible without selecting them", async () => {
  await render();
  await open();
  expect(item("Terminal").textContent).toContain("Unavailable while reconnecting");
  await act(() => item("Terminal").click());
  expect(showTerminal).not.toHaveBeenCalled();
  expect(showConversation).not.toHaveBeenCalled();
  expect(showPages).not.toHaveBeenCalled();
});

it("dismisses with Escape and returns keyboard focus to Tools", async () => {
  await render();
  await open();
  await act(() => {
    item("Pages").focus();
    item("Pages").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger());
  expect(showPages).not.toHaveBeenCalled();
  expect(showConversation).not.toHaveBeenCalled();
});
