// @vitest-environment jsdom
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  IMPORTED_BROWSER_PROFILE_ID,
  type BrowserImportSource,
  type ClientSettings,
  type DesktopPreviewBridge,
} from "@starkfuture/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn<() => ClientSettings>(),
  persistSettings: vi.fn(),
  settingsReady: true,
  environment: { environmentId: "local-environment" } as { environmentId: string } | null,
  openSystemSettings: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: mocks.getSettings,
  persistClientSettingsUpdate: mocks.persistSettings,
  useClientSettingsHydrated: () => mocks.settingsReady,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: mocks.environment
      ? [
          {
            ...mocks.environment,
            connection: { phase: "connected" },
            entry: {
              target: {
                _tag: "PrimaryConnectionTarget",
                httpBaseUrl: "http://127.0.0.1:3773",
                wsBaseUrl: "ws://127.0.0.1:3773",
              },
            },
          },
        ]
      : [],
  }),
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openSystemSettings: mocks.openSystemSettings } }),
}));

import { BrowserStep } from "./BrowserStep";

const listSources = vi.fn<DesktopPreviewBridge["listBrowserImportSources"]>();
const importCookies = vi.fn<DesktopPreviewBridge["importBrowserCookies"]>();
const clearCookies = vi.fn<DesktopPreviewBridge["clearCookies"]>();
const clearCache = vi.fn<DesktopPreviewBridge["clearCache"]>();
const pagesConnect = vi.fn();
const onContinue = vi.fn();
const chrome: BrowserImportSource = {
  id: "chrome",
  name: "Chrome",
  isDefault: true,
  profiles: [
    {
      directory: "Default",
      name: "Personal",
      cookieCount: 4,
      domains: ["personal.example", "other.example"],
      domainsTruncated: false,
    },
    {
      directory: "Profile 1",
      name: "Work",
      cookieCount: 9,
      domains: ["work.example", "other.example"],
      domainsTruncated: false,
    },
  ],
};
const firefox: BrowserImportSource = {
  id: "firefox",
  name: "Firefox",
  profiles: [
    {
      directory: "work.default",
      name: "Firefox Work",
      cookieCount: 2,
      domains: ["firefox.example"],
      domainsTruncated: false,
    },
  ],
};
let root: Root;
let container: HTMLDivElement;

