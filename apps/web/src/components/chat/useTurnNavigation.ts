import { useCallback, useEffect, useRef, useState } from "react";
import { toastManager } from "../ui/toast";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import type { TimelineMinimapItem } from "./timelineMinimapItems";

export interface TurnNavigationRequest {
  readonly threadKey: string;
  readonly entryId: string;
  readonly requestId: number;
}

/** Materializes an indexed turn through existing history pages before asking the list to jump. */
export function useTurnNavigation({
  threadKey,
  items,
  history,
  historyCursor,
  onManualNavigation,
  scrollToTurn,
  request,
  onRequestConsumed,
}: {
  threadKey: string;
  items: ReadonlyArray<TimelineMinimapItem>;
  history?: MessagesTimelineHistoryControls | undefined;
  historyCursor?: string | null | undefined;
  onManualNavigation: () => void;
  scrollToTurn: (rowIndex: number, animated: boolean) => void;
  request?: TurnNavigationRequest | null | undefined;
  onRequestConsumed?: ((requestId: number) => void) | undefined;
}) {
  const [target, setTarget] = useState<{
    key: string;
    entryId: string;
    selection: number;
  } | null>(null);
  const requestedPages = useRef(new Set<string>());
  const consumedRequest = useRef<string | null>(null);
  const currentSelection = useRef(0);
  const selectItem = useCallback(
    (item: TimelineMinimapItem, animated = true) => {
      const selection = ++currentSelection.current;
      onManualNavigation();
      requestedPages.current.clear();
      if (item.rowIndex < 0) {
        setTarget({ key: threadKey, entryId: item.entryId ?? item.id, selection });
      } else {
        setTarget(null);
        scrollToTurn(item.rowIndex, animated);
      }
    },
    [threadKey, onManualNavigation, scrollToTurn],
  );
  useEffect(() => {
    if (!request || request.threadKey !== threadKey) return;
    const key = `${request.threadKey}:${request.requestId}`;
    if (consumedRequest.current === key) return;
    consumedRequest.current = key;
    selectItem(
      items.find((item) => (item.entryId ?? item.id) === request.entryId) ?? {
        id: request.entryId,
        entryId: request.entryId,
        rowIndex: -1,
        userText: null,
        assistantText: null,
      },
      false,
    );
    onRequestConsumed?.(request.requestId);
  }, [request, threadKey, items, selectItem, onRequestConsumed]);
  useEffect(() => {
    if (!target || target.selection !== currentSelection.current) return;
    if (target.key !== threadKey) {
      setTarget(null);
      return;
    }
    const item = items.find((item) => (item.entryId ?? item.id) === target.entryId);
    if (item) {
      scrollToTurn(item.rowIndex, false);
      setTarget(null);
      return;
    }
    if (history?.loading) return;
    if (history?.error || !history?.hasMoreHistory) {
      setTarget(null);
      toastManager.add({
        type: "warning",
        title: "Could not open this turn",
        description: history?.error ?? "This turn is no longer available in the conversation.",
      });
      return;
    }
    const cursor = historyCursor ?? items[0]?.id ?? "first";
    if (requestedPages.current.has(cursor)) return;
    requestedPages.current.add(cursor);
    history.onLoadEarlier(target.entryId);
  }, [target, threadKey, items, history, historyCursor, scrollToTurn]);
  const cancel = useCallback(() => {
    currentSelection.current += 1;
    setTarget(null);
  }, []);
  return { selectItem, pending: target?.key === threadKey, cancel };
}
