import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@starkfuture/contracts";
import {
  composerUsageNeedsRefresh,
  formatComposerUsagePercent,
  formatComposerUsageSummary,
  selectComposerUsage,
} from "./ComposerUsageRing.logic";

const now = Date.parse("2026-10-17T12:00:00Z");
const weekly: ServerProviderUsageWindow = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 67,
  resetsAt: "2026-10-19T18:00:00Z",
};
const session: ServerProviderUsageWindow = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 12,
  resetsAt: "2026-10-17T15:00:00Z",
};
function provider(windows: readonly ServerProviderUsageWindow[] = [weekly]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Stark Future 1",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "hidden@example.com" },
    checkedAt: "2026-10-17T12:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-10-17T11:55:00Z", windows },
  };
}
describe("selectComposerUsage", () => {
  it("never shows subscription allowances or schedules usage refreshes for an API key connection", () => {
    const api = {
      ...provider(),
      apiBackend: "openrouter" as const,
      auth: { status: "authenticated" as const, type: "apiKey" },
    };
    expect(selectComposerUsage(api, true, now)).toBeNull();
    expect(composerUsageNeedsRefresh(api, now)).toBe(false);
    expect(
      selectComposerUsage({ ...api, driver: ProviderDriverKind.make("codex") }, true, now),
    ).toBeNull();
  });
  it("shows Claude's session and week while excluding scoped model allowances", () => {
    const scoped = { ...weekly, id: "seven_day_opus", usedPercent: 99 };
    const result = selectComposerUsage(provider([scoped, session, weekly]), true, now);
    expect(result?.window?.usedPercent).toBe(67);
    expect(result?.windows).toEqual([
      { id: "session", label: "Session · all models", window: session, message: null },
      { id: "weekly", label: "Weekly · all models", window: weekly, message: null },
    ]);
    expect(selectComposerUsage(provider([scoped, session]), true, now)?.label).toBe(
      "Session · all models",
    );
    expect(selectComposerUsage(provider([scoped]), true, now)?.window).toBeNull();
  });
  it("shows Codex account windows and supports monthly plans without model-specific buckets", () => {
    const session = { ...weekly, id: "primary", kind: "session" as const, usedPercent: 12 };
    const week = { ...weekly, id: "secondary", usedPercent: 48 };
    const codex = { ...provider([session, week]), driver: ProviderDriverKind.make("codex") };
    expect(selectComposerUsage(codex, true, now)?.window?.usedPercent).toBe(48);
    expect(
      selectComposerUsage(
        { ...codex, usageLimits: { ...codex.usageLimits!, windows: [session] } },
        true,
        now,
      )?.label,
    ).toBe("Session");
    expect(
      selectComposerUsage(
        {
          ...codex,
          usageLimits: { ...codex.usageLimits!, windows: [{ ...session, kind: "monthly" }] },
        },
        true,
        now,
      )?.label,
    ).toBe("Monthly");
    expect(
      selectComposerUsage(
        { ...codex, usageLimits: { ...codex.usageLimits!, windows: [{ ...week, id: "spark" }] } },
        true,
        now,
      )?.window,
    ).toBeNull();
  });
  it("uses Codex's window kind rather than the primary/secondary position", () => {
    const week = { ...weekly, id: "primary" };
    const short = { ...session, id: "secondary" };
    const codex = { ...provider([week, short]), driver: ProviderDriverKind.make("codex") };
    const result = selectComposerUsage(codex, true, now);
    expect(result?.windows).toEqual([
      { id: "session", label: "Session", window: short, message: null },
      { id: "weekly", label: "Weekly", window: week, message: null },
    ]);
    expect(result?.window).toEqual(week);
  });
  it.each(["claudeAgent", "codex"] as const)(
    "makes the %s ring reflect the more consumed session while retaining weekly details",
    (driver) => {
      const short = {
        ...session,
        id: driver === "codex" ? "primary" : session.id,
        usedPercent: 92,
      };
      const week = { ...weekly, id: driver === "codex" ? "secondary" : weekly.id };
      const result = selectComposerUsage(
        { ...provider([week, short]), driver: ProviderDriverKind.make(driver) },
        true,
        now,
      );
      expect(result?.window).toEqual(short);
      expect(result?.label).toMatch(/^Session/);
      expect(result?.windows.map((row) => row.window?.usedPercent)).toEqual([92, 67]);
    },
  );
  it("keeps the established weekly ring when session and week have equal usage", () => {
    const result = selectComposerUsage(
      provider([{ ...session, usedPercent: 67 }, weekly]),
      true,
      now,
    );
    expect(result?.window).toEqual(weekly);
    expect(result?.label).toBe("Weekly · all models");
  });
  it("keeps missing session allowance distinct from a reported zero weekly allowance", () => {
    const zero = { ...weekly, usedPercent: 0 };
    const result = selectComposerUsage(provider([zero]), true, now);
    expect(result?.windows).toEqual([
      { id: "session", label: "Session · all models", window: null, message: "Not reported." },
      { id: "weekly", label: "Weekly · all models", window: zero, message: null },
    ]);
    expect(result?.window).toEqual(zero);
    expect(result?.message).toBeNull();
  });
  it("adds a Codex monthly row while keeping missing session and weekly windows explicit", () => {
    const monthly = { ...weekly, id: "primary", kind: "monthly" as const, label: "Monthly" };
    const result = selectComposerUsage(
      { ...provider([monthly]), driver: ProviderDriverKind.make("codex") },
      true,
      now,
    );
    expect(result?.windows).toEqual([
      { id: "session", label: "Session", window: null, message: "Not reported." },
      { id: "weekly", label: "Weekly", window: null, message: "Not reported." },
      { id: "monthly", label: "Monthly", window: monthly, message: null },
    ]);
    expect(result?.window).toEqual(monthly);
  });
  it.each([
    ["claudeAgent", "session"],
    ["claudeAgent", "weekly"],
    ["codex", "session"],
    ["codex", "weekly"],
  ] as const)("keeps the other %s window visible after %s resets", (driver, expiredKind) => {
    const windows = [session, weekly].map((window) => ({
      ...window,
      id: driver === "codex" ? (window.kind === "session" ? "primary" : "secondary") : window.id,
      ...(window.kind === expiredKind
        ? { usedPercent: 100, resetsAt: new Date(now).toISOString() }
        : {}),
    }));
    const result = selectComposerUsage(
      { ...provider(windows), driver: ProviderDriverKind.make(driver) },
      true,
      now,
    );
    const reset = result?.windows.find((row) => row.id === expiredKind);
    const valid = result?.windows.find((row) => row.id !== expiredKind);
    expect(reset?.window).toBeNull();
    expect(reset?.message).toContain("has reset");
    expect(valid?.message).toBeNull();
    expect(valid?.window?.usedPercent).toBe(expiredKind === "session" ? 67 : 12);
    expect(result?.window).toEqual(valid?.window);
    expect(result?.message).toBeNull();
  });
  it.each([0, 100])("keeps a reported percentage of %s distinct from unknown", (percent) => {
    const result = selectComposerUsage(provider([{ ...weekly, usedPercent: percent }]), true, now);
    expect(result?.window?.usedPercent).toBe(percent);
    expect(result?.message).toBeNull();
    expect(formatComposerUsagePercent(percent)).toBe(`${percent}%`);
  });
  it.each(["unsupported", "probeFailed"] as const)(
    "does not present old cached usage after %s",
    (reason) => {
      const value = provider();
      const result = selectComposerUsage(
        { ...value, usageLimits: { ...value.usageLimits!, unavailable: { reason } } },
        true,
        now,
      );
      expect(result?.window).toBeNull();
      expect(result?.windows).toEqual([]);
      expect(result?.message).toBe(
        reason === "unsupported"
          ? "This account does not report subscription usage."
          : "Usage could not be refreshed. Waiting for an update.",
      );
    },
  );
  it("retains last-known usage after 15 minutes but never guesses usage after reset", () => {
    expect(selectComposerUsage(provider(), true, now + 9 * 60_000)?.window?.usedPercent).toBe(67);
    const old = selectComposerUsage(provider(), true, now + 26 * 60_000)!;
    expect(old.windows.find((entry) => entry.id === "weekly")?.message).toContain("Last known");
    expect(old.window?.usedPercent).toBe(67);
    expect(formatComposerUsageSummary(old)).toBe("Last known · Session — · Weekly 67%");
    expect(
      selectComposerUsage(provider([{ ...weekly, resetsAt: "2026-10-17T12:00:00Z" }]), true, now)
        ?.message,
    ).toContain("has reset");
  });
  it("uses each window's observation time and preserves a genuine old zero", () => {
    const value = provider([
      { ...session, usedPercent: 0, checkedAt: "2026-10-17T11:30:00Z" },
      weekly,
    ]);
    const result = selectComposerUsage(value, true, now)!;
    expect(result.windows[0]?.message).toContain("Last known");
    expect(result.windows[1]?.message).toBeNull();
    expect(formatComposerUsageSummary(result)).toBe("Last known · Session 0% · Weekly 67%");
  });
  it("labels last-known values after a failed refresh and clears that warning after a later observation", () => {
    const base = provider([session, weekly]);
    const value = {
      ...base,
      usageLimits: { ...base.usageLimits!, refreshError: { checkedAt: "2026-10-17T11:58:00Z" } },
    };
    expect(selectComposerUsage(value, true, now)?.windows[0]?.message).toContain("refresh failed");
    const updated = {
      ...value,
      usageLimits: {
        ...value.usageLimits,
        windows: [{ ...session, checkedAt: "2026-10-17T11:59:00Z" }, weekly],
      },
    };
    expect(selectComposerUsage(updated, true, now)?.windows[0]?.message).toBeNull();
    expect(selectComposerUsage(updated, true, now)?.windows[1]?.message).toContain(
      "refresh failed",
    );
  });
  it("requests a selected-profile refresh only for stale, missing or failed supported usage", () => {
    const fresh = {
      ...provider(),
      usageLimits: { checkedAt: "2026-10-17T12:00:00Z", windows: [weekly] },
    };
    expect(composerUsageNeedsRefresh(fresh, now)).toBe(false);
    expect(composerUsageNeedsRefresh(fresh, now + 5 * 60_000)).toBe(true);
    expect(composerUsageNeedsRefresh({ ...fresh, usageLimits: undefined }, now)).toBe(true);
    expect(composerUsageNeedsRefresh({ ...fresh, auth: { status: "unauthenticated" } }, now)).toBe(
      false,
    );
    expect(
      composerUsageNeedsRefresh(
        {
          ...fresh,
          usageLimits: {
            checkedAt: "2026-10-17T12:00:00Z",
            windows: [],
            unavailable: { reason: "unsupported" },
          },
        },
        now,
      ),
    ).toBe(false);
  });
  it("keeps offline, signed-out and missing quota states neutral", () => {
    expect(selectComposerUsage(provider(), false, now)?.window).toBeNull();
    expect(selectComposerUsage(provider(), false, now)?.windows).toEqual([]);
    expect(selectComposerUsage(provider(), false, now)?.message).toBe(
      "Reconnect to see current usage.",
    );
    const signedOut = selectComposerUsage(
      { ...provider(), auth: { status: "unauthenticated" } },
      true,
      now,
    );
    expect(signedOut?.window).toBeNull();
    expect(signedOut?.windows).toEqual([]);
    expect(signedOut?.message).toBe("Sign in to see subscription usage.");
    const unchecked = selectComposerUsage(
      { ...provider(), auth: { status: "unknown" } },
      true,
      now,
    );
    expect(unchecked?.windows).toEqual([]);
    expect(unchecked?.message).toBe("Could not check your account. Refresh usage to try again.");
    expect(composerUsageNeedsRefresh({ ...provider(), auth: { status: "unknown" } }, now)).toBe(
      false,
    );
    const missing = selectComposerUsage({ ...provider(), usageLimits: undefined }, true, now);
    expect(missing?.window).toBeNull();
    expect(missing?.windows).toEqual([]);
    expect(missing?.message).toBe("Usage has not been reported yet.");
    expect(selectComposerUsage(provider([]), true, now)?.window).toBeNull();
  });
  it("does not render unsupported providers or absent selection", () => {
    expect(selectComposerUsage(null, true, now)).toBeNull();
    expect(
      selectComposerUsage({ ...provider(), driver: ProviderDriverKind.make("cursor") }, true, now),
    ).toBeNull();
  });
});
