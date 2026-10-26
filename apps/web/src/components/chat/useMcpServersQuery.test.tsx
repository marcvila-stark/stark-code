import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@starkfuture/contracts";
const state = vi.hoisted(() => ({ refresh: vi.fn(), pending: false }));
vi.mock("../../state/server", () => ({ serverEnvironment: { mcpServers: () => ({}) } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ refresh: state.refresh, isPending: state.pending }),
}));
import { useMcpServersQuery } from "./useMcpServersQuery";
let renderer: ReactTestRenderer | undefined;
function Subscriber({ interval, thread = "thread" }: { interval: number; thread?: string }) {
  useMcpServersQuery(EnvironmentId.make("env"), { threadId: ThreadId.make(thread) }, interval);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.refresh.mockReset();
  state.pending = false;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("polls each target once at the fastest visible subscriber interval and cleans up", async () => {
  await act(() => {
    renderer = create(
      <>
        <Subscriber interval={10_000} />
        <Subscriber interval={10_000} />
        <Subscriber interval={2_000} />
      </>,
    );
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await act(() => {
    vi.advanceTimersByTime(4_000);
  });
  expect(state.refresh).toHaveBeenCalledTimes(3);
  await act(() =>
    renderer!.update(
      <>
        <Subscriber interval={10_000} />
        <Subscriber interval={10_000} />
      </>,
    ),
  );
  await act(() => {
    vi.advanceTimersByTime(9_999);
  });
  expect(state.refresh).toHaveBeenCalledTimes(3);
  await act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(state.refresh).toHaveBeenCalledTimes(4);
  await act(() => renderer!.unmount());
  renderer = undefined;
  await act(() => {
    vi.advanceTimersByTime(20_000);
  });
  expect(state.refresh).toHaveBeenCalledTimes(4);
});

it("lets a slow inspection finish instead of restarting it on each poll", async () => {
  state.pending = true;
  await act(() => {
    renderer = create(<Subscriber interval={2_000} />);
  });
  await act(() => {
    vi.advanceTimersByTime(12_000);
  });
  expect(state.refresh).not.toHaveBeenCalled();
  state.pending = false;
  await act(() => {
    renderer!.update(<Subscriber interval={2_000} />);
  });
  await act(() => {
    vi.advanceTimersByTime(2_000);
  });
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("pauses all polling while hidden and refreshes once when visible again", async () => {
  const visibility = new EventTarget();
  let hidden = true;
  vi.stubGlobal("document", {
    get visibilityState() {
      return hidden ? "hidden" : "visible";
    },
    addEventListener: visibility.addEventListener.bind(visibility),
    removeEventListener: visibility.removeEventListener.bind(visibility),
  });
  await act(() => {
    renderer = create(
      <>
        <Subscriber interval={2_000} />
        <Subscriber interval={10_000} />
      </>,
    );
  });
  await act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(state.refresh).not.toHaveBeenCalled();
  await act(() => {
    hidden = false;
    visibility.dispatchEvent(new Event("visibilitychange"));
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await act(() => {
    vi.advanceTimersByTime(2_000);
  });
  expect(state.refresh).toHaveBeenCalledTimes(2);
  await act(() => {
    hidden = true;
    visibility.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(60_000);
  });
  expect(state.refresh).toHaveBeenCalledTimes(2);
});
