import { describe, expect, it } from "vite-plus/test";
import type { BrowserImportSource } from "@starkfuture/contracts";

import {
  canCloseWizard,
  copySignInsLabel,
  deselectSites,
  filterSites,
  initialWizardStep,
  initialTargetSelection,
  isRetryableReason,
  formatSkippedDomains,
  fullDiskAccessRecheckStep,
  MAX_IMPORT_SITES,
  outcomeToStep,
  parseSiteInput,
  recommendedSiteGroups,
  refreshedSourceProfileDirectory,
  refreshedSourceStep,
  resolveWizardTarget,
  selectSites,
  siteCountLabel,
  siteGroupSelectionLabel,
  siteGroupState,
} from "./browserImportWizard.logic";

describe("wizard target selection", () => {
  it("treats an existing profile whose id is new as an existing target", () => {
    const profiles = [{ id: "new", name: "Existing new" }];
    const selection = initialTargetSelection(false, profiles);

    expect(selection).toEqual({ kind: "existing", profileId: "new" });
    expect(resolveWizardTarget(selection, "generated", profiles)).toEqual({
      kind: "existing",
      profileId: "new",
      name: "Existing new",
    });
  });

  it("rejects an existing target that is no longer listed", () => {
    expect(
      resolveWizardTarget({ kind: "existing", profileId: "removed" }, "generated", [
        { id: "default", name: "Default" },
      ]),
    ).toBeUndefined();
  });
});

const source = (over: Partial<BrowserImportSource> = {}): BrowserImportSource => ({
  id: "helium",
  name: "Helium",
  profiles: [{ directory: "Default", name: "You" }],
  ...over,
});

describe("initialWizardStep", () => {
  it("opens on the quit screen when the browser is running", () => {
    expect(initialWizardStep(source({ unavailable: "browserRunning" }))).toEqual({ step: "quit" });
  });

  it("opens on configure when the source is ready", () => {
    expect(initialWizardStep(source())).toEqual({ step: "configure" });
  });

  it("asks for Full Disk Access before choosing an import target", () => {
    expect(initialWizardStep(source({ profiles: [], unavailable: "needsFullDiskAccess" }))).toEqual(
      {
        step: "fullDiskAccess",
        resume: "configure",
      },
    );
  });

  it("blocks on a reason nothing local can fix", () => {
    expect(initialWizardStep(source({ unavailable: "unsupportedPlatform" }))).toEqual({
      step: "blocked",
      reason: "unsupportedPlatform",
    });
  });

  it("blocks a ready source that reports no importable profiles", () => {
    expect(initialWizardStep(source({ profiles: [] }))).toEqual({
      step: "blocked",
      reason: "unknownSourceProfile",
    });
  });

  it("handles source availability before checking its profiles", () => {
    expect(
      initialWizardStep(source({ profiles: [], unavailable: "needsKeychainApproval" })),
    ).toEqual({ step: "blocked", reason: "needsKeychainApproval" });
  });
});

describe("canCloseWizard", () => {
  it("keeps the wizard open while an import writes its target profile", () => {
    expect(canCloseWizard({ step: "importing" })).toBe(false);
    expect(canCloseWizard({ step: "configure" })).toBe(true);
    expect(canCloseWizard({ step: "blocked", reason: "readFailed" })).toBe(true);
  });
});

describe("outcomeToStep", () => {
  it("lands on done after a successful import", () => {
    expect(
      outcomeToStep({
        kind: "imported",
        imported: 12,
        skipped: 3,
        skippedDomains: ["example.com"],
        targetName: "Work",
      }),
    ).toEqual({
      step: "done",
      imported: 12,
      skipped: 3,
      skippedDomains: ["example.com"],
      targetName: "Work",
    });
  });

  it("routes a reopened browser back to the quit screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "browserRunning" })).toEqual({ step: "quit" });
  });

  it("routes a Full Disk Access refusal to its own screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "needsFullDiskAccess" })).toEqual({
      step: "fullDiskAccess",
      resume: "import",
      checked: true,
    });
  });

  it("surfaces every other failure on the blocked screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "readFailed" })).toEqual({
      step: "blocked",
      reason: "readFailed",
    });
  });
});

describe("refreshedSourceStep", () => {
  it("moves to configure once a quit browser frees its cookies", () => {
    expect(refreshedSourceStep(source())).toEqual({ step: "configure" });
  });

  it("stays on quit while the browser is still running", () => {
    expect(refreshedSourceStep(source({ unavailable: "browserRunning" }))).toEqual({
      step: "quit",
    });
  });

  it("blocks when the source vanished from the list", () => {
    expect(refreshedSourceStep(undefined)).toEqual({ step: "blocked", reason: "unknownSource" });
  });

  it("blocks when the refreshed source has no profiles", () => {
    expect(refreshedSourceStep(source({ profiles: [] }))).toEqual({
      step: "blocked",
      reason: "unknownSourceProfile",
    });
  });
});

