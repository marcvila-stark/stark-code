/* oxlint-disable react/no-array-index-key -- MCP arrays have no item identity and each read replaces the entire result. */
import { preparePublishedHtml, publishedPageLink } from "./publishedPageDocument";
import type { StarkPublishedPageDocument } from "@starkfuture/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isOpenableStarkPageLink } from "@starkfuture/shared/starkPages";
import { pageFieldLabel, pageRecord, decodePublishedPageText } from "./publishedPagesFields";
import { cn } from "~/lib/utils";
import {
  MAX_PAGE_QUOTE_LENGTH,
  pageSelectionText,
  readPageSelection,
  type PageSelection,
  type StarkPageQuote,
} from "../starkPageQuote";
import type { StarkPageTarget } from "../starkPageTabs";
import { PagesQuoteSelection } from "./PagesQuoteSelection";

function openLink(url: string) {
  if (isOpenableStarkPageLink(url)) void window.desktopBridge?.openStarkPagesLink?.(url);
}

const markdownComponents: Components = {
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
  a: ({ href, children }) => (
    <button type="button" className="text-primary underline" onClick={() => href && openLink(href)}>
      {children}
    </button>
  ),
};

/** Published content gets no app origin, credentials, network access, forms or page scripts. */
function PublishedHtml({
  html,
  bundle,
  onNavigate,
  expanded = false,
  onExitExpanded,
  onQuote,
}: {
  html: string;
  bundle?: StarkPublishedPageDocument;
  onNavigate?: ((path: string) => void) | undefined;
  expanded?: boolean;
  onExitExpanded?: (() => void) | undefined;
  onQuote?: ((text: string) => boolean) | undefined;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const document = useMemo(() => preparePublishedHtml(html, bundle), [html, bundle]);
  const [selection, setSelection] = useState<(PageSelection & { token: string }) | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const data = pageRecord(event.data);
      if (data?.source !== "stark-published-page") return;
      if (data.type === "selection") {
        if (!onQuote) return;
        const selected = readPageSelection(data, "stark-published-page", document.selectionToken);
        if (selected !== null) setSelection({ token: document.selectionToken, ...selected });
        return;
      }
      if (data.type === "exit-expanded") {
        if (expanded) onExitExpanded?.();
        return;
      }
      if (data.type !== "open-link" || typeof data.url !== "string") return;
      const link = publishedPageLink(data.url, bundle);
      if (link?.kind === "page") onNavigate?.(link.path);
      else if (link?.kind === "external") openLink(link.url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bundle, onNavigate, expanded, onExitExpanded, onQuote, document.selectionToken]);
  return (
    <>
      {onQuote &&
      selection?.token === document.selectionToken &&
      (selection.text || selection.tooLong) ? (
        <PagesQuoteSelection
          text={selection.text}
          tooLong={selection.tooLong}
          onQuote={() => {
            if (!selection.tooLong && onQuote(selection.text)) setSelection(null);
          }}
        />
      ) : null}
      <iframe
        ref={frame}
        title="Published page"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={document.html}
        className={cn(
          "w-full bg-white",
          expanded
            ? "min-h-0 flex-1 border-0"
            : "h-[65vh] min-h-96 rounded-lg border border-border",
        )}
      />
      {document.warnings.length > 0 ? (
        <details className="max-h-28 shrink-0 overflow-auto text-xs text-muted-foreground">
          <summary>Some page resources are unavailable ({document.warnings.length})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {document.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function PublishedTextSelection({
  children,
  source,
  onQuote,
}: {
  children: ReactNode;
  source: string;
  onQuote?: ((text: string) => boolean) | undefined;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<(PageSelection & { source: string }) | null>(null);
  const readSelection = () => {
    const selected = window.getSelection();
    if (
      !selected ||
      !content.current?.contains(selected.anchorNode) ||
      !content.current.contains(selected.focusNode)
    ) {
      setSelection(null);
      return;
    }
    const text = selected.toString();
    setSelection({
      source,
      text: pageSelectionText(text) ?? "",
      tooLong: text.length > MAX_PAGE_QUOTE_LENGTH,
    });
  };
  return (
    <>
      {selection?.source === source && (selection.text || selection.tooLong) && onQuote ? (
        <PagesQuoteSelection
          text={selection.text}
          tooLong={selection.tooLong}
          onQuote={() => {
            if (!selection.tooLong && onQuote(selection.text)) setSelection(null);
          }}
        />
      ) : null}
      <div
        ref={content}
        className="min-h-0 flex-1 overflow-auto"
        onPointerUp={readSelection}
        onKeyUp={readSelection}
      >
        {children}
      </div>
    </>
  );
}

/** Keep arbitrary server result shapes readable without treating them as app markup. */
export function PublishedPageContent({
  value,
  document,
  onNavigate,
  expanded = false,
  onExitExpanded,
  onQuote,
  quotePage,
  depth = 0,
}: {
  value?: unknown;
  document?: StarkPublishedPageDocument;
  onNavigate?: (path: string) => void;
  expanded?: boolean;
  onExitExpanded?: (() => void) | undefined;
  onQuote?: ((quote: StarkPageQuote) => boolean) | undefined;
  quotePage?: Extract<StarkPageTarget, { kind: "published" }> | undefined;
  depth?: number;
}) {
  const quote =
    document &&
    quotePage &&
    onQuote &&
    quotePage.root === document.root &&
    quotePage.path === document.path
      ? (text: string) =>
          onQuote({
            text,
            page: quotePage,
            ...(document.publicUrl && isOpenableStarkPageLink(document.publicUrl)
              ? { url: document.publicUrl }
              : {}),
          })
      : undefined;
  if (document)
    return (
      <div
        className={cn(
          "min-w-0",
          expanded ? "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden" : "space-y-3",
        )}
      >
        {document.mimeType === "text/html" ? (
          <PublishedHtml
            html={document.source}
            bundle={document}
            onNavigate={onNavigate}
            expanded={expanded}
            onExitExpanded={onExitExpanded}
            onQuote={quote}
          />
        ) : (
          <PublishedTextSelection
            key={JSON.stringify([document.root, document.path])}
            source={document.source}
            onQuote={quote}
          >
            <PublishedPageContent value={document.source} />
          </PublishedTextSelection>
        )}
        {document.warnings.length > 0 ? (
          <details className="max-h-28 shrink-0 overflow-auto text-xs text-muted-foreground">
            <summary>Some page content is unavailable ({document.warnings.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {document.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    );
  if (depth > 10) return <p>More nested content is available in Pages.</p>;
  if (typeof value === "string") {
    const decoded = decodePublishedPageText(value);
    if (decoded !== value) return <PublishedPageContent value={decoded} depth={depth + 1} />;
    if (/<(?:!doctype|html|head|body|article|section|h[1-6]|div|p|table)(?:\s|>)/i.test(value))
      return <PublishedHtml html={value} />;
    return (
      <div className="chat-markdown max-w-none break-words text-sm leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>
          {value}
        </ReactMarkdown>
      </div>
    );
  }
  if (Array.isArray(value))
    return value.length ? (
      <div className="space-y-4">
        {value.slice(0, 200).map((item, index) => (
          <div key={index} className="rounded-lg border border-border p-3">
            <PublishedPageContent value={item} depth={depth + 1} />
          </div>
        ))}
        {value.length > 200 ? (
          <p>Showing the first 200 results. Narrow your search for more.</p>
        ) : null}
      </div>
    ) : (
      <p>No pages found.</p>
    );
  const record = pageRecord(value);
  if (record?.kind === "content" && typeof record.text === "string")
    return (
      <div className="space-y-3">
        {record.text.trim() ? (
          <PublishedPageContent value={record.text} depth={depth + 1} />
        ) : (
          <p>This page has no readable text. Use Page link to open it in your browser.</p>
        )}
        {record.truncated === true ? (
          <p className="text-xs text-muted-foreground">
            This is a shortened preview. Open the page in your browser for the full version.
          </p>
        ) : null}
      </div>
    );
  if (record)
    return (
      <dl className="space-y-3">
        {Object.entries(record)
          .slice(0, 100)
          .map(([key, item]) => (
            <div key={key}>
              <dt className="mb-1 text-xs font-medium text-muted-foreground">
                {pageFieldLabel(key)}
              </dt>
              <dd>
                <PublishedPageContent value={item} depth={depth + 1} />
              </dd>
            </div>
          ))}
      </dl>
    );
  return <span>{value === null || value === undefined ? "—" : String(value)}</span>;
}
