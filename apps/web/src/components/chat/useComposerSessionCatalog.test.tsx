import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderSessionId,
  ThreadId,
  type ServerProviderSessionCatalog,
} from "@starkfuture/contracts";
const state = vi.hoisted(() => ({
  query: {
    data: null as ServerProviderSessionCatalog | null,
    dataUpdatedAt: 0,
    isPending: false,
    refresh: vi.fn(),
  },
  request: vi.fn(),
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { readSessionCatalog: state.request } }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => state.query }));
import { useComposerSessionCatalog } from "./useComposerSessionCatalog";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("window", { setInterval, clearInterval });
  state.query.data = null;
  state.query.dataUpdatedAt = 0;
  state.query.refresh.mockClear();
  state.request.mockClear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("refreshes an open picker, follows live replacement, and stops polling when closed", async () => {
  const input = {
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    providerThreadId: "provider-thread",
    providerInstanceId: "claude",
    open: true,
  };
  let result: ReturnType<typeof useComposerSessionCatalog>;
  function Picker({ open = true, thread = "thread" }: { open?: boolean; thread?: string }) {
    result = useComposerSessionCatalog({ ...input, open, threadId: ThreadId.make(thread) });
    return null;
  }
  await act(async () => {
    renderer = create(<Picker />);
  });
  expect(state.query.refresh).toHaveBeenCalledTimes(1);
  expect(state.request).toHaveBeenCalledWith({
    environmentId: input.environmentId,
    input: { threadId: input.threadId },
  });
  const catalog = (name: string) =>
    ({
      live: true,
      providerSessionId: ProviderSessionId.make("session"),
      commands: [{ name }],
      skills: [],
      mcpServers: [],
    }) satisfies ServerProviderSessionCatalog;
  state.query.data = catalog("first");
  state.query.dataUpdatedAt = Date.now();
  await act(async () => renderer!.update(<Picker />));
  expect(result!.catalog!.commands.map((command) => command.name)).toEqual(["first"]);
  state.query.data = catalog("replacement");
  state.query.dataUpdatedAt++;
  await act(async () => renderer!.update(<Picker />));
  expect(result!.catalog!.commands.map((command) => command.name)).toEqual(["replacement"]);
  await act(async () => {
    vi.advanceTimersByTime(5_000);
  });
  expect(state.query.refresh).toHaveBeenCalledTimes(2);
  await act(async () => renderer!.update(<Picker thread="other" />));
  expect(result!.catalog).toBeNull();
  expect(state.query.refresh).toHaveBeenCalledTimes(3);
  await act(async () => renderer!.update(<Picker open={false} />));
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(result!.catalog).toBeNull();
  expect(state.query.refresh).toHaveBeenCalledTimes(3);
});
