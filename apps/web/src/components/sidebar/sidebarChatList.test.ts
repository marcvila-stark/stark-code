import { describe, expect, it } from "vite-plus/test";
import { mergeSidebarChatRows } from "./sidebarChatList";

function row(key: string, day: number, pinned = false) {
  return { key, timestamp: `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`, pinned };
}

describe("mergeSidebarChatRows", () => {
  it("places drafts among recent chats instead of in a separate block", () => {
    const threads = Object.freeze([row("new", 26), row("middle", 23), row("old", 20)]);
    const drafts = Object.freeze([
      row("old-draft", 19),
      row("middle-draft", 24),
      row("new-draft", 27),
    ]);

    expect(mergeSidebarChatRows(threads, drafts).map((item) => item.key)).toEqual([
      "new-draft",
      "new",
      "middle-draft",
      "middle",
      "old",
      "old-draft",
    ]);
    expect(threads.map((item) => item.key)).toEqual(["new", "middle", "old"]);
    expect(drafts.map((item) => item.key)).toEqual(["old-draft", "middle-draft", "new-draft"]);
  });

  it("keeps pinned chats first in their existing order regardless of date", () => {
    const firstPin = row("first-pin", 10, true);
    const secondPin = row("second-pin", 25, true);
    const recent = row("recent", 24);
    const draft = row("draft", 26);

    expect(mergeSidebarChatRows([firstPin, recent, secondPin], [draft])).toEqual([
      firstPin,
      secondPin,
      draft,
      recent,
    ]);
  });

  it("keeps saved chats before drafts at equal times and preserves draft ties", () => {
    expect(
      mergeSidebarChatRows(
        [row("thread-a", 24), row("thread-b", 24)],
        [row("draft-a", 24), row("draft-b", 24)],
      ).map((item) => item.key),
    ).toEqual(["thread-a", "thread-b", "draft-a", "draft-b"]);
  });

  it("does not reorder saved chats even if their timestamps differ from their list order", () => {
    const threads = [row("earlier-in-list", 20), row("later-in-list", 26)];
    expect(
      mergeSidebarChatRows(threads, [row("draft", 23)]).filter((item) => item.key !== "draft"),
    ).toEqual(threads);
  });

  it("puts invalid draft times last with deterministic ties", () => {
    const invalidThread = { ...row("invalid-thread", 20), timestamp: "invalid" };
    const invalidDraft = { ...row("invalid-draft", 20), timestamp: "" };
    const anotherInvalidDraft = { ...row("another-invalid-draft", 20), timestamp: "invalid" };
    expect(
      mergeSidebarChatRows(
        [row("thread", 24), invalidThread],
        [invalidDraft, row("valid-draft", 23), anotherInvalidDraft],
      ).map((item) => item.key),
    ).toEqual([
      "thread",
      "valid-draft",
      "invalid-thread",
      "invalid-draft",
      "another-invalid-draft",
    ]);
  });

  it("handles either list being empty without mutating the remaining list", () => {
    const threads = [row("thread", 24)];
    const drafts = [row("older-draft", 20), row("newer-draft", 25)];
    expect(mergeSidebarChatRows(threads, [])).toEqual(threads);
    expect(mergeSidebarChatRows(threads, [])).not.toBe(threads);
    expect(mergeSidebarChatRows([], drafts)).toEqual([drafts[1], drafts[0]]);
    expect(mergeSidebarChatRows([], [])).toEqual([]);
  });
});
