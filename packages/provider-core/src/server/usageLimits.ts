import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@starkfuture/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it. An
 * update with no windows leaves `previous` untouched.
 *
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const observedAt = Date.parse(input.checkedAt);
  if (!Number.isFinite(observedAt)) return previous;
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Publish their fresh observation at most
  // once a minute; otherwise a genuinely current zero becomes falsely stale.
  let changed = false;
  for (const window of update.windows) {
    // Malformed provider values are unknown, never a fabricated zero.
    if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0) continue;
    const existing = merged.get(window.id);
    const previousObservation = existing?.checkedAt ?? previous?.checkedAt;
    const previousObservedAt = previousObservation ? Date.parse(previousObservation) : NaN;
    if (Number.isFinite(previousObservedAt) && observedAt < previousObservedAt) continue;
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      checkedAt: input.checkedAt,
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (
      existing === undefined ||
      !usageWindowEquals(existing, next) ||
      !Number.isFinite(previousObservedAt) ||
      observedAt - previousObservedAt >= 60_000
    ) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed) {
    return previous;
  }
  return {
    ...makeUsageLimits({
      checkedAt: input.checkedAt,
      windows: Array.from(merged.values(), (window) =>
        window.checkedAt || !previous ? window : { ...window, checkedAt: previous.checkedAt },
      ),
    }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(previous?.credentialFingerprint !== undefined
      ? { credentialFingerprint: previous.credentialFingerprint }
      : {}),
    ...(previous?.refreshError !== undefined ? { refreshError: previous.refreshError } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/**
 * Choose what to publish after a status probe finishes. A probe that failed
 * this time must not wipe bars a previous probe or a turn already
 * established, so the last good snapshot stays; `unsupported` is
 * authoritative and replaces them.
 *
 * A cached probe must not overwrite newer turn observations. Full reads
 * still remove absent older windows; only a demonstrably newer window wins.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return {
      ...published,
      refreshError: {
        checkedAt: probed.checkedAt,
        ...(probed.unavailable.message ? { message: probed.unavailable.message } : {}),
      },
    };
  }
  if (probed && published && !probed.unavailable && !published.unavailable) {
    const probeTime = Date.parse(probed.checkedAt);
    const newer = published.windows.filter(
      (window) => Date.parse(window.checkedAt ?? published.checkedAt) > probeTime,
    );
    if (newer.length > 0) {
      const windows = new Map(
        probed.windows.map((window) => [
          window.id,
          {
            ...window,
            checkedAt: window.checkedAt ?? probed.checkedAt,
          },
        ]),
      );
      for (const window of newer)
        windows.set(window.id, {
          ...window,
          checkedAt: window.checkedAt ?? published.checkedAt,
        });
      return {
        ...probed,
        checkedAt:
          Date.parse(published.checkedAt) > probeTime ? published.checkedAt : probed.checkedAt,
        windows: sortWindows(windows.values()),
      };
    }
  }
  return probed;
}
