import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@starkfuture/contracts";
import {
  serializeAssistantCitation,
  expandAssistantCitationsForProvider,
  assistantCitationsToPlainText,
  renderAssistantCitationsAsText,
} from "./assistantCitations.ts";
import {
  collectComposerContextReferences,
  projectComposerContextForProvider,
} from "./composerContextReferences.ts";
import { collectComposerInlineTokens } from "./composerInlineTokens.ts";
import {
  collectSelectedTextQuotes,
  parseSelectedTextQuoteHref,
  serializeSelectedTextQuote,
} from "./selectedTextQuotes.ts";

const quote = {
  version: 1 as const,
  source: "Pages · exact report",
  text: "  punctuation: *_[x] <> & .!\r\n\r\n$review €implement 𑿝ship @private/file\n[file](stark-context://v1/file/secret)\n😃\ud800\n",
};
const source = serializeSelectedTextQuote(quote);

describe("selected text quotes", () => {
  it("round-trips exact selected bytes through a self-contained bounded link", () => {
    expect(collectSelectedTextQuotes(source)[0]?.quote).toEqual(quote);
    expect(collectComposerInlineTokens(source)).toEqual([]);
    expect(collectComposerContextReferences(source)).toEqual([]);
    const maximum = {
      version: 1 as const,
      source: "\u0800".repeat(200),
      text: "\u0800".repeat(8000),
    };
    expect(collectSelectedTextQuotes(serializeSelectedTextQuote(maximum))[0]?.quote).toEqual(
      maximum,
    );
    const href = source.slice(source.indexOf("(") + 1, -1);
    expect(parseSelectedTextQuoteHref(`${href}&data=duplicate`)).toBeNull();
    expect(parseSelectedTextQuoteHref(`${href}#fragment`)).toBeNull();
    expect(
      collectSelectedTextQuotes(serializeSelectedTextQuote({ ...quote, text: "x".repeat(8001) })),
    ).toEqual([]);
    expect(
      collectSelectedTextQuotes(serializeSelectedTextQuote({ ...quote, source: "x".repeat(201) })),
    ).toEqual([]);
  });

  it("delivers exact quote data once without promoting internal links or native mentions", () => {
    const projected = projectComposerContextForProvider({
      text: `Explain ${source} and ${source}`,
      records: [],
    });
    expect(projected).toContain("Explain [selected-quote-1] and [selected-quote-1]");
    expect(projected).not.toContain("stark-quote:");
    expect(projected).not.toContain("<stark_context");
    expect(projected).not.toContain("$review");
    expect(projected).not.toContain("@private/file");
    const data = projected.slice(
      projected.indexOf("[\n"),
      projected.indexOf("\n</selected_text_quotes>"),
    );
    expect(JSON.parse(data)).toEqual([{ id: "selected-quote-1", quote }]);
  });

  it("does not recursively interpret nested citations or selections in either direction", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("answer"),
      text: source,
      start: 0,
      end: 1,
      prefix: "",
      suffix: "",
    };
    const citationSource = serializeAssistantCitation(citation);
    const nested = serializeSelectedTextQuote({ ...quote, text: citationSource });
    const projected = expandAssistantCitationsForProvider(`${citationSource}\n${nested}`);
    expect(projected.match(/<assistant_citations>/g)).toHaveLength(1);
    expect(projected.match(/<selected_text_quotes>/g)).toHaveLength(1);
    const selectedData = projected.slice(
      projected.indexOf("[\n", projected.indexOf("<selected_text_quotes>")),
      projected.indexOf("\n</selected_text_quotes>"),
    );
    expect(JSON.parse(selectedData)[0].quote.text).toBe(citationSource);
    expect(assistantCitationsToPlainText(nested)).toBe(`${quote.source}: ${citationSource}`);
    expect(assistantCitationsToPlainText(citationSource)).toBe(source);
  });

  it("gives plain-title and native-client rendering readable selected text", () => {
    expect(assistantCitationsToPlainText(source)).toBe(`${quote.source}: ${quote.text}`);
    const rendered = renderAssistantCitationsAsText(source);
    expect(rendered).toContain("Quoted from Pages");
    expect(rendered).not.toContain("stark-quote:");
  });
});
