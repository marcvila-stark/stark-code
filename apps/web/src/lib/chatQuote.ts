import { ASSISTANT_CITATION_MAX_TEXT_LENGTH } from "@starkfuture/contracts";
import { serializeSelectedTextQuote } from "@starkfuture/shared/selectedTextQuotes";

export function chatQuoteText(text: string, source: string): string | null {
  if (!text.trim() || text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) return null;
  const label =
    source
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 200) || "selected text";
  return `${serializeSelectedTextQuote({ version: 1, source: label, text })}\n\n`;
}

export function appendChatQuote(prompt: string, quote: string): string {
  return `${prompt}${prompt.length === 0 || prompt.endsWith("\n\n") ? "" : prompt.endsWith("\n") ? "\n" : "\n\n"}${quote}`;
}
