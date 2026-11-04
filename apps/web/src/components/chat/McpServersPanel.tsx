import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import {
  isExpectedMcpCallback,
  type EnvironmentId,
  type McpServersListInput,
  type McpServersReloadResult,
  type McpServerStatusEntry,
  type McpServerSignInStart,
  type ScopedThreadRef,
} from "@starkfuture/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentPresentation } from "../../state/presentation";
import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useMcpServersQuery } from "./useMcpServersQuery";
import { mcpRecoveryMessage } from "./mcpRecoveryPresentation";
import {
  describeMcpStatusFreshness,
  MCP_STATUS_FRESH_ON_OPEN_MS,
  mcpStatusMemory,
  mcpStatusTargetKey,
  resolveMcpStatusView,
} from "./mcpStatusMemory";
import {
  isLocalMcpDesktopTarget,
  mcpConnectionSummary,
  mcpDisplayText,
  MCP_SOURCE_LABELS,
  MCP_STATUS_LABELS,
  safeMcpBrowserTarget,
} from "./mcpServerPresentation";

type ServerAction = "reconnect" | "enable" | "disable" | "sign-in" | "sign-out";
export function McpServerRows({
  servers,
  canReconnect,
  canManage,
  busy,
  waitingName,
  onAction,
  spacious = false,
}: {
  servers: ReadonlyArray<McpServerStatusEntry>;
  canReconnect: boolean;
  canManage: boolean;
  busy: boolean;
  waitingName?: string | undefined;
  onAction: (server: McpServerStatusEntry, action: ServerAction) => void;
  spacious?: boolean;
}) {
  return (
    <div className="space-y-3">
      {servers.map((server) => (
        <section
          key={server.name}
          className={spacious ? "stark-mcp-server-card" : "rounded-xl border p-3"}
        >
          <div className="flex items-center justify-between gap-2">
            <h4 className="flex min-w-0 items-center gap-3 break-all font-medium">
              {spacious ? (
                <PlugIcon aria-hidden className="size-6 shrink-0 text-muted-foreground" />
              ) : null}
              {mcpDisplayText(server.name, 256)}
            </h4>
            <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs">
              {server.source
                ? MCP_SOURCE_LABELS[server.source]
                : server.scope
                  ? mcpDisplayText(server.scope, 100)
                  : "Provider"}
              {server.pluginName ? ` ${mcpDisplayText(server.pluginName, 100)}` : ""}
            </span>
          </div>
          <p
            className={spacious ? "stark-mcp-server-status" : "mt-1 text-xs text-muted-foreground"}
          >
            {spacious && server.status === "connected" ? (
              <CheckIcon aria-hidden className="size-4" />
            ) : null}
            {waitingName === server.name
              ? "Waiting for sign-in…"
              : MCP_STATUS_LABELS[server.status]}
            {server.locked ? " · Locked app server" : ""} · {server.tools.length} tools
          </p>
          {mcpRecoveryMessage(server) ? (
            <p className="mt-1 text-xs text-muted-foreground">{mcpRecoveryMessage(server)}</p>
          ) : null}
          {server.error ? (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
              <p className="mt-2 break-all text-destructive">{mcpDisplayText(server.error)}</p>
            </details>
          ) : null}
          {server.tools.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs">Tools</summary>
              <ul className="mt-2 space-y-2">
                {server.tools.map((tool) => (
                  <li key={tool.name} className="rounded bg-muted/50 p-2">
                    <p className="break-all font-mono text-xs">{mcpDisplayText(tool.name, 256)}</p>
                    {tool.description ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {mcpDisplayText(tool.description)}
                      </p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-1 text-3xs">
                      {tool.readOnly !== undefined ? (
                        <span className="rounded border px-1">
                          {tool.readOnly ? "Read-only" : "Read/write"}
                        </span>
                      ) : null}
                      {tool.destructive !== undefined ? (
                        <span className="rounded border px-1">
                          {tool.destructive ? "Destructive" : "Non-destructive"}
                        </span>
                      ) : null}
                      {tool.openWorld !== undefined ? (
                        <span className="rounded border px-1">
                          {tool.openWorld ? "Open-world" : "Closed-world"}
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {!server.locked ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {canReconnect && server.status === "failed" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!busy && canReconnect) onAction(server, "reconnect");
                  }}
                >
                  Reconnect
                </Button>
              ) : null}
              {canManage ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!busy && canManage)
                      onAction(server, server.status === "disabled" ? "enable" : "disable");
                  }}
                >
                  {server.status === "disabled"
                    ? "Enable"
                    : server.source === "codex"
                      ? "Disable in Codex settings"
                      : "Disable for this project"}
                </Button>
              ) : null}
              {canManage && server.status === "needs-auth" && waitingName !== server.name ? (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    if (!busy && canManage) onAction(server, "sign-in");
                  }}
                >
                  Sign in
                </Button>
              ) : null}
              {canManage && server.authKind === "oauth" && server.canSignOut ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (!busy && canManage) onAction(server, "sign-out");
                  }}
                >
                  Sign out
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

type McpServersPanelProps = {
  environmentId: EnvironmentId;
  target: McpServersListInput;
  providerKind?: "claudeAgent" | "codex" | undefined;
  sessionBusy?: boolean | undefined;
  /** Set only by an explicit Sign in click in the health banner. */
  initialSignIn?: string | undefined;
  showHeading?: boolean;
  presentation?: "settings" | "compact";
  scopeControls?: ReactNode;
};

export function McpServersPanel(props: McpServersPanelProps) {
  // A held confirmation and OAuth callback belong to exactly one target. A late
  // action from the previous target must never populate the newly selected panel.
  return (
    <McpServersPanelTarget
      key={`${mcpStatusTargetKey(props.environmentId, props.target)}:${props.providerKind ?? ""}`}
      {...props}
    />
  );
}

function McpServersPanelTarget({
  environmentId,
  target,
  providerKind,
  sessionBusy = false,
  initialSignIn,
  showHeading = true,
  presentation = "compact",
  scopeControls,
}: McpServersPanelProps) {
  const reloadLabel = providerKind === "claudeAgent" ? "Reload plugins" : "Reload MCPs";
  const reloadFailure =
    providerKind === "claudeAgent"
      ? "Could not reload Claude plugins. Refresh status and try again."
      : "Could not reload MCP servers. Refresh status and try again.";
  const query = useMcpServersQuery(environmentId, target, 2_000);
  // Read once: the panel remounts whenever its target changes. Shown only
  // until this panel's own inspection answers.
  const [remembered] = useState(() =>
    mcpStatusMemory.recall(mcpStatusTargetKey(environmentId, target)),
  );
  const [freshSince, setFreshSince] = useState(() => Date.now() - MCP_STATUS_FRESH_ON_OPEN_MS);
  const nowMinute = useNowMinute();
  const status = resolveMcpStatusView({
    current: query.data,
    currentReceivedAt: query.dataUpdatedAt,
    pending: query.isPending,
    failed: query.error !== null,
    remembered,
    freshSince,
    now: Date.parse(`${nowMinute}Z`),
  });
  const shown = status.kind === "known" ? status.result : null;
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const [inspectionSlow, setInspectionSlow] = useState(false);
  const waitingForStatus = status.kind === "checking";
  const refreshingShown = status.kind === "known" && status.refreshing;
  const inspecting = waitingForStatus || refreshingShown;
  useEffect(() => {
    setInspectionSlow(false);
    if (!inspecting) return;
    const timer = window.setTimeout(() => setInspectionSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [inspecting, inspectionAttempt]);
  const freshness = describeMcpStatusFreshness(status, inspectionSlow);
  const retryStatus = () => {
    setFreshSince(Date.now());
    setInspectionAttempt((attempt) => attempt + 1);
    query.refresh();
  };
  const reload = useAtomCommand(serverEnvironment.reloadMcpServers, { reportFailure: false });
  const reconnect = useAtomCommand(serverEnvironment.reconnectMcpServer, { reportFailure: false });
  const toggle = useAtomCommand(serverEnvironment.setMcpServerEnabled, { reportFailure: false });
  const signIn = useAtomCommand(serverEnvironment.signInMcpServer, { reportFailure: false });
  const signOut = useAtomCommand(serverEnvironment.signOutMcpServer, { reportFailure: false });
  const submit = useAtomCommand(serverEnvironment.submitMcpServerCallback, {
    reportFailure: false,
  });
  const { presentation: environmentPresentation } = useEnvironmentPresentation(environmentId);
  const desktopHost = environmentPresentation
    ? isLocalMcpDesktopTarget(isElectron, environmentPresentation.entry.target)
    : false;
  const canOperate = useEnvironmentScope(environmentId, "orchestration:operate") && desktopHost;
  const canReconnect =
    canOperate && query.data?.live === true && query.data.reconnectScope === "server";
  const canReload =
    target.threadId !== undefined &&
    canOperate &&
    query.data?.live === true &&
    query.data.canReload === true;
  const canManage = useEnvironmentScope(environmentId, "providers:manage") && desktopHost;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const unavailable =
    !query.data || Boolean(query.error) || (target.threadId !== undefined && !query.data.live);
  const mutationBlocked = busy || sessionBusy || unavailable;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [reloadResult, setReloadResult] = useState<McpServersReloadResult | null>(null);
  const [pending, setPending] = useState<{
    name: string;
    flow: McpServerSignInStart;
    opened: boolean;
    startedAt: number;
  } | null>(null);
  const [callback, setCallback] = useState("");
  const refresh = useRef(query.refresh);
  refresh.current = query.refresh;
  useEffect(() => {
    if (!pending) return;
    if (
      query.data?.servers.some(
        (server) => server.name === pending.name && server.status === "connected",
      )
    ) {
      setPending(null);
      setCallback("");
      return;
    }
    const timer = window.setTimeout(
      () => {
        setPending(null);
        setCallback("");
        setError("Sign-in timed out. Start again when you are ready.");
      },
      Math.max(0, 300_000 - (Date.now() - pending.startedAt)),
    );
    return () => window.clearTimeout(timer);
  }, [pending, query.data]);
  const run = async (operation: () => Promise<{ readonly _tag: string }>) => {
    if (busyRef.current || sessionBusy || unavailable) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setReloadResult(null);
    try {
      const result = await operation();
      if (result._tag === "Failure") setError("The MCP action failed. Refresh and try again.");
      else refresh.current();
    } catch {
      setError("The MCP action failed. Refresh and try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const reloadServers = async (force = false) => {
    if (
      !canReload ||
      unavailable ||
      sessionBusy ||
      busyRef.current ||
      (!force && reloadResult?.status === "confirmation-required") ||
      (force && reloadResult?.status !== "confirmation-required")
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setReloadResult(null);
    try {
      const result = await reload({
        environmentId,
        input: { ...target, ...(force ? { force: true } : {}) },
      });
      if (result._tag === "Failure") {
        setError(reloadFailure);
      } else {
        setReloadResult(result.value);
      }
    } catch {
      setError(reloadFailure);
    } finally {
      busyRef.current = false;
      setBusy(false);
      refresh.current();
    }
  };
  const action = (server: McpServerStatusEntry, kind: ServerAction) => {
    if (server.locked || mutationBlocked) return;
    const input = { ...target, name: server.name };
    if (kind === "reconnect") {
      if (canReconnect && server.status === "failed")
        void run(() => reconnect({ environmentId, input }));
      return;
    }
    if (!canManage) return;
    if (kind === "enable" || kind === "disable") {
      void run(() => toggle({ environmentId, input: { ...input, enabled: kind === "enable" } }));
      return;
    }
    if (kind === "sign-out") {
      void run(() => signOut({ environmentId, input }));
      return;
    }
    if (kind === "sign-in")
      void run(async () => {
        const result = await signIn({ environmentId, input });
        if (result._tag === "Success" && mounted.current) {
          const flow = result.value;
          if (flow.url && !safeMcpBrowserTarget(flow.url)) {
            setError("The server returned an unsafe sign-in URL.");
            return result;
          }
          if (!flow.completed) {
            let opened = flow.browserOpened === true;
            const browserTarget = flow.url ? safeMcpBrowserTarget(flow.url) : null;
            if (!opened && browserTarget) {
              try {
                await ensureLocalApi().shell.openExternal(browserTarget.url);
                opened = true;
              } catch {
                setError("Could not open the system browser. Try again.");
              }
            }
            if (!mounted.current) return result;
            setPending({
              name: server.name,
              flow,
              opened,
              startedAt: Date.now(),
            });
            setCallback("");
          }
        }
        return result;
      });
  };
  const requestedSignIn = useRef<string | null>(null);
  useEffect(() => {
    if (
      !initialSignIn ||
      requestedSignIn.current === initialSignIn ||
      !canManage ||
      mutationBlocked
    )
      return;
    const server = query.data?.servers.find(
      (entry) => entry.name === initialSignIn && entry.status === "needs-auth" && !entry.locked,
    );
    if (!server) return;
    requestedSignIn.current = initialSignIn;
    action(server, "sign-in");
  });
  const browser = pending?.flow.url ? safeMcpBrowserTarget(pending.flow.url) : null;
  const waitingServer = query.data?.servers.find((server) => server.name === pending?.name);
  const canPaste =
    pending?.opened && pending.flow.callbackExpected && waitingServer?.canSubmitCallback === true;
  return (
    <section
      className={presentation === "settings" ? "stark-mcp-panel" : "space-y-4 text-sm"}
      aria-label="Connected tools"
    >
      {presentation === "settings" ? (
        <>
          <div className="stark-settings-intro stark-mcp-heading">
            <div>
              <h1>
                Connected tools <span>MCP servers</span>
              </h1>
              <p>Connections for the selected agent and folder.</p>
            </div>
            <Button
              size="comfortable"
              variant="subtle-outline"
              disabled={busy}
              onClick={retryStatus}
            >
              <RefreshCwIcon />
              Check status
            </Button>
          </div>
          <div className="stark-settings-scope">{scopeControls}</div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {showHeading ? <h3 className="font-medium">Connected tools</h3> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={retryStatus}>
              Refresh status
            </Button>
            {target.threadId !== undefined ? (
              <Button
                size="xs"
                variant="outline"
                disabled={
                  !canReload || mutationBlocked || reloadResult?.status === "confirmation-required"
                }
                onClick={() => void reloadServers()}
              >
                {reloadLabel}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {target.threadId !== undefined && providerKind ? (
        <p className="text-xs text-muted-foreground">
          {providerKind === "claudeAgent"
            ? "Applies installed Claude plugin changes for this chat. New or removed plugin MCP servers may need a new session."
            : "Reloads MCP configuration and connections in the running Codex session."}
        </p>
      ) : null}
      {!desktopHost ? (
        <p className="text-xs text-muted-foreground">
          Status only. Manage MCP servers from the desktop host.
        </p>
      ) : null}
      {sessionBusy ? (
        <p className="text-xs text-muted-foreground">
          Connection changes are available after this turn finishes.
        </p>
      ) : null}
      {shown?.live && shown.reconnectScope === "all" ? (
        <p className="text-xs text-muted-foreground">
          This provider cannot reconnect one server without reloading healthy connections.
          Individual retries are unavailable here.
        </p>
      ) : null}
      {target.threadId === undefined && presentation !== "settings" ? (
        <p className="text-xs text-muted-foreground">
          This checks connections for the selected folder and agent. To manage a running chat, use +
          → Connectors → Manage connections in its message box.
        </p>
      ) : null}
      {error || query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? "Could not read MCP status. Refresh and try again."}
        </p>
      ) : null}
      {reloadResult?.status === "confirmation-required" ? (
        <div className="space-y-3 rounded-xl border p-3 text-xs" role="status">
          <p>
            Reloading may invalidate the agent's prompt cache and increase token usage on the next
            turn. No servers have been reloaded yet.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!canReload || mutationBlocked}
              onClick={() => void reloadServers(true)}
            >
              Reload anyway
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setReloadResult(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : reloadResult?.status === "reloaded" ? (
        <div className="space-y-1 text-xs text-muted-foreground" role="status">
          {reloadResult.failedServers.length > 0 || (reloadResult.pluginErrors ?? 0) > 0 ? (
            <>
              <p>
                {providerKind === "claudeAgent"
                  ? "Claude plugin reload reported issues."
                  : "MCP reload reported issues."}
              </p>
              {reloadResult.failedServers.length > 0 ? (
                <p>
                  Failed servers:{" "}
                  {reloadResult.failedServers.map((name) => mcpDisplayText(name, 256)).join(", ")}.
                </p>
              ) : null}
              {(reloadResult.pluginErrors ?? 0) > 0 ? (
                <p>
                  {reloadResult.pluginErrors} plugin{" "}
                  {reloadResult.pluginErrors === 1 ? "error" : "errors"} reported.
                </p>
              ) : null}
            </>
          ) : (
            <p>
              {providerKind === "claudeAgent"
                ? "Claude plugins reloaded. Connection status updates below."
                : providerKind === "codex"
                  ? "Codex MCP reload requested. Connection status updates below."
                  : "MCP reload requested. Connection status updates below."}
            </p>
          )}
        </div>
      ) : null}
      {pending ? (
        <div className="space-y-3 rounded-xl border p-3 text-xs">
          <p>Waiting for sign-in to {mcpDisplayText(pending.name, 256)}…</p>
          {browser ? (
            <>
              <p>Opens {browser.host} in your browser.</p>
              <Button
                size="xs"
                disabled={mutationBlocked}
                onClick={() => {
                  if (!canManage || mutationBlocked) return;
                  void ensureLocalApi()
                    .shell.openExternal(browser.url)
                    .then(() => {
                      setPending((current) => (current ? { ...current, opened: true } : null));
                      refresh.current();
                    })
                    .catch(() => setError("Could not open the system browser. Try again."));
                }}
              >
                Open {browser.host} in browser
              </Button>
            </>
          ) : null}
          {canPaste ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canManage || mutationBlocked) return;
                if (!isExpectedMcpCallback(callback, pending.flow)) {
                  setError("Paste the matching localhost callback address from this sign-in flow.");
                  return;
                }
                void run(async () => {
                  const answer = await submit({
                    environmentId,
                    input: { ...target, name: pending.name, url: callback },
                  });
                  if (answer._tag === "Success") setCallback("");
                  return answer;
                });
              }}
            >
              <label className="flex flex-col gap-2">
                If the redirect did not finish, paste the address from your browser
                <input
                  aria-label="Browser callback address"
                  autoComplete="off"
                  spellCheck={false}
                  className="rounded border bg-background px-2 py-1"
                  value={callback}
                  onChange={(event) => setCallback(event.target.value)}
                />
              </label>
              <Button size="xs" disabled={mutationBlocked || !callback.trim()} type="submit">
                Complete sign-in
              </Button>
            </form>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setPending(null);
              setCallback("");
            }}
          >
            Cancel waiting
          </Button>
        </div>
      ) : null}
      {freshness ? (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          <p>{freshness}</p>
          {refreshingShown && inspectionSlow ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={retryStatus}>
              Retry status check
            </Button>
          ) : null}
        </div>
      ) : null}
      {waitingForStatus ? (
        <div
          className={
            presentation === "settings"
              ? "stark-mcp-status-hero"
              : "space-y-3 rounded-xl border p-5"
          }
          role="status"
        >
          {presentation === "settings" ? (
            <div className="stark-mcp-status-icon">
              <PlugIcon aria-hidden />
            </div>
          ) : null}
          <p className="font-medium">
            {inspectionSlow ? "Status is taking longer than expected" : "Checking connected tools…"}
          </p>
          <p className="text-xs text-muted-foreground">
            {inspectionSlow
              ? "No server result has arrived yet. You can try again or continue working."
              : "Reading the tools available to this agent."}
          </p>
          {inspectionSlow ? (
            <Button
              size={presentation === "settings" ? "comfortable" : "sm"}
              variant={presentation === "settings" ? "brand" : "outline"}
              disabled={busy}
              onClick={retryStatus}
            >
              {presentation === "settings" ? <RefreshCwIcon /> : null}
              {presentation === "settings" ? "Try status check again" : "Retry status check"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {target.threadId !== undefined && shown && !shown.live ? (
        <p className="text-xs text-muted-foreground">
          Send a message to start this thread's MCP session.
        </p>
      ) : null}
      {shown && !(target.threadId !== undefined && !shown.live) && shown.servers.length === 0 ? (
        <p className="text-xs text-muted-foreground">No MCP servers reported.</p>
      ) : null}
      {canReconnect &&
      query.data?.servers.some((server) => server.status === "failed" && !server.locked) ? (
        <Button
          size="xs"
          variant="outline"
          disabled={mutationBlocked}
          onClick={() => {
            void run(async () => {
              for (const server of query.data?.servers ?? []) {
                if (server.status !== "failed" || server.locked) continue;
                const answer = await reconnect({
                  environmentId,
                  input: { ...target, name: server.name },
                });
                if (answer._tag === "Failure") return answer;
              }
              return { _tag: "Success" };
            });
          }}
        >
          Reconnect failed
        </Button>
      ) : null}
      <McpServerRows
        spacious={presentation === "settings"}
        servers={shown?.servers ?? []}
        canReconnect={canReconnect}
        canManage={canManage}
        busy={mutationBlocked}
        waitingName={pending?.name}
        onAction={action}
      />
      {presentation === "settings" ? (
        <div className="stark-mcp-health-note">
          <strong>Healthy connections stay connected.</strong>
          <p>Reconnect is offered only for a connection that needs it, when the agent is ready.</p>
        </div>
      ) : null}
    </section>
  );
}

function McpServersChip({
  threadRef,
  providerKind,
  sessionBusy,
}: {
  threadRef: ScopedThreadRef;
  providerKind?: "claudeAgent" | "codex" | undefined;
  sessionBusy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const query = useMcpServersQuery(threadRef.environmentId, { threadId: threadRef.threadId });
  const summary = mcpConnectionSummary(query.data?.servers ?? []);
  const hasStatus = query.data?.live === true && !query.error;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label={
              hasStatus
                ? `MCP servers: ${summary.connected} connected${summary.warning ? ", needs attention" : ""}`
                : "MCP servers: status unavailable"
            }
          >
            MCP{hasStatus ? ` ${summary.connected}` : ""}
            {hasStatus && summary.warning ? (
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
            ) : null}
          </Button>
        }
      />
      <PopoverPopup side="bottom" align="end" width="auto">
        <div className="max-h-[75vh] w-[min(34rem,85vw)] overflow-auto p-4">
          <McpServersPanel
            key={`${threadRef.environmentId}:${threadRef.threadId}`}
            environmentId={threadRef.environmentId}
            target={{ threadId: threadRef.threadId }}
            providerKind={providerKind}
            sessionBusy={sessionBusy}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
