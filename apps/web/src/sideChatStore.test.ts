// @vitest-environment jsdom

import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@starkfuture/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useRightPanelStore } from "./rightPanelStore";
import { openSideChat, useSideChatStore } from "./sideChatStore";

const parentA = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("parent"));
const parentB = scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("parent"));
const childA = ThreadId.make("child-a");
const childB = ThreadId.make("child-b");
const keyA = scopedThreadKey(parentA);
const keyB = scopedThreadKey(parentB);
const draftA = scopedThreadKey(scopeThreadRef(parentA.environmentId, childA));
const draftB = scopedThreadKey(scopeThreadRef(parentB.environmentId, childB));

beforeEach(() => {
  localStorage.clear();
  useSideChatStore.setState({ selectedByParent: {}, draftsByChat: {}, scrollByChat: {} });
  useRightPanelStore.setState({
    byThreadKey: {},
    auxiliaryPanelByThreadKey: {},
    threadPanelInlineOpen: true,
    threadPanelPopoverOpenByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

describe("saved side chat views", () => {
  it("restores each parent's selected chat, unfinished draft, and reading position after rehydration", async () => {
    const state = useSideChatStore.getState();
    state.select(parentA, childA);
    state.select(parentB, childB);
    state.setDraft(draftA, "A follow-up I have not sent");
    state.setDraft(draftB, "A different follow-up");
    state.setScroll(draftA, 347);
    state.setScroll(draftB, 912);

    const { name, storage } = useSideChatStore.persist.getOptions();
    const saved = await storage!.getItem(name!);
    expect(saved).not.toBeNull();
    // Model a fresh in-memory store loading the persisted view state.
    useSideChatStore.setState({ selectedByParent: {}, draftsByChat: {}, scrollByChat: {} });
    await storage!.setItem(name!, saved!);
    await useSideChatStore.persist.rehydrate();

    expect(useSideChatStore.getState()).toMatchObject({
      selectedByParent: { [keyA]: childA, [keyB]: childB },
      draftsByChat: {
        [draftA]: "A follow-up I have not sent",
        [draftB]: "A different follow-up",
      },
      scrollByChat: { [draftA]: 347, [draftB]: 912 },
    });
    // A restored view remains editable; hydrating must not replace store actions.
    useSideChatStore.getState().setDraft(draftA, "Edited after restart");
    expect(useSideChatStore.getState().draftsByChat[draftA]).toBe("Edited after restart");
    expect(useSideChatStore.getState().draftsByChat[draftB]).toBe("A different follow-up");
  });

  it("keeps identical parent IDs in different environments independent", () => {
    const state = useSideChatStore.getState();
    state.select(parentA, childA);
    state.select(parentB, childB);
    state.setDraft(draftA, "Keep this draft");
    state.setScroll(draftA, 120);
    state.select(parentA, null);

    expect(useSideChatStore.getState().selectedByParent).toEqual({
      [keyA]: null,
      [keyB]: childB,
    });
    expect(useSideChatStore.getState().draftsByChat[draftA]).toBe("Keep this draft");
    expect(useSideChatStore.getState().scrollByChat[draftA]).toBe(120);
  });

  it("reopens a child beside its own parent and closing the panel retains its view state", () => {
    useRightPanelStore.getState().openAuxiliary(parentB, "pages");
    useSideChatStore.getState().setDraft(draftA, "Unsent child draft");
    useSideChatStore.getState().setScroll(draftA, 80);
    openSideChat(parentA, childA);

    expect(useRightPanelStore.getState().auxiliaryPanelByThreadKey).toMatchObject({
      [keyA]: "side-work",
      [keyB]: "pages",
    });
    expect(useSideChatStore.getState().selectedByParent[keyA]).toBe(childA);

    useRightPanelStore.getState().close(parentA);
    openSideChat(parentA, childA);
    expect(useSideChatStore.getState().draftsByChat[draftA]).toBe("Unsent child draft");
    expect(useSideChatStore.getState().scrollByChat[draftA]).toBe(80);
    expect(useRightPanelStore.getState().auxiliaryPanelByThreadKey[keyB]).toBe("pages");
  });
});
