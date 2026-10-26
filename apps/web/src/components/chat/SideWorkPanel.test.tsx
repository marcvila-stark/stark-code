// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  PlanId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
} from "@starkfuture/contracts";
import type { EnvironmentThreadShell } from "@starkfuture/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { makeThreadFixture, makeThreadProjectionFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  supportsSideChats: true,
  allowed: true,
  start: vi.fn(),
  interrupt: vi.fn(),
  approve: vi.fn(),
  update: vi.fn(),
  child: null as EnvironmentThreadShell | null,
  projection: null as OrchestrationV2ThreadProjection | null,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    startTurn: "start",
    interruptTurn: "interrupt",
    respondToApproval: "approve",
    updateMetadata: "update",
  },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: "start" | "interrupt" | "approve" | "update") =>
    state[command],
}));
vi.mock("../../state/entities", () => ({
  useAllEnvironmentShellsBootstrapped: () => true,
  useServerConfigs: () =>
    new Map([
      [
        parent.environmentId,
        { environment: { capabilities: { threadSideChats: state.supportsSideChats } } },
      ],
    ]),
  useThreadShells: () => (state.child ? [state.child] : []),
  useThreadShell: (ref: { threadId: string } | null) =>
    ref?.threadId === state.child?.id ? state.child : null,
  useThreadProjection: (ref: { threadId: string } | null) =>
    ref?.threadId === state.child?.id && state.projection ? { projection: state.projection } : null,
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("./HtmlRenderFrame", () => ({
  HtmlRenderFrame: ({ htmlRender }: { htmlRender: { title: string } }) => (
    <div aria-label="HTML result">{htmlRender.title}</div>
  ),
}));

import { useSideChatStore } from "../../sideChatStore";
import { SideWorkPanel } from "./SideWorkPanel";

let root: Root;
let container: HTMLDivElement;
const parent = makeThreadFixture({ runtimeMode: "full-access" });
const onOpen = vi.fn();
const bringBack = vi.fn();
const now = DateTime.makeUnsafe("2026-10-15T00:00:00Z");
function answer(text: string, threadId = parent.id): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make("answer"),
    threadId,
    runId: null,
    nodeId: null,
    role: "assistant",
    text,
    attachments: [],
    streaming: false,
    createdBy: "agent",
    creationSource: "provider",
    createdAt: now,
    updatedAt: now,
  };
}
const projection = {
  ...makeThreadProjectionFixture(),
  messages: [answer("Main answer to visualize")],
};
async function render(nativeShellMode = false, messages = projection.messages) {
  await act(() =>
    root.render(
      <SideWorkPanel
        parent={parent}
        projection={{ ...projection, messages }}
        workspaceRoot="/work"
        nativeShellMode={nativeShellMode}
        onOpenThread={onOpen}
        onBringBack={bringBack}
        onClose={() => undefined}
      />,
    ),
  );
}
function button(text: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) =>
      element.textContent?.trim() === text || element.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function type(label: string, value: string) {
  const input = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(text: string) {
  await act(() => button(text).click());
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useSideChatStore.setState({ selectedByParent: {}, draftsByChat: {}, scrollByChat: {} });
  state.allowed = true;
  state.supportsSideChats = true;
  state.child = null;
  state.projection = null;
  state.start.mockReset().mockResolvedValue({ _tag: "Success" });
  state.interrupt.mockReset().mockResolvedValue({ _tag: "Success" });
  state.approve.mockReset().mockResolvedValue({ _tag: "Success" });
  onOpen.mockClear();
  bringBack.mockReset().mockReturnValue(true);
  state.update.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("preserves a pending side chat's title when sending a follow-up", async () => {
  await type("Side question", "Original side question");
  await click("Ask in side chat");
  await type("Side chat follow-up", "A different follow-up");
  await click("Send follow-up");
  expect(container.textContent).toContain("Original side question");
  expect(container.textContent).not.toContain("A different follow-up");
  expect(state.start).toHaveBeenCalledTimes(2);
});

it("blocks creation when the server cannot save lineage, even through a form submit", async () => {
  state.supportsSideChats = false;
  await render();
  await type("Side question", "Keep my question");
  expect(button("Ask in side chat").disabled).toBe(true);
  await act(() =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(state.start).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")?.value).toBe("Keep my question");
  expect(container.textContent).toContain("Update this connection");
});

it("starts a linked side question and shows its live response without navigating the main chat", async () => {
  await type("Side question", "Why is this approach useful?");
  await click("Ask in side chat");
  const call = state.start.mock.calls[0]![0];
  expect(call.input.threadId).not.toBe(parent.id);
  expect(call.input.runtimeMode).toBe("approval-required");
  expect(call.input.message.text).toContain("Main answer to visualize");
  expect(onOpen).not.toHaveBeenCalled();
  state.child = makeThreadFixture({
    id: ThreadId.make(call.input.threadId),
    title: "Side question",
  });
  state.projection = {
    ...makeThreadProjectionFixture(),
    messages: [answer("Independent answer", state.child.id)],
  };
  await render();
  expect(container.textContent).toContain("Independent answer");
  expect(button("Side chat history")).not.toBeNull();
  await click("Open side chat in main view");
  expect(onOpen).toHaveBeenCalledWith(call.input.threadId);
});

it("shows only the focused side chat and keeps unrelated tools out of its empty state", async () => {
  expect(container.textContent).toContain("Explore a side question");
  expect(container.querySelector('[aria-label="Side chat history"]')).toBeNull();
  expect(container.querySelector("select")).toBeNull();
  for (const label of ["Reader", "Bookmarks", "Agents", "Checks", "Review"]) {
    expect(
      [...container.querySelectorAll("button")].some(
        (element) => element.textContent?.trim() === label,
      ),
    ).toBe(false);
  }
  expect(state.start).not.toHaveBeenCalled();
});

it("explains native context explicitly and never copies the main chat into the side question", async () => {
  await render(true);
  expect(container.textContent).toContain("Terminal output is not included automatically");
  await type("Side question", "What does this output mean?");
  await click("Ask in side chat");
  expect(state.start.mock.calls[0]![0].input.message.text).not.toContain(
    "Main answer to visualize",
  );
});

it("keeps saved side chats and earlier formatting chats accessible from one history menu", async () => {
  const saved = [
    {
      threadId: ThreadId.make("saved-side"),
      kind: "question",
      title: "Side question: Earlier decision",
    },
    {
      threadId: ThreadId.make("saved-format"),
      kind: "format",
      title: "Visual response: Earlier answer",
    },
  ];
  const storageKey = `stark-code:side-work:${scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id))}`;
  localStorage.setItem(storageKey, JSON.stringify(saved));
  await act(() => root.unmount());
  root = createRoot(container);
  await render();
  await click("Side chat history");
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === label,
    )!;
  expect(menuItem("New side chat")).not.toBeNull();
  await act(() => menuItem("Earlier decision").click());
  expect(container.textContent).toContain("Earlier decision");
  expect(button("Send follow-up")).not.toBeNull();
  await click("Side chat history");
  await act(() => menuItem("New side chat").click());
  expect(container.textContent).toContain("Explore a side question");
  await click("Side chat history");
  await act(() => menuItem("Visual response: Earlier answer").click());
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("saved-format");
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  expect(state.start).not.toHaveBeenCalled();
});

it("keeps side work unavailable to a connection without thread permissions", async () => {
  state.allowed = false;
  await render();
  expect(button("Ask in side chat").disabled).toBe(true);
  await act(() =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(state.start).not.toHaveBeenCalled();
});

it("stops only the selected side chat and never submits another turn while it is running", async () => {
  await type("Side question", "Explain the choice");
  await click("Ask in side chat");
  const threadId = ThreadId.make(state.start.mock.calls[0]![0].input.threadId);
  const child = makeThreadFixture({ id: threadId });
  state.child = { ...child, runtime: { ...child.runtime!, status: "running" } };
  await render();
  await type("Side chat follow-up", "More detail");
  await act(() =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(state.start).toHaveBeenCalledOnce();
  await click("Stop side chat");
  expect(state.interrupt).toHaveBeenCalledExactlyOnceWith({
    environmentId: parent.environmentId,
    input: { threadId },
  });
});

it("keeps approval controls scoped to the side chat and disables them for read-only or expired sessions", async () => {
  await type("Side question", "Explain the choice");
  await click("Ask in side chat");
  const threadId = ThreadId.make(state.start.mock.calls[0]![0].input.threadId);
  state.child = makeThreadFixture({ id: threadId, hasPendingApprovals: true });
  const requestId = RuntimeRequestId.make("side-approval");
  state.projection = {
    ...makeThreadProjectionFixture(),
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("side-approval-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("side-provider"),
        },
        createdAt: now,
        resolvedAt: null,
      },
    ],
  };
  state.allowed = false;
  await render();
  expect(button("Approve").disabled).toBe(true);
  await click("Approve");
  expect(state.approve).not.toHaveBeenCalled();
  state.allowed = true;
  await render();
  await click("Approve");
  expect(state.approve).toHaveBeenCalledExactlyOnceWith({
    environmentId: parent.environmentId,
    input: { threadId, requestId, decision: "accept" },
  });
  state.projection = {
    ...state.projection,
    runtimeRequests: state.projection.runtimeRequests.map((request) => ({
      ...request,
      responseCapability: { type: "not_resumable", reason: "Provider stopped" },
    })),
  };
  await render();
  expect(button("Approve").disabled).toBe(true);
});

it("restores a durable child and its unfinished draft after remount without legacy storage", async () => {
  state.child = makeThreadFixture({
    id: ThreadId.make("durable-child"),
    title: "Explain retries",
    lineage: {
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      relationshipToParent: "side_chat",
    },
  });
  state.projection = {
    ...makeThreadProjectionFixture(),
    messages: [answer("Saved answer", state.child.id)],
  };
  await render();
  expect(container.textContent).toContain("Saved answer");
  await type("Side chat follow-up", "Unfinished follow-up");
  await act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain("Saved answer");
  expect(container.querySelector("textarea")?.value).toBe("Unfinished follow-up");
  expect(state.start).not.toHaveBeenCalled();
});

it("brings a completed response into an editable main draft without starting either agent", async () => {
  state.child = makeThreadFixture({
    id: ThreadId.make("quote-child"),
    title: "Side question: Delivery failure",
    lineage: {
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      relationshipToParent: "side_chat",
    },
  });
  state.projection = {
    ...makeThreadProjectionFixture(),
    messages: [answer("Keep the retry queue.", state.child.id)],
  };
  await render();
  await click("Bring back to main chat");
  expect(bringBack).toHaveBeenCalledExactlyOnceWith(
    "Keep the retry queue.",
    "Side chat · Delivery failure",
  );
  expect(container.textContent).toContain("Added to draft");
  expect(state.start).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

it("does not offer incomplete streaming text to bring back", async () => {
  state.child = makeThreadFixture({
    id: ThreadId.make("streaming-child"),
    lineage: {
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      relationshipToParent: "side_chat",
    },
  });
  state.projection = {
    ...makeThreadProjectionFixture(),
    messages: [{ ...answer("Still writing", state.child.id), streaming: true }],
  };
  await render();
  expect(container.textContent).not.toContain("Bring back to main chat");
  expect(bringBack).not.toHaveBeenCalled();
});

it("shows a plan-only answer and brings the completed plan into the main draft without sending", async () => {
  state.child = makeThreadFixture({
    id: ThreadId.make("plan-child"),
    title: "Retry design",
    lineage: {
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      relationshipToParent: "side_chat",
    },
  });
  state.projection = {
    ...makeThreadProjectionFixture(),
    messages: [],
    turnItems: [
      {
        id: TurnItemId.make("side-plan-item"),
        threadId: state.child.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "running",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "proposed_plan",
        planId: PlanId.make("side-plan"),
        markdown: "Add bounded retries and a dead-letter queue.",
        streaming: true,
      },
    ],
  };
  await render();
  expect(container.textContent).toContain("Add bounded retries and a dead-letter queue.");
  expect(container.textContent).not.toContain("Bring back to main chat");
  state.projection = {
    ...state.projection,
    turnItems: state.projection.turnItems.map((item) => ({
      ...item,
      status: "completed",
      completedAt: now,
      streaming: false,
    })),
  };
  await render();
  await click("Bring back to main chat");
  expect(bringBack).toHaveBeenCalledExactlyOnceWith(
    "Add bounded retries and a dead-letter queue.",
    "Side chat · Retry design",
  );
  expect(container.textContent).toContain("Added to draft");
  expect(state.start).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});
