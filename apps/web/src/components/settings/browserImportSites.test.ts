import { expect, it } from "vite-plus/test";
import { BROWSER_IMPORT_MAX_DOMAINS } from "@starkfuture/contracts";
import { browserImportSites, isStarkImportSite, normalizeImportSite } from "./browserImportSites";

it("matches only the company's exact domain and its subdomains", () => {
  expect(isStarkImportSite("starkfuture.com")).toBe(true);
  expect(isStarkImportSite("pages.starkfuture.com")).toBe(true);
  for (const site of [
    "starkfuture.com.evil.example",
    "notstarkfuture.com",
    "github.com",
    "accounts.google.com",
  ])
    expect(isStarkImportSite(site)).toBe(false);
});

it("accepts a pasted page address without expanding its exact host", () => {
  expect(normalizeImportSite(" https://Pages.Starkfuture.com/report?q=1 ")).toBe(
    "pages.starkfuture.com",
  );
  expect(normalizeImportSite(".example.com")).toBe("example.com");
  expect(normalizeImportSite("127.0.0.1")).toBe("127.0.0.1");
  for (const value of [
    "",
    "*.example.com",
    "not a site",
    "file:///etc/passwd",
    "https://",
    "example..com",
  ])
    expect(normalizeImportSite(value)).toBeUndefined();
});

it("deduplicates the inventory and puts company hosts first without selecting anything", () => {
  const result = browserImportSites({
    directory: "Default",
    name: "Personal",
    domains: [".EXAMPLE.COM", "pages.starkfuture.com", "example.com", "bad host"],
    domainsTruncated: false,
  });
  expect(result.sites).toEqual(["pages.starkfuture.com", "example.com"]);
  expect(result.starkSites).toEqual(["pages.starkfuture.com"]);
});

it("requires an explicitly complete full-size inventory before offering select-all", () => {
  const domains = Array.from(
    { length: BROWSER_IMPORT_MAX_DOMAINS },
    (_, index) => `site${index}.example`,
  );
  const profile = { directory: "Default", name: "Personal", domains };
  expect(browserImportSites({ ...profile, domains: domains.slice(0, 1_500) }).complete).toBe(false);
  expect(browserImportSites(profile).complete).toBe(false);
  expect(browserImportSites({ ...profile, domainsTruncated: true }).complete).toBe(false);
  expect(browserImportSites({ ...profile, domainsTruncated: false }).complete).toBe(true);
  expect(
    browserImportSites({
      ...profile,
      domains: [...domains, "extra.example"],
      domainsTruncated: false,
    }).complete,
  ).toBe(false);
  expect(browserImportSites({ ...profile, domains: undefined }).complete).toBe(false);
});
