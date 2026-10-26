import { useEffect, useRef, useState } from "react";
import type { StarkPublishedPageDocument } from "@starkfuture/contracts";
import { preparePublishedHtml } from "./publishedPageDocument";
import { observeResize } from "~/lib/observeResize";
import styles from "./PublishedPageCover.module.css";

type CoverJob = { cancelled: boolean; run: () => Promise<void> };
type Cover = { root: string; html?: string; text?: string };
const pending: CoverJob[] = [];
let active = 0;

function drainCovers() {
  while (active < 2 && pending.length) {
    const job = pending.shift()!;
    if (job.cancelled) continue;
    active += 1;
    void (async () => {
      try {
        await job.run();
      } catch {
        // A collection without an index keeps its typographic cover.
      } finally {
        active -= 1;
        drainCovers();
      }
    })();
  }
}

function queueCover(run: CoverJob["run"]) {
  const job = { cancelled: false, run };
  pending.push(job);
  drainCovers();
  return () => {
    job.cancelled = true;
    const index = pending.indexOf(job);
    if (index !== -1) pending.splice(index, 1);
  };
}

function coverHtml(page: StarkPublishedPageDocument) {
  const prepared = preparePublishedHtml(page.source, page);
  const document = new DOMParser().parseFromString(prepared.html, "text/html");
  // A decorative cover needs neither the reader's trusted bridge nor page interaction.
  for (const script of document.querySelectorAll("script")) script.remove();
  const csp = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]');
  if (csp)
    csp.content =
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  const staticStyles = document.createElement("style");
  staticStyles.textContent =
    "html,body{overflow:hidden!important}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
  document.head.append(staticStyles);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

/** A visible collection's own offline page, with no scripts, network or interactive surface. */
export function PublishedPageCover({
  root,
  title,
  enabled = true,
}: {
  root: string;
  title: string;
  enabled?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const attempt = useRef<{ root: string; result: Promise<Cover | null> } | null>(null);
  const [width, setWidth] = useState(220);
  const [cover, setCover] = useState<Cover | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const measured = element.getBoundingClientRect().width;
      if (measured > 0) setWidth(measured);
    };
    measure();
    return observeResize(element, measure);
  }, []);

  useEffect(() => {
    const element = container.current;
    const bridge = window.desktopBridge?.publishedPages;
    if (!enabled || !element || !bridge) return;
    let mounted = true;
    const receive = async (result: Promise<Cover | null>) => {
      const value = await result;
      if (mounted && value) setCover(value);
    };
    if (attempt.current?.root === root) {
      void receive(attempt.current.result);
      return () => {
        mounted = false;
      };
    }
    if (typeof IntersectionObserver === "undefined") return;
    let visible = false;
    let scheduled = false;
    let cancel = () => {};
    const observer = new IntersectionObserver((entries) => {
      if (!mounted) return;
      visible = entries.some((entry) => entry.isIntersecting);
      if (!visible || scheduled) return;
      scheduled = true;
      cancel = queueCover(async () => {
        if (!mounted || !visible) {
          scheduled = false;
          return;
        }
        observer.disconnect();
        const result = bridge
          .openPage({ root, path: "index.html", refresh: false })
          .then((page): Cover =>
            page.mimeType === "text/html"
              ? { root, html: coverHtml(page) }
              : { root, text: page.source.slice(0, 600) },
          )
          .catch(() => null);
        attempt.current = { root, result };
        await receive(result);
      });
    });
    observer.observe(element);
    return () => {
      mounted = false;
      observer.disconnect();
      cancel();
    };
  }, [root, enabled]);

  const current = cover?.root === root ? cover : null;
  return (
    <div ref={container} className={styles.cover} aria-hidden="true">
      {current?.html ? (
        <iframe
          title={`${title} preview`}
          sandbox=""
          referrerPolicy="no-referrer"
          tabIndex={-1}
          srcDoc={current.html}
          style={{ width: 960, height: 568, transform: `scale(${width / 960})` }}
        />
      ) : current?.text ? (
        <div className={styles.text}>{current.text}</div>
      ) : (
        <div className={styles.fallback}>
          <span className={styles.rule} />
          <span className={styles.title}>{title}</span>
          <span className={styles.lines}>
            <i />
            <i />
            <i />
          </span>
        </div>
      )}
    </div>
  );
}
