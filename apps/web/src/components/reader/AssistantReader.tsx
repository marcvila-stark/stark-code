import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeResize } from "../../lib/observeResize";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  readerAvailableHeight,
  readerComposer,
  readerNeedsContents,
  readerSections,
  readerViewport,
  type ReaderSection,
} from "./readerOutline";

/** Reader presentation for assistant Markdown, including captured native-shell replies. */
export function AssistantReader({
  children,
  contentKey,
  isStreaming = false,
}: {
  readonly children: ReactNode;
  readonly contentKey: string;
  readonly isStreaming?: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  const contentsControl = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const [outline, setOutline] = useState<{ key: string; sections: ReaderSection[] } | null>(null);
  const [open, setOpen] = useState(false);
  const selectedSection = useRef<HTMLElement | null>(null);
  const compensation = useRef<{ viewport: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const pending = compensation.current;
    compensation.current = null;
    if (pending && content.current) {
      // The user is already reading below the reply's top. Keep that text in place
      // when the completed reply gains (or loses) its one-line contents control.
      pending.viewport.scrollTop += content.current.getBoundingClientRect().top - pending.top;
    }
  });
  useEffect(() => {
    const container = content.current;
    if (!container || isStreaming) return;
    const markdown = container.querySelector<HTMLElement>(".chat-markdown") ?? container;
    const sections = readerSections(markdown);
    if (sections.length < 3) return;
    const viewport = readerViewport(container);
    const composer = readerComposer(container, viewport);
    const measure = () => {
      const visible = readerNeedsContents({
        sectionCount: sections.length,
        contentHeight: Math.max(container.scrollHeight, container.getBoundingClientRect().height),
        viewportHeight: readerAvailableHeight(container, viewport, composer),
        isStreaming: false,
      });
      if (visible !== (contentsControl.current !== null) && viewport) {
        const top = container.getBoundingClientRect().top;
        compensation.current =
          top < viewport.getBoundingClientRect().top ? { viewport, top } : null;
      }
      setOutline((previous) => {
        if (!visible) return previous === null ? previous : null;
        if (
          previous?.key === contentKey &&
          previous.sections.length === sections.length &&
          previous.sections.every(
            (section, index) =>
              section.element === sections[index]?.element &&
              section.label === sections[index]?.label,
          )
        )
          return previous;
        return { key: contentKey, sections };
      });
    };
    const restore = sections.map(({ element }, index) => {
      const id = element.getAttribute("id");
      const tabindex = element.getAttribute("tabindex");
      if (!id) element.id = `${prefix}-section-${index}`;
      if (tabindex === null) element.tabIndex = -1;
      return () => {
        if (id === null) element.removeAttribute("id");
        else element.setAttribute("id", id);
        if (tabindex === null) element.removeAttribute("tabindex");
      };
    });
    const cancelObservation = observeResize(
      [container, ...(viewport ? [viewport] : []), ...(composer ? [composer] : [])],
      measure,
    );
    const initialMeasure = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelObservation();
      window.cancelAnimationFrame(initialMeasure);
      window.removeEventListener("resize", measure);
      for (const reset of restore) reset();
    };
  }, [contentKey, isStreaming, prefix]);
  const sections = !isStreaming && outline?.key === contentKey ? outline.sections : [];
  return (
    <div className="assistant-reader min-w-0 w-full">
      {sections.length >= 3 ? (
        <div
          ref={contentsControl}
          data-thread-find-ignore
          data-scroll-anchor-ignore
          className="mb-2 h-8 max-w-[33rem]"
        >
          <Popover
            open={open}
            onOpenChange={(next) => {
              if (next) selectedSection.current = null;
              setOpen(next);
            }}
          >
            <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
              Contents ({sections.length})
            </PopoverTrigger>
            <PopoverPopup
              width="md"
              align="start"
              padding="compact"
              finalFocus={() => selectedSection.current ?? true}
            >
              <nav aria-label="Reply contents" data-thread-find-ignore>
                <ol className="flex max-h-60 flex-col items-start gap-1 overflow-auto text-sm">
                  {sections.map((section) => (
                    <li key={section.element.id} className="max-w-full">
                      <a
                        href={`#${encodeURIComponent(section.element.id)}`}
                        className="block rounded-sm text-muted-foreground underline-offset-4 [overflow-wrap:anywhere] hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={(event) => {
                          event.preventDefault();
                          selectedSection.current = section.element;
                          setOpen(false);
                          section.element.scrollIntoView({ block: "start", behavior: "auto" });
                          section.element.focus({ preventScroll: true });
                        }}
                      >
                        {section.label}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            </PopoverPopup>
          </Popover>
        </div>
      ) : null}
      <div ref={content} data-assistant-reader-content className="min-w-0">
        {children}
      </div>
    </div>
  );
}
