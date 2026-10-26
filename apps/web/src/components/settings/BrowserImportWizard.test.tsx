// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  BROWSER_IMPORT_MAX_DOMAINS,
  IMPORTED_BROWSER_PROFILE_ID,
  type BrowserImportSource,
} from "@starkfuture/contracts";
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

function checkbox(label: string) {
  const value = [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
    (node) => node.getAttribute("aria-label") === label,
  );
  expect(value).toBeDefined();
  return value!;
}

async function renderWizard(input: BrowserImportSource = source) {
  const importCookies = vi.fn(async () => ({
    kind: "imported" as const,
    imported: 1,
    skipped: 0,
    skippedDomains: [],
    targetName: "Personal imported sessions",
  }));
  await act(() =>
    root.render(
      <BrowserImportWizard
        source={input}
        destinationEnvironmentName="This Mac"
        targetProfiles={[{ id: IMPORTED_BROWSER_PROFILE_ID, name: "Personal imported sessions" }]}
        canCreateProfile={false}
        onImport={importCookies}
        onRefreshSource={async () => input}
        onOpenFullDiskAccessSettings={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  return importCookies;
}

const consentLabel = "Allow copying sign-ins for selected sites";

it("keeps import disabled until both an exact site and consent are chosen", async () => {
  const importCookies = await renderWizard();
  expect(document.body.textContent).toContain("0 sites selected");
  expect(button("Select sites to import").disabled).toBe(true);
  await act(() => checkbox(consentLabel).click());
  expect(button("Select sites to import").disabled).toBe(true);
  await act(() => checkbox("example.com").click());
  expect(checkbox(consentLabel).getAttribute("aria-checked")).toBe("false");
  expect(button("Import 1 site").disabled).toBe(true);
  await act(() => checkbox(consentLabel).click());
  expect(button("Import 1 site").disabled).toBe(false);
  expect(importCookies).not.toHaveBeenCalled();
  await act(() => button("Import 1 site").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      selectedDomains: ["example.com"],
      consent: true,
    }),
  );
});

it("prioritizes Stark sites without selecting shared services or look-alike domains", async () => {
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
        domainsTruncated: false,
      },
    ],
  });
  expect(document.body.textContent).toContain("0 sites selected");
  expect(document.querySelector('[aria-label="github.com"][role="checkbox"]')).toBeNull();
  await act(() => button("Select Stark sites (2)").click());
  await act(() => checkbox(consentLabel).click());
  await act(() => button("Import 2 sites").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      selectedDomains: ["id.starkfuture.com", "starkfuture.com"],
    }),
  );
});

it("selects the complete inventory beyond the old 100-site limit only by explicit action", async () => {
  const domains = Array.from({ length: 125 }, (_, index) => `site${index}.example.com`);
  const importCookies = await renderWizard({
    ...source,
    profiles: [
      {
        directory: "All",
        name: "Personal",
        domains,
        domainsTruncated: false,
      },
    ],
  });
  await act(() => button("Select all 125 sites").click());
  expect(document.body.textContent).toContain("125 sites selected");
  expect(document.body.textContent).toContain("including personal sites");
  expect(importCookies).not.toHaveBeenCalled();
  expect(button("Import 125 sites").disabled).toBe(true);
  await act(() => button("Show more").click());
  expect(checkbox("site99.example.com").getAttribute("aria-checked")).toBe("true");
  await act(() => checkbox(consentLabel).click());
  await act(() => button("Import 125 sites").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      selectedDomains: [...domains].sort((left, right) => left.localeCompare(right)),
      consent: true,
    }),
  );
});

it("requires renewed consent after changing an all-sites selection", async () => {
  const importCookies = await renderWizard({
    ...source,
    profiles: [
      {
        directory: "All",
        name: "Personal",
        domains: ["one.example", "two.example"],
        domainsTruncated: false,
      },
    ],
  });
  await act(() => button("Select all 2 sites").click());
  await act(() => checkbox(consentLabel).click());
  expect(button("Import 2 sites").disabled).toBe(false);
  await act(() => checkbox("two.example").click());
  expect(button("Import 1 site").disabled).toBe(true);
  expect(checkbox(consentLabel).getAttribute("aria-checked")).toBe("false");
  await act(() => checkbox(consentLabel).click());
  await act(() => button("Import 1 site").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ selectedDomains: ["one.example"] }),
  );
});

it("searches shared services without selecting company sites automatically", async () => {
  const importCookies = await renderWizard({
    ...source,
    profiles: [
      {
        directory: "Mixed",
        name: "Personal",
        domains: ["pages.starkfuture.com", "github.com"],
        domainsTruncated: false,
      },
    ],
  });
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search sites"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "github",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => checkbox("github.com").click());
  await act(() => checkbox(consentLabel).click());
  await act(() => button("Import 1 site").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ selectedDomains: ["github.com"] }),
  );
});

it("adds a pasted URL as one exact site without selecting its parent or siblings", async () => {
  const importCookies = await renderWizard();
  const input = document.querySelector<HTMLInputElement>('[aria-label="Site domain"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "https://docs.example.com/report",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => button("Add site").click());
  expect(checkbox("docs.example.com").getAttribute("aria-checked")).toBe("true");
  expect(button("Import 1 site").disabled).toBe(true);
  await act(() => checkbox(consentLabel).click());
  await act(() => button("Import 1 site").click());
  expect(importCookies).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ selectedDomains: ["docs.example.com"] }),
  );
});

it.each([
  { directory: "Partial", name: "Partial", domains: ["one.example"], domainsTruncated: true },
  { directory: "Unavailable", name: "Unavailable" },
  {
    directory: "LegacySmall",
    name: "LegacySmall",
    domains: Array.from({ length: 1_500 }, (_, i) => `s${i}.example`),
  },
  {
    directory: "Legacy",
    name: "Legacy",
    domains: Array.from({ length: BROWSER_IMPORT_MAX_DOMAINS }, (_, i) => `s${i}.example`),
  },
])(
  "never offers all-sites import for an incomplete or missing inventory: $name",
  async (profile) => {
    const importCookies = await renderWizard({ ...source, profiles: [profile] });
    expect(
      [...document.querySelectorAll("button")].some((node) =>
        node.textContent?.startsWith("Select all"),
      ),
    ).toBe(false);
    expect(button("Select sites to import").disabled).toBe(true);
    expect(importCookies).not.toHaveBeenCalled();
  },
);

it("requires fresh site selection and consent when refresh replaces the chosen source account", async () => {
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
  expect(checkbox("example.com").getAttribute("aria-checked")).toBe("false");
  expect(checkbox(consentLabel).getAttribute("aria-checked")).toBe("false");
  await act(() => checkbox("example.com").click());
  await act(() => checkbox(consentLabel).click());
  expect(button("Import 1 site").disabled).toBe(false);
  await act(() => button("Import 1 site").click());
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
    [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')].every(
      (box) => box.getAttribute("aria-checked") === "false",
    ),
  ).toBe(true);
  expect(button("Select sites to import").disabled).toBe(true);
  expect(importCookies).toHaveBeenCalledTimes(1);
});
