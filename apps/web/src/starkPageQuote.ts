import { ASSISTANT_CITATION_MAX_TEXT_LENGTH } from "@starkfuture/contracts";
import type { StarkPageTarget } from "./starkPageTabs";

export const MAX_PAGE_QUOTE_LENGTH = ASSISTANT_CITATION_MAX_TEXT_LENGTH;

export interface PageSelection {
  readonly text: string;
  readonly tooLong: boolean;
}

export interface StarkPageQuote {
  readonly text: string;
  readonly page: StarkPageTarget;
  readonly url?: string;
  readonly projectRoot?: string;
}

/** Empty selections clear the action; malformed or oversized messages are ignored. */
export function pageSelectionText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_PAGE_QUOTE_LENGTH) return null;
  return (
    value
      .replace(/\r\n?/g, "\n")
      // oxlint-disable-next-line no-control-regex -- Remove unprintable controls from untrusted text.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim()
  );
}

export function readPageSelection(
  data: unknown,
  source: "stark-published-page" | "stark-pages",
  selectionToken: string,
): PageSelection | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (
    Reflect.get(data, "source") !== source ||
    Reflect.get(data, "type") !== "selection" ||
    Reflect.get(data, "selectionToken") !== selectionToken
  )
    return null;
  if (Reflect.get(data, "tooLong") === true) {
    return Reflect.get(data, "text") === "" ? { text: "", tooLong: true } : null;
  }
  const text = pageSelectionText(Reflect.get(data, "text"));
  return text === null ? null : { text, tooLong: false };
}
