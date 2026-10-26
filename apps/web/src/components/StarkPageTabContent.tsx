import { useCallback, useEffect, useRef, useState } from "react";
import type { StarkPublishedPageDocument, StarkPublishedPagesStatus } from "@starkfuture/contracts";
import { isOpenableStarkPageLink } from "@starkfuture/shared/starkPages";
import type { StarkPageTarget } from "../starkPageTabs";
import { StarkPagesSidebar } from "./StarkPagesSidebar";
import { PublishedPageContent } from "./PublishedPageContent";
import { PagesConnectionNotice } from "./PagesConnectionNotice";
import { publishedPageTitle } from "./publishedPagesNavigation";
import { Button } from "./ui/button";
import type { StarkPageQuote } from "../starkPageQuote";

type PageTabProps = {
  page: StarkPageTarget;
  active: boolean;
  projectRoot: string;
  agent: "claude" | "codex";
  canPublish: boolean;
  onPublishRequest: (slug: string, title: string) => void;
  onNavigate: (page: StarkPageTarget) => void;
  onClose?: () => void;
  onQuote?: ((quote: StarkPageQuote) => boolean) | undefined;
};

/** A tab stays mounted while hidden so its frame and reading position survive. */
export function StarkPageTabContent(props: PageTabProps) {
  const { page, active, onNavigate } = props;
  return (
    <section
      aria-label={page.title}
      hidden={!active}
      inert={!active}
      className={active ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}
      data-stark-page-tab-content
    >
      {page.kind === "local" ? (
        <StarkPagesSidebar
          projectRoot={props.projectRoot}
          agent={props.agent}
          canPublish={props.canPublish}
          onPublishRequest={props.onPublishRequest}
          onClose={props.onClose ?? (() => {})}
          showHeader={false}
          initialSlug={page.slug}
          active={active}
          onOpenPage={onNavigate}
          onQuote={active ? props.onQuote : undefined}
        />
      ) : (
        <PublishedPageTab
          // A destination change starts a new reader; only refreshing the same
          // resource may retain its previous document and browser link.
          key={JSON.stringify([page.root, page.path])}
          page={page}
          active={active}
          onNavigate={onNavigate}
          onQuote={active ? props.onQuote : undefined}
        />
      )}
    </section>
  );
}

function PublishedPageTab({
  page,
  active,
  onNavigate,
  onQuote,
}: {
  page: Extract<StarkPageTarget, { kind: "published" }>;
  active: boolean;
  onNavigate: (page: StarkPageTarget) => void;
  onQuote?: ((quote: StarkPageQuote) => boolean) | undefined;
}) {
  const bridge = window.desktopBridge?.publishedPages;
  const [status, setStatus] = useState<StarkPublishedPagesStatus | null>(null);
  const [document, setDocument] = useState<StarkPublishedPageDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const connected = useRef(false);
  const connecting = useRef(false);
  const load = useCallback(
    async (refresh: boolean) => {
      if (!bridge) return;
      const request = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        const current = await bridge.status();
        if (request !== generation.current) return;
        setStatus(current);
        if (current.state !== "connected") {
          connected.current = false;
          setDocument(null);
          return;
        }
        const result = await bridge.openPage({ root: page.root, path: page.path, refresh });
        if (request !== generation.current) return;
        if (result.root !== page.root || result.path !== page.path)
          throw new Error("Pages returned a different page. Try opening it again.");
        setDocument(result);
      } catch (failure) {
        if (request === generation.current)
          setError(
            failure instanceof Error && !failure.message.includes("IPC")
              ? failure.message.slice(0, 500)
              : "This page could not be opened. Try again.",
          );
      } finally {
        if (request === generation.current) setBusy(false);
      }
    },
    [bridge, page.root, page.path],
  );

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    let pending = false;
    const check = async () => {
      if (pending || connecting.current) return;
      pending = true;
      try {
        const next = await bridge.status();
        if (cancelled) return;
        setStatus(next);
        if (next.state !== "connected") {
          generation.current += 1;
          connected.current = false;
          setDocument(null);
          setBusy(false);
          setError(null);
        } else if (!connected.current) {
          connected.current = true;
          void load(false);
        }
      } catch {
        if (!cancelled) {
          generation.current += 1;
          connected.current = false;
          setDocument(null);
          setBusy(false);
          setStatus({ state: "error", message: null });
          setError("Could not check the Pages connection. Try again.");
        }
      } finally {
        pending = false;
      }
    };
    void check();
    // Continue checking hidden tabs too: a sign-out clears all cached private views.
    const timer = window.setInterval(() => void check(), 2000);
    return () => {
      cancelled = true;
      generation.current += 1;
      connected.current = false;
      window.clearInterval(timer);
    };
  }, [bridge, load]);

  const connect = async () => {
    if (!bridge || connecting.current) return;
    connecting.current = true;
    const request = generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.connect();
      if (request === generation.current) setStatus(next);
    } catch {
      if (request === generation.current) setError("Pages sign-in could not start. Try again.");
    } finally {
      connecting.current = false;
      if (request === generation.current) setBusy(false);
    }
  };

  if (!bridge)
    return <p className="p-4 text-sm">Open Stark Code on your Mac to read published Pages.</p>;

  return (
    <div className="stark-review-surface flex min-h-0 min-w-0 flex-1 flex-col bg-background text-sm text-foreground">
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-2.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Company page</span>
        {status?.state === "connected" ? (
          <>
            <Button
              size="comfortable"
              variant="quiet"
              disabled={busy}
              onClick={() => void load(true)}
            >
              Refresh page
            </Button>
            {document?.publicUrl && isOpenableStarkPageLink(document.publicUrl) ? (
              <Button
                size="comfortable"
                variant="quiet"
                onClick={() => void window.desktopBridge?.openStarkPagesLink?.(document.publicUrl!)}
              >
                Open in browser
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {error ? (
        <div className="space-y-2 p-3">
          <p role="alert">{error}</p>
          {status?.state === "connected" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(true)}>
              Retry page
            </Button>
          ) : null}
        </div>
      ) : null}
      {status?.state === "connected" ? (
        <>
          {busy ? <p role="status">{document ? "Refreshing page…" : "Opening page…"}</p> : null}
          {document ? (
            <PublishedPageContent
              document={document}
              quotePage={page}
              onQuote={active ? onQuote : undefined}
              expanded
              onNavigate={(path) => {
                if (active)
                  onNavigate({
                    kind: "published",
                    root: page.root,
                    path,
                    title: publishedPageTitle(path),
                  });
              }}
            />
          ) : null}
        </>
      ) : (
        <div className="space-y-3 p-3">
          <PagesConnectionNotice status={status} busy={busy} onConnect={() => void connect()} />
        </div>
      )}
    </div>
  );
}
