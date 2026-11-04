import * as NodeEvents from "node:events";
import type { BrowserWindow, MenuItemConstructorOptions, Session } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makePagesWebsite } from "./PagesWebsite.ts";
import { PAGES_WEBSITE_HOME, PAGES_WEBSITE_PARTITION } from "./pagesWebsitePolicy.ts";
import { PAGES_WEBSITE_CHANNELS as channels } from "../ipc/pagesWebsiteChannels.ts";

const mocks = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  openExternal: vi.fn(),
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
  views: [] as unknown[],
  restrictWebsitePermissions: vi.fn(),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    session: { fromPartition: mocks.fromPartition },
    shell: { openExternal: mocks.openExternal },
    Menu: { buildFromTemplate: mocks.buildFromTemplate },
    WebContentsView: class {
      visible = false;
      destroyed = false;
      url = PAGES_WEBSITE_HOME;
      title = "Stark Pages";
      loading = false;
      options: unknown;
      webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed,
        getURL: () => this.url,
        getTitle: () => this.title,
        isLoading: () => this.loading,
        loadURL: vi.fn(async (url: string) => {
          this.url = url;
        }),
        reload: vi.fn(),
        stop: vi.fn(),
        capturePage: vi.fn(async () => ({
          isEmpty: () => false,
          toDataURL: () => "data:image/png;base64,aGVsbG8=",
        })),
        close: vi.fn(() => {
          this.destroyed = true;
        }),
        setWindowOpenHandler: vi.fn(),
        navigationHistory: {
          canGoBack: vi.fn(() => false),
          canGoForward: vi.fn(() => false),
          goBack: vi.fn(),
          goForward: vi.fn(),
        },
        session: { cookies: { flushStore: vi.fn(async () => {}) } },
      });
      constructor(options: unknown) {
        this.options = options;
        mocks.views.push(this);
      }
      setVisible = vi.fn((visible: boolean) => {
        this.visible = visible;
      });
      getVisible = () => this.visible;
      setBounds = vi.fn();
    },
  };
});

type MockView = {
  visible: boolean;
  destroyed: boolean;
  title: string;
  url: string;
  loading: boolean;
  options: { webPreferences: Record<string, unknown> };
  setBounds: ReturnType<typeof vi.fn>;
  getVisible: () => boolean;
  webContents: NodeEvents.EventEmitter & {
    loadURL: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    capturePage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    navigationHistory: {
      canGoBack: ReturnType<typeof vi.fn>;
      canGoForward: ReturnType<typeof vi.fn>;
      goBack: ReturnType<typeof vi.fn>;
      goForward: ReturnType<typeof vi.fn>;
    };
    session: { cookies: { flushStore: ReturnType<typeof vi.fn> } };
  };
};
function makeWindow() {
  let minimized = false;
  let destroyed = false;
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: Object.assign(new NodeEvents.EventEmitter(), {
      isDestroyed: () => destroyed,
      getZoomFactor: () => 1.25,
      send: vi.fn(),
      focus: vi.fn(),
    }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    minimize() {
      minimized = true;
      window.emit("minimize");
    },
    restore() {
      minimized = false;
      window.emit("restore");
    },
    close() {
      destroyed = true;
      window.emit("closed");
    },
  });
  return window;
}
const bounds = (viewId = "lease-a") => ({
  viewId,
  x: 400,
  y: 100,
  width: 700,
  height: 600,
  visible: true,
});
let controller: ReturnType<typeof makePagesWebsite>;
let window: ReturnType<typeof makeWindow>;
const current = () => mocks.views.at(-1) as MockView;
const mount = (viewId = "lease-a") =>
  controller.setBounds(window as unknown as BrowserWindow, bounds(viewId));
