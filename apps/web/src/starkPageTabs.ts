import { create } from "zustand";
import { randomUUID } from "./lib/utils";

export type StarkPageTarget =
  | { readonly kind: "local"; readonly slug: string; readonly title: string }
  | {
      readonly kind: "published";
      readonly root: string;
      readonly path: string;
      readonly title: string;
    };

export type StarkPageTab = { readonly id: string; readonly page: StarkPageTarget };
type ConversationPages = {
  readonly pages: readonly StarkPageTab[];
  readonly activeTabId: string;
};
const EMPTY: ConversationPages = { pages: [], activeTabId: "chat" };
const samePage = (left: StarkPageTarget, right: StarkPageTarget) =>
  left.kind === "local"
    ? right.kind === "local" && left.slug === right.slug
    : right.kind === "published" && left.root === right.root && left.path === right.path;

/** Only open-view metadata lives here, scoped to a chat and working folder. */
export const useStarkPageTabs = create<{
  byWorkspace: Readonly<Record<string, ConversationPages>>;
  open: (workspace: string, page: StarkPageTarget) => void;
  select: (workspace: string, id: string) => void;
  close: (workspace: string, id: string) => void;
  navigate: (workspace: string, id: string, page: StarkPageTarget) => void;
}>((set) => ({
  byWorkspace: {},
  open: (workspace, page) =>
    set((state) => {
      const current = state.byWorkspace[workspace] ?? EMPTY;
      const existing = current.pages.find((tab) => samePage(tab.page, page));
      const id = existing?.id ?? `page:${randomUUID()}`;
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [workspace]: {
            pages: existing
              ? current.pages.map((tab) => (tab.id === id ? { id, page } : tab))
              : [...current.pages, { id, page }],
            activeTabId: id,
          },
        },
      };
    }),
  select: (workspace, id) =>
    set((state) => {
      const current = state.byWorkspace[workspace] ?? EMPTY;
      if (id !== "chat" && !current.pages.some((tab) => tab.id === id)) return state;
      return {
        byWorkspace: { ...state.byWorkspace, [workspace]: { ...current, activeTabId: id } },
      };
    }),
  close: (workspace, id) =>
    set((state) => {
      const current = state.byWorkspace[workspace] ?? EMPTY;
      if (id === "chat" || !current.pages.some((tab) => tab.id === id)) return state;
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [workspace]: {
            pages: current.pages.filter((tab) => tab.id !== id),
            activeTabId: current.activeTabId === id ? "chat" : current.activeTabId,
          },
        },
      };
    }),
  navigate: (workspace, id, page) =>
    set((state) => {
      const current = state.byWorkspace[workspace] ?? EMPTY;
      // A late iframe/read result must never reopen a closed tab or steal focus.
      if (!current.pages.some((tab) => tab.id === id)) return state;
      const existing = current.pages.find((tab) => tab.id !== id && samePage(tab.page, page));
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [workspace]: {
            pages: existing
              ? current.pages.filter((tab) => tab.id !== id)
              : current.pages.map((tab) => (tab.id === id ? { id, page } : tab)),
            activeTabId: current.activeTabId === id ? (existing?.id ?? id) : current.activeTabId,
          },
        },
      };
    }),
}));

export const selectStarkPageTabs = (
  state: Pick<ReturnType<typeof useStarkPageTabs.getState>, "byWorkspace">,
  workspace: string | null,
): ConversationPages => (workspace ? (state.byWorkspace[workspace] ?? EMPTY) : EMPTY);
