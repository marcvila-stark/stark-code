// @vitest-environment jsdom

import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import type { EnvironmentThreadShell } from "@starkfuture/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@starkfuture/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  threads: [] as readonly EnvironmentThreadShell[],
  allowed: true,
  update: vi.fn(),
  connected: [] as EnvironmentId[],
  configs: new Map<
    EnvironmentId,
    { environment: { capabilities: { threadSideChats?: boolean } } }
  >(),
}));
vi.mock("../../state/entities", () => ({
  useThreadShells: () => state.threads,
  useServerConfigs: () => state.configs,
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => state.allowed,
  useEnvironmentsWithScope: () => new Set(state.allowed ? state.connected : []),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: "update" } }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.update,
}));
vi.mock("../../state/environments", () => ({
  useConnectedEnvironmentIds: () => state.connected,
}));

import { SideChatMigration } from "./SideChatMigration";

const parent = makeThreadFixture({ id: ThreadId.make("main"), title: "Main task" });
const child = makeThreadFixture({ id: ThreadId.make("side"), title: "Why this approach?" });
const otherChild = makeThreadFixture({ id: ThreadId.make("other-side") });
const key = `stark-code:side-work:${scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id))}`;
const record = { threadId: child.id, kind: "question", title: child.title };
const format = { threadId: "format", kind: "format", title: "Earlier visual answer" };
let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(() => root.render(<SideChatMigration />));
}

async function remount() {
  await act(() => root.unmount());
  root = createRoot(container);
  await render();
}

