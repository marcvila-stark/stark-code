import type { EnvironmentId, ScopedThreadRef } from "@starkfuture/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@starkfuture/shared/htmlRender";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { toastManager } from "../ui/toast";
import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { InlinePreviewStage } from "./InlinePreviewStage";
import { observeResize } from "~/lib/observeResize";

// A frame may load its URL a little after mounting.
const MIN_URL_LIFE_MS = 5 * 60_000;

/**
 * An agent's HTML render inline in the thread, at the server's measured height until the
 * page reports its own. Loading and failure hold the same box so nothing below
 * it moves.
 */
export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
  readonly navigation?: {
    readonly index: number;
    readonly count: number;
    readonly onPrevious: () => void;
    readonly onNext: () => void;
  };
}) {
  const { attachmentId, title } = props.htmlRender;
  // The frame takes the page's measured height at its own width, read before
  // first paint so the reserved box is already the right size.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      // A visited carousel page stays mounted while hidden; keep its last real width.
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
  }, []);
  // Client fonts can wrap a page taller than the server measured it; a frame
  // left short would scroll inside the thread and take the reader's scroll.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const fileName = htmlRenderFileName(title);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  // A cached URL with life left is reused, so the browser's cache serves the
  // page again; one near expiry is minted afresh, since a frame cannot report a
  // failed load. The page keeps its first URL for its lifetime.
  const [src, setSrc] = useState<string | null>(null);
  const [expandedSrc, setExpandedSrc] = useState<string | null>(null);
  const { onFullscreenChange } = props;
  useEffect(() => {
    if (expandedSrc === null) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expandedSrc, onFullscreenChange]);
  const [failed, setFailed] = useState(false);
  const assetUrl = useAssetUrlState(src === null ? props.environmentId : null, resource);
  const cachedUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  const cachedExpiresAt = assetUrl._tag === "Success" ? assetUrl.expiresAt : 0;
  const cacheFailed = assetUrl._tag === "Failure";
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  // At most one mint per mount: expiry is server time and the check uses the
  // client clock, so a skewed clock must not mint again on every update.
  const minting = useRef(false);
  useEffect(() => {
    if (src !== null || minting.current) return;
    if (cacheFailed) {
      // oxlint-disable-next-line react/set-state-in-effect -- Mirrors the cached URL's failure.
      setFailed(true);
      return;
    }
    if (cachedUrl === null) return;
    if (cachedExpiresAt - Date.now() > MIN_URL_LIFE_MS) {
      setSrc(cachedUrl);
      return;
    }
    minting.current = true;
    void refresh().then(
      (url) => (url === null ? setFailed(true) : setSrc(url)),
      () => setFailed(true),
    );
  }, [cacheFailed, cachedExpiresAt, cachedUrl, refresh, src]);

  const expand = async () => {
    const url = await refresh().catch(() => null);
    if (url !== null) setExpandedSrc(url);
    else
      toastManager.add({
        type: "error",
        title: "Page unavailable",
        description: "Reconnect to the environment and try again.",
      });
  };

  return (
    <InlinePreviewStage
      title={title}
      {...props.navigation}
      onExpand={expand}
      expandDisabled={src === null}
    >
      <div ref={boxRef} className="relative" style={{ height }}>
        {src !== null ? (
          <>
            <HtmlRenderDocument
              src={src}
              title={title}
              threadRef={props.threadRef}
              className="block size-full"
              onContentHeight={setContentHeight}
            />
            {expandedSrc !== null ? (
              <HtmlRenderDialog
                src={expandedSrc}
                title={title}
                threadRef={props.threadRef}
                onClose={() => setExpandedSrc(null)}
              />
            ) : null}
          </>
        ) : failed ? (
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            Unable to load {title}
          </p>
        ) : null}
      </div>
    </InlinePreviewStage>
  );
}

/** Only adjacent pages from one turn share navigation. Visited pages retain their UI state. */
export function HtmlRenderGallery(props: {
  readonly environmentId: EnvironmentId;
  readonly renders: readonly HtmlRenderReference[];
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
}) {
  const [selected, setSelected] = useState(props.renders[0]?.attachmentId);
  const [visited, setVisited] = useState(() => new Set([selected]));
  const galleryRef = useRef<HTMLDivElement>(null);
  const navigationFocus = useRef<string | null>(null);
  const foundIndex = props.renders.findIndex((render) => render.attachmentId === selected);
  const index = Math.max(0, foundIndex);
  const navigate = (direction: -1 | 1) => {
    const next = props.renders[(index + direction + props.renders.length) % props.renders.length];
    if (!next) return;
    navigationFocus.current = direction === -1 ? "Previous preview" : "Next preview";
    setSelected(next.attachmentId);
    setVisited((current) => new Set([...current, next.attachmentId]));
  };
  useLayoutEffect(() => {
    if (selected === undefined || navigationFocus.current === null) return;
    galleryRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-preview-active="true"] button[aria-label="${navigationFocus.current}"]`,
      )
      ?.focus({ preventScroll: true });
    navigationFocus.current = null;
  }, [selected]);
  return (
    <div ref={galleryRef}>
      {props.renders.map((render, position) =>
        position === index || visited.has(render.attachmentId) ? (
          <div
            key={render.attachmentId}
            hidden={position !== index}
            data-preview-active={position === index}
          >
            <HtmlRenderFrame
              environmentId={props.environmentId}
              htmlRender={render}
              threadRef={props.threadRef}
              {...(props.onFullscreenChange
                ? { onFullscreenChange: props.onFullscreenChange }
                : {})}
              navigation={{
                index: position,
                count: props.renders.length,
                onPrevious: () => navigate(-1),
                onNext: () => navigate(1),
              }}
            />
          </div>
        ) : null,
      )}
    </div>
  );
}
