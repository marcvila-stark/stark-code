import { Dialog } from "@base-ui/react/dialog";
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { isElectron } from "~/env";
import { usePreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { cn } from "~/lib/utils";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Keep side-chat drafts and history mounted when another tool occupies the panel. */
export function ConversationToolsPanel({
  active,
  inline,
  onClose,
  children,
}: {
  readonly active: boolean;
  readonly inline: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const overlay = expanded || !inline;
  const { width, handlers } = usePreviewPanelInlineSize(panel, {
    enabled: active && !overlay,
    container: portalHost?.parentElement,
    widthStorageKey: "starkcode:conversation-tools-panel-width",
    defaultWidth: 420,
  });
  useLayoutEffect(() => {
    if (
      active &&
      overlay &&
      portalHost &&
      panel.current &&
      !panel.current.contains(document.activeElement)
    ) {
      expandButton.current?.focus({ preventScroll: true });
    }
  }, [active, overlay, portalHost]);
  useEffect(() => {
    if (!active) return;
    const toggleExpanded = () => setExpanded((current) => !current);
    window.addEventListener("starkcode:auxiliary-panel-toggle-expanded", toggleExpanded);
    return () =>
      window.removeEventListener("starkcode:auxiliary-panel-toggle-expanded", toggleExpanded);
  }, [active]);
  const restorePanel = () => {
    setExpanded(false);
    expandButton.current?.focus({ preventScroll: true });
  };

  return (
    <Dialog.Root
      open={active}
      modal={active && overlay}
      disablePointerDismissal={!overlay}
      onOpenChange={(open, details) => {
        if (open || !active) return;
        if (expanded) restorePanel();
        else if (overlay || details.reason === "escape-key") onClose();
      }}
    >
      <div ref={setPortalHost} className="contents" />
      {portalHost ? (
        <Dialog.Portal keepMounted container={portalHost} className="contents">
          {active && overlay ? (
            <Dialog.Backdrop className="fixed inset-0 z-[60] bg-background/60 backdrop-blur-xs" />
          ) : null}
          <Dialog.Popup
            ref={panel}
            role={overlay ? "dialog" : "complementary"}
            aria-label="Side chat"
            aria-modal={(active && overlay) || undefined}
            initialFocus={false}
            hidden={!active}
            inert={!active}
            data-auxiliary-panel-overlay={active && overlay ? "true" : undefined}
            data-conversation-tools-expanded={expanded ? "true" : "false"}
            className={cn(
              "min-h-0 min-w-0 flex-col bg-background text-foreground outline-none [-webkit-app-region:no-drag]",
              active ? "flex" : "hidden",
              overlay
                ? "fixed inset-y-0 right-0 z-[60]"
                : "relative h-full shrink-0 border-l border-border",
              overlay && !expanded && isElectron && "top-(--workspace-topbar-height)",
              overlay &&
                (expanded
                  ? "left-0"
                  : "w-[min(540px,calc(100%-2rem))] border-l border-border shadow-lg"),
            )}
            style={overlay ? undefined : { width }}
          >
            {!overlay ? <RightPanelResizeHandle handlers={handlers} /> : null}
            <div
              className={cn(
                "flex shrink-0 items-center justify-between gap-2 border-b border-border p-2",
                expanded &&
                  isElectron &&
                  "drag-region min-h-(--workspace-topbar-height) pl-(--workspace-controls-left) wco:pr-(--workspace-native-controls-inset)",
              )}
            >
              <h2 className="min-w-0 truncate pl-1 text-sm font-medium">Side chat</h2>
              <div className="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        ref={expandButton}
                        size="icon-sm"
                        variant="ghost"
                        aria-label={
                          expanded ? "Return side chat to side panel" : "Expand side chat"
                        }
                        onClick={() => (expanded ? restorePanel() : setExpanded(true))}
                      >
                        {expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom" positionMethod="fixed">
                    {expanded ? "Show beside chat" : "Expand side chat"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Close side chat"
                        onClick={onClose}
                      >
                        <XIcon aria-hidden />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom" positionMethod="fixed">
                    Close side chat
                  </TooltipPopup>
                </Tooltip>
              </div>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
          </Dialog.Popup>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
