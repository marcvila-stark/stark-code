import {
  IMPORTED_BROWSER_PROFILE_ID,
  type PagesWebsiteBounds,
  type PagesWebsiteNavigation,
  type PagesWebsiteSnapshot,
  type PagesWebsiteState,
} from "@starkfuture/contracts";
import {
  Menu,
  session,
  shell,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
} from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { PAGES_WEBSITE_CHANNELS as channels } from "../ipc/pagesWebsiteChannels.ts";
import * as BrowserSession from "../preview/BrowserSession.ts";
import {
  PAGES_WEBSITE_HOME,
  PAGES_WEBSITE_PARTITION,
  pagesWebsiteBounds,
  pagesWebsiteNavigationUrl,
  pagesWebsiteUrl,
  safeWebsiteExternalUrl,
} from "./pagesWebsitePolicy.ts";

export class PagesWebsiteError extends Schema.TaggedError<PagesWebsiteError>()(
  "PagesWebsiteError",
  {
    reason: Schema.Literals(["sender", "unavailable"]),
  },
) {}

const initialState = (): PagesWebsiteState => ({
  url: PAGES_WEBSITE_HOME,
  title: "Stark Pages",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  signInRequired: false,
});

interface PagesWebsiteDependencies {
  readonly getImportedSession?: (environmentId: string) => Promise<Session>;
  readonly restrictWebsitePermissions?: (contents: WebContents) => void;
}