const event = () => ({ preventDefault: vi.fn() });
const menu = () => mocks.buildFromTemplate.mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];
const quote = () => menu().find((item) => item.label === "Quote in chat")!;
const clickQuote = () =>
  quote().click?.(undefined as never, undefined as never, undefined as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.views.length = 0;
  mocks.fromPartition.mockReturnValue({
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  });
  mocks.openExternal.mockResolvedValue(undefined);
  mocks.buildFromTemplate.mockReturnValue({ popup: mocks.popup });
  controller = makePagesWebsite({ restrictWebsitePermissions: mocks.restrictWebsitePermissions });
  window = makeWindow();
});
afterEach(() => controller.dispose());

describe("temporary Pages menu backdrop", () => {
  const cover = () =>
    controller.setBounds(window as unknown as BrowserWindow, {
      ...bounds(),
      visible: false,
      captureSnapshot: true,
    });
  const image = { isEmpty: () => false, toDataURL: () => "data:image/png;base64,aGVsbG8=" };

  it("captures the visible document once, uncovers the menu and restores without navigation", async () => {
    await mount();
    const view = current();
    expect(await cover()).toEqual({ viewId: "lease-a", dataUrl: image.toDataURL() });
    expect(view.visible).toBe(false);
    expect(await cover()).toBeNull();
    expect(view.webContents.capturePage).toHaveBeenCalledOnce();
    await mount();
    expect(view.visible).toBe(true);
    expect(view.webContents.loadURL).toHaveBeenCalledOnce();
    expect(mocks.views).toHaveLength(1);
  });

  it.each(["hide", "new lease", "close", "navigation", "renderer crash"])(
    "does not return a stale image or hide a replacement after %s",
    async (action) => {
      await mount();
      const view = current();
      let finish!: (value: typeof image) => void;
      view.webContents.capturePage.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const covering = cover();
      if (action === "hide") controller.hide("lease-a");
      if (action === "new lease") await mount("lease-b");
      if (action === "close") window.close();
      if (action === "navigation") controller.navigate({ viewId: "lease-a", action: "home" });
      if (action === "renderer crash") window.webContents.emit("render-process-gone");
      finish(image);
      expect(await covering).toBeNull();
      if (action === "new lease") expect(view.visible).toBe(true);
    },
  );

  it("coalesces a geometry update while capture is pending", async () => {
    await mount();
    const view = current();
    let finish!: (value: typeof image) => void;
    view.webContents.capturePage.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = cover();
    const second = controller.setBounds(window as unknown as BrowserWindow, {
      ...bounds(),
      width: 650,
      visible: false,
      captureSnapshot: true,
    });
    expect(view.webContents.capturePage).toHaveBeenCalledOnce();
    finish(image);
    expect(await first).toBeNull();
    expect(await second).toEqual({ viewId: "lease-a", dataUrl: image.toDataURL() });
    expect(view.visible).toBe(false);
  });

  it.each(["https://accounts.google.com/", "https://pages.starkfuture.com/auth/callback"])(
    "never captures a sign-in surface at %s",
    async (url) => {
      await mount();
      current().url = url;
      expect(await cover()).toBeNull();
      expect(current().webContents.capturePage).not.toHaveBeenCalled();
      expect(current().visible).toBe(false);
    },
  );

  it("unblocks the menu after failed or empty captures and never captures a close", async () => {
    await mount();
    current().webContents.capturePage.mockRejectedValueOnce(new Error("capture failed"));
    expect(await cover()).toBeNull();
    expect(current().visible).toBe(false);
    await mount();
    current().webContents.capturePage.mockResolvedValueOnce({ isEmpty: () => true });
    expect(await cover()).toBeNull();
    expect(current().visible).toBe(false);
    await mount();
    current().webContents.capturePage.mockClear();
    await controller.setBounds(window as unknown as BrowserWindow, { ...bounds(), visible: false });
    expect(current().webContents.capturePage).not.toHaveBeenCalled();
  });
});

