import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import type { ClaudeAccount, ClaudeAccountsSnapshot, EnvironmentId } from "@starkfuture/contracts";
import { CheckIcon, ChevronDownIcon, InfoIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { claudeAccountsEnvironment } from "../../state/claudeAccounts";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ClaudeAI } from "../Icons";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AccountUsageSummary } from "./AccountUsageSummary";

interface ClaudeOrganizationSwitcherProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly isConnected: boolean;
  readonly onManage: () => void;
  readonly onUsage?: () => void;
}

function organizationLabel(account: ClaudeAccount) {
  return (
    account.organizationName ||
    account.alias ||
    account.organizationUuid ||
    `Organization ${account.number}`
  );
}

function usageUnavailable(account: ClaudeAccount) {
  if (account.usageStatus === "relogin_required") return "Sign in again to see usage.";
  if (account.usageStatus !== "ok") return "Usage could not be refreshed.";
  if (
    account.usageAgeSeconds === null ||
    !Number.isFinite(account.usageAgeSeconds) ||
    account.windows.length === 0
  )
    return "Usage not reported.";
  return null;
}

/** A saved organization changes the machine's shared login, not one conversation. */
export function ClaudeOrganizationSwitcher(props: ClaudeOrganizationSwitcherProps) {
  return <ClaudeOrganizationSwitcherContent key={props.environmentId} {...props} />;
}

