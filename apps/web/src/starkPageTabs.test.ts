import { beforeEach, expect, it } from "vite-plus/test";

import { selectStarkPageTabs, useStarkPageTabs, type StarkPageTarget } from "./starkPageTabs";

const workspace = JSON.stringify(["env-a:chat-a", "/work"]);
const otherChat = JSON.stringify(["env-a:chat-b", "/work"]);
const otherFolder = JSON.stringify(["env-a:chat-a", "/work/another-folder"]);
const otherEnvironment = JSON.stringify(["env-b:chat-a", "/work"]);
const localPage: StarkPageTarget = { kind: "local", slug: "launch", title: "Launch notes" };
const secondLocalPage: StarkPageTarget = { kind: "local", slug: "services", title: "Services" };
const publishedPage: StarkPageTarget = {
  kind: "published",
  root: "stark/engineering",
  path: "launch/index.html",
  title: "Published launch notes",
};
const current = (scope: string | null = workspace) =>
  selectStarkPageTabs(useStarkPageTabs.getState(), scope);
const open = (page: StarkPageTarget, scope = workspace) => {
  useStarkPageTabs.getState().open(scope, page);
  return current(scope).activeTabId;
};

beforeEach(() => useStarkPageTabs.setState({ byWorkspace: {} }));

it("starts every chat in Chat with no pre-opened pages", () => {
  expect(current()).toEqual({ pages: [], activeTabId: "chat" });
  expect(current(null)).toEqual({ pages: [], activeTabId: "chat" });
  expect(current()).toBe(current(otherChat));
  expect(useStarkPageTabs.getState().byWorkspace).toEqual({});
});

it("opens only the requested page and returns to Chat when it closes", () => {
  const id = open(localPage);
  expect(id).not.toBe("chat");
  expect(current()).toEqual({ pages: [{ id, page: localPage }], activeTabId: id });
  useStarkPageTabs.getState().close(workspace, id);
  expect(current()).toEqual({ pages: [], activeTabId: "chat" });
});

it("reuses an existing local slug and refreshes its name without duplicating the tab", () => {
  const id = open(localPage);
  open(secondLocalPage);
  const renamed = { ...localPage, title: "Final launch notes" };
  expect(open(renamed)).toBe(id);
  expect(current().pages).toHaveLength(2);
  expect(current().pages[0]).toEqual({ id, page: renamed });
  expect(current().activeTabId).toBe(id);
});

it("identifies published pages by both root and path and keeps local pages separate", () => {
  const id = open(publishedPage);
  expect(open({ ...publishedPage, title: "Renamed published notes" })).toBe(id);
  const otherRoot = open({ ...publishedPage, root: "stark/product" });
  const otherPath = open({ ...publishedPage, path: "services/index.html" });
  const localId = open({ kind: "local", slug: publishedPage.path, title: publishedPage.title });
  expect(new Set([id, otherRoot, otherPath, localId]).size).toBe(4);
  expect(current().pages).toHaveLength(4);
});

it("keeps open pages and selection isolated by chat, working folder, and environment", () => {
  const first = open(localPage);
  const chatId = open(secondLocalPage, otherChat);
  const folderId = open(publishedPage, otherFolder);
  const environmentId = open(localPage, otherEnvironment);
  useStarkPageTabs.getState().select(workspace, "chat");
  useStarkPageTabs.getState().close(otherChat, chatId);
  expect(current()).toEqual({ pages: [{ id: first, page: localPage }], activeTabId: "chat" });
  expect(current(otherChat)).toEqual({ pages: [], activeTabId: "chat" });
  expect(current(otherFolder)).toEqual({
    pages: [{ id: folderId, page: publishedPage }],
    activeTabId: folderId,
  });
  expect(current(otherEnvironment)).toEqual({
    pages: [{ id: environmentId, page: localPage }],
    activeTabId: environmentId,
  });
});

it("preserves the selected page when a different page closes", () => {
  const first = open(localPage);
  const selected = open(secondLocalPage);
  useStarkPageTabs.getState().close(workspace, first);
  expect(current()).toEqual({
    pages: [{ id: selected, page: secondLocalPage }],
    activeTabId: selected,
  });
});

it("returns to Chat when the selected page closes, keeping other pages available", () => {
  const first = open(localPage);
  const selected = open(secondLocalPage);
  useStarkPageTabs.getState().close(workspace, selected);
  expect(current()).toEqual({ pages: [{ id: first, page: localPage }], activeTabId: "chat" });
  useStarkPageTabs.getState().select(workspace, first);
  expect(current().activeTabId).toBe(first);
});

it("cannot close Chat or select a page owned by another scope", () => {
  const id = open(localPage, otherChat);
  useStarkPageTabs.getState().close(workspace, "chat");
  useStarkPageTabs.getState().select(workspace, id);
  expect(current()).toEqual({ pages: [], activeTabId: "chat" });
  expect(useStarkPageTabs.getState().byWorkspace[workspace]).toBeUndefined();
});

it("ignores a late navigation result after its page closes", () => {
  const id = open(localPage);
  useStarkPageTabs.getState().close(workspace, id);
  const before = useStarkPageTabs.getState();
  useStarkPageTabs.getState().navigate(workspace, id, secondLocalPage);
  expect(useStarkPageTabs.getState()).toBe(before);
  expect(current()).toEqual({ pages: [], activeTabId: "chat" });
});

it("cannot let a closed frame change a later reopening of the same page", () => {
  const closedId = open(localPage);
  useStarkPageTabs.getState().close(workspace, closedId);
  const reopenedId = open(localPage);
  expect(reopenedId).not.toBe(closedId);
  useStarkPageTabs.getState().navigate(workspace, closedId, secondLocalPage);
  expect(current()).toEqual({
    pages: [{ id: reopenedId, page: localPage }],
    activeTabId: reopenedId,
  });
});

it("updates an inactive page's destination without stealing focus from Chat", () => {
  const id = open(localPage);
  useStarkPageTabs.getState().select(workspace, "chat");
  useStarkPageTabs.getState().navigate(workspace, id, secondLocalPage);
  expect(current()).toEqual({ pages: [{ id, page: secondLocalPage }], activeTabId: "chat" });
});

it("preserves another page's selection when a late navigation arrives", () => {
  const backgroundId = open(localPage);
  const selected = open(publishedPage);
  useStarkPageTabs.getState().navigate(workspace, backgroundId, secondLocalPage);
  expect(current().activeTabId).toBe(selected);
  expect(current().pages).toEqual([
    { id: backgroundId, page: secondLocalPage },
    { id: selected, page: publishedPage },
  ]);
});

it("merges navigation into an already open page and selects the surviving tab", () => {
  const destination = open(secondLocalPage);
  const source = open(localPage);
  useStarkPageTabs.getState().navigate(workspace, source, secondLocalPage);
  expect(current()).toEqual({
    pages: [{ id: destination, page: secondLocalPage }],
    activeTabId: destination,
  });
});

it("merges background navigation into an existing page without moving selection", () => {
  const destination = open(publishedPage);
  const source = open(localPage);
  const selected = open(secondLocalPage);
  useStarkPageTabs.getState().navigate(workspace, source, publishedPage);
  expect(current()).toEqual({
    pages: [
      { id: destination, page: publishedPage },
      { id: selected, page: secondLocalPage },
    ],
    activeTabId: selected,
  });
});
