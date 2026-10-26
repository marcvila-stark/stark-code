import { Dialog } from "@base-ui/react/dialog";
import { ChevronDownIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { usePreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { StarkPagesSidebar } from "./StarkPagesSidebar";
import { PublishedStarkPages } from "./PublishedStarkPages";
import { PagesWebsiteView, type PagesWebsiteQuote } from "./PagesWebsiteView";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { RightPanelResizeHandle } from "./preview/RightPanelResizeHandle";

type PagesSource = "local" | "published";
const SOURCE_KEY = "starkcode:pages-source";
function initialPagesSource(): PagesSource {
  try {
    return window.localStorage.getItem(SOURCE_KEY) === "local" ? "local" : "published";
  } catch {
    return "published";
  }
}

/** One mounted viewer survives docking, expansion and window-size changes. */
export function StarkPagesPanel({
  inline,
  active = true,
  tools,
  onWebsiteQuote,
  ...props
}: ComponentProps<typeof StarkPagesSidebar> & {
  readonly inline: boolean;
  readonly active?: boolean;
  readonly tools?: ReactNode;
  readonly onWebsiteQuote?: ((quote: PagesWebsiteQuote) => boolean) | undefined;
}) {
  const websiteAvailable = Boolean(window.desktopBridge?.pagesWebsite);
  const [library, setLibrary] = useState({
    visible: !websiteAvailable,
    visited: !websiteAvailable,
  });
  const [source, setSource] = useState(() => {
    const view = initialPagesSource();
    return { view, visited: new Set<PagesSource>([view]) };
  });
  const { view, visited } = source;
  const chooseSource = (value: string) => {
    if (value !== "local" && value !== "published") return;
    setSource((current) => ({ view: value, visited: new Set([...current.visited, value]) }));
    try {
      window.localStorage.setItem(SOURCE_KEY, value);
    } catch {
      /* Remembering the choice is optional. */
    }
  };
  const [presentation, setPresentation] = useState({ active, expanded: false });
  if (presentation.active !== active) setPresentation({ active, expanded: false });
  const expanded = presentation.active === active && presentation.expanded;
  const setExpanded = (value: boolean) => setPresentation({ active, expanded: value });
  const expandPages = () => setExpanded(true);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const overlay = expanded || !inline;
  const { width, handlers } = usePreviewPanelInlineSize(panel, {
    enabled: active && !overlay,
    container: portalHost?.parentElement,
    widthStorageKey: "starkcode:pages-panel-width",
    defaultWidth: 540,
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
  const restorePanel = () => {
    setExpanded(false);
    expandButton.current?.focus({ preventScroll: true });
  };
  const toggleExpanded = useEffectEvent(() => {
    if (expanded) restorePanel();
    else expandPages();
  });
  useEffect(() => {
    if (!active) return;
    const toggle = () => toggleExpanded();
    window.addEventListener("starkcode:auxiliary-panel-toggle-expanded", toggle);
    return () => window.removeEventListener("starkcode:auxiliary-panel-toggle-expanded", toggle);
  }, [active]);

  return (
    <Dialog.Root
      open={active}
      modal={active && overlay}
      disablePointerDismissal={!overlay}
      onOpenChange={(open, details) => {
        if (open || !active) return;
        // Escape restores the reading panel before a second Escape closes it.
        if (expanded) restorePanel();
        else if (overlay || details.reason === "escape-key") props.onClose();
      }}
    >
      {/* Keeping the portal's container fixed avoids reloading the iframe when
          it becomes a modal. display:contents keeps the dock in the flex row. */}
      <div ref={setPortalHost} className="contents" />
      {portalHost ? (
        <Dialog.Portal keepMounted container={portalHost} className="contents">
          {active && overlay ? (
            <Dialog.Backdrop className="fixed inset-0 z-[60] bg-background/60 backdrop-blur-xs" />
          ) : null}
          <Dialog.Popup
            ref={panel}
            role={overlay ? "dialog" : "complementary"}
            aria-label="Stark Pages"
            aria-modal={(active && overlay) || undefined}
            initialFocus={false}
            hidden={!active}
            inert={!active}
            data-pages-overlay={active && overlay ? "true" : undefined}
            data-auxiliary-panel-overlay={active && overlay ? "true" : undefined}
            data-pages-expanded={expanded ? "true" : "false"}
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
                "flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-border p-2",
                expanded &&
                  isElectron &&
                  "drag-region min-h-(--workspace-topbar-height) pl-(--workspace-controls-left) wco:pr-(--workspace-native-controls-inset)",
              )}
            >
              <div className="min-w-0">
                <Menu>
                  <MenuTrigger
                    render={<Button size="sm" variant="ghost" aria-label="Choose Pages source" />}
                  >
                    {view === "published" ? "Company pages" : "Local pages"}
                    <ChevronDownIcon aria-hidden />
                  </MenuTrigger>
                  <MenuPopup align="start" positionMethod="fixed">
                    <MenuGroup>
                      <MenuGroupLabel>Browse Pages</MenuGroupLabel>
                      <MenuRadioGroup value={view} onValueChange={chooseSource}>
                        <MenuRadioItem closeOnClick value="published" aria-label="Company pages">
                          <span className="flex items-center gap-3">
                            <span className="flex-1 py-1">
                              <span className="block font-medium">Company pages</span>
                              <span className="block text-xs text-muted-foreground">
                                Shared through Stark Pages
                              </span>
                            </span>
                            <MenuRadioItemIndicator />
                          </span>
                        </MenuRadioItem>
                        <MenuRadioItem closeOnClick value="local" aria-label="Local pages">
                          <span className="flex items-center gap-3">
                            <span className="min-w-0 flex-1 py-1">
                              <span className="block font-medium">Local pages</span>
                              <span className="block max-w-64 break-words text-xs text-muted-foreground">
                                Pages built on this Mac
                              </span>
                            </span>
                            <MenuRadioItemIndicator />
                          </span>
                        </MenuRadioItem>
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuPopup>
                </Menu>
              </div>
              <div className="flex items-center gap-1">
                {tools}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        ref={expandButton}
                        size="icon-sm"
                        variant="ghost"
                        aria-label={expanded ? "Return Pages to side panel" : "Expand Pages"}
                        onClick={() => (expanded ? restorePanel() : expandPages())}
                      >
                        {expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom" positionMethod="fixed">
                    {expanded ? "Show beside chat" : "Expand Pages"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Close Pages"
                        onClick={props.onClose}
                      >
                        <XIcon aria-hidden />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom" positionMethod="fixed">
                    Close Pages
                  </TooltipPopup>
                </Tooltip>
              </div>
            </div>
            {/* Retain visited viewers so switching the source does not discard a
                page, its search results, or its reading position. */}
            <div
              hidden={view !== "local"}
              inert={view !== "local"}
              className={view === "local" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}
            >
              {visited.has("local") ? (
                <StarkPagesSidebar
                  {...props}
                  active={active && view === "local"}
                  showHeader={false}
                />
              ) : null}
            </div>
            <div
              hidden={view !== "published"}
              inert={view !== "published"}
              className={view === "published" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}
            >
              {visited.has("published") && websiteAvailable ? (
                <div
                  hidden={library.visible}
                  inert={library.visible}
                  className={library.visible ? "hidden" : "flex min-h-0 min-w-0 flex-1 flex-col"}
                >
                  <PagesWebsiteView
                    active={active && view === "published" && !library.visible}
                    onOpenLibrary={() => setLibrary({ visible: true, visited: true })}
                    onEscape={() => (expanded ? restorePanel() : props.onClose())}
                    onQuote={onWebsiteQuote}
                  />
                </div>
              ) : null}
              {visited.has("published") && library.visited ? (
                <div
                  hidden={!library.visible}
                  inert={!library.visible}
                  className={library.visible ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}
                >
                  {websiteAvailable ? (
                    <div className="shrink-0 border-b border-border px-3 py-1">
                      <Button
                        size="compact"
                        variant="ghost"
                        onClick={() => setLibrary((current) => ({ ...current, visible: false }))}
                      >
                        Show Pages website
                      </Button>
                    </div>
                  ) : null}
                  <PublishedStarkPages
                    active={active && view === "published" && library.visible}
                    expanded={expanded}
                    onExitExpanded={restorePanel}
                    onOpenPage={props.onOpenPage}
                    onQuote={
                      active && view === "published" && library.visible ? props.onQuote : undefined
                    }
                  />
                </div>
              ) : null}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