async function observeLinks(...ids: ThreadId[]) {
  const linked = new Set(ids);
  state.threads = state.threads.map((thread) =>
    linked.has(thread.id)
      ? {
          ...thread,
          lineage: {
            parentThreadId: parent.id,
            rootThreadId: parent.id,
            relationshipToParent: "side_chat" as const,
          },
        }
      : thread,
  );
  await render();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  state.allowed = true;
  state.threads = [parent, child, otherChild];
  state.connected = [parent.environmentId];
  state.configs = new Map([
    [parent.environmentId, { environment: { capabilities: { threadSideChats: true } } }],
  ]);
  state.update.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("legacy side chat migration", () => {
  it("links only the exact saved question to its parent and retains earlier formatting records", async () => {
    localStorage.setItem(key, JSON.stringify([record, format]));
    await render();

    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: parent.environmentId,
      input: { threadId: child.id, sideChatParentThreadId: parent.id },
    });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record, format]);
    await observeLinks(child.id);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([format]);

    await remount();
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([format]);
  });

  it("removes only individually observed server links and preserves failures for another attempt", async () => {
    const failedRecord = { threadId: otherChild.id, kind: "question", title: "Keep me" };
    state.update.mockImplementation(({ input }: { input: { threadId: ThreadId } }) =>
      Promise.resolve({ _tag: input.threadId === child.id ? "Success" : "Failure" }),
    );
    localStorage.setItem(key, JSON.stringify([record, failedRecord, format]));
    await render();

    expect(state.update).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record, failedRecord, format]);
    await observeLinks(child.id);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([failedRecord, format]);
    state.update.mockResolvedValue({ _tag: "Success" });
    await remount();
    expect(state.update).toHaveBeenLastCalledWith({
      environmentId: parent.environmentId,
      input: { threadId: otherChild.id, sideChatParentThreadId: parent.id },
    });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([failedRecord, format]);
    await observeLinks(otherChild.id);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([format]);
  });

  it("does not discard the sole legacy link while its write is still pending", async () => {
    let complete!: (result: { _tag: "Success" }) => void;
    state.update.mockImplementation(
      () =>
        new Promise<{ _tag: "Success" }>((resolve) => {
          complete = resolve;
        }),
    );
    localStorage.setItem(key, JSON.stringify([record]));
    await render();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record]);

    await act(async () => complete({ _tag: "Success" }));
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record]);
    await observeLinks(child.id);
    expect(localStorage.getItem(key)).toBeNull();
    await remount();
    expect(state.update).toHaveBeenCalledTimes(1);
  });

  it("does not guess parent links from titles or from a parent in another environment", async () => {
    state.threads = [
      parent,
      makeThreadFixture({ id: child.id, title: `Side question: ${parent.title}` }),
    ];
    await render();
    expect(state.update).not.toHaveBeenCalled();

    const otherKey = `stark-code:side-work:${scopedThreadKey(
      scopeThreadRef(EnvironmentId.make("another-environment"), parent.id),
    )}`;
    localStorage.setItem(otherKey, JSON.stringify([record]));
    await remount();
    expect(state.update).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(otherKey)!)).toEqual([record]);
  });

  it("leaves saved links untouched when this connection cannot update chats", async () => {
    state.allowed = false;
    localStorage.setItem(key, JSON.stringify([record, format]));
    await render();
    expect(state.update).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record, format]);
  });

  it("retries a failed write after reconnect without repeatedly retrying on ordinary renders", async () => {
    state.update.mockResolvedValue({ _tag: "Failure" });
    localStorage.setItem(key, JSON.stringify([record]));
    await render();
    expect(state.update).toHaveBeenCalledTimes(1);
    state.threads = [...state.threads];
    await render();
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record]);

    state.connected = [];
    await render();
    expect(state.update).toHaveBeenCalledTimes(1);
    state.connected = [parent.environmentId];
    state.update.mockResolvedValue({ _tag: "Success" });
    await render();
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record]);
    await observeLinks(child.id);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("migrates when this connection gains permission without restarting the app", async () => {
    state.allowed = false;
    localStorage.setItem(key, JSON.stringify([record]));
    await render();
    expect(state.update).not.toHaveBeenCalled();
    state.allowed = true;
    await render();
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record]);
    await observeLinks(child.id);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it.each([false, undefined])(
    "does not trust a successful RPC result when the server capability is %j",
    async (threadSideChats) => {
      state.configs = new Map([
        [
          parent.environmentId,
          {
            environment: { capabilities: threadSideChats === undefined ? {} : { threadSideChats } },
          },
        ],
      ]);
      state.update.mockResolvedValue({ _tag: "Success" });
      localStorage.setItem(key, JSON.stringify([record, format]));
      await render();
      expect(state.update).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record, format]);
      await remount();
      expect(state.update).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record, format]);
    },
  );

  it("keeps acknowledged but unprojected links across restarts", async () => {
    localStorage.setItem(key, JSON.stringify([record]));
    await render();
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record]);
    await remount();
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record]);
  });

  it("cleans an already projected link without issuing a redundant mutation", async () => {
    state.threads = [
      parent,
      {
        ...child,
        lineage: {
          parentThreadId: parent.id,
          rootThreadId: parent.id,
          relationshipToParent: "side_chat",
        },
      },
    ];
    localStorage.setItem(key, JSON.stringify([record, format]));
    await render();
    expect(state.update).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([format]);
  });

  it("migrates more than forty legacy questions without deleting unknown or formatting records", async () => {
    const children = Array.from({ length: 45 }, (_, index) =>
      makeThreadFixture({ id: ThreadId.make(`side-${index}`) }),
    );
    const records = children.map((thread) => ({
      threadId: thread.id,
      kind: "question",
      title: `Question ${thread.id}`,
    }));
    const unknown = [
      { threadId: "future-record", kind: "future", payload: { keep: true } },
      null,
      "future metadata",
    ];
    state.threads = [parent, ...children];
    localStorage.setItem(key, JSON.stringify([...records, format, ...unknown]));
    await render();
    expect(state.update).toHaveBeenCalledTimes(45);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([...records, format, ...unknown]);
    await observeLinks(children[0]!.id);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([
      ...records.slice(1),
      format,
      ...unknown,
    ]);
    await observeLinks(...children.map((thread) => thread.id));
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([format, ...unknown]);
  });

  it("notices a legacy question added by another window after the initial scan", async () => {
    await render();
    expect(state.update).not.toHaveBeenCalled();
    localStorage.setItem(key, JSON.stringify([record]));
    await act(() => window.dispatchEvent(new StorageEvent("storage", { key })));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: parent.environmentId,
      input: { threadId: child.id, sideChatParentThreadId: parent.id },
    });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record]);
  });

  it.each(["fork", "subagent", "side_chat"] as const)(
    "does not overwrite an existing %s relationship with a stale legacy link",
    async (relationshipToParent) => {
      state.threads = [
        parent,
        makeThreadFixture({
          id: child.id,
          lineage: {
            parentThreadId: otherChild.id,
            rootThreadId: otherChild.id,
            relationshipToParent,
          },
        }),
        otherChild,
      ];
      localStorage.setItem(key, JSON.stringify([record]));
      await render();
      expect(state.update).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual([record]);
    },
  );

  it("leaves malformed legacy data untouched", async () => {
    localStorage.setItem(key, "not valid JSON");
    await render();
    expect(state.update).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe("not valid JSON");
  });
});
