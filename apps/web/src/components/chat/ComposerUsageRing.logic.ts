import type { ServerProvider, ServerProviderUsageWindow } from "@starkfuture/contracts";

const USAGE_STALE_AFTER_MS = 15 * 60_000;

type ComposerUsageWindow = {
  id: "session" | "weekly" | "monthly";
  label: string;
  window: ServerProviderUsageWindow | null;
  message: string | null;
};

/** Keep each account quota separate; the ring reflects the most-used current window. */
export function selectComposerUsage(
  provider: ServerProvider | null,
  connected: boolean,
  nowMs: number,
) {
  if (
    !provider ||
    provider.apiBackend === "openrouter" ||
    provider.auth.type === "apiKey" ||
    (provider.driver !== "claudeAgent" && provider.driver !== "codex")
  ) {
    return null;
  }
  const profile = provider.displayName ?? (provider.driver === "claudeAgent" ? "Claude" : "Codex");
  const unknown = (message: string) => ({
    profile,
    window: null,
    label: null,
    message,
    windows: [] as ComposerUsageWindow[],
  });
  if (!connected) return unknown("Reconnect to see current usage.");
  if (!provider.enabled || !provider.installed || provider.availability === "unavailable") {
    return unknown("This profile is not available.");
  }
  if (provider.auth.status === "unauthenticated") {
    return unknown("Sign in to see subscription usage.");
  }
  if (provider.auth.status !== "authenticated") {
    return unknown("Could not check your account. Refresh usage to try again.");
  }
  const limits = provider.usageLimits;
  if (!limits) return unknown("Usage has not been reported yet.");
  if (limits.unavailable?.reason === "unsupported") {
    return unknown("This account does not report subscription usage.");
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return unknown("Usage could not be refreshed. Waiting for an update.");
  }
  const accountWindows = limits.windows.filter((entry) =>
    provider.driver === "claudeAgent"
      ? entry.id === "five_hour" || entry.id === "seven_day"
      : entry.id === "primary" || entry.id === "secondary",
  );
  const kinds: ComposerUsageWindow["id"][] = ["session", "weekly"];
  if (accountWindows.some((entry) => entry.kind === "monthly")) kinds.push("monthly");
  const windows = kinds.map((kind): ComposerUsageWindow => {
    // Codex's primary/secondary identifiers describe positions, not durations.
    const reported = accountWindows.find((entry) => entry.kind === kind);
    const name = kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Session";
    const label = provider.driver === "claudeAgent" ? `${name} · all models` : name;
    if (
      !reported ||
      !Number.isFinite(reported.usedPercent) ||
      reported.usedPercent < 0 ||
      reported.usedPercent > 100
    )
      return { id: kind, label, window: null, message: "Not reported." };
    if (reported.resetsAt && Date.parse(reported.resetsAt) <= nowMs)
      return {
        id: kind,
        label,
        window: null,
        message: "The usage window has reset. Waiting for an update.",
      };
    const checkedAt = Date.parse(reported.checkedAt ?? limits.checkedAt);
    const failedAt = limits.refreshError ? Date.parse(limits.refreshError.checkedAt) : NaN;
    const lastKnown =
      !Number.isFinite(checkedAt) ||
      nowMs - checkedAt >= USAGE_STALE_AFTER_MS ||
      (Number.isFinite(failedAt) && failedAt >= checkedAt);
    return {
      id: kind,
      label,
      window: reported,
      message: lastKnown
        ? Number.isFinite(failedAt) && failedAt >= checkedAt
          ? "Last known usage. The latest refresh failed."
          : "Last known usage. Refresh to check the current allowance."
        : null,
    };
  });
  const dominant = windows.reduce<ComposerUsageWindow | null>((current, entry) => {
    if (!entry.window) return current;
    if (
      !current?.window ||
      entry.window.usedPercent > current.window.usedPercent ||
      (entry.window.usedPercent === current.window.usedPercent && entry.id === "weekly")
    )
      return entry;
    return current;
  }, null);
  return {
    profile,
    window: dominant?.window ?? null,
    label: dominant?.label ?? null,
    message: dominant
      ? null
      : (windows.find((entry) => entry.message?.includes("has reset"))?.message ??
        "No account usage window has been reported yet."),
    windows,
  };
}

export function formatComposerUsagePercent(percent: number): string {
  return `${Number(percent.toFixed(1))}%`;
}

/** A missing window is unknown, never an implicit zero or a full allowance. */
export function formatComposerUsageSummary(
  usage: NonNullable<ReturnType<typeof selectComposerUsage>>,
): string {
  const windows =
    usage.windows.length > 0
      ? usage.windows
      : [
          { id: "session", window: null },
          { id: "weekly", window: null },
        ];
  const summary = windows
    .map((entry) => {
      const label =
        entry.id === "weekly" ? "Weekly" : entry.id === "monthly" ? "Monthly" : "Session";
      return `${label} ${entry.window ? formatComposerUsagePercent(entry.window.usedPercent) : "—"}`;
    })
    .join(" · ");
  return usage.windows.some((entry) => entry.window && entry.message)
    ? `Last known · ${summary}`
    : summary;
}

/** Focus/re-entry may refresh an old snapshot; the existing background scheduler owns polling. */
export function composerUsageNeedsRefresh(provider: ServerProvider | null, nowMs: number): boolean {
  if (
    !provider?.enabled ||
    provider.apiBackend === "openrouter" ||
    !provider.installed ||
    provider.auth.status !== "authenticated" ||
    provider.auth.type === "apiKey" ||
    provider.availability === "unavailable" ||
    (provider.driver !== "claudeAgent" && provider.driver !== "codex")
  )
    return false;
  if (provider.usageLimits?.unavailable?.reason === "unsupported") return false;
  if (
    !provider.usageLimits ||
    provider.usageLimits.unavailable ||
    provider.usageLimits.refreshError
  )
    return true;
  return (
    provider.usageLimits.windows.length === 0 ||
    provider.usageLimits.windows.some((window) => {
      const checkedAt = Date.parse(window.checkedAt ?? provider.usageLimits!.checkedAt);
      return (
        !Number.isFinite(checkedAt) ||
        nowMs - checkedAt >= 5 * 60_000 ||
        (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= nowMs)
      );
    })
  );
}
