// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { IMPORTED_BROWSER_PROFILE_ID, type BrowserImportSource } from "@starkfuture/contracts";
import { BrowserImportWizard } from "./BrowserImportWizard";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const source: BrowserImportSource = {
  id: "chrome",
  name: "Chrome",
  profiles: [{ directory: "Original", name: "Original account", domains: ["example.com"] }],
};
function button(label: string) {
  const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(value).toBeDefined();
  return value!;
}

it("requires a fresh site selection when refresh replaces the chosen source account", async () => {
  const importCookies = vi.fn(async () => ({
    kind: "blocked" as const,
    reason: "browserRunning" as const,
  }));
  const refreshed: BrowserImportSource = {
    ...source,
    profiles: [{ directory: "Replacement", name: "Replacement account", domains: ["example.com"] }],
  };
  await act(() =>
    root.render(
      <BrowserImportWizard
        source={source}
        destinationEnvironmentName="This Mac"
        targetProfiles={[{ id: IMPORTED_BROWSER_PROFILE_ID, name: "Personal imported sessions" }]}
        canCreateProfile={false}
        onImport={importCookies}
        onRefreshSource={async () => refreshed}
        onOpenFullDiskAccessSettings={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  const originalBoxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(originalBoxes.every((box) => !box.checked)).toBe(true);
  await act(() => {
    originalBoxes.forEach((box) => box.click());
  });
  expect(button("Copy sign-ins for 1 site").disabled).toBe(false);
  await act(() => button("Copy sign-ins for 1 site").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sourceProfileDirectory: "Original",
      selectedDomains: ["example.com"],
      consent: true,
    }),
  );
  await act(() => button("I’ve quit it").click());
  expect(document.body.textContent).toContain("Replacement account");
  expect(
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
      (box) => !box.checked,
    ),
  ).toBe(true);
  expect(button("Copy sign-ins").disabled).toBe(true);
  expect(importCookies).toHaveBeenCalledTimes(1);
});

async function renderWizard(
  wizardSource: BrowserImportSource,
  onImport = vi.fn(async () => ({ kind: "blocked" as const, reason: "readFailed" as const })),
) {
  await act(() =>
    root.render(
      <BrowserImportWizard
        source={wizardSource}
        destinationEnvironmentName="This Mac"
        targetProfiles={[{ id: IMPORTED_BROWSER_PROFILE_ID, name: "Personal imported sessions" }]}
        canCreateProfile={false}
        onImport={onImport}
        onRefreshSource={async () => undefined}
        onOpenFullDiskAccessSettings={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  return onImport;
}
const checkboxes = () => [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')];

it("opens a recommended set so one site can be unticked while the rest stay chosen", async () => {
  const importCookies = await renderWizard({
    ...source,
    profiles: [
      {
        directory: "Original",
        name: "Original account",
        domains: [
          "pages.starkfuture.com",
          "admin.starkfuture.com",
          "starkfuture.com",
          "example.com",
        ],
      },
    ],
  });
  const starkSet = checkboxes()[0]!;
  await act(() => starkSet.click());
  expect(button("Copy sign-ins for 3 sites").disabled).toBe(false);

  const summary = button("pages.starkfuture.com and 2 more");
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  await act(() => summary.click());
  expect(summary.getAttribute("aria-expanded")).toBe("true");
  const admin = [...document.querySelectorAll("label")].find(
    (label) => label.textContent === "admin.starkfuture.com",
  );
  expect(admin).toBeDefined();
  await act(() => admin!.querySelector<HTMLElement>('[role="checkbox"]')!.click());

  expect(starkSet.getAttribute("aria-checked")).toBe("mixed");
  expect(document.body.textContent).toContain("2 of 3 selected");
  // Collapsing the set keeps the partial choice visible on its row.
  await act(() => summary.click());
  expect(document.body.textContent).toContain("2 of 3 selected");
  await act(() => button("Copy sign-ins for 2 sites").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ selectedDomains: ["pages.starkfuture.com", "starkfuture.com"] }),
  );
});

it("keeps the privacy pair visible and the storage details behind More details", async () => {
  await renderWizard(source);
  const text = () => document.body.textContent ?? "";
  expect(text()).toContain("Kept on this computer, in Stark Code's own profile.");
  expect(text()).toContain(
    "Not uploaded to Stark servers; used when you visit the selected websites.",
  );
  expect(text()).not.toContain("system keychain");

  await act(() => button("More details").click());
  expect(text()).toContain("Encrypted with your system keychain. Agents can't open this profile.");
  expect(text()).toContain("Clear it any time in Settings → Connected tools → Browser & privacy.");
  expect(text()).toContain("anyone using this computer account could use it inside Stark Code");
  expect(text()).toContain("Not passwords, history or bookmarks. One-time copy.");
});

function siteCheckbox(host: string) {
  const label = [...document.querySelectorAll("label")].find((node) => node.textContent === host);
  expect(label).toBeDefined();
  return label!.querySelector<HTMLElement>('[role="checkbox"]')!;
}
async function typeInto(input: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const otherSitesToggle = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
    node.textContent?.startsWith("Other sites"),
  )!;

it("copies only starkfuture.com hosts from the Stark set, never look-alikes or shared services", async () => {
  const importCookies = await renderWizard({
    ...source,
    profiles: [
      {
        directory: "Work",
        name: "Personal",
        domains: [
          "github.com",
          "id.starkfuture.com",
          "starkfuture.com",
          "starkfuture.com.evil.example",
          "bank.example",
        ],
      },
    ],
  });
  expect(button("Copy sign-ins").disabled).toBe(true);
  await act(() => checkboxes()[0]!.click());
  await act(() => button("Copy sign-ins for 2 sites").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      selectedDomains: ["id.starkfuture.com", "starkfuture.com"],
      consent: true,
    }),
  );
});

it("filters other sites and copies only the one ticked", async () => {
  const importCookies = await renderWizard({
    ...source,
    profiles: [
      {
        directory: "Mixed",
        name: "Personal",
        domains: ["pages.starkfuture.com", "bank.example", "docs.example"],
      },
    ],
  });
  await act(() => otherSitesToggle().click());
  await typeInto(
    document.querySelector<HTMLInputElement>('[aria-label="Filter other sites"]')!,
    "bank",
  );
  expect(document.body.textContent).not.toContain("docs.example");
  await act(() => siteCheckbox("bank.example").click());
  await act(() => button("Copy sign-ins for 1 site").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ selectedDomains: ["bank.example"] }),
  );
});

it("adds a pasted URL as one exact site when the browser can't list its sites", async () => {
  const importCookies = await renderWizard({
    ...source,
    profiles: [{ directory: "Unlisted", name: "Unlisted" }],
  });
  expect(document.body.textContent).toContain("This browser can't list its sites.");
  expect(button("Copy sign-ins").disabled).toBe(true);
  await typeInto(
    document.querySelector<HTMLInputElement>('input[placeholder="pages.starkfuture.com"]')!,
    "https://docs.example.com/report",
  );
  await act(() => button("Add").click());
  expect(siteCheckbox("docs.example.com").getAttribute("aria-checked")).toBe("true");
  await act(() => button("Copy sign-ins for 1 site").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ selectedDomains: ["docs.example.com"] }),
  );
});
