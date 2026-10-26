// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import { ThreadId } from "@starkfuture/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import {
  buildSidebarThreadLookup,
  filterSidebarV2VisibleThreads,
  groupSidebarSideChats,
} from "../Sidebar.logic";
import { buildThreadActionMenuItems } from "../threadActionMenu.logic";

vi.mock("../../sideChatStore", () => ({
  useSideChatStore: (select: (state: { selectedByParent: object }) => unknown) =>
    select({ selectedByParent: {} }),
}));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: (select: (state: { auxiliaryPanelByThreadKey: object }) => unknown) =>
    select({ auxiliaryPanelByThreadKey: {} }),
}));
import { SidebarSideChats } from "./SidebarSideChats";

const parent = makeThreadFixture({ id: ThreadId.make("parent"), title: "Main task" });
const child = makeThreadFixture({
  id: ThreadId.make("child"),
  title: "Side discussion",
  lineage: {
    rootThreadId: parent.id,
    parentThreadId: parent.id,
    relationshipToParent: "side_chat",
  },
});
const keyOf = (thread: typeof parent) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Exercises the production roster, action lookup, menu and child editor together.
 * Native menu presentation and metadata persistence are replaced by local UI state. */
function SidebarActionHarness() {
  const [threads, setThreads] = useState([parent, child]);
  const [menuThread, setMenuThread] = useState<typeof parent | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const groups = groupSidebarSideChats(filterSidebarV2VisibleThreads(threads, null));
  const lookup = buildSidebarThreadLookup(groups.roots, groups.sideChatsByParentKey);
  const items = menuThread
    ? buildThreadActionMenuItems({
        canOperate: true,
        branch: null,
        projectFilter: null,
        isPinned: false,
        isSettled: false,
        autoSettleEnabled: false,
        isSnoozed: false,
        canSnoozeNow: true,
        isRegeneratingTitle: false,
        isRunning: false,
        supports: {
          settlement: false,
          autoSettleOptOut: false,
          snooze: false,
          pinning: false,
          titleRegeneration: false,
        },
        snoozePresets: [],
      })
    : [];
  return (
    <>
      <ul>
        {groups.roots.map((root) => (
          <li key={root.id}>{root.title}</li>
        ))}
        {groups.sideChatsByParentKey.get(keyOf(parent)) ? (
          <SidebarSideChats
            parent={parent}
            chats={groups.sideChatsByParentKey.get(keyOf(parent))!}
            isParentActive
            onOpen={() => {}}
            onContextMenu={(chat) => setMenuThread(lookup.get(keyOf(chat)) ?? null)}
            rename={{
              threadKey: renaming,
              title,
              onChange: setTitle,
              onCancel: () => setRenaming(null),
              onCommit: (chat, nextTitle) => {
                setThreads((current) =>
                  current.map((thread) =>
                    thread.id === chat.id ? { ...thread, title: nextTitle } : thread,
                  ),
                );
                setRenaming(null);
              },
            }}
          />
        ) : null}
      </ul>
      {menuThread ? (
        <div role="menu">
          {items
            .filter((item) => item.id === "rename" || item.id === "archive")
            .map((item) => (
              <button
                role="menuitem"
                key={item.id}
                disabled={item.disabled}
                onClick={() => {
                  if (item.id === "rename") {
                    setRenaming(keyOf(menuThread));
                    setTitle(menuThread.title);
                  } else {
                    setThreads((current) =>
                      current.map((thread) =>
                        thread.id === menuThread.id
                          ? { ...thread, archivedAt: "2026-10-24T01:00:00.000Z" }
                          : thread,
                      ),
                    );
                  }
                  setMenuThread(null);
                }}
              >
                {item.label}
              </button>
            ))}
        </div>
      ) : null}
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<SidebarActionHarness />));
  await act(() => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("finds a grouped child for right-click rename and keyboard archive without affecting its parent", async () => {
  const childRow = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open side chat: Side discussion"]',
  )!;
  await act(() => childRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  const rename = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === "Rename thread",
  );
  expect(rename).toBeDefined();
  await act(() => rename!.click());
  const editor = container.querySelector<HTMLInputElement>('[aria-label="Side chat title"]')!;
  expect(editor.value).toBe("Side discussion");
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      editor,
      "Retry behavior",
    );
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() =>
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  const renamed = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open side chat: Retry behavior"]',
  );
  expect(renamed).not.toBeNull();
  expect(container.textContent).toContain("Main task");
  await act(() =>
    renamed!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
    ),
  );
  const archive = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === "Archive thread",
  );
  expect(archive).toBeDefined();
  await act(() => archive!.click());
  expect(container.textContent).not.toContain("Retry behavior");
  expect(container.textContent).toBe("Main task");
});
