import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import type { ResponseVisualsResult, ScopedThreadRef } from "@starkfuture/contracts";
import { BookOpenIcon } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { responseVisualsEnvironment } from "../../state/responseVisuals";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { readerViewport } from "../reader/readerOutline";
import { Button } from "../ui/button";
import { ResponseVisualOverview } from "./ResponseVisualPanel";

interface ReplyPresentation {
  readonly reading: boolean;
  readonly result: ResponseVisualsResult | null;
  readonly busy: boolean;
  readonly error: string | null;
}
interface ReplyPresentationEntry {
  readonly answer: string;
  snapshot: ReplyPresentation;
  readonly listeners: Set<() => void>;
}

// Virtualized rows unmount while scrolling. Keep a bounded, session-only cache so
// their presentation and in-flight generation survive without writing reply text to storage.
const replyPresentations = new Map<string, ReplyPresentationEntry>();
function replyPresentation(props: InlineReadableReplyProps): ReplyPresentationEntry {
  const key = JSON.stringify([
    props.threadRef.environmentId,
    props.threadRef.threadId,
    props.answerId,
  ]);
  const saved = replyPresentations.get(key);
  if (saved?.answer === props.answer) return saved;
  const entry: ReplyPresentationEntry = {
    answer: props.answer,
    snapshot: {
      reading: props.initiallyReadable ?? false,
      result: null,
      busy: false,
      error: null,
    },
    listeners: new Set(),
  };
  replyPresentations.set(key, entry);
  for (const [oldKey, oldEntry] of replyPresentations) {
    if (replyPresentations.size <= 64) break;
    if (oldEntry !== entry && oldEntry.listeners.size === 0 && !oldEntry.snapshot.busy)
      replyPresentations.delete(oldKey);
  }
  return entry;
}

function updateReplyPresentation(
  entry: ReplyPresentationEntry,
  update: Partial<ReplyPresentation>,
) {
  entry.snapshot = { ...entry.snapshot, ...update };
  for (const listener of entry.listeners) listener();
}

export interface InlineReadableReplyProps {
  readonly answerId: string;
  readonly answer: string;
  readonly threadRef: ScopedThreadRef;
  readonly cwd?: string | undefined;
  readonly completed?: boolean | undefined;
  readonly initiallyReadable?: boolean | undefined;
  readonly truncated?: boolean | undefined;
  /** Keep the caller's original source and citation anchors mounted in both views. */
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly onReadabilityRequest?: (() => void) | undefined;
  readonly onRevealOverview?: ((overview: HTMLElement) => void) | undefined;
}

/** Wait for virtualized row measurements, and stop immediately on a new user gesture. */
export function revealReadableOverview(options: {
  readonly overview: HTMLElement;
  readonly viewport: HTMLElement;
  readonly scrollToOffset: (offset: number) => Promise<unknown> | void;
  readonly cancelScroll?: (() => void) | undefined;
  readonly onSettled: () => void;
}): () => void {
  const { overview, viewport } = options;
  let frame: number | null = null;
  let stopped = false;
  let attempts = 0;
  let stableFrames = 0;
  function dispose() {
    if (stopped) return;
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    viewport.removeEventListener("wheel", cancelNavigation);
    viewport.removeEventListener("touchmove", cancelNavigation);
    viewport.removeEventListener("pointerdown", cancelNavigation);
    viewport.ownerDocument.removeEventListener("keydown", scrollKey);
  }
  function finish() {
    if (stopped) return;
    dispose();
    options.onSettled();
  }
  function cancelNavigation() {
    if (stopped) return;
    options.cancelScroll?.();
    finish();
  }
  function scrollKey(event: KeyboardEvent) {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
      cancelNavigation();
  }
  function schedule() {
    if (!stopped) frame = requestAnimationFrame(reconcile);
  }
  function reconcile() {
    frame = null;
    if (stopped) return;
    if (!overview.isConnected || !viewport.contains(overview) || ++attempts > 12) {
      finish();
      return;
    }
    const offset = Math.max(
      0,
      Math.min(
        viewport.scrollHeight - viewport.clientHeight,
        viewport.scrollTop +
          overview.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          16,
      ),
    );
    if (Math.abs(viewport.scrollTop - offset) > 1) {
      stableFrames = 0;
      void Promise.resolve(options.scrollToOffset(offset)).then(schedule, finish);
    } else if (++stableFrames >= 2) finish();
    else schedule();
  }
  viewport.addEventListener("wheel", cancelNavigation, { passive: true });
  viewport.addEventListener("touchmove", cancelNavigation, { passive: true });
  viewport.addEventListener("pointerdown", cancelNavigation, { passive: true });
  viewport.ownerDocument.addEventListener("keydown", scrollKey);
  schedule();
  return () => {
    if (!stopped) options.cancelScroll?.();
    dispose();
  };
}

/** The one-click visual summary stays beside the untouched, quoteable source. */
export function InlineReadableReply(props: InlineReadableReplyProps) {
  return (
    <ReadableReply
      key={`${props.threadRef.environmentId}:${props.threadRef.threadId}:${props.answerId}:${props.answer}`}
      {...props}
    />
  );
}

