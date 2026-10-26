import { DEFAULT_UNIFIED_SETTINGS } from "@starkfuture/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import {
  alphaCompatibilityPreferences,
  alphaCompatibilityPreferencesForTargets,
} from "./SettingsPanels.alpha";

const alphaDefaults = DEFAULT_UNIFIED_SETTINGS;

describe("saved alpha compatibility preferences", () => {
  it("does not offer retired features to a fresh alpha user", () => {
    expect(alphaCompatibilityPreferences(alphaDefaults)).toEqual([]);
  });

  it("keeps an existing automation visible and lets its owner turn it off without changing other preferences", () => {
    const settings = {
      ...alphaDefaults,
      sidebarAutoSettleOnMerge: true,
      sidebarAutoSettleAfterDays: 7,
      autoResumeLimitedThreads: true,
    };
    const entries = alphaCompatibilityPreferences(settings);
    expect(entries.map((entry) => entry.id)).toEqual([
      "auto-settle-merged-threads",
      "auto-settle-inactive-threads",
      "auto-resume-limited-threads",
    ]);
    expect(
      entries.find((entry) => entry.id === "auto-settle-inactive-threads")?.description,
    ).toContain("7 days");
    const stopContinuation = entries.find((entry) => entry.id === "auto-resume-limited-threads")!;
    expect(stopContinuation.description).toContain("spend tokens");
    const after = { ...settings, ...stopContinuation.patch };
    expect(after.autoResumeLimitedThreads).toBe(false);
    expect(after.sidebarAutoSettleAfterDays).toBe(7);
    expect(settings.autoResumeLimitedThreads).toBe(true);
    expect(
      alphaCompatibilityPreferences(after).some((entry) => entry.id === stopContinuation.id),
    ).toBe(false);
  });

  it("preserves saved interface exceptions until the user explicitly returns each to the alpha behavior", () => {
    const settings = {
      ...alphaDefaults,
      timestampFormat: "24-hour" as const,
      showSkillsInSlashMenu: false,
      proactivePanelsEnabled: true,
      legacySidebarEnabled: true,
    };
    const entries = alphaCompatibilityPreferences(settings);
    expect(new Set(entries.map((entry) => entry.id))).toEqual(
      new Set(["legacy-sidebar", "time-format", "proactive-panels", "skills-in-slash-menu"]),
    );
    expect(settings.timestampFormat).toBe("24-hour");
    expect(settings.showSkillsInSlashMenu).toBe(false);
    const reset = { ...settings };
    for (const entry of entries) Object.assign(reset, entry.patch);
    expect(reset.timestampFormat).toBe("locale");
    expect(reset.showSkillsInSlashMenu).toBe(true);
    expect(reset.legacySidebarEnabled).toBe(false);
    expect(alphaCompatibilityPreferences(reset)).toEqual([]);
  });
  it("keeps recovery controls for active policies on a non-representative target", () => {
    const targets = [
      alphaDefaults,
      { ...alphaDefaults, autoResumeLimitedThreads: true, sidebarAutoSettleAfterDays: 7 },
    ];
    const entries = alphaCompatibilityPreferencesForTargets(targets);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "auto-resume-limited-threads",
          mixed: true,
          settingKeys: ["autoResumeLimitedThreads"],
        }),
        expect.objectContaining({ id: "auto-settle-inactive-threads", mixed: true }),
      ]),
    );
    const disableResume = entries.find((entry) => entry.id === "auto-resume-limited-threads")!;
    const updated = targets.map((target) => ({ ...target, ...disableResume.patch }));
    expect(alphaCompatibilityPreferencesForTargets(updated).map((entry) => entry.id)).toEqual([
      "auto-settle-inactive-threads",
    ]);
  });

  it("detects differing active values without duplicating a shared client preference", () => {
    const targets = [3, 7].map((days) => ({
      ...alphaDefaults,
      sidebarAutoSettleAfterDays: days,
      timestampFormat: "24-hour" as const,
    }));
    const entries = alphaCompatibilityPreferencesForTargets(targets);
    expect(entries.filter((entry) => entry.id === "time-format")).toHaveLength(1);
    expect(entries.find((entry) => entry.id === "time-format")).toMatchObject({
      mixed: false,
      settingKeys: [],
    });
    expect(entries.find((entry) => entry.id === "auto-settle-inactive-threads")?.mixed).toBe(true);
  });
});
