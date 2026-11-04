import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationSearchThreadHistoryInput,
  type OrchestrationSearchThreadHistoryResult,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadHistoryEntry,
} from "@starkfuture/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createThreadHistoryResultsAtomFamily,
  createThreadSearchResultsAtomFamily,
  makeThreadHistoryKey,
  makeThreadSearchKey,
  mergeThreadHistoryPages,
  threadSearchMatchKey,
} from "./threadSearch.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

it("creates stable keys regardless of environment order", () => {
  expect(makeThreadSearchKey([envB, envA], "needle")).toBe(
    makeThreadSearchKey([envA, envB], "needle"),
  );
});

it("creates keys without array methods unavailable in Hermes", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  Reflect.deleteProperty(Array.prototype, "toSorted");

  try {
    expect(makeThreadSearchKey([envB, envA], "needle")).toBe('[["env-a","env-b"],"needle"]');
  } finally {
    if (descriptor !== undefined) {
      Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  }
});

it("encodes scoped thread keys without delimiter collisions", () => {
  const first = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env\u0000thread"),
    threadId: ThreadId.make("id"),
  });
  const second = threadSearchMatchKey({
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread\u0000id"),
  });

  expect(first).not.toBe(second);
});

it("accepts search keys at the maximum decoded query length", () => {
  const queries: string[] = [];
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (_environmentId, query) => {
      queries.push(query);
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();
  const query = "a".repeat(200);

  try {
    registry.get(searchAtom(makeThreadSearchKey([envA], query)));
    registry.get(searchAtom(makeThreadSearchKey([envA], ` ${query} `)));

    expect(queries).toEqual([query, query]);
  } finally {
    registry.dispose();
  }
});

it("ignores invalid search keys", () => {
  let searchCount = 0;
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: () => {
      searchCount += 1;
      return Atom.make(AsyncResult.success({ matches: [] }));
    },
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();

  try {
    const state = registry.get(searchAtom(makeThreadSearchKey([envA], "a".repeat(201))));
    const malformedState = registry.get(searchAtom("not json{{"));

    expect(state).toEqual({ matches: [], isLoading: false });
    expect(malformedState).toEqual({ matches: [], isLoading: false });
    expect(searchCount).toBe(0);
  } finally {
    registry.dispose();
  }
});

it("merges successful environments and silently ignores failures", () => {
  const result: OrchestrationSearchThreadsResult = {
    matches: [
      {
        threadId: ThreadId.make("thread-a"),
        projectId: ProjectId.make("project-a"),
        source: "user",
        snippet: "needle",
        messageCreatedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
  };
  const searchAtom = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (environmentId) =>
      environmentId === envA
        ? Atom.make(AsyncResult.success(result))
        : Atom.make(
            AsyncResult.failure<OrchestrationSearchThreadsResult, Error>(
              Cause.fail(new Error("unsupported rpc")),
            ),
          ),
    labelPrefix: "test:thread-search",
  });
  const registry = AtomRegistry.make();

  const state = registry.get(searchAtom(makeThreadSearchKey([envB, envA], "needle")));
  expect(state).toEqual({
    matches: [{ ...result.matches[0], environmentId: envA }],
    isLoading: false,
  });
  expect(threadSearchMatchKey(state.matches[0]!)).toBe('["env-a","thread-a"]');

  registry.dispose();
});

const historyEntry = (threadId: string, minute: number): OrchestrationThreadHistoryEntry => ({
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("project-a"),
  title: threadId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  origin: "stark",
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: `2026-10-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
  firstPrompt: null,
  match: null,
});
const historyPage = (
  entries: ReadonlyArray<OrchestrationThreadHistoryEntry>,
  more: boolean,
): AsyncResult.AsyncResult<OrchestrationSearchThreadHistoryResult, Error> => {
  const last = entries.at(-1);
  return AsyncResult.success({
    entries,
    nextCursor:
      more && last !== undefined ? { updatedAt: last.updatedAt, threadId: last.threadId } : null,
  });
};

it("holds back history another environment may still precede", () => {
  const state = mergeThreadHistoryPages([
    {
      environmentId: envA,
      pages: [historyPage([historyEntry("a1", 50), historyEntry("a2", 40)], true)],
    },
    {
      environmentId: envB,
      pages: [historyPage([historyEntry("b1", 45), historyEntry("b2", 10)], false)],
    },
  ]);

  // env-a may still hold threads between minute 40 and minute 10.
  expect(state.entries.map((entry) => entry.threadId)).toEqual(["a1", "b1", "a2"]);
  expect(state.hasOlder).toBe(true);
  expect(state.older).toEqual([
    { environmentId: envA, after: { updatedAt: "2026-10-01T00:40:00.000Z", threadId: "a2" } },
  ]);

  const next = mergeThreadHistoryPages([
    {
      environmentId: envA,
      pages: [
        historyPage([historyEntry("a1", 50), historyEntry("a2", 40)], true),
        historyPage([historyEntry("a3", 20)], false),
      ],
    },
    {
      environmentId: envB,
      pages: [historyPage([historyEntry("b1", 45), historyEntry("b2", 10)], false)],
    },
  ]);
  // The retained b2 shows once env-a has nothing newer left.
  expect(next.entries.map((entry) => entry.threadId)).toEqual(["a1", "b1", "a2", "a3", "b2"]);
  expect(next.hasOlder).toBe(false);
  expect(next.older).toEqual([]);
});

it("pages the environment holding the list back, and none while it loads", () => {
  const pages = (
    secondPage: AsyncResult.AsyncResult<OrchestrationSearchThreadHistoryResult, Error>,
  ) =>
    mergeThreadHistoryPages([
      {
        environmentId: envA,
        pages: [historyPage([historyEntry("a1", 50)], true), secondPage],
      },
      { environmentId: envB, pages: [historyPage([historyEntry("b1", 30)], true)] },
    ]);

  const loading = pages(AsyncResult.initial(true));
  expect(loading.isLoading).toBe(true);
  expect(loading.older).toEqual([]);
  expect(loading.entries.map((entry) => entry.threadId)).toEqual(["a1"]);

  const failed = pages(
    AsyncResult.failure<OrchestrationSearchThreadHistoryResult, Error>(
      Cause.fail(new Error("offline")),
    ),
  );
  // A failed environment stops holding the others back.
  expect(failed.failedEnvironmentIds).toEqual([envA]);
  expect(failed.entries.map((entry) => entry.threadId)).toEqual(["a1", "b1"]);
  expect(failed.older).toEqual([
    { environmentId: envB, after: { updatedAt: "2026-10-01T00:30:00.000Z", threadId: "b1" } },
  ]);
});

it("keys history views by filters and per-environment cursors in a stable order", () => {
  const cursor = { updatedAt: "2026-10-01T00:30:00.000Z", threadId: ThreadId.make("b1") };
  expect(
    makeThreadHistoryKey({ query: "needle", archived: "include" }, [
      { environmentId: envB, cursors: [null, cursor] },
      { environmentId: envA, cursors: [null] },
    ]),
  ).toBe(
    makeThreadHistoryKey({ archived: "include", query: "needle" }, [
      { environmentId: envA, cursors: [null] },
      { environmentId: envB, cursors: [null, cursor] },
    ]),
  );

  const requested: Array<[EnvironmentId, OrchestrationSearchThreadHistoryInput]> = [];
  const historyAtom = createThreadHistoryResultsAtomFamily<Error>({
    getHistoryAtom: (environmentId, input) => {
      requested.push([environmentId, input]);
      return Atom.make(historyPage([], false));
    },
    labelPrefix: "test:thread-history",
  });
  const registry = AtomRegistry.make();
  try {
    registry.get(
      historyAtom(
        makeThreadHistoryKey({ query: "needle" }, [
          { environmentId: envB, cursors: [null, cursor] },
        ]),
      ),
    );
    expect(requested).toEqual([
      [envB, { query: "needle" }],
      [envB, { query: "needle", after: cursor }],
    ]);
    expect(registry.get(historyAtom("not json{{")).entries).toEqual([]);
  } finally {
    registry.dispose();
  }
});

it("resumes inside the thread a page stopped in, and lists that thread once", () => {
  // The server ran out of its message budget inside a2 before deciding it.
  const inside = {
    updatedAt: "2026-10-01T00:40:00.000Z",
    threadId: ThreadId.make("a2"),
    beforeMessage: {
      createdAt: "2026-09-30T12:00:00.000Z",
      messageId: MessageId.make("a2-message-63"),
    },
  };
  const firstPage = AsyncResult.success<OrchestrationSearchThreadHistoryResult>({
    entries: [historyEntry("a1", 50)],
    nextCursor: inside,
  });
  const secondPage = historyPage([historyEntry("a2", 40), historyEntry("a3", 20)], false);

  const stopped = mergeThreadHistoryPages([{ environmentId: envA, pages: [firstPage] }]);
  expect(stopped.entries.map((entry) => entry.threadId)).toEqual(["a1"]);
  expect(stopped.older).toEqual([{ environmentId: envA, after: inside }]);

  const requested: Array<OrchestrationSearchThreadHistoryInput> = [];
  const historyAtom = createThreadHistoryResultsAtomFamily<Error>({
    getHistoryAtom: (_environmentId, input) => {
      requested.push(input);
      return Atom.make(input.after === undefined ? firstPage : secondPage);
    },
    labelPrefix: "test:thread-history",
  });
  const registry = AtomRegistry.make();
  try {
    const state = registry.get(
      historyAtom(
        makeThreadHistoryKey({ query: "needle" }, [
          { environmentId: envA, cursors: [null, inside] },
        ]),
      ),
    );
    // The view's key keeps the whole cursor, so the next page resumes inside a2.
    expect(requested).toEqual([{ query: "needle" }, { query: "needle", after: inside }]);
    expect(state.entries.map((entry) => entry.threadId)).toEqual(["a1", "a2", "a3"]);
    expect(state.hasOlder).toBe(false);
  } finally {
    registry.dispose();
  }
});