describe("personal Pages website", () => {
  it("uses one persistent sandboxed view while closing and reopening the panel", () => {
    mount();
    const view = current();
    expect(mocks.fromPartition).toHaveBeenCalledWith(PAGES_WEBSITE_PARTITION);
    expect(PAGES_WEBSITE_PARTITION).toMatch(/^persist:/);
    expect(view.options.webPreferences).toMatchObject({
      partition: PAGES_WEBSITE_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
    });
    expect(view.options.webPreferences).not.toHaveProperty("preload");
    expect(view.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(PAGES_WEBSITE_HOME);
    controller.hide("lease-a");
    expect(view.visible).toBe(false);
    mount("lease-b");
    expect(mocks.views).toHaveLength(1);
    expect(view.visible).toBe(true);
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
    controller.hide("lease-a");
    controller.setBounds(window as unknown as BrowserWindow, { ...bounds(), visible: false });
    expect(view.visible).toBe(true);
  });

  it("denies permission checks and requests in its personal partition", () => {
    mount();
    const partition = mocks.fromPartition.mock.results[0]!.value;
    const check = partition.setPermissionCheckHandler.mock.calls[0][0];
    const request = partition.setPermissionRequestHandler.mock.calls[0][0];
    for (const permission of ["media", "geolocation", "clipboard-read", "notifications"]) {
      expect(check(null, permission)).toBe(false);
      const callback = vi.fn();
      request(null, permission, callback, {});
      expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    }
  });

  it("clamps scaled geometry, hides on minimize and restores the same content", () => {
    mount();
    const view = current();
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 500, y: 125, width: 500, height: 675 });
    window.minimize();
    expect(view.visible).toBe(false);
    window.emit("resize");
    expect(view.visible).toBe(false);
    window.restore();
    expect(view.visible).toBe(true);
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
  });

  it.each(["navigation", "renderer crash"])(
    "requires a fresh renderer lease after %s",
    (reason) => {
      mount();
      const view = current();
      if (reason === "navigation")
        window.webContents.emit("did-start-navigation", {}, "starkcode://app/", false, true);
      else window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
      expect(view.visible).toBe(false);
      window.emit("resize");
      window.restore();
      expect(view.visible).toBe(false);
      controller.navigate({ viewId: "lease-a", action: "reload" });
      expect(view.webContents.reload).not.toHaveBeenCalled();
      mount("lease-b");
      expect(view.visible).toBe(true);
    },
  );

  it("releases the native contents and event listeners on parent close", () => {
    mount();
    const view = current();
    expect(window.listenerCount("resize")).toBe(1);
    window.close();
    expect(view.webContents.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    expect(view.webContents.session.cookies.flushStore).toHaveBeenCalledTimes(1);
    expect(window.listenerCount("resize")).toBe(0);
    expect(window.listenerCount("restore")).toBe(0);
    expect(controller.getState()).toMatchObject({ url: PAGES_WEBSITE_HOME, loading: false });
    controller.dispose();
    expect(view.webContents.close).toHaveBeenCalledTimes(1);
  });

  it("closes its native child when the destroyed parent rejects webContents access", () => {
    const mainContents = window.webContents;
    Object.defineProperty(window, "webContents", {
      get() {
        if (window.isDestroyed()) throw new Error("Object has been destroyed");
        return mainContents;
      },
    });
    mount();
    const view = current();
    expect(() => window.close()).not.toThrow();
    expect(view.webContents.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    expect(view.webContents.session.cookies.flushStore).toHaveBeenCalledOnce();
    expect(mainContents.listenerCount("did-start-navigation")).toBe(0);
    expect(mainContents.listenerCount("render-process-gone")).toBe(0);
    expect(controller.getState()).toMatchObject({ url: PAGES_WEBSITE_HOME, loading: false });
    controller.dispose();
    expect(view.webContents.close).toHaveBeenCalledTimes(1);
  });

  it("still releases the owned WebContents if native parent detachment fails", () => {
    mount();
    const view = current();
    window.contentView.removeChildView.mockImplementationOnce(() => {
      throw new Error("Parent view unavailable");
    });
    expect(() => controller.dispose()).toThrow("Parent view unavailable");
    expect(view.webContents.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    controller.dispose();
    expect(view.webContents.close).toHaveBeenCalledTimes(1);
  });

  it("replaces contents when ownership moves to a different window", () => {
    mount();
    const old = current();
    const other = makeWindow();
    controller.setBounds(other as unknown as BrowserWindow, bounds("lease-b"));
    expect(old.webContents.close).toHaveBeenCalledTimes(1);
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(old);
    expect(other.contentView.addChildView).toHaveBeenCalledWith(current());
    expect(mocks.fromPartition.mock.calls.map(([name]) => name)).toEqual([
      PAGES_WEBSITE_PARTITION,
      PAGES_WEBSITE_PARTITION,
    ]);
  });

  it("allows Pages navigation but rejects dangerous or malformed destinations", () => {
    mount();
    const wc = current().webContents;
    const inside = event();
    wc.emit("will-navigate", inside, "https://pages.starkfuture.com/projects/work");
    expect(inside.preventDefault).not.toHaveBeenCalled();
    for (const raw of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "starkcode://app/",
      "https://user:pass@pages.starkfuture.com/",
      "not a url",
    ]) {
      const denied = event();
      wc.emit("will-navigate", denied, raw);
      expect(denied.preventDefault).toHaveBeenCalledOnce();
    }
    expect(mocks.openExternal).not.toHaveBeenCalled();
    const outside = event();
    wc.emit("will-navigate", outside, "https://example.com/help");
    expect(outside.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/help");
  });

  it("never grants popup windows the personal session", () => {
    mount();
    const handler = current().webContents.setWindowOpenHandler.mock.calls[0]![0];
    expect(handler({ url: "https://pages.starkfuture.com/projects/demo" })).toEqual({
      action: "deny",
    });
    expect(current().webContents.loadURL).toHaveBeenLastCalledWith(
      "https://pages.starkfuture.com/projects/demo",
    );
    expect(handler({ url: "https://external.example/" })).toEqual({ action: "deny" });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("blocks an external redirect and reports a browser-only destination", () => {
    mount();
    const redirected = event();
    current().webContents.emit(
      "will-redirect",
      redirected,
      "https://accounts.google.com.attacker.test/oauth",
      false,
      true,
    );
    expect(redirected.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      loading: false,
      error: expect.stringContaining("browser"),
    });
  });

  it("allows the website's exact sign-in chain without moving it into another session", () => {
    mount();
    for (const url of [
      "https://pages.starkfuture.com/auth/login?next=/",
      "https://vibecoded-ext.starkfuture.com/app-oauth/authorize?state=private-state",
      "https://accounts.google.com/o/oauth2/v2/auth?state=private-state",
      "https://pages.starkfuture.com/auth/callback?code=private-code",
    ]) {
      const navigation = event();
      const redirect = event();
      current().webContents.emit("will-navigate", navigation, url);
      current().webContents.emit("will-redirect", redirect, url, false, true);
      expect(navigation.preventDefault).not.toHaveBeenCalled();
      expect(redirect.preventDefault).not.toHaveBeenCalled();
    }
    expect(mocks.fromPartition).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("does not copy an OAuth URL into renderer state", () => {
    mount();
    const view = current();
    view.url = "https://pages.starkfuture.com/auth/callback?code=private-code";
    view.title = "Sign in to Pages";
    view.webContents.emit("did-navigate");
    expect(controller.getState()).toMatchObject({ url: PAGES_WEBSITE_HOME, signInRequired: true });
    expect(JSON.stringify(window.webContents.send.mock.calls)).not.toContain("private-code");
  });

  it("keeps allowed auth popups in the same isolated view without exposing their URL", () => {
    mount();
    const view = current();
    const handler = view.webContents.setWindowOpenHandler.mock.calls[0]![0];
    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=private-state";
    expect(handler({ url })).toEqual({ action: "deny" });
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith(url);
    view.webContents.emit("did-navigate");
    expect(controller.getState().url).toBe(PAGES_WEBSITE_HOME);
    expect(JSON.stringify(window.webContents.send.mock.calls)).not.toContain("private-state");
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("quotes only a user-selected bounded text from the active lease", () => {
    mount();
    const view = current();
    view.url = "https://pages.starkfuture.com/project/guide";
    view.title = "Guide";
    view.webContents.emit(
      "context-menu",
      {},
      { selectionText: "  Selected heading  ", linkURL: "" },
    );
    expect(window.webContents.send.mock.calls.some(([channel]) => channel === channels.quote)).toBe(
      false,
    );
    view.title = "A later page title";
    clickQuote();
    expect(window.webContents.send).toHaveBeenLastCalledWith(channels.quote, {
      viewId: "lease-a",
      text: "Selected heading",
      title: "Guide",
      url: view.url,
    });
    view.webContents.emit("context-menu", {}, { selectionText: "x".repeat(8_001), linkURL: "" });
    expect(menu().some((item) => item.label === "Quote in chat")).toBe(false);
  });

  it("does not send a stale context-menu quote into a replacement chat lease", () => {
    mount();
    current().webContents.emit(
      "context-menu",
      {},
      { selectionText: "Old chat selection", linkURL: "" },
    );
    const oldQuote = quote();
    mount("lease-b");
    window.webContents.send.mockClear();
    oldQuote.click?.(undefined as never, undefined as never, undefined as never);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("requires the active lease for navigation and forwards Escape without typing", () => {
    mount();
    controller.navigate({ viewId: "wrong-lease", action: "reload" });
    expect(current().webContents.reload).not.toHaveBeenCalled();
    controller.navigate({ viewId: "lease-a", action: "reload" });
    expect(current().webContents.reload).toHaveBeenCalledOnce();
    const key = event();
    current().webContents.emit("before-input-event", key, { type: "keyDown", key: "Escape" });
    expect(key.preventDefault).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenLastCalledWith(channels.escape, "lease-a");
    expect(window.webContents.focus).toHaveBeenCalledOnce();
  });
});

function deferredSession() {
  let resolve!: (session: Session) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Session>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function importedSession() {
  return {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    cookies: { flushStore: vi.fn(async () => {}) },
  };
}
function useImportedSessions(getImportedSession: (environmentId: string) => Promise<Session>) {
  controller.dispose();
  controller = makePagesWebsite({
    getImportedSession,
    restrictWebsitePermissions: mocks.restrictWebsitePermissions,
  });
}
const mountImported = (environmentId = "environment-a", viewId = "lease-a") =>
  controller.setBounds(window as unknown as BrowserWindow, { ...bounds(viewId), environmentId });

describe("Pages personal browser session reuse", () => {
  it("reuses the existing session without replacing its permission handlers", async () => {
    const personal = importedSession();
    const getImportedSession = vi.fn(async () => personal as unknown as Session);
    useImportedSessions(getImportedSession);
    mocks.restrictWebsitePermissions.mockImplementation((wc) => {
      expect(wc.loadURL).not.toHaveBeenCalled();
    });
    await mountImported();
    const view = current();
    expect(getImportedSession).toHaveBeenCalledExactlyOnceWith("environment-a");
    expect(view.options.webPreferences.session).toBe(personal);
    expect(view.options.webPreferences).not.toHaveProperty("partition");
    expect(view.options.webPreferences).not.toHaveProperty("preload");
    expect(view.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false });
    expect(personal.setPermissionRequestHandler).not.toHaveBeenCalled();
    expect(personal.setPermissionCheckHandler).not.toHaveBeenCalled();
    expect(mocks.fromPartition).not.toHaveBeenCalled();
    expect(mocks.restrictWebsitePermissions).toHaveBeenCalledExactlyOnceWith(view.webContents);
    controller.hide("lease-a");
    await mountImported("environment-a", "lease-b");
    expect(current()).toBe(view);
    expect(view.visible).toBe(true);
    expect(getImportedSession).toHaveBeenCalledTimes(1);
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
  });

  it.each([
    "hide",
    "hidden bounds",
    "window hide",
    "minimize",
    "close",
    "navigation",
    "renderer crash",
    "dispose",
  ])(
    "does not create a stale native view when %s interrupts session acquisition",
    async (reason) => {
      const pending = deferredSession();
      useImportedSessions(() => pending.promise);
      const mounting = mountImported();
      expect(window.listenerCount("closed")).toBe(1);
      expect(window.webContents.listenerCount("did-start-navigation")).toBe(1);
      if (reason === "hide") controller.hide("lease-a");
      if (reason === "hidden bounds")
        await controller.setBounds(window as unknown as BrowserWindow, {
          ...bounds(),
          environmentId: "environment-a",
          visible: false,
        });
      if (reason === "window hide") window.emit("hide");
      if (reason === "minimize") window.minimize();
      if (reason === "close") window.close();
      if (reason === "navigation")
        window.webContents.emit("did-start-navigation", {}, "starkcode://app/", false, true);
      if (reason === "renderer crash") window.webContents.emit("render-process-gone");
      if (reason === "dispose") controller.dispose();
      pending.resolve(importedSession() as unknown as Session);
      await mounting;
      expect(mocks.views).toHaveLength(0);
      expect(window.contentView.addChildView).not.toHaveBeenCalled();
      expect(mocks.restrictWebsitePermissions).not.toHaveBeenCalled();
    },
  );

  it("uses only the latest lease and geometry while a shared lookup is pending", async () => {
    const pending = deferredSession();
    const getImportedSession = vi.fn(() => pending.promise);
    useImportedSessions(getImportedSession);
    const first = mountImported();
    const second = controller.setBounds(window as unknown as BrowserWindow, {
      ...bounds("lease-b"),
      environmentId: "environment-a",
      width: 200,
    });
    controller.hide("lease-a");
    pending.resolve(importedSession() as unknown as Session);
    await Promise.all([first, second]);
    expect(getImportedSession).toHaveBeenCalledTimes(1);
    expect(mocks.views).toHaveLength(1);
    expect(current().visible).toBe(true);
    expect(current().setBounds).toHaveBeenLastCalledWith({
      x: 500,
      y: 125,
      width: 250,
      height: 675,
    });
    controller.navigate({ viewId: "lease-a", action: "reload" });
    expect(current().webContents.reload).not.toHaveBeenCalled();
    controller.navigate({ viewId: "lease-b", action: "reload" });
    expect(current().webContents.reload).toHaveBeenCalledOnce();
  });

  it("discards the old environment's pending session when a newer one resolves first", async () => {
    const first = deferredSession();
    const second = deferredSession();
    useImportedSessions((environmentId) =>
      environmentId === "environment-a" ? first.promise : second.promise,
    );
    const mountingFirst = mountImported();
    const mountingSecond = mountImported("environment-b", "lease-b");
    const personal = importedSession();
    second.resolve(personal as unknown as Session);
    await mountingSecond;
    const view = current();
    first.resolve(importedSession() as unknown as Session);
    await mountingFirst;
    expect(mocks.views).toHaveLength(1);
    expect(view.options.webPreferences.session).toBe(personal);
    expect(view.visible).toBe(true);
    expect(window.listenerCount("closed")).toBe(1);
  });

  it("closes the old environment's view before loading another personal session", async () => {
    const one = importedSession();
    const two = importedSession();
    useImportedSessions(
      async (environmentId) =>
        (environmentId === "environment-a" ? one : two) as unknown as Session,
    );
    await mountImported();
    const old = current();
    await mountImported("environment-b", "lease-b");
    expect(old.webContents.close).toHaveBeenCalledOnce();
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(old);
    expect(current()).not.toBe(old);
    expect(current().options.webPreferences.session).toBe(two);
  });

  it.each(["did-fail-load", "render-process-gone"])(
    "ignores a late %s event from the replaced environment's native view",
    async (eventName) => {
      useImportedSessions(async () => importedSession() as unknown as Session);
      await mountImported();
      const old = current();
      await mountImported("environment-b", "lease-b");
      const state = controller.getState();
      window.webContents.send.mockClear();
      old.webContents.emit(eventName, {}, -2, "Load failed", PAGES_WEBSITE_HOME, true);
      expect(controller.getState()).toBe(state);
      expect(window.webContents.send).not.toHaveBeenCalled();
      expect(current().visible).toBe(true);
    },
  );

  it("does not surface an obsolete acquisition failure after the panel is hidden", async () => {
    const pending = deferredSession();
    useImportedSessions(() => pending.promise);
    const mounting = mountImported();
    controller.hide("lease-a");
    pending.reject(new Error("session lookup failed"));
    await expect(mounting).resolves.toBeNull();
    expect(mocks.views).toHaveLength(0);
  });

  it("reports a current acquisition failure and permits a clean retry", async () => {
    const getImportedSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("session lookup failed"))
      .mockResolvedValueOnce(importedSession());
    useImportedSessions(getImportedSession);
    await expect(mountImported()).rejects.toThrow("session lookup failed");
    expect(mocks.views).toHaveLength(0);
    await mountImported();
    expect(current().visible).toBe(true);
  });
});

describe("bounded Pages loading", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops a stalled navigation after 15 seconds, keeps its session, and gives retry a fresh budget", async () => {
    await mount();
    const view = current();
    view.loading = true;
    expect(controller.getState()).toMatchObject({ loading: true });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(view.webContents.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(view.webContents.stop).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({
      loading: false,
      signInRequired: false,
      error: expect.stringContaining("15 seconds"),
    });
    view.loading = false;
    view.webContents.emit("did-stop-loading");
    expect(controller.getState().error).toContain("15 seconds");
    controller.navigate({ viewId: "lease-a", action: "reload" });
    expect(controller.getState()).toMatchObject({ loading: true, error: undefined });
    expect(current()).toBe(view);
    expect(view.webContents.close).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(view.webContents.stop).toHaveBeenCalledOnce();
    view.webContents.emit("did-stop-loading");
    await vi.advanceTimersByTimeAsync(1);
    expect(view.webContents.stop).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ loading: false, error: undefined });
  });

  it.each([
    [-106, "offline"],
    [-105, "address could not be found"],
    [-118, "timed out"],
    [-21, "network changed"],
    [-202, "secure connection"],
    [-2, "could not be reached"],
  ])("reports network error %s without claiming login expired", async (code, message) => {
    await mount();
    const view = current();
    view.title = "Sign in to Pages";
    view.webContents.emit(
      "did-fail-load",
      {},
      code,
      "private raw diagnostic",
      PAGES_WEBSITE_HOME,
      true,
    );
    view.webContents.emit("page-title-updated");
    expect(controller.getState()).toMatchObject({ loading: false, signInRequired: false });
    expect(controller.getState().error).toContain(message);
    expect(controller.getState().error).not.toContain("private raw diagnostic");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(view.webContents.stop).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("does not treat aborted navigation or a failed subframe as a failed website", async () => {
    await mount();
    current().webContents.emit("did-fail-load", {}, -3, "abort", PAGES_WEBSITE_HOME, true);
    current().webContents.emit("did-fail-load", {}, -106, "offline", PAGES_WEBSITE_HOME, false);
    expect(controller.getState()).toMatchObject({ loading: true, error: undefined });
    current().webContents.emit("did-stop-loading");
    expect(controller.getState()).toMatchObject({ loading: false, error: undefined });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(current().webContents.stop).not.toHaveBeenCalled();
  });

  it("discards an old load promise rejection after retry", async () => {
    await mount();
    let rejectOld!: (error: Error) => void;
    current().webContents.loadURL.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    controller.navigate({ viewId: "lease-a", action: "home" });
    controller.navigate({ viewId: "lease-a", action: "reload" });
    rejectOld(Object.assign(new Error("obsolete private failure"), { errno: -106 }));
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ loading: true, error: undefined });
  });

  it("keeps the same timeout budget across redirects and cancels it on disposal", async () => {
    await mount();
    const view = current();
    await vi.advanceTimersByTimeAsync(10_000);
    view.webContents.emit("did-start-loading");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.getState().error).toContain("15 seconds");
    controller.navigate({ viewId: "lease-a", action: "reload" });
    controller.dispose();
    const sends = window.webContents.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(window.webContents.send).toHaveBeenCalledTimes(sends);
    expect(view.webContents.stop).toHaveBeenCalledOnce();
  });
});
