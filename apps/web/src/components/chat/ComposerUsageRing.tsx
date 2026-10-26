import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerProvider } from "@starkfuture/contracts";
import type { TimestampFormat } from "@starkfuture/contracts/settings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatShortTimestamp } from "../../timestampFormat";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  formatComposerUsagePercent,
  formatComposerUsageSummary,
  selectComposerUsage,
  composerUsageNeedsRefresh,
} from "./ComposerUsageRing.logic";

const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });

export function ComposerUsageRing({
  provider,
  connected,
  size = "sm",
  timestampFormat = "locale",
  compact = false,
  onRefresh,
}: {
  provider: ServerProvider | null;
  connected: boolean;
  size?: ComposerControlSize;
  timestampFormat?: TimestampFormat;
  compact?: boolean;
  onRefresh?: () => Promise<void>;
}) {
  const nowMinute = useNowMinute();
  const usage = selectComposerUsage(provider, connected, Date.parse(`${nowMinute}:00Z`));
  const [open, setOpen] = useState(false);
  const scope = JSON.stringify([
    provider?.instanceId,
    provider?.auth.email,
    provider?.auth.workspaceId,
    provider?.usageLimits?.credentialFingerprint,
  ]);
  const requestRef = useRef<{ scope: string; requestedAt: number; pending: boolean } | null>(null);
  const [refreshState, setRefreshState] = useState<{
    scope: string;
    busy: boolean;
    failed: boolean;
  } | null>(null);
  const canRefresh =
    connected &&
    onRefresh &&
    provider?.enabled &&
    provider.apiBackend !== "openrouter" &&
    provider.installed &&
    provider.auth.status === "authenticated" &&
    provider.auth.type !== "apiKey" &&
    provider.availability !== "unavailable" &&
    provider.usageLimits?.unavailable?.reason !== "unsupported";
  const refresh = useCallback(
    async (explicit: boolean) => {
      if (!canRefresh || !onRefresh || document.visibilityState === "hidden") return;
      const current = requestRef.current;
      const now = Date.now();
      if (
        current?.scope === scope &&
        (current.pending || (!explicit && now - current.requestedAt < 60_000))
      )
        return;
      if (!explicit && !composerUsageNeedsRefresh(provider, now)) return;
      const request = { scope, requestedAt: now, pending: true };
      requestRef.current = request;
      setRefreshState({ scope, busy: true, failed: false });
      try {
        await onRefresh();
        if (requestRef.current === request) setRefreshState({ scope, busy: false, failed: false });
      } catch {
        if (requestRef.current === request) setRefreshState({ scope, busy: false, failed: true });
      } finally {
        request.pending = false;
      }
    },
    [canRefresh, onRefresh, provider, scope],
  );
  useEffect(() => {
    // Re-entry/focus refreshes only the selected profile. No extra polling,
    // healthy MCP reload or model request is involved.
    const refreshOnFocus = () => {
      void refresh(false);
    };
    refreshOnFocus();
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [refresh]);
  if (!usage) return null;
  const busy = refreshState?.scope === scope && refreshState.busy;
  const refreshFailed = refreshState?.scope === scope && refreshState.failed;
  const lastKnown = usage.windows.some((entry) => entry.window && entry.message);
  const percent = usage.window?.usedPercent;
  const title =
    usage.windows.length > 0
      ? usage.windows
          .map((entry) =>
            entry.window
              ? `${entry.label}: ${formatComposerUsagePercent(entry.window.usedPercent)} used${entry.message ? " (last known)" : ""}`
              : `${entry.label}: unavailable`,
          )
          .join(". ")
      : "Subscription usage unavailable";
  const details = (
    <div className="space-y-3 text-sm">
      {usage.windows.length > 0 ? (
        usage.windows.map((entry) => {
          const reset = entry.window?.resetsAt;
          const checkedAt = entry.window?.checkedAt ?? provider?.usageLimits?.checkedAt;
          return (
            <div key={entry.id} className="space-y-1">
              <p>
                {entry.label}:{" "}
                {entry.window
                  ? `${formatComposerUsagePercent(entry.window.usedPercent)} used`
                  : "Not reported"}
              </p>
              {entry.window ? (
                <p className="text-muted-foreground">
                  {reset && Number.isFinite(Date.parse(reset)) ? (
                    <>
                      Resets {weekdayFormatter.format(new Date(reset))}{" "}
                      {formatShortTimestamp(reset, timestampFormat)}
                    </>
                  ) : (
                    "Reset time not reported."
                  )}
                </p>
              ) : entry.message !== "Not reported." ? (
                <p className="text-muted-foreground">{entry.message}</p>
              ) : null}
              {entry.window && entry.message ? (
                <p className="text-muted-foreground">{entry.message}</p>
              ) : null}
              {entry.window && checkedAt && Number.isFinite(Date.parse(checkedAt)) ? (
                <p className="text-xs text-muted-foreground">
                  Updated {new Date(checkedAt).toLocaleDateString()}{" "}
                  {formatShortTimestamp(checkedAt, timestampFormat)}
                </p>
              ) : null}
            </div>
          );
        })
      ) : (
        <>
          <p>{title}</p>
          {usage.message ? <p className="text-muted-foreground">{usage.message}</p> : null}
        </>
      )}
      <p className="text-xs text-muted-foreground">Selected profile: {usage.profile}</p>
    </div>
  );
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const color = lastKnown
    ? "var(--color-muted-foreground)"
    : percent !== undefined && percent >= 95
      ? "var(--color-error)"
      : percent !== undefined && percent >= 80
        ? "var(--color-warning)"
        : "var(--color-primary)";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size={size}
                  data-composer-usage-ring="true"
                  className="min-w-0 max-w-full"
                  aria-label={`${title}. Selected profile: ${usage.profile}`}
                />
              }
            />
          }
        >
          <span className="relative flex size-5 items-center justify-center">
            <svg className="size-5 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
              <circle
                cx="10"
                cy="10"
                r={radius}
                fill="none"
                strokeWidth="2.5"
                className="stroke-muted-foreground/30"
              />
              {percent !== undefined && percent > 0 ? (
                <circle
                  cx="10"
                  cy="10"
                  r={radius}
                  fill="none"
                  stroke={color}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - percent / 100)}
                />
              ) : null}
            </svg>
            {percent === undefined ? (
              <span aria-hidden="true" className="absolute text-xs text-muted-foreground">
                –
              </span>
            ) : null}
          </span>
          {!compact ? (
            <span
              className="min-w-0 whitespace-normal text-start text-xs tabular-nums"
              data-composer-usage-summary
            >
              {formatComposerUsageSummary(usage)}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup {...composerFloatingLayerProps} side="top" align="end">
          {details}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...composerFloatingLayerProps}
        width="sm"
        padding="compact"
        side="top"
        align="end"
        aria-label="Subscription usage"
      >
        {details}
        {onRefresh && canRefresh ? (
          <div className="mt-3 space-y-2">
            <Button
              size="compact"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void refresh(true);
              }}
            >
              {busy ? "Refreshing…" : "Refresh usage"}
            </Button>
            {refreshFailed ? (
              <p role="status" className="text-xs text-muted-foreground">
                Could not refresh usage. Any last known figures are unchanged.
              </p>
            ) : null}
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