describe("fullDiskAccessRecheckStep", () => {
  it("marks a still-denied access check for visible feedback", () => {
    expect(fullDiskAccessRecheckStep(source({ unavailable: "needsFullDiskAccess" }))).toEqual({
      step: "fullDiskAccess",
      resume: "configure",
      checked: true,
    });
  });

  it("moves on once access reveals the source profiles", () => {
    expect(fullDiskAccessRecheckStep(source())).toEqual({ step: "configure" });
  });
});

describe("refreshedSourceProfileDirectory", () => {
  const refreshed = source({
    profiles: [
      { directory: "Default", name: "Personal" },
      { directory: "Profile 2", name: "Work" },
    ],
  });

  it("preserves a selected non-first profile after the browser quits", () => {
    expect(refreshedSourceProfileDirectory("Profile 2", refreshed)).toBe("Profile 2");
  });

  it("falls back only when the old profile vanished and clears an empty result", () => {
    expect(refreshedSourceProfileDirectory("Removed", refreshed)).toBe("Default");
    expect(refreshedSourceProfileDirectory("Removed", source({ profiles: [] }))).toBe("");
  });
});

describe("isRetryableReason", () => {
  it("offers a retry for failures a second attempt can clear", () => {
    expect(isRetryableReason("needsKeychainApproval")).toBe(true);
    expect(isRetryableReason("keychainUnavailable")).toBe(true);
    expect(isRetryableReason("readFailed")).toBe(true);
  });

  it("does not offer a retry for a permanent failure", () => {
    expect(isRetryableReason("unsupportedPlatform")).toBe(false);
    expect(isRetryableReason("unknownSourceProfile")).toBe(false);
    // Retrying the same new-profile import cannot lower the profile count.
    expect(isRetryableReason("profileLimitReached")).toBe(false);
  });

  it("offers a retry once the user has signed in to create the missing key", () => {
    // The blocked copy tells the user to sign in and retry, so the screen
    // has to offer the retry it asks for.
    expect(isRetryableReason("keychainItemMissing")).toBe(true);
  });

  it("offers a retry when the cookies landed but the new profile was not saved", () => {
    expect(isRetryableReason("profileNotSaved")).toBe(true);
  });
});

describe("formatSkippedDomains", () => {
  it("joins a short list naturally", () => {
    expect(formatSkippedDomains([])).toBe("");
    expect(formatSkippedDomains(["a.com"])).toBe("a.com");
    expect(formatSkippedDomains(["a.com", "b.com"])).toBe("a.com and b.com");
    expect(formatSkippedDomains(["a.com", "b.com", "c.com"])).toBe("a.com, b.com and c.com");
  });

  it("summarizes a long list", () => {
    expect(formatSkippedDomains(["a.com", "b.com", "c.com", "d.com", "e.com"])).toBe(
      "a.com, b.com, c.com and 2 more",
    );
  });
});

describe("recommendedSiteGroups", () => {
  it("offers Stark hosts as one set, led by Stark Pages", () => {
    const groups = recommendedSiteGroups([
      "admin.starkfuture.com",
      "example.com",
      "pages.starkfuture.com",
      "starkfuture.com",
    ]);

    expect(groups.recommended).toEqual([
      {
        id: "stark",
        title: "Stark sites",
        description: undefined,
        hostsLabel: "pages.starkfuture.com and 2 more",
        hosts: ["pages.starkfuture.com", "admin.starkfuture.com", "starkfuture.com"],
      },
    ]);
    expect(groups.other).toEqual(["example.com"]);
  });

  it("does not treat look-alike hosts as Stark sites", () => {
    const groups = recommendedSiteGroups(["notstarkfuture.com", "starkfuture.com.evil.io"]);

    expect(groups.recommended).toEqual([]);
    expect(groups.other).toEqual(["notstarkfuture.com", "starkfuture.com.evil.io"]);
  });

  it("names a single Stark host without a count", () => {
    expect(recommendedSiteGroups(["shop.starkfuture.com"]).recommended[0]?.hostsLabel).toBe(
      "shop.starkfuture.com",
    );
  });

  it("offers only the sign-in providers the profile lists", () => {
    const groups = recommendedSiteGroups([
      "accounts.google.com",
      "github.com",
      "google.com",
      "gist.github.com",
    ]);

    expect(groups.recommended).toEqual([
      {
        id: "signInProviders",
        title: "Sign-in providers",
        description: "Needed when a site asks you to sign in again",
        hostsLabel: "accounts.google.com, github.com",
        hosts: ["accounts.google.com", "github.com"],
      },
    ]);
    // Only the exact provider hosts are grouped; siblings stay individual choices.
    expect(groups.other).toEqual(["google.com", "gist.github.com"]);
  });

  it("lists Stark sites before sign-in providers and keeps every other host once", () => {
    const groups = recommendedSiteGroups([
      "login.live.com",
      "pages.starkfuture.com",
      "Example.com",
      "example.com",
    ]);

    expect(groups.recommended.map((group) => group.id)).toEqual(["stark", "signInProviders"]);
    expect(groups.other).toEqual(["example.com"]);
  });

  it("has nothing to offer for a profile without listed hosts", () => {
    expect(recommendedSiteGroups([])).toEqual({ recommended: [], other: [] });
  });
});

