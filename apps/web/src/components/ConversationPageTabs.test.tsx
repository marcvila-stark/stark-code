// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  CONVERSATION_CHAT_TAB_ID,
  ConversationPageTabs,
  type ConversationPageTab,
} from "./ConversationPageTabs";

let container: HTMLDivElement;
let root: Root;
const initialPages = [
  { id: "page-one", title: "Launch notes" },
  { id: "page-two", title: "Service diagram" },
];

function Harness({
  pages: initial = initialPages,
  selected = CONVERSATION_CHAT_TAB_ID,
}: {
  pages?: ConversationPageTab[];
  selected?: string;
}) {
  const [pages, setPages] = useState(initial);
  const [activeTabId, setActiveTabId] = useState(selected);
  return (
    <>
      <ConversationPageTabs
        pages={pages}
        activeTabId={activeTabId}
        onSelect={setActiveTabId}
        onClose={(id) => {
          const index = pages.findIndex((page) => page.id === id);
          if (activeTabId === id) {
            setActiveTabId(pages[index - 1]?.id ?? CONVERSATION_CHAT_TAB_ID);
          }
          setPages(pages.filter((page) => page.id !== id));
        }}
      />
      <section role="tabpanel" aria-label="Current view">
        {activeTabId === CONVERSATION_CHAT_TAB_ID
          ? "Conversation draft"
          : pages.find((page) => page.id === activeTabId)?.title}
      </section>
      <button type="button" onClick={() => setActiveTabId("page-two")}>
        Open diagram from conversation
      </button>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tab(name: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (element) => element.textContent === name,
  );
  if (!found) throw new Error(`Missing tab: ${name}`);
  return found;
}

function currentView() {
  return container.querySelector('[role="tabpanel"]')?.textContent;
}

async function key(element: HTMLButtonElement, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  await act(() => element.dispatchEvent(event));
  return event;
}

it("starts with only Chat and never closes it with Delete", async () => {
  await act(() => root.render(<Harness pages={[]} />));
  await act(() => tab("Chat").focus());
  await key(tab("Chat"), "Delete");
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(container.querySelector('[aria-label^="Close"]')).toBeNull();
  expect(currentView()).toBe("Conversation draft");
  expect(document.activeElement).toBe(tab("Chat"));
  await key(tab("Chat"), "ArrowRight");
  expect(document.activeElement).toBe(tab("Chat"));
});

it("moves focus with arrows without replacing the view until Enter or Space activates a tab", async () => {
  await act(() => root.render(<Harness />));
  await act(() => tab("Chat").focus());
  expect((await key(tab("Chat"), "ArrowRight")).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(tab("Launch notes"));
  expect(currentView()).toBe("Conversation draft");
  expect(tab("Chat").getAttribute("aria-selected")).toBe("true");
  expect(tab("Launch notes").tabIndex).toBe(0);
  expect(tab("Chat").tabIndex).toBe(-1);
  await key(tab("Launch notes"), "Enter");
  expect(currentView()).toBe("Launch notes");
  expect(tab("Launch notes").getAttribute("aria-selected")).toBe("true");
  await key(tab("Launch notes"), "ArrowRight");
  await key(tab("Service diagram"), " ");
  expect(currentView()).toBe("Service diagram");
  await key(tab("Service diagram"), "ArrowRight");
  expect(document.activeElement).toBe(tab("Chat"));
  await key(tab("Chat"), "ArrowLeft");
  expect(document.activeElement).toBe(tab("Service diagram"));
});

it("uses Home and End to reach and reveal tabs beyond the scroll viewport", async () => {
  await act(() => root.render(<Harness />));
  const reveal = vi.fn();
  tab("Service diagram").scrollIntoView = reveal;
  await act(() => tab("Chat").focus());
  await key(tab("Chat"), "End");
  expect(document.activeElement).toBe(tab("Service diagram"));
  expect(reveal).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  expect(currentView()).toBe("Conversation draft");
  await key(tab("Service diagram"), "Home");
  expect(document.activeElement).toBe(tab("Chat"));
});

it("closes a page with Delete and keeps focus on a surviving tab, including return to Chat", async () => {
  await act(() => root.render(<Harness selected="page-two" />));
  await act(() => tab("Service diagram").focus());
  await key(tab("Service diagram"), "Delete");
  expect(currentView()).toBe("Launch notes");
  expect(document.activeElement).toBe(tab("Launch notes"));
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  await key(tab("Launch notes"), "Delete");
  expect(currentView()).toBe("Conversation draft");
  expect(document.activeElement).toBe(tab("Chat"));
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
});

it("closing an inactive page leaves the current conversation in place", async () => {
  await act(() => root.render(<Harness />));
  const close = container.querySelector<HTMLButtonElement>('[aria-label="Close Launch notes"]');
  if (!close) throw new Error("Missing close action");
  await act(() => close.click());
  expect(currentView()).toBe("Conversation draft");
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(document.activeElement).toBe(tab("Chat"));
  await act(() => tab("Service diagram").click());
  expect(currentView()).toBe("Service diagram");
});

it("updates the keyboard entry point when a page opens from elsewhere in the app", async () => {
  await act(() => root.render(<Harness />));
  const open = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === "Open diagram from conversation",
  );
  if (!open) throw new Error("Missing page opener");
  await act(() => open.click());
  expect(currentView()).toBe("Service diagram");
  expect(tab("Service diagram").tabIndex).toBe(0);
  expect(tab("Chat").tabIndex).toBe(-1);
});