function button(label: string) {
  const match = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
function profileButton(name: string) {
  const match = [...document.querySelectorAll("button[aria-pressed]")].find(
    (candidate) => candidate.firstElementChild?.firstElementChild?.textContent === name,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing profile: ${name}`);
  return match;
}
function siteCheckbox(site: string) {
  const match = [...document.querySelectorAll("label")]
    .find((candidate) => candidate.textContent === site)
    ?.querySelector<HTMLElement>('[role="checkbox"]');
  if (!match) throw new Error(`Missing site checkbox: ${site}`);
  return match;
}
/** Ticks one site; the copy button, which is the confirmation, then names it. */
async function chooseSite(site: string) {
  expect(button("Copy sign-ins").disabled).toBe(true);
  expect(siteCheckbox(site).getAttribute("aria-checked")).toBe("false");
  await act(async () => siteCheckbox(site).click());
  expect(button("Copy sign-ins for 1 site").disabled).toBe(false);
}
const mount = () =>
  act(async () =>
    root.render(
      <BrowserStep
        environmentId={EnvironmentId.make("local-environment")}
        onContinue={onContinue}
      />,
    ),
  );
const click = (label: string) => act(async () => button(label).click());
function chooseBrowser(id: string) {
  return act(async () => {
    const select = container.querySelector("select")!;
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.settingsReady = true;
  mocks.environment = { environmentId: "local-environment" };
  mocks.getSettings.mockReturnValue(DEFAULT_CLIENT_SETTINGS);
  listSources.mockResolvedValue([chrome, firefox]);
  importCookies.mockResolvedValue({ imported: 9, skipped: 0, skippedDomains: [] });
  window.desktopBridge = {
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        label: "This Mac",
        runningDistro: null,
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      },
    ],
    preview: {
      listBrowserImportSources: listSources,
      importBrowserCookies: importCookies,
      clearCookies,
      clearCache,
    },
    publishedPages: { connect: pagesConnect },
  } as unknown as NonNullable<Window["desktopBridge"]>;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});

describe("browser import onboarding", () => {
  it("only discovers metadata until the user chooses to import and allows skipping", async () => {
    await mount();
    expect(listSources).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Your default browser");
    expect(container.textContent).toContain("Chrome");
    expect(importCookies).not.toHaveBeenCalled();
    await click("Skip for now");
    expect(onContinue).toHaveBeenCalledOnce();
    expect(importCookies).not.toHaveBeenCalled();
    expect(mocks.persistSettings).not.toHaveBeenCalled();
    expect(pagesConnect).not.toHaveBeenCalled();
  });

  it("does not guess a default browser when the OS has not identified one", async () => {
    listSources.mockResolvedValue([{ ...chrome, isDefault: false }, firefox]);
    await mount();
    expect(container.querySelector("select")?.value).toBe("");
    expect(button("Review before importing").disabled).toBe(true);
    await chooseBrowser("firefox");
    await click("Review before importing");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Firefox Work");
    expect(importCookies).not.toHaveBeenCalled();
    await click("Cancel");
    expect(importCookies).not.toHaveBeenCalled();
  });

  it("can change the detected default without importing either browser", async () => {
    await mount();
    await click("Change browser");
    await chooseBrowser("firefox");
    expect(container.textContent).toContain("Firefox");
    expect(container.textContent).toContain("Selected browser");
    await click("Review before importing");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Firefox Work");
    expect(importCookies).not.toHaveBeenCalled();
    await click("Cancel");
    expect(importCookies).not.toHaveBeenCalled();
  });

  it("reviews the selected browser profile and imports only after the exact choice is confirmed", async () => {
    await mount();
    await click("Review before importing");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Use your Chrome sign-ins in Stark Code",
    );
    await act(async () => profileButton("Work").click());
    expect(importCookies).not.toHaveBeenCalled();
    await chooseSite("work.example");
    expect(importCookies).not.toHaveBeenCalled();
    await click("Copy sign-ins for 1 site");
    expect(importCookies).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local-environment",
      sourceId: "chrome",
      sourceProfileDirectory: "Profile 1",
      targetProfileId: IMPORTED_BROWSER_PROFILE_ID,
      selectedDomains: ["work.example"],
      consent: true,
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Imported 9 cookies");
    await click("Done");
    expect(container.textContent).toContain("Browser sign-ins imported");
    await click("Continue");
    expect(onContinue).toHaveBeenCalledOnce();
    expect(pagesConnect).not.toHaveBeenCalled();
  });

  it("keeps imported sign-ins isolated when the default profile changes during review", async () => {
    const initialSettings: ClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      browserDefaultProfileId: "company",
      browserProfiles: [
        { id: "company", name: "Company", kind: "persistent" },
        { id: "personal", name: "Personal destination", kind: "persistent" },
      ],
    };
    mocks.getSettings.mockReturnValue(initialSettings);
    await mount();
    await click("Review before importing");
    mocks.getSettings.mockReturnValue({ ...initialSettings, browserDefaultProfileId: "personal" });
    await mount();
    await chooseSite("personal.example");
    await click("Copy sign-ins for 1 site");
    expect(importCookies).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local-environment",
      sourceId: "chrome",
      sourceProfileDirectory: "Default",
      targetProfileId: IMPORTED_BROWSER_PROFILE_ID,
      selectedDomains: ["personal.example"],
      consent: true,
    });
    expect(mocks.persistSettings).not.toHaveBeenCalled();
  });

  it("does not write into an incognito destination", async () => {
    mocks.getSettings.mockReturnValue({
      ...DEFAULT_CLIENT_SETTINGS,
      browserDefaultProfileId: "incognito",
    });
    await mount();
    await click("Review before importing");
    await chooseSite("personal.example");
    await click("Copy sign-ins for 1 site");
    expect(importCookies).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local-environment",
      sourceId: "chrome",
      sourceProfileDirectory: "Default",
      targetProfileId: IMPORTED_BROWSER_PROFILE_ID,
      selectedDomains: ["personal.example"],
      consent: true,
    });
  });

  it("rechecks a running browser without importing until the user confirms the reviewed profile", async () => {
    listSources.mockResolvedValueOnce([{ ...chrome, unavailable: "browserRunning" }]);
    await mount();
    await click("Review before importing");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Quit Chrome to import",
    );
    expect(importCookies).not.toHaveBeenCalled();
    await click("I’ve quit it");
    expect(listSources).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Use your Chrome sign-ins in Stark Code",
    );
    expect(importCookies).not.toHaveBeenCalled();
    await click("Cancel");
    expect(importCookies).not.toHaveBeenCalled();
  });

  it("does not claim an empty import connected the browser", async () => {
    importCookies.mockResolvedValue({ imported: 0, skipped: 0, skippedDomains: [] });
    await mount();
    await click("Review before importing");
    await chooseSite("personal.example");
    await click("Copy sign-ins for 1 site");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("No cookies found");
    await click("Done");
    expect(container.textContent).not.toContain("Browser sign-ins imported");
    await click("Skip for now");
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("shows a failed copy without exposing raw errors or marking setup ready", async () => {
    importCookies.mockRejectedValue(new Error("Authorization: private-cookie-value"));
    await mount();
    await click("Review before importing");
    await chooseSite("personal.example");
    await click("Copy sign-ins for 1 site");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Couldn’t import from Chrome",
    );
    expect(document.body.textContent).not.toContain("private-cookie-value");
    await click("Close");
    expect(container.textContent).not.toContain("Browser sign-ins imported");
    expect(button("Skip for now")).toBeDefined();
  });

  it("does not start import before client settings are hydrated or an environment is available", async () => {
    mocks.settingsReady = false;
    await mount();
    expect(button("Review before importing").disabled).toBe(true);
    mocks.settingsReady = true;
    mocks.environment = null;
    await mount();
    expect(button("Review before importing").disabled).toBe(true);
    expect(importCookies).not.toHaveBeenCalled();
  });

  it("retries failed source discovery on request without importing or opening Pages sign-in", async () => {
    listSources.mockRejectedValueOnce(new Error("Keychain: secret-metadata"));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not find your browsers",
    );
    expect(document.body.textContent).not.toContain("secret-metadata");
    await click("Try again");
    expect(listSources).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Your default browser");
    expect(container.textContent).toContain("Chrome");
    expect(importCookies).not.toHaveBeenCalled();
    expect(pagesConnect).not.toHaveBeenCalled();
  });
});

it("refuses local cookie import after the destination computer changes", async () => {
  await mount();
  await click("Review before importing");
  await chooseSite("personal.example");
  mocks.environment = { environmentId: "another-environment" };
  await mount();
  await click("Copy sign-ins for 1 site");
  expect(importCookies).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Couldn’t import from Chrome");
});

it("does not discover local browsers for an unproven remote destination", async () => {
  window.desktopBridge!.getLocalEnvironmentBootstraps = () => [];
  await mount();
  expect(listSources).not.toHaveBeenCalled();
  expect(button("Review before importing").disabled).toBe(true);
  expect(container.textContent).toContain(
    "Browser import is available when setting up this computer",
  );
  await click("Skip for now");
  expect(onContinue).toHaveBeenCalledOnce();
});