describe("site selection", () => {
  it("adds a whole set at once without duplicating hosts", () => {
    expect(selectSites(["a.com"], ["a.com", "b.com"])).toEqual({
      selected: ["a.com", "b.com"],
      limitReached: false,
    });
  });

  it("refuses a step that would pass the import cap and keeps the selection", () => {
    const full = Array.from({ length: MAX_IMPORT_SITES }, (_, index) => `site${index}.com`);

    expect(selectSites(full, ["one-more.com"])).toEqual({ selected: full, limitReached: true });
    // Re-selecting hosts already chosen does not count against the cap.
    expect(selectSites(full, [full[0]!])).toEqual({ selected: full, limitReached: false });
  });

  it("does not half-select a set that only partly fits", () => {
    const almost = Array.from({ length: MAX_IMPORT_SITES - 1 }, (_, index) => `site${index}.com`);

    expect(selectSites(almost, ["x.com", "y.com"])).toEqual({
      selected: almost,
      limitReached: true,
    });
  });

  it("removes a set's hosts and leaves the rest", () => {
    expect(deselectSites(["a.com", "b.com", "c.com"], ["b.com", "z.com"])).toEqual([
      "a.com",
      "c.com",
    ]);
  });

  it("reports a set as fully, partly, or not selected", () => {
    expect(siteGroupState(["a.com", "b.com"], ["a.com", "b.com"])).toBe("all");
    expect(siteGroupState(["a.com"], ["a.com", "b.com"])).toBe("some");
    expect(siteGroupState(["c.com"], ["a.com", "b.com"])).toBe("none");
  });

  it("unticks one host inside a selected set and keeps the rest", () => {
    const stark = ["pages.starkfuture.com", "admin.starkfuture.com", "starkfuture.com"];
    const all = selectSites(["example.com"], stark).selected;
    const withoutAdmin = deselectSites(all, ["admin.starkfuture.com"]);

    expect(withoutAdmin).toEqual(["example.com", "pages.starkfuture.com", "starkfuture.com"]);
    expect(siteGroupState(withoutAdmin, stark)).toBe("some");
    // Ticking it again completes the set without duplicating hosts.
    const again = selectSites(withoutAdmin, ["admin.starkfuture.com"]);
    expect(again.limitReached).toBe(false);
    expect(siteGroupState(again.selected, stark)).toBe("all");
    expect(again.selected).toHaveLength(4);
  });

  it("counts a partly chosen set and says nothing when it is all or none", () => {
    const hosts = ["a.com", "b.com", "c.com"];

    expect(siteGroupSelectionLabel(["a.com", "c.com", "x.com"], hosts)).toBe("2 of 3 selected");
    expect(siteGroupSelectionLabel(hosts, hosts)).toBeUndefined();
    expect(siteGroupSelectionLabel(["x.com"], hosts)).toBeUndefined();
  });
});

describe("parseSiteInput", () => {
  it("accepts an exact host, a pasted URL, or a cookie-style domain", () => {
    expect(parseSiteInput("  Pages.StarkFuture.com ")).toBe("pages.starkfuture.com");
    expect(parseSiteInput("https://pages.starkfuture.com/projects?x=1")).toBe(
      "pages.starkfuture.com",
    );
    expect(parseSiteInput(".example.com")).toBe("example.com");
  });

  it("rejects anything that is not one exact host", () => {
    expect(parseSiteInput("")).toBeUndefined();
    expect(parseSiteInput("localhost")).toBeUndefined();
    expect(parseSiteInput("*.example.com")).toBeUndefined();
    expect(parseSiteInput("example-.com-")).toBeUndefined();
    expect(parseSiteInput("not a site")).toBeUndefined();
  });
});

describe("filterSites", () => {
  it("matches part of a host and caps what is rendered", () => {
    expect(filterSites(["a.example.com", "b.test.com", "c.example.com"], "EXAMPLE", 1)).toEqual({
      visible: ["a.example.com"],
      hiddenCount: 1,
    });
  });

  it("shows every host for an empty filter", () => {
    expect(filterSites(["a.com", "b.com"], "  ")).toEqual({
      visible: ["a.com", "b.com"],
      hiddenCount: 0,
    });
  });
});

describe("labels", () => {
  it("counts a source profile's sites instead of its raw cookies", () => {
    expect(siteCountLabel(undefined)).toBeUndefined();
    expect(siteCountLabel([])).toBe("No sites");
    expect(siteCountLabel(["a.com"])).toBe("1 site");
    expect(siteCountLabel(["a.com", "b.com"])).toBe("2 sites");
  });

  it("marks a count the browser cut short", () => {
    expect(siteCountLabel(["a.com", "b.com"], true)).toBe("2+ sites");
    expect(siteCountLabel(["a.com"], true)).toBe("1+ sites");
    expect(siteCountLabel(["a.com"], false)).toBe("1 site");
  });

  it("names what the confirm button copies", () => {
    expect(copySignInsLabel(0)).toBe("Copy sign-ins");
    expect(copySignInsLabel(1)).toBe("Copy sign-ins for 1 site");
    expect(copySignInsLabel(4)).toBe("Copy sign-ins for 4 sites");
  });
});
