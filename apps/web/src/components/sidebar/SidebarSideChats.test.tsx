// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, ThreadId } from "@starkfuture/contracts";
import { makeThreadFixture } from "../../test-fixtures";

const selection = vi.hoisted(() => ({ selectedByParent: {} as Record<string, string | null> }));
const panels = vi.hoisted(() => ({ auxiliaryPanelByThreadKey: {} as Record<string, string> }));
vi.mock("../../sideChatStore", () => ({
  useSideChatStore: (select: (state: typeof selection) => unknown) => select(selection),
}));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: (select: (state: typeof panels) => unknown) => select(panels),
}));
import { SidebarSideChats } from "./SidebarSideChats";

const parent = makeThreadFixture({ id: ThreadId.make("parent"), title: "Assess queue setup" });
const parentKey = `${parent.environmentId}:${parent.id}`;
const children = [
  makeThreadFixture({ id: ThreadId.make("sns"), title: "Do we need SNS?" }),
  makeThreadFixture({ id: ThreadId.make("delivery"), title: "What happens if delivery fails?" }),
];
let container: HTMLDivElement;
let root: Root;
const render = (chats = children) =>
  act(() =>
    root.render(
      <ul>
        <SidebarSideChats
          parent={parent}
          chats={chats}
          isParentActive
          onOpen={() => {}}
          onContextMenu={() => {}}
        />
      </ul>,
    ),
  );
const toggle = () =>
  act(() => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  selection.selectedByParent = {};
  panels.auxiliaryPanelByThreadKey = {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("starts collapsed, reveals actual saved titles, and remembers the disclosure after remount", async () => {
  await render();
  expect(container.textContent).toBe("Side chats 2");
  expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
    "false",
  );
  await toggle();
  expect(container.textContent).toContain("Do we need SNS?");
  expect(container.textContent).toContain("What happens if delivery fails?");
  await act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(container.textContent).toContain("Do we need SNS?");
  await toggle();
  expect(container.textContent).not.toContain("Do we need SNS?");
});

it("marks only the visible selected child and keeps attention discoverable while collapsed", async () => {
  selection.selectedByParent[parentKey] = children[0]!.id;
  panels.auxiliaryPanelByThreadKey[parentKey] = "side-work";
  const waiting = [{ ...children[0]!, hasPendingUserInput: true }, children[1]!];
  await render(waiting);
  expect(container.querySelector('[title="Needs you"]')).not.toBeNull();
  await toggle();
  expect(container.querySelector('[aria-current="true"]')?.textContent).toBe("Do we need SNS?");
  panels.auxiliaryPanelByThreadKey[parentKey] = "pages";
  await render(waiting);
  expect(container.querySelector('[aria-current="true"]')).toBeNull();
});

it("keeps a failed child visible as an attention hint even before expanding", async () => {
  await render([
    {
      ...children[0]!,
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: "Plan limit reached",
        lastErrorClass: "usage_limit",
        updatedAt: "2026-10-23T12:00:00.000Z",
      },
    },
  ]);
  expect(container.querySelector('[title="Needs attention"]')).not.toBeNull();
  expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
    "false",
  );
});
