type SidebarChatRow = { key: string; timestamp: string; pinned: boolean };

function rowTimestamp(row: SidebarChatRow): number {
  const timestamp = Date.parse(row.timestamp);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/** Keep the saved chat order while inserting local drafts into recent chats. */
export function mergeSidebarChatRows<T extends SidebarChatRow>(
  threads: readonly T[],
  drafts: readonly T[],
): T[] {
  const rows = threads.filter((thread) => thread.pinned);
  const recentThreads = threads.filter((thread) => !thread.pinned);
  const recentDrafts = drafts
    .map((draft, index) => ({ draft, index, timestamp: rowTimestamp(draft) }))
    .sort((left, right) =>
      left.timestamp === right.timestamp
        ? left.index - right.index
        : right.timestamp - left.timestamp,
    );
  let draftIndex = 0;

  for (const thread of recentThreads) {
    const timestamp = rowTimestamp(thread);
    while (draftIndex < recentDrafts.length && recentDrafts[draftIndex]!.timestamp > timestamp) {
      rows.push(recentDrafts[draftIndex++]!.draft);
    }
    rows.push(thread);
  }
  for (; draftIndex < recentDrafts.length; draftIndex += 1) {
    rows.push(recentDrafts[draftIndex]!.draft);
  }
  return rows;
}
