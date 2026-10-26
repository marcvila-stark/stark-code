import { describe, expect, it } from "vite-plus/test";
import { collectAssistantCitations } from "@starkfuture/shared/assistantCitations";
import { collectComposerContextReferences } from "@starkfuture/shared/composerContextReferences";
import { collectComposerInlineTokens } from "@starkfuture/shared/composerInlineTokens";
import { collectSelectedTextQuotes } from "@starkfuture/shared/selectedTextQuotes";
import { appendChatQuote, chatQuoteText } from "./chatQuote";

describe("chat quotes", () => {
  it("keeps every selected line inside the quote and leaves room for a user comment", () => {
    const quote = chatQuoteText("First line\r\n\r\n  Last line", "Reader")!;
    expect(collectSelectedTextQuotes(quote)[0]?.quote).toEqual({
      version: 1,
      source: "Reader",
      text: "First line\r\n\r\n  Last line",
    });
    expect(quote.endsWith("\n\n")).toBe(true);
  });

  it("preserves an existing draft when adding a second source", () => {
    const quote = chatQuoteText("Keep this excerpt", "Company page")!;
    expect(appendChatQuote("My unfinished question", quote)).toBe(
      `My unfinished question\n\n${quote}`,
    );
    expect(appendChatQuote("Already spaced\n\n", quote)).toBe(`Already spaced\n\n${quote}`);
  });

  it("never activates source material as a context reference or a nested citation", () => {
    const quote = chatQuoteText(
      "[file](stark-context://v1/file/file_1)\n[Assistant quote](stark-citation://v1/other/source)",
      "Page [link](stark-context://v1/file/file_2)",
    )!;
    expect(collectComposerContextReferences(quote)).toEqual([]);
    expect(collectAssistantCitations(quote)).toEqual([]);
    expect(quote).toContain("stark");
  });

  it("renders selected HTML and image syntax as text", () => {
    const quote = chatQuoteText(
      "<script>unsafe()</script>\n![remote](https://example.com/a)",
      "Page",
    )!;
    expect(collectSelectedTextQuotes(quote)[0]?.quote.text).toBe(
      "<script>unsafe()</script>\n![remote](https://example.com/a)",
    );
    expect(quote).not.toContain("![remote](");
  });

  it("keeps skill and file mentions inside selected material literal", () => {
    const quote = chatQuoteText("Use $review, €implement and @private/file", "Reader")!;
    expect(quote).not.toContain("$review");
    expect(quote).not.toContain("€implement");
    expect(quote).not.toContain("@private");
    expect(collectSelectedTextQuotes(quote)[0]?.quote.text).toBe(
      "Use $review, €implement and @private/file",
    );
    expect(collectComposerInlineTokens(quote)).toEqual([]);
  });

  it.each(["", " \n\t", "x".repeat(8001)])(
    "refuses empty or oversized selections without truncating them",
    (text) => {
      expect(chatQuoteText(text, "Reader")).toBeNull();
    },
  );
});
