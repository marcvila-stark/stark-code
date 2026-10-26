import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly entryId?: string;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

/** Keep full source text untouched until a minimap preview is opened. */
export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || !isNavigationTurnStart(row)) {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      entryId: row.message.id,
      userText: row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
    });
  }
  return items;
}

/** Steering and generated follow-ups belong to the surrounding turn, matching the server index. */
function isNavigationTurnStart(row: Extract<MessagesTimelineRow, { kind: "message" }>) {
  if (row.message.role !== "user") return false;
  const item = row.projectedItem?.item;
  return (
    item === undefined ||
    (item.type === "user_message" &&
      item.createdBy === "user" &&
      (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn"))
  );
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (isNavigationTurnStart(row)) {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        userText: compactMinimapPreview(item.userText),
        assistantText: compactMinimapPreview(item.assistantText),
      };
}
