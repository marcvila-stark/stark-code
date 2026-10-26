import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";

const BookmarkIds = Schema.Array(Schema.String.check(Schema.isMaxLength(1_024)));
const EMPTY: ReadonlyArray<string> = [];

/** Bookmarks persist on this device and are isolated by environment and conversation. */
export function useTurnBookmarks(threadKey: string) {
  const [ids, setIds] = useLocalStorage(
    `stark-code:turn-bookmarks:${threadKey}`,
    EMPTY,
    BookmarkIds,
  );
  const bookmarks = useMemo(() => new Set(ids), [ids]);
  const toggleBookmark = useCallback(
    (id: string) => {
      setIds((current) =>
        current.includes(id) ? current.filter((saved) => saved !== id) : [...current, id],
      );
    },
    [setIds],
  );
  return { bookmarks, toggleBookmark };
}
