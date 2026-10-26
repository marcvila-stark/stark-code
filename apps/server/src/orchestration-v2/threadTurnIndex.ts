import type { OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@starkfuture/contracts";
import { isThreadHistoryUserTurn } from "./threadHistoryPaging.ts";

type IndexRow = {
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
  readonly item: Pick<OrchestrationV2TurnItem, "type" | "runId"> & {
    readonly messageId?: string;
    readonly inputIntent?: "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer";
    readonly createdBy?: "user" | "agent" | "system";
  };
};

/** Page by a stable prompt identity, so newly appended turns cannot shift older pages. */
export function selectThreadTurnIndexPage<Row extends IndexRow>(
  rows: ReadonlyArray<Row>,
  beforeEntryId?: string,
) {
  const turns: Array<{ user: Row; assistant: Row | null }> = [];
  for (const row of rows) {
    if (isThreadHistoryUserTurn(row.item)) turns.push({ user: row, assistant: null });
    else if (row.item.type === "assistant_message" && turns.length > 0) {
      turns[turns.length - 1]!.assistant = row;
    }
  }
  const end =
    beforeEntryId === undefined
      ? turns.length
      : turns.findIndex(({ user }) => user.item.messageId === beforeEntryId);
  if (end < 0) throw new Error("Conversation turn index cursor is no longer available");
  const start = Math.max(0, end - 200);
  return {
    turns: turns.slice(start, end),
    totalTurns: turns.length,
    nextBeforeEntryId: start === 0 ? null : (turns[start]?.user.item.messageId ?? null),
  };
}
