import type { BrowserImportSourceId } from "@starkfuture/contracts";

const APPLICATION_IDS: Readonly<Record<string, BrowserImportSourceId>> = {
  "google chrome.app": "chrome",
  "microsoft edge.app": "edge",
  "brave browser.app": "brave",
  "vivaldi.app": "vivaldi",
  "opera.app": "opera",
  "arc.app": "arc",
  "helium.app": "helium",
  "firefox.app": "firefox",
  "zen.app": "zen",
  "safari.app": "safari",
  "google-chrome": "chrome",
  "google-chrome-stable": "chrome",
  "google-chrome.desktop": "chrome",
  "microsoft-edge": "edge",
  "microsoft-edge-stable": "edge",
  "microsoft-edge.desktop": "edge",
  "brave-browser": "brave",
  "brave-browser.desktop": "brave",
  vivaldi: "vivaldi",
  "vivaldi-stable.desktop": "vivaldi",
  opera: "opera",
  "opera.desktop": "opera",
  helium: "helium",
  "net.imput.helium.desktop": "helium",
  firefox: "firefox",
  "firefox.desktop": "firefox",
};

const WINDOWS_APPLICATION_PATHS: ReadonlyArray<readonly [string, BrowserImportSourceId]> = [
  ["/google/chrome/application/chrome.exe", "chrome"],
  ["/microsoft/edge/application/msedge.exe", "edge"],
  ["/bravesoftware/brave-browser/application/brave.exe", "brave"],
  ["/vivaldi/application/vivaldi.exe", "vivaldi"],
  ["/mozilla firefox/firefox.exe", "firefox"],
  ["/imput/helium/application/helium.exe", "helium"],
];

const sourceForApplicationId = (id: string) =>
  Object.hasOwn(APPLICATION_IDS, id) ? APPLICATION_IDS[id] : undefined;

/** Match known handlers exactly: a beta build or browser selector may use different data. */
export function defaultBrowserSourceId(
  application: { readonly name: string; readonly path: string } | undefined,
): BrowserImportSourceId | undefined {
  if (!application) return undefined;
  const path = application.path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  if (path !== "") {
    const segments = path.split("/");
    const appBundle = segments.find((segment) => segment.endsWith(".app"));
    if (appBundle) return sourceForApplicationId(appBundle);
    if (path.endsWith(".exe")) {
      return WINDOWS_APPLICATION_PATHS.find(([suffix]) => path.endsWith(suffix))?.[1];
    }
    return sourceForApplicationId(segments.at(-1) ?? "");
  }
  // Linux may supply only the desktop entry identifier. A display-name fallback
  // is deliberately absent: it cannot distinguish stable and alternate profiles.
  const name = application.name.toLowerCase();
  return name.endsWith(".desktop") ? sourceForApplicationId(name) : undefined;
}
