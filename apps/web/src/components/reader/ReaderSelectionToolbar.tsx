import { ASSISTANT_CITATION_MAX_TEXT_LENGTH } from "@starkfuture/contracts";
import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { captureAssistantTextSelection } from "../../lib/assistantTextSelection";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "../../lib/selectionActions";
import { Button } from "../ui/button";

/** Quotes sources without an assistant-message identity; never creates a citation. */
export function ReaderSelectionToolbar({
  viewport,
  source,
  label,
  onQuote,
}: {
  viewport: HTMLElement | null;
  source: HTMLElement | null;
  label: string;
  onQuote: (text: string, label: string) => boolean;
}) {
  const [selection, setSelection] = useState<{
    text: string;
    position: SelectionActionPoint;
  } | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);
  useEffect(() => {
    if (!viewport || !source) return;
    const clear = () => setSelection(null);
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      onSelection: (pointer) => {
        const captured = captureAssistantTextSelection(viewport, window.getSelection(), source);
        if (!captured) return clear();
        const rect = captured.range.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        if (rect.width === 0 || rect.bottom < bounds.top || rect.top > bounds.bottom)
          return clear();
        setSelection({
          text: captured.selector.text,
          position: resolveSelectionActionPosition({
            bounds,
            selectionRect: rect,
            pointer,
            viewport: { width: window.innerWidth, height: window.innerHeight },
          }),
        });
      },
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusAction = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.disabled ||
        toolbar.contains(event.target as Node)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusAction, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusAction, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [source, viewport]);
  if (!selection) return null;
  const tooLong = selection.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="xs"
      variant="glass"
      disabled={tooLong}
      aria-label={tooLong ? "Selection is too long to quote" : "Quote selection in chat"}
      className="fixed z-[70] max-w-[calc(100vw-1rem)]"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (tooLong || !onQuote(selection.text, label)) return;
        window.getSelection()?.removeAllRanges();
        dismiss();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong ? "Shorten selection" : "Quote in chat"}
    </Button>,
    // Expanded native shells are modal. Keep their quote action inside the
    // dialog so focus trapping/inert outside content cannot swallow the click.
    viewport?.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') ?? document.body,
  );
}
