import { describe, expect, it } from "vite-plus/test";
import {
  pagesWebsiteBounds,
  pagesWebsiteNavigationUrl,
  pagesWebsiteUrl,
  safeWebsiteExternalUrl,
} from "./pagesWebsitePolicy.ts";

describe("Pages website boundaries", () => {
  it("admits only the exact HTTPS Pages origin inside the personal view", () => {
    expect(pagesWebsiteUrl("https://pages.starkfuture.com/project/one")?.pathname).toBe(
      "/project/one",
    );
    for (const raw of [
      "http://pages.starkfuture.com/",
      "https://pages.starkfuture.com.evil.test/",
      "https://pages.starkfuture.com@evil.test/",
      "https://user@pages.starkfuture.com/",
      "https://pages.starkfuture.com:8443/",
      "file:///tmp/page.html",
      "not a url",
    ])
      expect(pagesWebsiteUrl(raw)).toBeUndefined();
  });

  it("permits ordinary external web links without handing arbitrary schemes to the OS", () => {
    expect(safeWebsiteExternalUrl("https://example.com/help")).toBe(true);
    expect(safeWebsiteExternalUrl("http://localhost:3000/")).toBe(true);
    for (const raw of [
      "file:///tmp/a",
      "javascript:alert(1)",
      "starkcode://app/",
      "vscode://ssh/host",
      "https://user:secret@example.com/",
      "bad",
    ])
      expect(safeWebsiteExternalUrl(raw)).toBe(false);
  });

  it("admits exact sign-in hosts for navigation without treating them as quotable Pages", () => {
    for (const host of [
      "pages.starkfuture.com",
      "vibecoded-ext.starkfuture.com",
      "accounts.google.com",
    ])
      expect(pagesWebsiteNavigationUrl(`https://${host}/auth`)?.hostname).toBe(host);
    for (const raw of [
      "https://accounts.google.com.evil.test/",
      "https://vibecoded-ext.starkfuture.com.evil.test/",
      "https://accounts.google.com@evil.test/",
      "https://user:secret@accounts.google.com/",
      "https://accounts.google.com:8443/",
      "http://accounts.google.com/",
      "https://google.com/",
      "https://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a URL",
    ])
      expect(pagesWebsiteNavigationUrl(raw)).toBeUndefined();
    expect(pagesWebsiteUrl("https://accounts.google.com/")).toBeUndefined();
    expect(pagesWebsiteUrl("https://vibecoded-ext.starkfuture.com/")).toBeUndefined();
  });

  it("converts CSS coordinates to native bounds and clips to the content area", () => {
    const content = { width: 1000, height: 700 };
    expect(
      pagesWebsiteBounds(
        { viewId: "a", x: -20, y: 40, width: 1000, height: 700, visible: true },
        1.5,
        content,
      ),
    ).toEqual({ x: 0, y: 60, width: 1000, height: 640 });
    expect(
      pagesWebsiteBounds(
        { viewId: "a", x: 1500, y: 900, width: 30, height: 30, visible: true },
        1,
        content,
      ),
    ).toEqual({ x: 1000, y: 700, width: 0, height: 0 });
    for (const zoom of [0, -1, Infinity, NaN])
      expect(
        pagesWebsiteBounds(
          { viewId: "a", x: 0, y: 0, width: 100, height: 100, visible: true },
          zoom,
          content,
        ),
      ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
