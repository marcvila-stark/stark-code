import { useLayoutEffect, useState } from "react";

import { observeResize } from "../lib/observeResize";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { useMediaQuery } from "./useMediaQuery";
import { canFitInlinePreviewPanel } from "./usePreviewPanelInlineSize";

/** The sidebar takes room too: decide against the workspace, not just the window. */
export function useRightPanelSheet(container: HTMLElement | null): boolean {
  const narrowViewport = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [narrowWorkspace, setNarrowWorkspace] = useState(false);
  useLayoutEffect(() => {
    if (!container) return;
    const measure = () => setNarrowWorkspace(!canFitInlinePreviewPanel(container.clientWidth));
    measure();
    return observeResize(container, measure);
  }, [container]);
  return narrowViewport || narrowWorkspace;
}
