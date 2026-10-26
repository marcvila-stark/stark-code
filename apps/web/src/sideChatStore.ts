import { scopedThreadKey } from "@starkfuture/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@starkfuture/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { useRightPanelStore } from "./rightPanelStore";

interface SideChatState {
  selectedByParent: Record<string, ThreadId | null>;
  draftsByChat: Record<string, string>;
  scrollByChat: Record<string, number>;
  select: (parent: ScopedThreadRef, childId: ThreadId | null) => void;
  setDraft: (key: string, draft: string) => void;
  setScroll: (key: string, scrollTop: number) => void;
}

/** Only view preferences live here. Chat messages and parent links live on the server. */
export const useSideChatStore = create<SideChatState>()(
  persist(
    (set) => ({
      selectedByParent: {},
      draftsByChat: {},
      scrollByChat: {},
      select: (parent, childId) =>
        set((state) => ({
          selectedByParent: { ...state.selectedByParent, [scopedThreadKey(parent)]: childId },
        })),
      setDraft: (key, draft) =>
        set((state) => {
          const draftsByChat = { ...state.draftsByChat };
          if (draft) draftsByChat[key] = draft;
          else delete draftsByChat[key];
          return { draftsByChat };
        }),
      setScroll: (key, scrollTop) =>
        set((state) => ({ scrollByChat: { ...state.scrollByChat, [key]: scrollTop } })),
    }),
    {
      name: "stark-code:side-chat-view:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ selectedByParent, draftsByChat, scrollByChat }) => ({
        selectedByParent,
        draftsByChat,
        scrollByChat,
      }),
    },
  ),
);

export function openSideChat(parent: ScopedThreadRef, childId: ThreadId) {
  useSideChatStore.getState().select(parent, childId);
  useRightPanelStore.getState().openAuxiliary(parent, "side-work");
}
