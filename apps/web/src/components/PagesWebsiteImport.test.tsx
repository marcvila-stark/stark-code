// @vitest-environment jsdom
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type DesktopBridge,
  type BrowserImportSource,
} from "@starkfuture/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PagesWebsiteImport } from "./PagesWebsiteImport";

vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  persistClientSettingsUpdate: vi.fn(),
  useClientSettingsHydrated: () => true,
}));
vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openSystemSettings: vi.fn() } }),
}));

const localId = EnvironmentId.make("desktop-local");
const sources: BrowserImportSource[] = [
  {
    id: "chrome",
    name: "Chrome",
    profiles: [
      { directory: "Chrome profile", name: "Personal", domains: ["pages.starkfuture.com"] },
    ],
  },
  {
    id: "brave",
    name: "Brave",
    isDefault: true,
    profiles: [
      {
        directory: "Default",
        name: "Work",
        domains: [
          "pages.starkfuture.com",
          "id.starkfuture.com",
          "accounts.google.com",
          "bank.example",
        ],
        domainsTruncated: false,
      },
    ],
  },
];
let root: Root;
let container: HTMLDivElement;
const imported = vi.fn();
const close = vi.fn();
const importCookies = vi.fn();
const listSources = vi.fn();
const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Missing ${label}`);
  return element;
};
/** A recommended site set's checkbox, found by the set's title. */
const siteSet = (title: string) => {
  const element = [...document.querySelectorAll("label")]
    .find((item) => item.textContent?.startsWith(title))
    ?.querySelector<HTMLElement>('[role="checkbox"]');
  if (!element) throw new Error(`Missing site set ${title}`);
  return element;
};
const render = (id = localId as EnvironmentId | null) =>
  act(() =>
    root.render(<PagesWebsiteImport environmentId={id} onClose={close} onImported={imported} />),
  );
const click = (label: string) => act(() => button(label).click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  imported.mockReset();
  close.mockReset();
  importCookies.mockReset();
  listSources.mockReset();
  importCookies.mockResolvedValue({ imported: 2, skipped: 0, skippedDomains: [] });
  listSources.mockResolvedValue(sources);
  window.desktopBridge = {
    preview: { listBrowserImportSources: listSources, importBrowserCookies: importCookies },
  } as unknown as DesktopBridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});

it("starts with the default browser and zero selected sites, then imports only explicit Stark selections into the local personal profile", async () => {
  await render();
  expect(button("Browser to import from").textContent).toContain("Brave");
  expect(importCookies).not.toHaveBeenCalled();
  await click("Choose sites");
  expect(document.body.textContent).toContain("Use your Brave sign-ins in Stark Code");
  expect(siteSet("Stark sites").getAttribute("aria-checked")).toBe("false");
  expect(button("Copy sign-ins").disabled).toBe(true);
  await act(() => siteSet("Stark sites").click());
  expect(importCookies).not.toHaveBeenCalled();
  await click("Copy sign-ins for 2 sites");
  expect(importCookies).toHaveBeenCalledExactlyOnceWith({
    environmentId: localId,
    sourceId: "brave",
    sourceProfileDirectory: "Default",
    targetProfileId: "personal-imported",
    selectedDomains: ["pages.starkfuture.com", "id.starkfuture.com"],
    consent: true,
  });
  expect(imported).toHaveBeenCalledOnce();
});

it("blocks a pending import if its captured local destination goes away", async () => {
  await render();
  await click("Choose sites");
  await act(() => siteSet("Stark sites").click());
  await render(null);
  await click("Copy sign-ins for 2 sites");
  expect(importCookies).not.toHaveBeenCalled();
  expect(imported).not.toHaveBeenCalled();
});

it("does not read browser inventories until an available local destination is provided", async () => {
  await render(null);
  expect(listSources).not.toHaveBeenCalled();
  expect(button("Choose sites").disabled).toBe(true);
  expect(document.body.textContent).toContain("Connect this computer before importing");
});

it("keeps an explicit import failure visible without claiming a successful sign-in", async () => {
  importCookies.mockRejectedValue(new Error("Browser import failed: readFailed."));
  await render();
  await click("Choose sites");
  await act(() => siteSet("Stark sites").click());
  await click("Copy sign-ins for 2 sites");
  expect(importCookies).toHaveBeenCalledOnce();
  expect(imported).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("cookie database could not be read");
});
