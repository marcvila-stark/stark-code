import { act, StrictMode, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useTurnNavigation, type TurnNavigationRequest } from "./useTurnNavigation";
import { toastManager } from "../ui/toast";
import type { TimelineMinimapItem } from "./timelineMinimapItems";
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
let renderer: ReactTestRenderer | undefined;
let navigation: ReturnType<typeof useTurnNavigation>;
const load = vi.fn();
const scroll = vi.fn();
const manual = vi.fn();
const consumed = vi.fn();
const recent = {
  id: "recent",
  entryId: "recent",
  rowIndex: 10,
  userText: "Recent",
  assistantText: null,
};
const indexed = {
  id: "old",
  entryId: "old",
  rowIndex: -1,
  userText: "Old",
  assistantText: "Old answer",
};
const RECENT_ITEMS = [recent];
function Probe({
  items = RECENT_ITEMS,
  cursor = "page-1",
  loading = false,
  threadKey = "a",
  error = null,
  request = null,
}: {
  items?: TimelineMinimapItem[];
  cursor?: string;
  loading?: boolean;
  threadKey?: string;
  error?: string | null;
  request?: TurnNavigationRequest | null;
}) {
  const state = useTurnNavigation({
    threadKey,
    items,
    historyCursor: cursor,
    onManualNavigation: manual,
    scrollToTurn: scroll,
    history: { hasMoreHistory: true, loading, error, onLoadEarlier: load },
    request,
    onRequestConsumed: consumed,
  });
  useLayoutEffect(() => {
    navigation = state;
  });
  return null;
}
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("loads only the selected turn's intervening history and jumps after its row exists", async () => {
  await act(() => {
    renderer = create(<Probe />);
  });
  await act(() => navigation.selectItem(indexed));
  expect(load).toHaveBeenCalledExactlyOnceWith("old");
  expect(scroll).not.toHaveBeenCalled();
  await act(() => renderer!.update(<Probe loading />));
  await act(() => renderer!.update(<Probe />));
  expect(load).toHaveBeenCalledOnce();
  await act(() => renderer!.update(<Probe cursor="page-2" />));
  expect(load).toHaveBeenCalledTimes(2);
  await act(() =>
    renderer!.update(<Probe cursor="page-3" items={[{ ...indexed, rowIndex: 0 }, recent]} />),
  );
  expect(scroll).toHaveBeenCalledExactlyOnceWith(0, false);
  expect(navigation.pending).toBe(false);
  expect(manual).toHaveBeenCalledOnce();
});

it("cancels pending jumps and does not scroll another conversation after a switch or history failure", async () => {
  await act(() => {
    renderer = create(<Probe />);
  });
  await act(() => navigation.selectItem(indexed));
  await act(() => navigation.cancel());
  await act(() => renderer!.update(<Probe items={[{ ...indexed, rowIndex: 0 }, recent]} />));
  expect(scroll).not.toHaveBeenCalled();
  await act(() => renderer!.update(<Probe />));
  await act(() => navigation.selectItem(indexed));
  await act(() => renderer!.update(<Probe threadKey="b" items={[{ ...indexed, rowIndex: 0 }]} />));
  expect(scroll).not.toHaveBeenCalled();
  expect(navigation.pending).toBe(false);
  await act(() => renderer!.update(<Probe threadKey="b" />));
  await act(() => navigation.selectItem(indexed));
  await act(() => renderer!.update(<Probe threadKey="b" error="Connection lost" />));
  expect(navigation.pending).toBe(false);
  expect(toastManager.add).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Connection lost" }),
  );
});

it("opens a bookmarked turn once and does not repeat it on render or return to the chat", async () => {
  const request = { threadKey: "a", entryId: "recent", requestId: 1 };
  await act(() => {
    renderer = create(
      <StrictMode>
        <Probe request={request} />
      </StrictMode>,
    );
  });
  expect(scroll).toHaveBeenCalledExactlyOnceWith(10, false);
  expect(consumed).toHaveBeenCalledExactlyOnceWith(1);
  await act(() =>
    renderer!.update(
      <StrictMode>
        <Probe request={{ ...request }} items={[recent]} />
      </StrictMode>,
    ),
  );
  await act(() => renderer!.update(<Probe threadKey="b" request={null} />));
  await act(() => renderer!.update(<Probe request={null} />));
  expect(scroll).toHaveBeenCalledOnce();
  expect(manual).toHaveBeenCalledOnce();
});

it("loads an older bookmark through existing history navigation and ignores another chat's request", async () => {
  await act(() => {
    renderer = create(<Probe request={{ threadKey: "b", entryId: "old", requestId: 1 }} />);
  });
  expect(load).not.toHaveBeenCalled();
  expect(consumed).not.toHaveBeenCalled();
  const request = { threadKey: "a", entryId: "old", requestId: 2 };
  await act(() => renderer!.update(<Probe request={request} />));
  expect(load).toHaveBeenCalledExactlyOnceWith("old");
  expect(consumed).toHaveBeenCalledExactlyOnceWith(2);
  await act(() =>
    renderer!.update(<Probe request={null} items={[{ ...indexed, rowIndex: 0 }, recent]} />),
  );
  expect(scroll).toHaveBeenCalledExactlyOnceWith(0, false);
});

it("does not finish an older pending jump after a newer bookmark request wins", async () => {
  await act(() => {
    renderer = create(<Probe />);
  });
  await act(() => navigation.selectItem(indexed));
  await act(() =>
    renderer!.update(
      <Probe
        items={[{ ...indexed, rowIndex: 0 }, recent]}
        request={{ threadKey: "a", entryId: "recent", requestId: 1 }}
      />,
    ),
  );
  expect(scroll).toHaveBeenCalledExactlyOnceWith(10, false);
  expect(navigation.pending).toBe(false);
});
