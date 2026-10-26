import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadTurnIndexInput,
  type OrchestrationV2ThreadTurnIndexPage,
} from "@starkfuture/contracts";
import { useThreadTurnIndex } from "./useThreadTurnIndex";
import { orchestrationEnvironment } from "~/state/orchestration";

const queries = vi.hoisted(() => ({
  pages: new Map<string, OrchestrationV2ThreadTurnIndexPage>(),
  error: null as string | null,
  refresh: vi.fn(),
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { threadTurnIndex: vi.fn((input: unknown) => input) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (
    atom: { environmentId: EnvironmentId; input: OrchestrationV2ThreadTurnIndexInput } | null,
  ) => ({
    data: atom
      ? (queries.pages.get(`${atom.environmentId}:${atom.input.beforeEntryId ?? "latest"}`) ?? null)
      : null,
    isPending: false,
    error: atom ? queries.error : null,
    refresh: queries.refresh,
  }),
}));
let renderer: ReactTestRenderer | undefined;
let index: ReturnType<typeof useThreadTurnIndex>;
const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const threadId = ThreadId.make("same-thread");
function Probe({
  environmentId = a,
  enabled = true,
}: {
  environmentId?: EnvironmentId;
  enabled?: boolean;
}) {
  const state = useThreadTurnIndex({ environmentId, threadId }, enabled);
  useLayoutEffect(() => {
    index = state;
  });
  return null;
}
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  queries.pages.clear();
  queries.error = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const turn = (entryId: string) => ({
  entryId,
  runId: null,
  userText: `Prompt ${entryId}`,
  assistantText: `Answer ${entryId}`,
});

it("loads all lightweight index pages in order only while the Turns menu is open", async () => {
  queries.pages.set("a:latest", {
    items: [turn("recent")],
    totalTurns: 2,
    nextBeforeEntryId: "recent",
  });
  queries.pages.set("a:recent", { items: [turn("old")], totalTurns: 2, nextBeforeEntryId: null });
  await act(() => {
    renderer = create(<Probe enabled={false} />);
  });
  expect(orchestrationEnvironment.threadTurnIndex).not.toHaveBeenCalled();
  await act(() => renderer!.update(<Probe />));
  expect(index.items.map((item) => item.entryId)).toEqual(["old", "recent"]);
  expect(index.complete).toBe(true);
  expect(index.loading).toBe(false);
  expect(orchestrationEnvironment.threadTurnIndex).toHaveBeenCalledTimes(2);
  await act(() => renderer!.update(<Probe enabled={false} />));
  queries.pages.set("a:latest", {
    items: [turn("updated")],
    totalTurns: 1,
    nextBeforeEntryId: null,
  });
  await act(() => renderer!.update(<Probe />));
  expect(index.items.map((item) => item.entryId)).toEqual(["updated"]);
});

it("isolates environments and retains already indexed turns if a later page fails", async () => {
  queries.pages.set("a:latest", {
    items: [turn("a-recent")],
    totalTurns: 2,
    nextBeforeEntryId: "a-recent",
  });
  await act(() => {
    renderer = create(<Probe />);
  });
  queries.error = "Connection lost";
  await act(() => renderer!.update(<Probe />));
  expect(index.items.map((item) => item.entryId)).toEqual(["a-recent"]);
  expect(index.error).toBe("Connection lost");
  expect(index.loading).toBe(false);
  queries.error = null;
  queries.pages.set("b:latest", {
    items: [turn("b-only")],
    totalTurns: 1,
    nextBeforeEntryId: null,
  });
  await act(() => renderer!.update(<Probe environmentId={b} />));
  expect(index.items.map((item) => item.entryId)).toEqual(["b-only"]);
});
