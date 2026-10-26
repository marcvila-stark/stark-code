/* oxlint-disable react/iframe-missing-sandbox -- This fixed loopback frame is cross-origin from the app and must run the mirror scripts. */
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import {
  isMirrorFollowUrl,
  isOpenableStarkPageLink,
  parseStarkPagesMessage,
  type StarkPagesMirror,
} from "@starkfuture/shared/starkPages";
import { Button } from "./ui/button";
import type { StarkPageTarget } from "../starkPageTabs";
import { readPageSelection, type PageSelection, type StarkPageQuote } from "../starkPageQuote";
import { PagesQuoteSelection } from "./PagesQuoteSelection";
import { LocalPagesLibrary, type LocalPageEntry } from "./LocalPagesLibrary";

const EMPTY = "No pages yet. Ask Claude for a decision or a report, or run /stark-workbench:page.";

export function StarkPagesSidebar(props: {
  readonly projectRoot: string;
  readonly agent: "claude" | "codex";
  readonly canPublish: boolean;
  readonly onPublishRequest: (slug: string, title: string) => void;
  readonly onClose: () => void;
  readonly showHeader?: boolean;
  readonly initialSlug?: string;
  readonly active?: boolean;
  readonly onPageChange?: ((page: StarkPageTarget) => void) | undefined;
  readonly onOpenPage?: ((page: StarkPageTarget) => void) | undefined;
  readonly onQuote?: ((quote: StarkPageQuote) => boolean) | undefined;
}) {
  const {
    projectRoot,
    agent,
    canPublish,
    onPublishRequest,
    onClose,
    initialSlug,
    active = true,
    onOpenPage,
    onPageChange,
    onQuote,
  } = props;
  const publishingEnabled = canPublish && agent === "claude";
  const libraryEnabled = !initialSlug && Boolean(window.desktopBridge?.listStarkPages);
  const [chosenPage, setChosenPage] = useState<{ root: string; page: LocalPageEntry } | null>(null);
  const documentSlug =
    initialSlug ?? (chosenPage?.root === projectRoot ? chosenPage.page.slug : undefined);
  const showLibrary = libraryEnabled && !documentSlug;
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [catalog, setCatalog] = useState<{
    key: string;
    pages: readonly LocalPageEntry[];
    error: boolean;
  } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const trusted = useRef<{ key: string; ready: boolean; selectionToken?: string } | null>(null);
  const [selection, setSelection] = useState<
    (PageSelection & { key: string; slug: string }) | null
  >(null);
  const connectionTimer = useRef<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [discovery, setDiscovery] = useState<{
    projectRoot: string;
    retry: number;
    mirror: StarkPagesMirror | null;
    startFailed: boolean;
  } | null>(null);
  const [notice, setNotice] = useState<{ key: string; message: string } | null>(null);
  const [selectedPage, setSelectedPage] = useState<{
    key: string;
    page: Extract<StarkPageTarget, { kind: "local" }>;
  } | null>(null);
  const mirror =
    discovery?.projectRoot === projectRoot && discovery.retry === retry ? discovery.mirror : null;
  const discovering = discovery?.projectRoot !== projectRoot || discovery.retry !== retry;
  const origin = mirror ? `http://127.0.0.1:${mirror.port}` : null;

  const panelKey = `${projectRoot}:${origin ?? ""}:${documentSlug ?? ""}:${retry}`;
  const catalogKey = `${projectRoot}:${origin ?? ""}:${retry}:${catalogRefresh}`;
  const currentCatalog = catalog?.key === catalogKey ? catalog : null;
  const shownSlug = useRef<string | null>(null);
  const mirrorRoot = mirror?.root;
  const mirrorPort = mirror?.port;
  const activeNotice =
    notice?.key === panelKey
      ? notice.message
      : discovery?.projectRoot === projectRoot && discovery.retry === retry && discovery.startFailed
        ? "Pages could not start. Retry, or reopen Stark Code if the problem continues."
        : null;

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const check = async (start = false) => {
      if (pending) return;
      pending = true;
      try {
        const ensure = window.desktopBridge?.ensureStarkPagesMirror;
        const result =
          (await (start && ensure
            ? ensure(projectRoot)
            : window.desktopBridge?.getStarkPagesMirror?.(projectRoot))) ?? null;
        if (!cancelled)
          setDiscovery((previous) => ({
            projectRoot,
            retry,
            mirror: result,
            startFailed:
              result !== null
                ? false
                : start && ensure !== undefined
                  ? true
                  : (previous?.startFailed ?? false),
          }));
      } catch {
        if (!cancelled) setDiscovery({ projectRoot, retry, mirror: null, startFailed: true });
      } finally {
        pending = false;
      }
    };
    void check(true);
    const timer = window.setInterval(() => {
      void check();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectRoot, retry]);

  useEffect(() => {
    const list = window.desktopBridge?.listStarkPages;
    if (!active || !libraryEnabled || !origin || !list) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const pages = await list(projectRoot);
        if (!cancelled) setCatalog({ key: catalogKey, pages: pages ?? [], error: pages === null });
      } catch {
        if (!cancelled) setCatalog({ key: catalogKey, pages: [], error: true });
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, libraryEnabled, origin, projectRoot, catalogKey]);

  useEffect(() => {
    trusted.current = { key: panelKey, ready: false };
    shownSlug.current = null;
  }, [panelKey]);
  useEffect(() => {
    if (!origin || showLibrary) return;
    connectionTimer.current = window.setTimeout(() => {
      if (trusted.current?.key === panelKey && trusted.current.ready) return;
      setNotice({
        key: panelKey,
        message: "The Pages panel did not connect. Retry Pages to reconnect.",
      });
    }, 8000);
    return () => {
      if (connectionTimer.current !== null) window.clearTimeout(connectionTimer.current);
      connectionTimer.current = null;
    };
  }, [origin, panelKey, showLibrary]);
  useEffect(() => {
    if (!origin || mirrorRoot === undefined || mirrorPort === undefined) return;
    const sendHost = () => {
      if (trusted.current?.key === panelKey && trusted.current.ready)
        frame.current?.contentWindow?.postMessage(
          {
            v: 1,
            source: "stark-host",
            type: "host",
            canPublish: publishingEnabled,
            agent: agent,
            ...(active && onQuote && trusted.current.selectionToken
              ? { selectionToken: trusted.current.selectionToken }
              : {}),
            ...(documentSlug ? { presentation: "document" } : {}),
            ...(libraryEnabled ? { embeddedControls: true } : {}),
          },
          origin,
        );
    };
    const sendShow = () => {
      if (documentSlug && trusted.current?.key === panelKey && trusted.current.ready)
        frame.current?.contentWindow?.postMessage(
          { v: 1, source: "stark-host", type: "show", slug: documentSlug },
          origin,
        );
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      if (
        active &&
        onQuote &&
        trusted.current?.key === panelKey &&
        trusted.current.ready &&
        trusted.current.selectionToken
      ) {
        const selected = readPageSelection(
          event.data,
          "stark-pages",
          trusted.current.selectionToken,
        );
        if (
          selected !== null &&
          event.data.v === 1 &&
          event.data.slug === shownSlug.current &&
          shownSlug.current
        ) {
          setSelection({ key: panelKey, slug: shownSlug.current, ...selected });
          return;
        }
      }
      const message = parseStarkPagesMessage(event.data);
      if (!message) return;
      if (message.type === "ready") {
        if (message.root !== mirrorRoot || message.port !== mirrorPort) {
          trusted.current = { key: panelKey, ready: false };
          setNotice({
            key: panelKey,
            message: "The pages panel belongs to a different project. Reopen Pages to try again.",
          });
          return;
        }
        // A new handshake invalidates selection messages queued by an older document.
        // @effect-diagnostics-next-line cryptoRandomUUID:off -- Per-frame message capability, never persisted.
        trusted.current = { key: panelKey, ready: true, selectionToken: crypto.randomUUID() };
        setSelection(null);
        if (connectionTimer.current !== null) window.clearTimeout(connectionTimer.current);
        connectionTimer.current = null;
        setNotice(null);
        sendHost();
        // A named tab belongs to one page. Do not let mirror events replace it
        // with a newly generated page while the user reads another tab.
        if (documentSlug)
          frame.current?.contentWindow?.postMessage(
            { v: 1, source: "stark-host", type: "pause" },
            origin,
          );
        return;
      }
      if (trusted.current?.key !== panelKey || !trusted.current.ready) return;
      if (message.type === "show") {
        shownSlug.current = message.page.slug;
        const page = { kind: "local" as const, ...message.page };
        // Followed catalog pages remain previews until the user opens a tab.
        setSelectedPage({ key: panelKey, page });
        setSelection(null);
        onPageChange?.(page);
        if (initialSlug) {
          if (active) onOpenPage?.(page);
        }
      } else if (message.type === "publish-request") {
        if (!active) return;
        if (!publishingEnabled) {
          setNotice({
            key: panelKey,
            message: "Publishing works in native Claude shell mode with the Stark plugin loaded.",
          });
          return;
        }
        // This stages text only. The user sends it, and the plugin's publish guard still asks.
        onPublishRequest(message.page.slug, message.page.title);
      } else if (message.type === "open-external" && isMirrorFollowUrl(message.url, mirrorPort)) {
        void window.desktopBridge
          ?.openStarkPagesExternal?.({ projectRoot, url: message.url })
          .then((opened) => {
            if (!opened)
              setNotice({
                key: panelKey,
                message:
                  "Could not open this page in your browser. Retry after the mirror reconnects.",
              });
          })
          .catch(() => {
            setNotice({ key: panelKey, message: "Could not open this page in your browser." });
          });
      } else if (message.type === "open-link" && isOpenableStarkPageLink(message.url)) {
        void window.desktopBridge
          ?.openStarkPagesLink?.(message.url)
          .then((opened) => {
            if (!opened)
              setNotice({ key: panelKey, message: "Could not open this link in your browser." });
          })
          .catch(() => {
            setNotice({ key: panelKey, message: "Could not open this link in your browser." });
          });
      }
    };
    window.addEventListener("message", onMessage);
    sendHost();
    if (active && documentSlug && shownSlug.current !== documentSlug) sendShow();
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [
    origin,
    mirrorRoot,
    mirrorPort,
    panelKey,
    projectRoot,
    agent,
    publishingEnabled,
    onPublishRequest,
    initialSlug,
    documentSlug,
    libraryEnabled,
    active,
    onOpenPage,
    onPageChange,
    onQuote,
  ]);

  return (
    <aside
      aria-label="Stark Pages"
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background"
    >
      {props.showHeader !== false ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium">Pages</span>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : null}
      {activeNotice && !showLibrary ? (
        <div className="space-y-2 border-b border-border px-3 py-2 text-sm text-muted-foreground">
          <p role="status">{activeNotice}</p>
          <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>
            Retry Pages
          </Button>
        </div>
      ) : null}
      {libraryEnabled && documentSlug ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setChosenPage(null);
              setSelection(null);
            }}
          >
            <ArrowLeftIcon aria-hidden />
            All pages
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm">
            {chosenPage?.root === projectRoot ? chosenPage.page.title : "Local page"}
          </span>
          {onOpenPage && chosenPage?.root === projectRoot ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!active}
              onClick={() =>
                onOpenPage({
                  kind: "local",
                  slug: chosenPage.page.slug,
                  title: chosenPage.page.title,
                })
              }
            >
              Open page in tab
            </Button>
          ) : null}
        </div>
      ) : null}
      {onOpenPage && !libraryEnabled && !initialSlug && selectedPage?.key === panelKey && origin ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm">{selectedPage.page.title}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={!active}
            onClick={() => onOpenPage(selectedPage.page)}
          >
            Open page in tab
          </Button>
        </div>
      ) : null}
      {active &&
      onQuote &&
      selection?.key === panelKey &&
      (selection.text || selection.tooLong) &&
      selectedPage?.key === panelKey &&
      selectedPage.page.slug === selection.slug ? (
        <PagesQuoteSelection
          text={selection.text}
          tooLong={selection.tooLong}
          onQuote={() => {
            if (
              !selection.tooLong &&
              onQuote({ text: selection.text, page: selectedPage.page, projectRoot })
            )
              setSelection(null);
          }}
        />
      ) : null}
      {showLibrary ? (
        <LocalPagesLibrary
          key={projectRoot}
          projectRoot={projectRoot}
          pages={currentCatalog?.pages ?? []}
          loading={Boolean(origin && !currentCatalog)}
          starting={!origin && discovering}
          error={
            activeNotice ??
            (currentCatalog?.error
              ? "Could not read this folder’s pages. Try again in a moment."
              : !origin && !discovering
                ? "The page preview is not running. Try again to reconnect."
                : null)
          }
          onRefresh={() => {
            if (!origin || activeNotice) setRetry((value) => value + 1);
            else setCatalogRefresh((value) => value + 1);
          }}
          onOpen={(page) => {
            setChosenPage({ root: projectRoot, page });
            setSelection(null);
            onPageChange?.({ kind: "local", slug: page.slug, title: page.title });
          }}
        />
      ) : origin && mirror ? (
        <iframe
          key={panelKey}
          ref={frame}
          src={`${origin}/panel${documentSlug ? `?slug=${encodeURIComponent(documentSlug)}` : ""}`}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          title="Stark pages"
          className="h-full min-h-0 w-full flex-1 border-0"
        />
      ) : (
        <div className="space-y-3 p-4 text-sm text-muted-foreground">
          <p>
            {window.desktopBridge?.ensureStarkPagesMirror &&
            (discovery?.projectRoot !== projectRoot || discovery.retry !== retry)
              ? "Starting Pages…"
              : EMPTY}
          </p>
          {!window.desktopBridge?.getStarkPagesMirror ? (
            <p>Open this project in the Stark Code desktop app to view its pages.</p>
          ) : null}
        </div>
      )}
    </aside>
  );
}
