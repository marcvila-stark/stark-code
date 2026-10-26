import {
  DEFAULT_CLIENT_SETTINGS,
  type BrowserImportResult,
  type BrowserImportSource,
  type ClientSettings,
  type EnvironmentId,
} from "@starkfuture/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { runBrowserImport } from "./browserImport";

const environmentId = "environment-a" as EnvironmentId;
const source: BrowserImportSource = {
  id: "chrome",
  name: "Chrome",
  profiles: [{ directory: "Default", name: "Personal" }],
};
const result: BrowserImportResult = { imported: 5, skipped: 2, skippedDomains: ["example.test"] };
const request = {
  source,
  environmentId,
  sourceProfileDirectory: "Default",
  target: {
    kind: "existing" as const,
    profileId: "personal-imported",
    name: "Personal imported sessions",
  },
  selectedDomains: ["example.test"],
  consent: true as const,
};

function fixture() {
  let settings: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS };
  const bridge = {
    importBrowserCookies: vi.fn().mockResolvedValue(result),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
  };
  const persistSettingsUpdate = vi.fn(
    async (update: (current: ClientSettings) => ClientSettings) => {
      settings = update(settings);
      return settings;
    },
  );
  return {
    bridge,
    getSettings: () => settings,
    persistSettingsUpdate,
    setSettings: (next: ClientSettings) => {
      settings = next;
    },
  };
}

describe("runBrowserImport", () => {
  it("copies only chosen sites into the personal profile without changing settings", async () => {
    const deps = fixture();
    expect(await runBrowserImport(deps, request)).toEqual({
      kind: "imported",
      ...result,
      targetName: "Personal imported sessions",
    });
    expect(deps.bridge.importBrowserCookies).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      sourceId: "chrome",
      sourceProfileDirectory: "Default",
      targetProfileId: "personal-imported",
      selectedDomains: ["example.test"],
      consent: true,
    });
    expect(deps.persistSettingsUpdate).not.toHaveBeenCalled();
  });
  it.each(["agent", "default", "profile-work", "incognito"])(
    "refuses importing into %s",
    async (profileId) => {
      const deps = fixture();
      expect(
        await runBrowserImport(deps, { ...request, target: { ...request.target, profileId } }),
      ).toEqual({ kind: "blocked", reason: "unsafeTarget" });
      expect(deps.bridge.importBrowserCookies).not.toHaveBeenCalled();
    },
  );
  it("requires a site selection before reading any cookies", async () => {
    const deps = fixture();
    expect(await runBrowserImport(deps, { ...request, selectedDomains: [] })).toEqual({
      kind: "blocked",
      reason: "unsafeTarget",
    });
    expect(deps.bridge.importBrowserCookies).not.toHaveBeenCalled();
  });
  it("reports absent desktop support without touching settings", async () => {
    expect(await runBrowserImport({ ...fixture(), bridge: null }, request)).toEqual({
      kind: "blocked",
      reason: "sessionUnavailable",
    });
  });
  it("keeps raw Keychain failures private", async () => {
    const deps = fixture();
    deps.bridge.importBrowserCookies.mockRejectedValue(
      new Error("Importing cookies from chrome failed: needsKeychainApproval. private details"),
    );
    expect(await runBrowserImport(deps, request)).toEqual({
      kind: "blocked",
      reason: "needsKeychainApproval",
    });
  });
});
