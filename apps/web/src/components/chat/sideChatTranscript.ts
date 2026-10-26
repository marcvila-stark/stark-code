import type { MessageId, OrchestrationV2ThreadProjection } from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

export interface SideChatTranscriptEntry {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
  readonly canBringBack: boolean;
  readonly citationMessageId?: MessageId;
  readonly isPlan: boolean;
  readonly createdAt: DateTime.Utc;
}

/** Plan-mode providers can return their answer as a plan instead of a message. */
export function sideChatTranscript(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems"> | null,
): SideChatTranscriptEntry[] {
  if (!projection) return [];
  const entries: SideChatTranscriptEntry[] = projection.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      id: message.id,
      role: message.role as "user" | "assistant",
      text: message.text,
      streaming: message.streaming,
      canBringBack: message.role === "assistant" && !message.streaming,
      citationMessageId: message.id,
      isPlan: false,
      createdAt: message.createdAt,
    }));

  for (const item of projection.turnItems) {
    if (item.type !== "proposed_plan" || !item.markdown.trim()) continue;
    if (
      projection.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.runId === item.runId &&
          message.text.trim() === item.markdown.trim(),
      )
    )
      continue;
    entries.push({
      id: `plan:${item.id}`,
      role: "assistant",
      text: item.markdown,
      streaming: item.streaming,
      canBringBack: item.status === "completed" && !item.streaming,
      isPlan: true,
      createdAt: item.startedAt ?? item.updatedAt,
    });
  }
  return entries.sort(
    (left, right) =>
      DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
  );
}
