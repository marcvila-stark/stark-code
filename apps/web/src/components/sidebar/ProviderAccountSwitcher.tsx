import { CheckIcon, ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { getDefaultProviderInstanceModel } from "../../providerInstances";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { usePrimarySettings } from "../../hooks/useSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { selectComposerUsage } from "../chat/ComposerUsageRing.logic";
import { providerClients } from "../settings/providerDriverMeta";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { SidebarAccountContext } from "./sidebarAccountContext";
import { AccountUsageSummary } from "./AccountUsageSummary";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";

function AccountUsage({ entry, connected }: { entry: ProviderInstanceEntry; connected: boolean }) {
  const minute = useNowMinute();
  const now = Date.parse(`${minute}:00Z`);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const usage = selectComposerUsage(entry.snapshot, connected, now);
  if (entry.snapshot.apiBackend === "openrouter") {
    return <span className="block text-xs text-muted-foreground">Billed through OpenRouter</span>;
  }
  if (!usage || usage.windows.length === 0) {
    return (
      <span className="block text-xs text-muted-foreground">
        {usage?.message ?? "Usage not reported."}
      </span>
    );
  }
  return (
    <AccountUsageSummary
      items={usage.windows.map((item) => ({
        id: item.id,
        label: item.label,
        percent: item.window?.usedPercent ?? null,
        detail: item.window?.resetsAt
          ? `Resets ${formatUpcomingTimestamp(item.window.resetsAt, timestampFormat, now)}`
          : (item.message ?? "Reset time not reported."),
      }))}
    />
  );
}

/** Configured accounts belong to this chat's computer; selecting one uses the normal model path. */
export function ProviderAccountSwitcher({
  context,
  selected,
  environmentLabel,
  connected,
  onManage,
  onUsage,
  trigger,
  popupSide = "top",
}: {
  context: SidebarAccountContext;
  selected: ProviderInstanceEntry;
  environmentLabel: string;
  connected: boolean;
  onManage: () => void;
  onUsage?: () => void;
  trigger?: React.ReactElement<React.ComponentProps<"button">> | undefined;
  popupSide?: "top" | "right" | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const canRefresh = useAtomValue(
    serverEnvironment.refreshProviders.permissionAtom(context.environmentId),
  );
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const label =
    selected.snapshot.apiBackend === "openrouter"
      ? "OpenRouter"
      : (providerClients.get(selected.driverKind)?.label ?? selected.displayName);
  const accounts = context.entries.filter(
    (entry) =>
      entry.driverKind === selected.driverKind &&
      entry.snapshot.apiBackend === selected.snapshot.apiBackend,
  );
  const lastRefreshAt = useRef<number | null>(null);
  const inFlight = useRef(false);
  const refreshAccounts = async (force = false) => {
    if (!canRefresh || !connected || inFlight.current) return;
    if (!force && lastRefreshAt.current !== null && Date.now() - lastRefreshAt.current < 60_000)
      return;
    inFlight.current = true;
    lastRefreshAt.current = Date.now();
    setRefreshing(true);
    setRefreshError(null);
    try {
      const result = await refresh({ environmentId: context.environmentId, input: {} });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : "Could not refresh usage.");
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void refreshAccounts();
      }}
    >
      <PopoverTrigger
        render={
          trigger ?? (
            <button
              type="button"
              className="stark-sidebar-account-trigger"
              aria-label={`${label} accounts`}
            />
          )
        }
      >
        {trigger ? (
          trigger.props.children
        ) : (
          <>
            <span className="stark-sidebar-account-avatar">
              <ProviderInstanceIcon
                driverKind={selected.driverKind}
                apiBackend={selected.snapshot.apiBackend}
                displayName={selected.displayName}
              />
            </span>
            <span className="stark-sidebar-account-identity">
              <span>{selected.displayName}</span>
              <span>{selected.snapshot.auth.email ?? label}</span>
            </span>
            <ChevronDownIcon className="stark-sidebar-account-chevron" />
          </>
        )}
      </PopoverTrigger>
      <PopoverPopup
        side={popupSide}
        align={popupSide === "right" ? "end" : "start"}
        width="account"
        variant="account"
        padding="none"
        aria-label={`${label} accounts`}
      >
        <div className="stark-account-menu-content">
          <div>
            <div className="stark-account-menu-heading">
              <h3>
                <ProviderInstanceIcon
                  driverKind={selected.driverKind}
                  apiBackend={selected.snapshot.apiBackend}
                  displayName={label}
                />
                {label} accounts
              </h3>
              <button
                type="button"
                disabled={!canRefresh || !connected || refreshing}
                onClick={() => void refreshAccounts(true)}
              >
                <RefreshCwIcon aria-hidden />
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            <p className="stark-account-menu-group">
              On {environmentLabel}
              {connected ? "" : " · Disconnected"}
            </p>
          </div>
          {refreshError ? (
            <p role="alert" className="text-xs text-destructive">
              {refreshError}
            </p>
          ) : null}
          <ul
            className="max-h-[min(28rem,60vh)] overflow-y-auto"
            aria-label={`Configured ${label} accounts`}
          >
            {accounts.map((entry) => {
              const model = getDefaultProviderInstanceModel(
                context.entries.map((item) => item.snapshot),
                entry.instanceId,
              );
              const reason = !connected
                ? `Waiting for ${environmentLabel} to connect.`
                : (context.unavailableReason ??
                  (!entry.enabled || !entry.isAvailable || !entry.installed
                    ? "This account is unavailable."
                    : entry.snapshot.auth.status !== "authenticated"
                      ? "Sign in in Manage accounts."
                      : model
                        ? context.getModelDisabledReason(entry.instanceId, model)
                        : "No model is available."));
              const current = entry.instanceId === selected.instanceId;
              return (
                <li key={entry.instanceId}>
                  <button
                    type="button"
                    aria-pressed={current}
                    disabled={current || reason !== null}
                    data-account-option
                    className="stark-account-option stark-account-option-provider"
                    onClick={() => {
                      if (!reason && model) {
                        context.onSelect(entry.instanceId, model);
                        setOpen(false);
                      }
                    }}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="stark-account-option-name">{entry.displayName}</span>
                      {current ? (
                        <CheckIcon
                          className="size-4 shrink-0 text-(--sr-gold)"
                          aria-label="Selected account"
                        />
                      ) : null}
                    </span>
                    {entry.snapshot.auth.email &&
                    entry.snapshot.auth.email !== entry.displayName ? (
                      <span className="block break-all text-xs text-muted-foreground">
                        {entry.snapshot.auth.email}
                      </span>
                    ) : null}
                    <AccountUsage entry={entry} connected={connected} />
                    {!current && reason ? (
                      <span className="mt-1 block text-xs text-muted-foreground">{reason}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {context.unavailableReason ? (
            <p className="text-xs text-muted-foreground">{context.unavailableReason}</p>
          ) : null}
          <div className="stark-account-menu-footer">
            {onUsage && selected.snapshot.apiBackend !== "openrouter" ? (
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
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              Manage accounts
            </button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
