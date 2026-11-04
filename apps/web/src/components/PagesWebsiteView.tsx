import type { DesktopBridge } from "@starkfuture/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  HouseIcon,
  ImportIcon,
  RotateCwIcon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { observeResize } from "~/lib/observeResize";
import { pageSelectionText } from "../starkPageQuote";
import { randomUUID } from "../lib/utils";
import { pagesWebsitePresentation } from "./pagesWebsitePresentation";
import { usePagesWebsiteEnvironment } from "./pagesWebsiteEnvironment";
import { PagesWebsiteImport } from "./PagesWebsiteImport";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type WebsiteBridge = NonNullable<DesktopBridge["pagesWebsite"]>;
type WebsiteState = Awaited<ReturnType<WebsiteBridge["getState"]>>;
type WebsiteAction = Parameters<WebsiteBridge["navigate"]>[0]["action"];
export type PagesWebsiteQuote = {
  readonly text: string;
  readonly title: string;
  readonly url: string;
};

function WebsiteControl({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side="top" positionMethod="fixed">
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The desktop owns the website and its saved session; React only places it. */
export function PagesWebsiteView({
  active,
  onOpenLibrary,
  onEscape,
  onQuote,
}: {
  readonly active: boolean;
  readonly onOpenLibrary: () => void;
  readonly onEscape: () => void;
  readonly onQuote?: ((quote: PagesWebsiteQuote) => boolean) | undefined;
}) {
  const bridge = window.desktopBridge?.pagesWebsite;
  const environmentId = usePagesWebsiteEnvironment();
  const [importOpen, setImportOpen] = useState(false);
  const [viewId] = useState(() => `pages-${randomUUID()}`);
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<WebsiteState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<{ environmentId: string; dataUrl: string } | null>(null);
  const escape = useEffectEvent((owner: string) => {
    if (active && !importOpen && owner === viewId) onEscape();
  });
  const quote = useEffectEvent((value: PagesWebsiteQuote & { readonly viewId: string }) => {
    if (!active || importOpen || value.viewId !== viewId || !onQuote) return;
    const text = pageSelectionText(value.text);
    if (text) onQuote({ ...value, text });
  });

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = bridge.onState((next) => {
      receivedEvent = true;
      if (!cancelled) setState(next);
    });
    const unsubscribeEscape = bridge.onEscape?.((owner) => escape(owner));
    const unsubscribeQuote = bridge.onQuote?.((value) => quote(value));
    void bridge.getState().then(
      (next) => {
        if (!cancelled && !receivedEvent) setState(next);
      },
      () => {
        if (!cancelled && !receivedEvent) setError("Could not open the Pages website. Try again.");
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeEscape?.();
      unsubscribeQuote?.();
    };
  }, [bridge]);

  const failure = error ?? state?.error;
  if (snapshot && (!active || failure || importOpen || snapshot.environmentId !== environmentId))
    setSnapshot(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!bridge || !element) return;
    if (!environmentId) {
      void bridge.hide(viewId).catch(() => undefined);
      return;
    }
    let disposed = false;
    let frame: number | undefined;
    let previous = "";
    let request = 0;
    const present = () => {
      frame = undefined;
      if (disposed) return;
      const bounds = pagesWebsitePresentation(element, active && !failure && !importOpen);
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      const currentRequest = ++request;
      if (!bounds.captureSnapshot) setSnapshot(null);
      void bridge.setBounds({ viewId, environmentId, ...bounds }).then(
        (image) => {
          if (disposed || request !== currentRequest || !bounds.captureSnapshot) return;
          if (image?.viewId === viewId && image.dataUrl.startsWith("data:image/png;base64,"))
            setSnapshot({ environmentId, dataUrl: image.dataUrl });
        },
        () => {
          if (!disposed && request === currentRequest)
            setError("Could not display the Pages website. Try again.");
        },
      );
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(present);
    };
    const stopObserving = observeResize(element, schedule);
    const overlays = new MutationObserver(schedule);
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "hidden",
        "inert",
        "aria-hidden",
        "style",
        "class",
        "data-open",
        "data-closed",
        "data-ending-style",
      ],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    present();
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      stopObserving();
      overlays.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      void bridge.hide(viewId).catch(() => undefined);
    };
  }, [active, bridge, environmentId, failure, importOpen, viewId]);

  const navigate = async (action: WebsiteAction) => {
    if (!bridge || !environmentId || busy) return;
    setError(null);
    setBusy(true);
    try {
      await bridge.navigate({ viewId, action });
    } catch {
      setError("Pages could not complete that action. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Stark Pages website" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <WebsiteControl
          label="Back in Pages"
          disabled={!environmentId || busy || !state?.canGoBack}
          onClick={() => void navigate("back")}
        >
          <ArrowLeftIcon aria-hidden />
        </WebsiteControl>
        <WebsiteControl
          label="Forward in Pages"
          disabled={!environmentId || busy || !state?.canGoForward}
          onClick={() => void navigate("forward")}
        >
          <ArrowRightIcon aria-hidden />
        </WebsiteControl>
        <WebsiteControl
          label="Reload Pages website"
          disabled={!environmentId || busy}
          onClick={() => void navigate("reload")}
        >
          <RotateCwIcon aria-hidden />
        </WebsiteControl>
        <WebsiteControl
          label="Pages home"
          disabled={!environmentId || busy}
          onClick={() => void navigate("home")}
        >
          <HouseIcon aria-hidden />
        </WebsiteControl>
        <p
          className="min-w-0 flex-1 truncate px-2 text-xs text-muted-foreground"
          role={state?.loading ? "status" : undefined}
        >
          {state?.loading ? "Loading Pages…" : state?.title || "Stark Pages"}
        </p>
        <WebsiteControl
          label="Import sign-in from browser"
          disabled={!environmentId || !window.desktopBridge?.preview || busy}
          onClick={() => setImportOpen(true)}
        >
          <ImportIcon aria-hidden />
        </WebsiteControl>
        <WebsiteControl
          label="Open Pages in main browser"
          disabled={!environmentId || busy}
          onClick={() => void navigate("open-external")}
        >
          <ExternalLinkIcon aria-hidden />
        </WebsiteControl>
      </div>
      {state?.loading && !failure && !importOpen ? (
        <div
          role="status"
          className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground"
        >
          Waiting for Pages to respond… You can keep working in chat.
        </div>
      ) : null}
      {state?.signInRequired && !state.loading && !failure ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            Already signed in in your browser? Import that sign-in, or sign in below.
          </p>
          <Button
            size="compact"
            variant="outline"
            disabled={!environmentId || !window.desktopBridge?.preview || busy}
            onClick={() => setImportOpen(true)}
          >
            Import sign-in from browser
          </Button>
          <Button size="compact" variant="ghost" onClick={onOpenLibrary}>
            Use connected library
          </Button>
        </div>
      ) : null}
      <div ref={host} data-pages-website-host className="relative min-h-0 flex-1 bg-background">
        {active && !failure && !importOpen && snapshot ? (
          <img
            src={snapshot.dataUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full select-none object-fill"
          />
        ) : null}
        {!environmentId ? (
          <p role="status" className="p-6 text-center text-sm text-muted-foreground">
            Waiting for this computer to connect…
          </p>
        ) : null}
        {failure ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <h3 className="text-sm font-medium">Pages couldn’t load</h3>
            <p className="max-w-sm text-sm text-muted-foreground" role="alert">
              {failure}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void navigate("reload")}
              >
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={onOpenLibrary}>
                Use connected library
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {importOpen ? (
        <PagesWebsiteImport
          environmentId={environmentId}
          onClose={() => setImportOpen(false)}
          onImported={() => void navigate("home")}
        />
      ) : null}
    </section>
  );
}
