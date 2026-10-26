import { describe, expect, it } from "vite-plus/test";

import { defaultBrowserSourceId } from "./DefaultBrowser.ts";

describe("default browser source", () => {
  it.each([
    ["/Applications/Google Chrome.app", "chrome"],
    ["/Applications/Microsoft Edge.app", "edge"],
    ["/Applications/Brave Browser.app", "brave"],
    ["/Applications/Vivaldi.app", "vivaldi"],
    ["/Applications/Opera.app", "opera"],
    ["/Applications/Arc.app", "arc"],
    ["/Applications/Helium.app", "helium"],
    ["/Applications/Firefox.app/Contents/MacOS/firefox", "firefox"],
    ["/Applications/Zen.app/Contents/MacOS/zen", "zen"],
    ["/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app", "safari"],
  ])("recognizes the installed browser at %s", (path, expected) => {
    expect(defaultBrowserSourceId({ name: "Localized app name", path })).toBe(expected);
  });

  it.each([
    ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "chrome"],
    ["C:\\Program Files\\Mozilla Firefox\\firefox.exe", "firefox"],
    ["/usr/bin/google-chrome-stable", "chrome"],
    ["/usr/share/applications/net.imput.helium.desktop", "helium"],
  ])("recognizes the exact cross-platform handler path %s", (path, expected) => {
    expect(defaultBrowserSourceId({ name: "", path })).toBe(expected);
  });

  it("accepts a known desktop entry when no application path is available", () => {
    expect(defaultBrowserSourceId({ name: "firefox.desktop", path: "" })).toBe("firefox");
  });

  it.each([
    { name: "Google Chrome", path: "/Applications/Google Chrome Beta.app" },
    { name: "Google Chrome", path: "/Applications/Chromium.app" },
    { name: "Google Chrome", path: "/Applications/Browser Selector.app" },
    { name: "Google Chrome", path: "C:\\Google\\Chrome Beta\\Application\\chrome.exe" },
    { name: "Google Chrome", path: "/usr/bin/google-chrome-unstable" },
    { name: "Firefox", path: "/Applications/Firefox Developer Edition.app" },
    { name: "Unknown", path: "/usr/bin/constructor" },
    { name: "Google Chrome", path: "" },
    { name: "", path: "" },
  ])("does not guess a source for $path / $name", (application) => {
    expect(defaultBrowserSourceId(application)).toBeUndefined();
  });

  it("leaves failed lookups unknown", () => {
    expect(defaultBrowserSourceId(undefined)).toBeUndefined();
  });
});