function ClaudeOrganizationSwitcherContent({
  environmentId,
  environmentLabel,
  isConnected,
  onManage,
  onUsage,
}: ClaudeOrganizationSwitcherProps) {
  const canRead = useAtomValue(claudeAccountsEnvironment.snapshot.permissionAtom(environmentId));
  const canWrite = useAtomValue(claudeAccountsEnvironment.command.permissionAtom(environmentId));
  const readSnapshot = useAtomCommand(claudeAccountsEnvironment.snapshot, { reportFailure: false });
  const sendCommand = useAtomCommand(claudeAccountsEnvironment.command, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ClaudeAccountsSnapshot | null>(null);
  const [snapshotReceivedAt, setSnapshotReceivedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLoginDetails, setShowLoginDetails] = useState(false);
  const loginDetailsId = useId();
  const minute = useNowMinute();
  const now = Date.parse(`${minute}:00Z`);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const lastSuccessfulRefreshAt = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function refresh() {
    if (!canRead || !isConnected || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await readSnapshot({ environmentId, input: undefined });
      if (!mounted.current) return;
      if (result._tag === "Success") {
        lastSuccessfulRefreshAt.current = Date.now();
        setSnapshot(result.value);
        setSnapshotReceivedAt(Date.now());
        setError(null);
      } else throw squashAtomCommandFailure(result);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not load Claude organizations.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const refreshVisible = useEffectEvent(() => {
    const stale =
      lastSuccessfulRefreshAt.current === null ||
      Date.now() - lastSuccessfulRefreshAt.current >= 60_000;
    if (document.visibilityState === "visible" && (stale || error !== null)) void refresh();
  });
  // The footer is identity, not a generic account launcher: load it before the menu opens.
  useEffect(() => {
    if (!isConnected) {
      lastSuccessfulRefreshAt.current = null;
      return;
    }
    if (!canRead) return;
    refreshVisible();
    document.addEventListener("visibilitychange", refreshVisible);
    return () => document.removeEventListener("visibilitychange", refreshVisible);
  }, [canRead, isConnected]);
  useEffect(() => {
    if (!open || !canRead || !isConnected) return;
    refreshVisible();
    const timer = window.setInterval(refreshVisible, 60_000);
    return () => window.clearInterval(timer);
  }, [open, canRead, isConnected]);

  async function switchOrganization(account: ClaudeAccount) {
    if (
      !canRead ||
      !canWrite ||
      !isConnected ||
      inFlight.current ||
      !snapshot?.available ||
      account.active
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setSwitching(account.number);
    setError(null);
    setNotice(null);
    try {
      const result = await sendCommand({
        environmentId,
        input: {
          action: "switch",
          accountNumber: account.number,
          expectedEmail: account.email,
          expectedOrganizationUuid: account.organizationUuid,
        },
      });
      if (!mounted.current) return;
      if (result._tag === "Success") {
        setSnapshot(result.value);
        setSnapshotReceivedAt(now);
        const current = result.value.accounts.find((candidate) => candidate.active);
        setNotice(
          current
            ? `Active organization: ${organizationLabel(current)}.`
            : "The active organization could not be confirmed. Refresh to check.",
        );
      } else throw squashAtomCommandFailure(result);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Could not switch Claude organizations.");
        // A switch can finish before a later usage read fails. Reconcile once without replaying it.
        try {
          const latest = await readSnapshot({ environmentId, input: undefined });
          if (mounted.current && latest._tag === "Success") {
            setSnapshot(latest.value);
            setSnapshotReceivedAt(now);
          }
        } catch {
          /* Keep the last known snapshot and the original action failure. */
        }
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        setSwitching(null);
      }
    }
  }

  const visibleSnapshot = canRead ? snapshot : null;
  const active = visibleSnapshot?.accounts.find((account) => account.active);
  const groups = new Map<string, ClaudeAccount[]>();
  for (const account of visibleSnapshot?.accounts ?? []) {
    const group = groups.get(account.email) ?? [];
    group.push(account);
    groups.set(account.email, group);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="stark-sidebar-account-trigger"
            aria-label="Switch Claude organization"
          />
        }
      >
        <span className="stark-sidebar-account-avatar stark-sidebar-account-avatar-claude">
          <ClaudeAI />
        </span>
        <span className="stark-sidebar-account-identity">
          <span>{active?.email ?? "Claude organizations"}</span>
          <span>{active ? organizationLabel(active) : environmentLabel}</span>
        </span>
        <ChevronDownIcon className="stark-sidebar-account-chevron" />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        width="account"
        variant="account"
        padding="none"
        aria-label="Claude organizations"
      >
        <div className="stark-account-menu-content max-h-[min(36rem,75vh)] overflow-y-auto">
          <div className="stark-account-menu-heading">
            <h3>
              <ClaudeAI className="size-4" />
              Claude organizations
            </h3>
            <button
              type="button"
              disabled={!canRead || !isConnected || busy}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon aria-hidden />
              {busy && switching === null ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {!isConnected ? (
            <p role="status" className="text-xs text-muted-foreground">
              Waiting for {environmentLabel} to connect.
            </p>
          ) : null}
          {!canRead ? (
            <p className="text-xs text-muted-foreground">
              Provider management permission is needed to view organizations.
            </p>
          ) : null}
          {canRead && !canWrite ? (
            <p className="text-xs text-muted-foreground">
              Provider management permission is needed to switch organizations.
            </p>
          ) : null}
          {canRead && error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {canRead && (switching !== null || notice) ? (
            <p role="status" className="text-xs">
              {switching !== null ? "Switching organization…" : notice}
            </p>
          ) : null}
          {canRead && !snapshot && busy ? (
            <p role="status" className="text-xs">
              Loading saved organizations…
            </p>
          ) : null}
          {visibleSnapshot && !visibleSnapshot.available ? (
            <p className="text-xs text-muted-foreground">
              Organization switching needs claude-swap on {environmentLabel}. Open Manage
              organizations for setup.
            </p>
          ) : visibleSnapshot && visibleSnapshot.accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No organizations saved yet. Add them in Manage organizations.
            </p>
          ) : (
            [...groups].map(([email, accounts]) => (
              <section key={email} aria-label={email}>
                <p className="stark-account-menu-group">{email}</p>
                <ul aria-label={`Saved organizations for ${email}`}>
                  {accounts.map((account) => {
                    const label = organizationLabel(account);
                    const duplicateLabel = accounts.some(
                      (other) =>
                        other.number !== account.number && organizationLabel(other) === label,
                    );
                    const unavailable = !isConnected
                      ? "Reconnect to see current usage."
                      : error
                        ? "Usage could not be refreshed."
                        : usageUnavailable(account);
                    const usageAge =
                      account.usageAgeSeconds === null
                        ? null
                        : account.usageAgeSeconds +
                          Math.max(0, (now - (snapshotReceivedAt ?? now)) / 1000);
                    return (
                      <li key={`${account.number}:${account.organizationUuid ?? ""}`}>
                        <button
                          type="button"
                          aria-pressed={account.active}
                          disabled={!canWrite || !isConnected || busy || account.active}
                          data-account-option
                          className="stark-account-option"
                          onClick={() => void switchOrganization(account)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="stark-account-option-name">{label}</span>
                            {duplicateLabel ? (
                              <span className="block break-all text-xs text-muted-foreground">
                                {account.organizationUuid ?? `Saved login ${account.number}`}
                              </span>
                            ) : null}
                            {unavailable ? (
                              <span className="block text-xs text-muted-foreground">
                                {unavailable}
                              </span>
                            ) : (
                              <span className="block text-xs text-(--sr-muted)">
                                <AccountUsageSummary
                                  items={account.windows.map((window) => {
                                    const resetAt = window.resetsAt
                                      ? Date.parse(window.resetsAt)
                                      : NaN;
                                    const hasReset = Number.isFinite(resetAt) && resetAt <= now;
                                    return {
                                      id: window.name,
                                      label: window.name,
                                      percent:
                                        hasReset || !Number.isFinite(window.percent)
                                          ? null
                                          : window.percent,
                                      detail: hasReset
                                        ? "This window has reset; refresh to check current usage."
                                        : window.resetsAt && Number.isFinite(resetAt)
                                          ? `Resets ${formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}`
                                          : "Reset time not reported.",
                                    };
                                  })}
                                />
                                {usageAge !== null && usageAge > 120 ? (
                                  <span className="mt-1 block text-2xs">
                                    Out of date · checked {Math.floor(usageAge / 60)} min ago
                                  </span>
                                ) : null}
                              </span>
                            )}
                          </span>
                          {account.active ? (
                            <CheckIcon
                              aria-label="Active organization"
                              className="size-4 shrink-0 text-(--sr-gold)"
                            />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
          <div className="stark-account-menu-footer">
            {onUsage ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onUsage();
                }}
              >
                Usage &amp; limits
              </button>
            ) : null}
            <div className="stark-account-menu-manage">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
              >
                Manage organizations
              </button>
              <button
                type="button"
                className="stark-account-menu-help"
                aria-label="About Claude organizations"
                aria-expanded={showLoginDetails}
                aria-controls={loginDetailsId}
                onClick={() => setShowLoginDetails((value) => !value)}
              >
                <InfoIcon aria-hidden />
              </button>
            </div>
            <div id={loginDetailsId} hidden={!showLoginDetails}>
              <p>
                Shared Claude login on {environmentLabel}. Running sessions may need restarting to
                use the new organization.
              </p>
              {visibleSnapshot?.notice ? <p>{visibleSnapshot.notice}</p> : null}
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