function ReadableReply(props: InlineReadableReplyProps) {
  const root = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{ element: HTMLElement; viewport: HTMLElement; top: number } | null>(
    null,
  );
  const revealOverview = useRef<HTMLElement | null>(null);
  const [presentation] = useState(() => replyPresentation(props));
  const { reading, result, busy, error } = useSyncExternalStore(
    (listener) => {
      presentation.listeners.add(listener);
      return () => presentation.listeners.delete(listener);
    },
    () => presentation.snapshot,
    () => presentation.snapshot,
  );
  function updatePresentation(update: Partial<ReplyPresentation>) {
    updateReplyPresentation(presentation, update);
  }
  const allowed = useAtomValue(
    responseVisualsEnvironment.format.permissionAtom(props.threadRef.environmentId),
  );
  const generate = useAtomCommand(responseVisualsEnvironment.format, { reportFailure: false });
  const tooLong =
    props.answer.length > 24_000 || new TextEncoder().encode(props.answer).byteLength > 48 * 1024;
  const available = props.completed !== false && props.answer.trim().length > 0;

  function preserveReadingPosition() {
    const container = root.current;
    if (!container) return;
    const viewport = readerViewport(container);
    if (!viewport) return;
    const viewportTop = viewport.getBoundingClientRect().top;
    const element =
      [
        ...container.querySelectorAll<HTMLElement>(
          "[data-inline-readable-source] :is(p,h1,h2,h3,h4,h5,h6,pre,li)",
        ),
      ].find((candidate) => candidate.getBoundingClientRect().top >= viewportTop) ?? container;
    scrollAnchor.current = { element, viewport, top: element.getBoundingClientRect().top };
  }

  useLayoutEffect(() => {
    const revealViewport = revealOverview.current;
    revealOverview.current = null;
    const overview = root.current?.querySelector<HTMLElement>("[data-inline-readable-overview]");
    if (revealViewport && overview) {
      scrollAnchor.current = null;
      if (props.onRevealOverview) {
        props.onRevealOverview(overview);
        return;
      }
      revealViewport.scrollTop +=
        overview.getBoundingClientRect().top - revealViewport.getBoundingClientRect().top - 16;
      return;
    }
    const anchor = scrollAnchor.current;
    scrollAnchor.current = null;
    if (anchor?.element.isConnected) {
      anchor.viewport.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
    }
  });

  async function makeVisual() {
    const viewport = root.current ? readerViewport(root.current) : null;
    const startedAtScrollTop = viewport?.scrollTop;
    if (result) {
      props.onReadabilityRequest?.();
      revealOverview.current = viewport;
      updatePresentation({ reading: true });
      return;
    }
    if (presentation.snapshot.busy || !allowed || tooLong || props.truncated) return;
    props.onReadabilityRequest?.();
    updatePresentation({ busy: true, error: null });
    try {
      const response = await generate({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, answer: props.answer, visualRequest: "auto" },
      });
      if (response._tag === "Failure") {
        const cause = squashAtomCommandFailure(response);
        updatePresentation({
          error: cause instanceof Error ? cause.message : "Could not make this reply visual.",
        });
      } else {
        // Reveal an explicit result only while the user is still waiting here.
        // Scrolling elsewhere during the call must not yank the conversation back.
        if (
          viewport &&
          startedAtScrollTop !== undefined &&
          Math.abs(viewport.scrollTop - startedAtScrollTop) < 2
        ) {
          revealOverview.current = viewport;
        } else preserveReadingPosition();
        updatePresentation({ result: response.value, reading: true });
      }
    } catch (cause) {
      updatePresentation({
        error: cause instanceof Error ? cause.message : "Could not make this reply visual.",
      });
    } finally {
      updatePresentation({ busy: false });
    }
  }

  function showOriginal() {
    preserveReadingPosition();
    updatePresentation({ reading: false });
  }

  return (
    <div ref={root} className="min-w-0" data-inline-readable={reading ? "reading" : "original"}>
      <div
        className={cn("min-w-0", reading && "py-2")}
        style={
          reading
            ? ({
                "--reply-reader-size": "1.125rem",
                "--reply-reader-line-height": "1.8",
                "--reply-reader-paragraph-gap": "1.1em",
                "--reply-reader-list-gap": "0.6em",
              } as CSSProperties)
            : undefined
        }
      >
        {reading && result ? (
          <div data-inline-readable-overview data-thread-find-ignore>
            <div className="mb-1 flex justify-end">
              <Button size="xs" variant="ghost-muted" onClick={showOriginal}>
                Show original
              </Button>
            </div>
            <ResponseVisualOverview result={result} />
          </div>
        ) : null}
        <div data-inline-readable-source>
          {props.children ?? (
            <ChatMarkdown
              reader
              remoteImagePolicy="click-to-load"
              text={props.answer}
              cwd={props.cwd}
              threadRef={props.threadRef}
              isStreaming={props.completed === false}
            />
          )}
        </div>
      </div>
      {available || props.actions ? (
        <div className="mt-2 flex flex-wrap items-center gap-1" data-thread-find-ignore>
          {props.actions}
          {available ? (
            <Button
              size="xs"
              variant="ghost-muted"
              title={
                result
                  ? "Switch between the original reply and its saved visual summary"
                  : !allowed
                    ? "Visual summaries are unavailable with your current permissions"
                    : tooLong || props.truncated
                      ? "This reply is too long or incomplete for a visual summary"
                      : "Use Claude Sonnet for this reply only"
              }
              aria-pressed={reading && result !== null}
              disabled={busy || (!result && (!allowed || tooLong || props.truncated === true))}
              onClick={() => {
                if (result && reading) {
                  showOriginal();
                } else void makeVisual();
              }}
            >
              <BookOpenIcon aria-hidden="true" />
              {busy ? "Making readable…" : result && reading ? "Show original" : "Make readable"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {available && !result && !allowed ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Visual summaries are unavailable with your current permissions.
        </p>
      ) : null}
      {available && (tooLong || props.truncated) ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This reply is too long or incomplete for a visual summary. The original is unchanged.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
