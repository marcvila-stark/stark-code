import { useMemo, useRef, useState } from "react";
import type { ScopedThreadRef } from "@starkfuture/contracts";
import { useThreadTurnIndex } from "./useThreadTurnIndex";
import { Input } from "../ui/input";
import { BookmarkIcon, ListIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import { resolveTimelineMinimapPreview, type TimelineMinimapItem } from "./timelineMinimapItems";

/** A keyboard and touch alternative when the conversation rail has no safe gutter. */
export function TimelineTurnOutline({
  items,
  currentId,
  history,
  onSelect,
  iconOnly = false,
  thread,
  bookmarks,
  onToggleBookmark,
}: {
  items: ReadonlyArray<TimelineMinimapItem>;
  currentId: string | null;
  history?: MessagesTimelineHistoryControls | undefined;
  onSelect: (item: TimelineMinimapItem) => void;
  iconOnly?: boolean;
  thread?: ScopedThreadRef | null | undefined;
  bookmarks?: ReadonlySet<string> | undefined;
  onToggleBookmark?: ((entryId: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyBookmarks, setOnlyBookmarks] = useState(false);
  const [visibleCount, setVisibleCount] = useState(100);
  const index = useThreadTurnIndex(thread, open);
  const allItems = useMemo(() => {
    const loaded = new Map(items.map((item) => [item.entryId ?? item.id, item]));
    const indexed = index.items.map(
      (item): TimelineMinimapItem =>
        loaded.get(item.entryId) ?? {
          id: item.entryId,
          entryId: item.entryId,
          rowIndex: -1,
          userText: item.userText,
          assistantText: item.assistantText,
        },
    );
    const known = new Set(index.items.map((item) => item.entryId));
    return [...indexed, ...items.filter((item) => !known.has(item.entryId ?? item.id))];
  }, [index.items, items]);
  const matchingItems = allItems.filter(
    (item) =>
      (!onlyBookmarks || bookmarks?.has(item.entryId ?? item.id)) &&
      (!query.trim() ||
        `${item.userText ?? ""} ${item.assistantText ?? ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  const currentIndex = matchingItems.findIndex((item) => item.id === currentId);
  const visibleStart =
    query.trim() || onlyBookmarks
      ? 0
      : Math.max(
          0,
          Math.min(
            matchingItems.length - visibleCount,
            (currentIndex < 0 ? matchingItems.length : currentIndex) - Math.floor(visibleCount / 2),
          ),
        );
  const visibleItems = matchingItems.slice(visibleStart, visibleStart + visibleCount);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={iconOnly ? "Conversation turns" : undefined}
        render={<Button size={iconOnly ? "icon-xs" : "xs"} variant="ghost-muted" />}
      >
        <ListIcon aria-hidden="true" />
        {iconOnly ? null : "Turns"}
      </PopoverTrigger>
      <PopoverPopup
        aria-label="Conversation turns"
        side="bottom"
        align="start"
        width="lg"
        padding="compact"
        initialFocus={() => buttons.current.get(currentId ?? items[0]?.id ?? "") ?? true}
      >
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {index.totalTurns ?? items.length}{" "}
            {index.totalTurns !== null || !history?.hasMoreHistory ? "turns" : "loaded turns"}
            {index.loading ? ` · Loading index (${index.items.length})…` : ""}
          </p>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Search turn previews"
              placeholder="Search turn previews"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(100);
              }}
            />
            {bookmarks && onToggleBookmark ? (
              <Button
                size="xs"
                variant={onlyBookmarks ? "secondary" : "ghost-muted"}
                aria-pressed={onlyBookmarks}
                onClick={() => {
                  setOnlyBookmarks((value) => !value);
                  setVisibleCount(100);
                }}
              >
                <BookmarkIcon aria-hidden="true" /> Saved
              </Button>
            ) : null}
          </div>
          {index.error ? (
            <div role="status" className="text-xs text-muted-foreground">
              {index.error}{" "}
              <Button size="xs" variant="outline" onClick={index.retry}>
                Retry index
              </Button>
            </div>
          ) : null}
          {history?.hasMoreHistory && !thread ? (
            <Button
              size="xs"
              variant="outline"
              disabled={history.loading}
              onClick={() => history.onLoadEarlier()}
            >
              {history.loading ? "Loading earlier turns…" : "Load earlier turns"}
            </Button>
          ) : null}
          {history?.error ? <p role="status">{history.error}</p> : null}
          <ol
            className="max-h-[min(28rem,60vh)] space-y-1 overflow-y-auto"
            aria-label="Turns"
            onKeyDown={(event) => {
              const focusedIndex = visibleItems.findIndex(
                (item) => buttons.current.get(item.id) === event.target,
              );
              if (focusedIndex < 0) return;
              const nextIndex =
                event.key === "ArrowDown"
                  ? Math.min(visibleItems.length - 1, focusedIndex + 1)
                  : event.key === "ArrowUp"
                    ? Math.max(0, focusedIndex - 1)
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? visibleItems.length - 1
                        : null;
              if (nextIndex === null) return;
              event.preventDefault();
              const item = visibleItems[nextIndex];
              if (item) buttons.current.get(item.id)?.focus();
            }}
          >
            {visibleItems.map((item) => {
              const preview = resolveTimelineMinimapPreview(item)!;
              const current = currentId === item.id;
              return (
                <li key={item.id} className="flex min-w-0 items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <Button
                      variant="ghost"
                      size="sm-multiline"
                      className="w-full justify-start"
                      aria-current={current ? "step" : undefined}
                      ref={(button) => {
                        if (button) buttons.current.set(item.id, button);
                        else buttons.current.delete(item.id);
                      }}
                      onClick={() => {
                        onSelect(item);
                        setOpen(false);
                      }}
                    >
                      <span className="block min-w-0 flex-1 py-1 text-left">
                        {current ? (
                          <span className="block text-xs text-muted-foreground">Current turn</span>
                        ) : null}
                        <span className="line-clamp-2 break-words">
                          {preview.userText ?? "User message"}
                        </span>
                        {preview.assistantText ? (
                          <span className="mt-1 line-clamp-3 break-words text-xs font-normal text-muted-foreground">
                            {preview.assistantText}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  </div>
                  {bookmarks && onToggleBookmark ? (
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`${bookmarks.has(item.entryId ?? item.id) ? "Remove bookmark from" : "Bookmark"} ${preview.userText ?? "turn"}`}
                      aria-pressed={bookmarks.has(item.entryId ?? item.id)}
                      onClick={() => onToggleBookmark(item.entryId ?? item.id)}
                    >
                      <BookmarkIcon
                        aria-hidden="true"
                        fill={bookmarks.has(item.entryId ?? item.id) ? "currentColor" : "none"}
                      />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {matchingItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {onlyBookmarks ? "No bookmarked turns match." : "No matching turns."}
            </p>
          ) : null}
          {matchingItems.length > visibleCount ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setVisibleCount((count) => count + 100)}
            >
              Show more turns ({matchingItems.length - visibleCount})
            </Button>
          ) : null}
          {onlyBookmarks ? (
            <p className="text-xs text-muted-foreground">Bookmarks are saved on this device.</p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