/** This view has no preload, bridge, or registration in the agent browser host. */
export function makePagesWebsite(dependencies: PagesWebsiteDependencies = {}) {
  let view: WebContentsView | undefined;
  let parent: BrowserWindow | undefined;
  let lease: string | undefined;
  let bounds: PagesWebsiteBounds | undefined;
  let state = initialState();
  let removeParentListeners: (() => void) | undefined;
  let environmentId: string | undefined;
  let revision = 0;
  let parentHidden = false;
  let pendingSession: Promise<Session> | undefined;
  let pendingCapture: ReturnType<WebContents["capturePage"]> | undefined;
  const emit = () => {
    if (!parent?.isDestroyed() && !parent?.webContents.isDestroyed())
      parent?.webContents.send(channels.stateChanged, state);
  };
  const update = () => {
    if (!view || view.webContents.isDestroyed()) return;
    const wc = view.webContents;
    const title = wc.getTitle().slice(0, 300);
    // Do not forward OAuth codes or arbitrary external URLs into the renderer.
    const url = pagesWebsiteUrl(wc.getURL());
    state = {
      ...state,
      url: url && !url.pathname.startsWith("/auth/") ? url.toString() : PAGES_WEBSITE_HOME,
      title: title || "Stark Pages",
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      signInRequired: /^sign in\b/i.test(title),
    };
    emit();
  };
  const hide = () => view?.setVisible(false);
  const applyBounds = () => {
    if (!view || !parent || parent.isDestroyed() || !bounds) return;
    const rect = pagesWebsiteBounds(
      bounds,
      parent.webContents.getZoomFactor(),
      parent.getContentBounds(),
    );
    view.setBounds(rect);
    view.setVisible(
      bounds.visible && rect.width > 0 && rect.height > 0 && !parent.isMinimized() && !parentHidden,
    );
  };
  const dispose = () => {
    revision++;
    pendingSession = undefined;
    pendingCapture = undefined;
    const ownedView = view;
    const owner = parent;
    const removeListeners = removeParentListeners;
    removeParentListeners = undefined;
    view = undefined;
    parent = undefined;
    lease = undefined;
    bounds = undefined;
    environmentId = undefined;
    parentHidden = false;
    state = initialState();
    try {
      removeListeners?.();
      if (ownedView && owner && !owner.isDestroyed()) owner.contentView.removeChildView(ownedView);
    } finally {
      // A native child outlives its parent unless its WebContents is closed.
      // Parent/listener cleanup must never prevent releasing that child.
      if (ownedView && !ownedView.webContents.isDestroyed()) {
        const wc = ownedView.webContents;
        try {
          // Flushing never turns a session-only site cookie into a permanent one.
          void wc.session.cookies.flushStore().catch(() => {});
        } finally {
          wc.close({ waitForBeforeUnload: false });
        }
      }
    }
  };
  const external = (raw: string) => {
    if (safeWebsiteExternalUrl(raw))
      void shell.openExternal(raw).catch(() => {
        state = { ...state, error: "Could not open your browser." };
        emit();
      });
  };
  const create = (window: BrowserWindow, personal?: Session) => {
    if (!personal) {
      const legacy = session.fromPartition(PAGES_WEBSITE_PARTITION);
      legacy.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      legacy.setPermissionCheckHandler(() => false);
    }
    const current = new WebContentsView({
      webPreferences: {
        ...(personal ? { session: personal } : { partition: PAGES_WEBSITE_PARTITION }),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        disableHtmlFullscreenWindowResize: true,
      },
    });
    view = current;
    current.setVisible(false);
    window.contentView.addChildView(current);
    const wc = current.webContents;
    (dependencies.restrictWebsitePermissions ?? BrowserSession.restrictWebsitePermissions)(wc);
    const load = (url: string) => {
      state = { ...state, error: undefined, loading: true };
      emit();
      void wc.loadURL(url).catch(() => {
        if (view !== current || wc.isDestroyed()) return;
        state = {
          ...state,
          loading: false,
          error: "Stark Pages could not load. Check your connection and try Reload.",
        };
        emit();
      });
    };
    wc.on("will-navigate", (event, raw) => {
      if (pagesWebsiteNavigationUrl(raw)) return;
      event.preventDefault();
      external(raw);
    });
    wc.on("will-redirect", (event, raw, _inPlace, isMainFrame) => {
      if (!isMainFrame || pagesWebsiteNavigationUrl(raw)) return;
      event.preventDefault();
      state = { ...state, loading: false, error: "This page needs to open in your browser." };
      emit();
    });
    wc.setWindowOpenHandler(({ url: raw }) => {
      const url = pagesWebsiteNavigationUrl(raw);
      if (url) load(url.toString());
      // No popup gets a bridge or a different browsing session.
      return { action: "deny" };
    });
    wc.on("did-start-loading", update);
    wc.on("did-stop-loading", update);
    wc.on("page-title-updated", update);
    wc.on("did-navigate", update);
    wc.on("did-navigate-in-page", update);
    wc.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
      if (view !== current || wc.isDestroyed() || !mainFrame || code === -3) return;
      state = {
        ...state,
        loading: false,
        error: "Stark Pages could not load. Check your connection and try Reload.",
      };
      emit();
    });
    wc.on("render-process-gone", () => {
      if (view !== current || wc.isDestroyed()) return;
      state = {
        ...state,
        loading: false,
        error: "The Pages view stopped. Choose Reload to reopen it.",
      };
      emit();
    });
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return;
      event.preventDefault();
      if (lease) window.webContents.send(channels.escape, lease);
      window.webContents.focus();
    });
    wc.on("context-menu", (_event, params) => {
      const menuLease = lease;
      const menuTitle = wc.getTitle().slice(0, 300);
      const text = params.selectionText.trim();
      const url = pagesWebsiteUrl(wc.getURL());
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (text) items.push({ role: "copy" });
      if (text && text.length <= 8_000 && url && !url.pathname.startsWith("/auth/")) {
        items.push({
          label: "Quote in chat",
          click: () => {
            if (
              menuLease &&
              lease === menuLease &&
              view === current &&
              !wc.isDestroyed() &&
              current.getVisible()
            )
              window.webContents.send(channels.quote, {
                viewId: menuLease,
                text,
                title: menuTitle,
                url: url.toString(),
              });
          },
        });
      }
      if (params.linkURL && safeWebsiteExternalUrl(params.linkURL))
        items.push({ label: "Open link in browser", click: () => external(params.linkURL) });
      if (items.length) Menu.buildFromTemplate(items).popup({ window });
    });
    load(PAGES_WEBSITE_HOME);
    return current;
  };
  const bindParent = (window: BrowserWindow) => {
    parent = window;
    // BrowserWindow.webContents can throw once the native window is destroyed.
    const mainContents = window.webContents;
    const invalidateRenderer = () => {
      revision++;
      bounds = undefined;
      lease = undefined;
      hide();
    };
    const rendererNavigated = (
      _event: Electron.Event,
      _url: string,
      _inPlace: boolean,
      mainFrame: boolean,
    ) => {
      if (mainFrame) invalidateRenderer();
    };
    const suspend = () => {
      revision++;
      parentHidden = true;
      hide();
    };
    const resume = () => {
      parentHidden = false;
      if (!view && bounds?.visible) void setBounds(window, bounds).catch(() => {});
      else applyBounds();
    };
    window.once("closed", dispose);
    window.on("resize", applyBounds);
    window.on("minimize", suspend);
    window.on("restore", resume);
    window.on("hide", suspend);
    window.on("show", resume);
    mainContents.on("did-start-navigation", rendererNavigated);
    mainContents.on("render-process-gone", invalidateRenderer);
    removeParentListeners = () => {
      window.removeListener("closed", dispose);
      window.removeListener("resize", applyBounds);
      window.removeListener("minimize", suspend);
      window.removeListener("restore", resume);
      window.removeListener("hide", suspend);
      window.removeListener("show", resume);
      mainContents.removeListener("did-start-navigation", rendererNavigated);
      mainContents.removeListener("render-process-gone", invalidateRenderer);
    };
  };
  const setBounds = async (
    window: BrowserWindow,
    input: PagesWebsiteBounds,
  ): Promise<PagesWebsiteSnapshot | null> => {
    if (!input.visible && lease !== input.viewId) return null;
    if (window.isDestroyed() || window.webContents.isDestroyed()) return null;
    if (
      parent !== window ||
      environmentId !== input.environmentId ||
      view?.webContents.isDestroyed()
    ) {
      dispose();
      environmentId = input.environmentId;
      // Observe navigation and close before the asynchronous session lookup.
      bindParent(window);
    }
    lease = input.viewId;
    bounds = input;
    if (input.visible || !input.captureSnapshot) pendingCapture = undefined;
    const currentRevision = ++revision;
    if (!input.visible || parentHidden || window.isMinimized()) {
      // Native views cover DOM menus. Capture only an already-visible Pages
      // document, then uncover the menu; the renderer holds the backdrop only
      // until the menu closes. Never capture a sign-in page or a hidden lease.
      const capturedView = view;
      const wc = capturedView?.webContents;
      const rawUrl = wc && !wc.isDestroyed() ? wc.getURL() : "";
      const url = pagesWebsiteUrl(rawUrl);
      if (
        input.captureSnapshot &&
        !input.visible &&
        capturedView?.getVisible() &&
        wc &&
        url &&
        !url.pathname.startsWith("/auth/") &&
        !state.signInRequired &&
        !parentHidden &&
        !window.isMinimized()
      ) {
        let capture: typeof pendingCapture;
        try {
          capture = pendingCapture ??= wc.capturePage();
          const image = await capture;
          if (
            revision !== currentRevision ||
            view !== capturedView ||
            lease !== input.viewId ||
            window.isDestroyed() ||
            wc.isDestroyed()
          )
            return null;
          hide();
          if (wc.getURL() !== rawUrl || wc.isLoading() || image.isEmpty()) return null;
          const dataUrl = image.toDataURL();
          return dataUrl.length <= 16 * 1024 * 1024 ? { viewId: input.viewId, dataUrl } : null;
        } catch {
          // A failed capture must still uncover app controls.
          if (revision === currentRevision) hide();
          return null;
        } finally {
          if (pendingCapture === capture) pendingCapture = undefined;
        }
      }
      hide();
      return null;
    }
    if (!view) {
      let personal: Session | undefined;
      if (input.environmentId !== undefined) {
        if (!dependencies.getImportedSession)
          throw new Error("Personal browser session unavailable.");
        const acquisition = (pendingSession ??= dependencies.getImportedSession(
          input.environmentId,
        ));
        try {
          personal = await acquisition;
        } catch (error) {
          if (pendingSession === acquisition) pendingSession = undefined;
          if (revision === currentRevision) throw error;
          return null;
        }
        if (
          revision !== currentRevision ||
          parent !== window ||
          window.isDestroyed() ||
          window.webContents.isDestroyed() ||
          lease !== input.viewId ||
          environmentId !== input.environmentId ||
          !bounds?.visible ||
          parentHidden ||
          window.isMinimized()
        )
          return null;
        if (pendingSession === acquisition) pendingSession = undefined;
      }
      create(window, personal);
    }
    applyBounds();
    return null;
  };
  return {
    getState: () => state,
    setBounds,
    hide(viewId: string) {
      if (viewId !== lease) return;
      revision++;
      if (bounds) bounds = { ...bounds, visible: false };
      hide();
    },
    navigate(input: PagesWebsiteNavigation) {
      if (input.viewId !== lease || !view || view.webContents.isDestroyed()) return;
      const wc = view.webContents;
      if (input.action === "open-external") {
        external(state.url);
        return;
      }
      revision++;
      pendingCapture = undefined;
      if (!bounds?.visible) hide();
      state = { ...state, error: undefined };
      if (input.action === "back" && wc.navigationHistory.canGoBack())
        wc.navigationHistory.goBack();
      if (input.action === "forward" && wc.navigationHistory.canGoForward())
        wc.navigationHistory.goForward();
      if (input.action === "reload") wc.reload();
      if (input.action === "home") void wc.loadURL(PAGES_WEBSITE_HOME).catch(() => {});
      update();
    },
    dispose,
  };
}

export class PagesWebsite extends Context.Service<
  PagesWebsite,
  ReturnType<typeof makePagesWebsite>
>()("@starkfuture/desktop/starkPages/PagesWebsite") {}
export const layer = Layer.effect(
  PagesWebsite,
  Effect.gen(function* () {
    const browserSessions = yield* BrowserSession.BrowserSession;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const controller = makePagesWebsite({
      getImportedSession: (environmentId) =>
        runPromise(
          browserSessions.getSession(
            JSON.stringify([environmentId, IMPORTED_BROWSER_PROFILE_ID]),
            true,
            "profile",
          ),
        ),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.dispose()));
    return controller;
  }),
);
