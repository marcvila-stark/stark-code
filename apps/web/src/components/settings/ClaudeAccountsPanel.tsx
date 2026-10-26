import { useAtomValue } from "@effect/atom-react";
import type {
  ClaudeAccount,
  ClaudeAccountsCommand,
  ClaudeAccountsSnapshot,
  EnvironmentId,
} from "@starkfuture/contracts";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { claudeAccountsEnvironment } from "../../state/claudeAccounts";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";

interface ClaudeAccountsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly readOnly?: boolean;
}

function accountLabel(account: ClaudeAccount) {
  return (
    account.organizationName ||
    account.alias ||
    account.organizationUuid ||
    `Organization ${account.number}`
  );
}

function usageAge(seconds: number | null) {
  if (seconds === null) return "Usage freshness unknown";
  if (seconds < 60) return "Checked just now";
  if (seconds < 3600) return `Checked ${Math.floor(seconds / 60)} min ago`;
  return `Checked ${Math.floor(seconds / 3600)} hr ago`;
}

function resetTime(value: string | null) {
  if (value === null) return "Reset time unavailable";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `Resets ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "Reset time unavailable";
}

/** Account state belongs to a machine, so changing environments discards pending UI work. */
export function ClaudeAccountsPanel(props: ClaudeAccountsPanelProps) {
  return <ClaudeAccountsPanelContent key={props.environmentId} {...props} />;
}

function ClaudeAccountsPanelContent({
  environmentId,
  environmentLabel,
  readOnly = false,
}: ClaudeAccountsPanelProps) {
  const canRead = useAtomValue(claudeAccountsEnvironment.snapshot.permissionAtom(environmentId));
  const canWrite = useAtomValue(claudeAccountsEnvironment.command.permissionAtom(environmentId));
  const canManage = canWrite && !readOnly;
  const readSnapshot = useAtomCommand(claudeAccountsEnvironment.snapshot, { reportFailure: false });
  const sendCommand = useAtomCommand(claudeAccountsEnvironment.command, { reportFailure: false });
  const [snapshot, setSnapshot] = useState<ClaudeAccountsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ClaudeAccountsCommand | null>(null);
  const [confirmationClosing, setConfirmationClosing] = useState(false);
  function requestConfirmation(command: ClaudeAccountsCommand) {
    setConfirmation(command);
    setConfirmationClosing(false);
  }
  const inFlight = useRef(false);
  const mounted = useRef(false);

  async function refresh() {
    if (!canRead || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await readSnapshot({ environmentId, input: undefined });
      if (!mounted.current) return;
      if (result._tag === "Success") {
        setSnapshot(result.value);
        setError(null);
      } else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not load Claude organizations.");
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const refreshVisible = useEffectEvent(() => {
    if (document.visibilityState === "visible") void refresh();
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setInterval(refreshVisible, 60_000);
    return () => window.clearInterval(timer);
  }, [loaded]);

  async function mutate(command: ClaudeAccountsCommand) {
    if (!canManage || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setConfirmationClosing(true);
    try {
      const result = await sendCommand({ environmentId, input: command });
      if (!mounted.current) return;
      if (result._tag === "Success") {
        setSnapshot(result.value);
        if (command.action === "automatic") setThresholdDraft(null);
      } else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not update Claude organizations.");
        // A process may have stopped or the login may have changed before a later
        // persistence/usage check failed. Reconcile without repeating the action.
        const latest = await readSnapshot({ environmentId, input: undefined });
        if (mounted.current && latest._tag === "Success") setSnapshot(latest.value);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const threshold = Number(thresholdDraft ?? snapshot?.automatic.threshold ?? 90);
  const validThreshold = Number.isInteger(threshold) && threshold >= 50 && threshold <= 99;
  const eligibleCount =
    snapshot?.accounts.filter((account) => !account.disabled && account.usageStatus !== "api_key")
      .length ?? 0;
  const controlsDisabled = !canManage || busy || !snapshot?.available;
  const switchingAccount =
    confirmation?.action === "switch"
      ? snapshot?.accounts.find(
          (account) =>
            account.number === confirmation.accountNumber &&
            account.email === confirmation.expectedEmail &&
            account.organizationUuid === confirmation.expectedOrganizationUuid,
        )
      : null;
  const isSwitchConfirmation = confirmation?.action === "switch";
  const staleConfirmation = isSwitchConfirmation && !switchingAccount;

  return (
    <SettingsSection
      {...searchableSetting("claude-organizations")}
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!canRead || busy}
          onClick={() => {
            setLoaded(true);
            void refresh();
          }}
        >
          {busy ? "Updating…" : snapshot ? "Refresh" : "Load organizations"}
        </Button>
      }
    >
      <div className="space-y-4 p-3 sm:p-4">
        <p className="text-sm text-muted-foreground">
          The shared Claude login on {environmentLabel}. Organizations with the same email are saved
          separately. Custom Claude profiles with their own login are unaffected.
        </p>
        {!canRead ? (
          <p className="text-sm text-muted-foreground">
            Provider management permission is needed to view these logins.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {canRead && !snapshot && !error ? (
          <p role="status" className="text-sm">
            {busy
              ? "Loading organizations…"
              : "Load saved logins and usage from claude-swap. macOS may ask for Keychain access."}
          </p>
        ) : null}
        {canRead && snapshot ? (
          <>
            {snapshot.notice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {snapshot.notice}
              </p>
            ) : null}
            {!snapshot.available ? (
              <div className="space-y-2 text-sm">
                <p>
                  Install claude-swap 0.25 or newer in Terminal on {environmentLabel}, then refresh.
                </p>
                <code className="block overflow-x-auto rounded-md bg-muted p-3 text-xs">
                  uv tool install claude-swap
                </code>
                <p className="text-xs text-muted-foreground">
                  Requires uv. This app never runs the installation command for you.
                </p>
                {snapshot.automatic.enabled ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canManage || busy}
                    onClick={() =>
                      void mutate({
                        action: "automatic",
                        enabled: false,
                        threshold: snapshot.automatic.threshold,
                      })
                    }
                  >
                    Stop automatic switching
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                {snapshot.accounts.length === 0 ? (
                  <p className="text-sm">No organizations saved yet.</p>
                ) : (
                  <ul className="space-y-3" aria-label="Saved Claude organizations">
                    {snapshot.accounts.map((account) => (
                      <li
                        key={account.number}
                        className="space-y-3 rounded-lg border border-border/60 p-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 space-y-1">
                            <p className="break-words text-sm font-medium">
                              {accountLabel(account)}
                              {account.active ? (
                                <span className="ml-2 text-xs text-primary">
                                  Active shared login
                                </span>
                              ) : null}
                            </p>
                            <p className="break-all text-xs text-muted-foreground">
                              {account.email}
                            </p>
                            <p className="break-all text-xs text-muted-foreground">
                              {account.organizationUuid
                                ? `Organization ID: ${account.organizationUuid}`
                                : "Organization ID unavailable"}
                            </p>
                          </div>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={controlsDisabled || account.active}
                            onClick={() =>
                              requestConfirmation({
                                action: "switch",
                                accountNumber: account.number,
                                expectedEmail: account.email,
                                expectedOrganizationUuid: account.organizationUuid,
                              })
                            }
                          >
                            Switch
                          </Button>
                        </div>
                        {account.usageStatus === "ok" && account.windows.length > 0 ? (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {account.windows.map((window) => (
                              <div key={window.name} className="min-w-0 text-xs">
                                <div className="flex justify-between gap-2">
                                  <span>{window.name}</span>
                                  <span className="tabular-nums">
                                    {Math.round(window.percent)}% used
                                  </span>
                                </div>
                                <progress
                                  className="my-1 block h-1.5 w-full accent-primary"
                                  max={100}
                                  value={Math.max(0, Math.min(100, window.percent))}
                                  aria-label={`${accountLabel(account)} ${window.name} usage`}
                                />
                                <p className="text-muted-foreground">
                                  {resetTime(window.resetsAt)}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">Usage unavailable.</p>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>
                            {account.usageStatus.replaceAll("_", " ")} ·{" "}
                            {usageAge(account.usageAgeSeconds)}
                          </span>
                          <label className="flex items-center gap-2">
                            Include in auto-switching
                            <Switch
                              size="sm"
                              aria-label={`Include ${accountLabel(account)} in auto-switching`}
                              checked={!account.disabled && account.usageStatus !== "api_key"}
                              disabled={controlsDisabled || account.usageStatus === "api_key"}
                              onCheckedChange={(eligible) =>
                                void mutate({
                                  action: "setEligible",
                                  accountNumber: account.number,
                                  expectedEmail: account.email,
                                  expectedOrganizationUuid: account.organizationUuid,
                                  eligible,
                                })
                              }
                            />
                          </label>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    To add an organization, run <code>/login</code> in your normal Claude terminal
                    and choose it, then save that login here. Repeat for each organization. Saving
                    does not sign you in.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={controlsDisabled}
                    onClick={() => void mutate({ action: "capture" })}
                  >
                    Save current login
                  </Button>
                </div>
                <div className="space-y-3 border-t border-border/60 pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">Automatic switching</p>
                    <Switch
                      aria-label="Automatic Claude organization switching"
                      checked={snapshot.automatic.enabled}
                      disabled={
                        controlsDisabled ||
                        (!snapshot.automatic.enabled && (eligibleCount < 2 || !validThreshold))
                      }
                      onCheckedChange={(enabled) => {
                        if (enabled)
                          requestConfirmation({ action: "automatic", enabled: true, threshold });
                        else
                          void mutate({
                            action: "automatic",
                            enabled: false,
                            threshold: snapshot.automatic.threshold,
                          });
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <label htmlFor="claude-auto-threshold">Switch when usage reaches</label>
                    <input
                      id="claude-auto-threshold"
                      aria-label="Claude switching threshold percent"
                      type="number"
                      min={50}
                      max={99}
                      step={1}
                      value={thresholdDraft ?? snapshot.automatic.threshold}
                      disabled={controlsDisabled}
                      onChange={(event) => setThresholdDraft(event.target.value)}
                      className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
                    />
                    <span>%</span>
                    {snapshot.automatic.enabled && threshold !== snapshot.automatic.threshold ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={controlsDisabled || !validThreshold}
                        onClick={() =>
                          requestConfirmation({ action: "automatic", enabled: true, threshold })
                        }
                      >
                        Save threshold
                      </Button>
                    ) : null}
                  </div>
                  {!validThreshold ? (
                    <p className="text-xs text-destructive">
                      Choose a whole percentage from 50 to 99.
                    </p>
                  ) : null}
                  {eligibleCount < 2 ? (
                    <p className="text-xs text-muted-foreground">
                      Include at least two saved organizations to enable automatic switching.
                    </p>
                  ) : null}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    When a usage window reaches the threshold, the next Claude requests may use
                    another included organization’s quota. Switching changes the shared Claude login
                    on this machine, including other terminals and VS Code. Running sessions may
                    keep their previous login until Claude refreshes its credentials. Stark Code
                    never restarts a session or replays a request. Organization inclusion also
                    changes cswap’s shared auto-switching list.
                  </p>
                  {snapshot.automatic.lastOutcome ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      {snapshot.automatic.lastOutcome}
                    </p>
                  ) : null}
                </div>
              </>
            )}
          </>
        ) : null}
      </div>
      <AlertDialog
        open={confirmation !== null && !confirmationClosing && canManage}
        onOpenChange={(open) => {
          if (!open) setConfirmationClosing(true);
        }}
        onOpenChangeComplete={(open) => {
          // Keep the confirmed action's copy throughout the exit animation.
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isSwitchConfirmation
                ? switchingAccount
                  ? `Switch to ${accountLabel(switchingAccount)}?`
                  : "Saved login changed"
                : "Enable automatic organization switching?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isSwitchConfirmation
                ? "This changes"
                : `At ${confirmation?.action === "automatic" ? confirmation.threshold : threshold}% usage, Stark Code may change`}{" "}
              the shared Claude login on {environmentLabel}, including other terminals and VS Code.
              Running Claude sessions may keep their previous login until their credentials refresh.
              No session will be restarted and no request will be replayed. Custom isolated Claude
              profiles keep their own login.
              {staleConfirmation
                ? " This saved login changed. Close this dialog and refresh before switching."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmationClosing(true)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !canManage || staleConfirmation}
              onClick={() => {
                if (confirmation && !staleConfirmation) void mutate(confirmation);
              }}
            >
              {isSwitchConfirmation ? "Switch shared login" : "Enable automatic switching"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
