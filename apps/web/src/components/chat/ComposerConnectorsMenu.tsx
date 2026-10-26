import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  McpServersListInput,
  McpServerStatusEntry,
} from "@starkfuture/contracts";
import { Settings2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isElectron } from "../../env";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { MenuCheckboxItem, MenuItem, MenuSeparator, MenuSubPopup } from "../ui/menu";
import { McpServersPanel } from "./McpServersPanel";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  isLocalMcpDesktopTarget,
  mcpDisplayText,
  MCP_STATUS_LABELS,
} from "./mcpServerPresentation";

type ConnectionTargetProps = {
  environmentId: EnvironmentId;
  target: McpServersListInput;
  providerKind: "claudeAgent" | "codex";
  providerLabel: string;
};

function connectionTargetKey({ environmentId, target, providerKind }: ConnectionTargetProps) {
  return JSON.stringify([
    environmentId,
    target.threadId,
    target.projectId,
    target.providerInstanceId,
    providerKind,
  ]);
}

function connectionScope(providerKind: ConnectionTargetProps["providerKind"]) {
  return providerKind === "codex"
    ? "Changes apply to Codex settings, including other Codex sessions."
    : "Changes apply to Claude connections for this project.";
}

type ComposerConnectorsMenuProps = ConnectionTargetProps & {
  open: boolean;
  inspectionTarget?: McpServersListInput;
  onManage: (target: McpServersListInput) => void;
};

/** Put inside MenuSub. Keep the management dialog outside the parent menu's popup. */
export function ComposerConnectorsMenu(props: ComposerConnectorsMenuProps) {
  return <ComposerConnectorsMenuTarget key={connectionTargetKey(props)} {...props} />;
}

function ComposerConnectorsMenuTarget({
  environmentId,
  target,
  providerKind,
  providerLabel,
  open,
  inspectionTarget,
  onManage,
}: ComposerConnectorsMenuProps) {
  // Project status starts an inspection process. Only the explicit Inspect action may do that;
  // the submenu can read an already-running chat without launching a new provider.
  const canReadAutomatically = target.threadId !== undefined;
  const query = useEnvironmentQuery(
    open && canReadAutomatically
      ? serverEnvironment.mcpServers({ environmentId, input: target })
      : null,
  );
  const toggleAllowed = useAtomValue(
    serverEnvironment.setMcpServerEnabled.permissionAtom(environmentId),
  );
  const toggle = useAtomCommand(serverEnvironment.setMcpServerEnabled, { reportFailure: false });
  const { presentation } = useEnvironmentPresentation(environmentId);
  const desktopHost = presentation
    ? isLocalMcpDesktopTarget(isElectron, presentation.entry.target)
    : false;
  const canManage =
    toggleAllowed && desktopHost && query.data?.live === true && query.error === null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const refresh = useRef(query.refresh);
  useEffect(() => {
    refresh.current = query.refresh;
  }, [query.refresh]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open && canReadAutomatically) refresh.current();
  }, [open, canReadAutomatically]);

  const setEnabled = async (server: McpServerStatusEntry, enabled: boolean) => {
    if (!open || !canManage || server.locked || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await toggle({
        environmentId,
        input: { ...target, name: server.name, enabled },
      });
      if (!mounted.current) return;
      if (result._tag === "Failure") {
        setError("Could not change this connection. Open Manage connections to try again.");
      } else {
        refresh.current();
      }
    } catch {
      if (mounted.current) {
        setError("Could not change this connection. Open Manage connections to try again.");
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const servers = query.data?.servers ?? [];
  const live = query.data?.live === true;
  const managementTarget =
    !canReadAutomatically || query.data?.live === false ? (inspectionTarget ?? target) : target;
  const inspectsProject = managementTarget.threadId === undefined;
  const inspectionUnavailable = inspectsProject && !desktopHost;
  const openManagement = () => {
    if (!inspectionUnavailable) onManage(managementTarget);
  };
  return (
    <MenuSubPopup
      {...composerFloatingLayerProps}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.stopPropagation();
      }}
    >
      <div className="w-80 max-w-[calc(100vw-3rem)]">
        <MenuItem disabled={inspectionUnavailable} onClick={openManagement}>
          <Settings2Icon />
          {inspectsProject ? "Inspect project connections" : "Manage connections"}
        </MenuItem>
        <div className="space-y-1 px-2 py-2 text-xs text-muted-foreground">
          <p>{mcpDisplayText(providerLabel, 100)} MCP connections</p>
          <p>{connectionScope(providerKind)}</p>
          {query.data ? (
            <p role="status">
              {live
                ? `${servers.length} configured · Current provider status`
                : "Connection status unavailable · Session not running"}
            </p>
          ) : null}
          {!canReadAutomatically ? <p role="status">Connections have not been checked.</p> : null}
          {inspectsProject && desktopHost ? (
            <p>Inspect to load this project's configured tools. No message is sent.</p>
          ) : null}
          {!desktopHost ? <p>Status only. Manage connections on the desktop host.</p> : null}
          {desktopHost && !toggleAllowed ? (
            <p>You do not have permission to change connections.</p>
          ) : null}
        </div>
        <MenuSeparator />
        {error || query.error ? (
          <p role="alert" className="px-2 py-2 text-xs text-destructive">
            {error ?? "Could not read connections. Open Manage connections to refresh."}
          </p>
        ) : null}
        {canReadAutomatically && !query.data && !query.error ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">Reading connections…</p>
        ) : null}
        {live && servers.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No connections reported. Open Manage connections for setup instructions.
          </p>
        ) : null}
        {servers.map((server) => {
          const label = mcpDisplayText(server.name, 256);
          const needsAttention = server.status === "needs-auth" || server.status === "failed";
          const status = live
            ? MCP_STATUS_LABELS[server.status]
            : server.status === "disabled"
              ? "Disabled"
              : "Configured · status unavailable";
          const content = (
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate">{label}</span>
              <span className="text-xs text-muted-foreground">
                {status}
                {server.locked ? " · Required by Stark Code" : ""}
              </span>
            </span>
          );
          if (!server.locked && needsAttention) {
            return (
              <MenuItem
                key={server.name}
                disabled={inspectionUnavailable}
                onClick={openManagement}
                aria-label={`Manage ${label}`}
              >
                {content}
              </MenuItem>
            );
          }
          if (!server.locked && canManage) {
            return (
              <MenuCheckboxItem
                key={server.name}
                variant="switch"
                checked={server.status !== "disabled"}
                disabled={busy}
                closeOnClick={false}
                aria-label={`${server.status === "disabled" ? "Enable" : "Disable"} ${label}${providerKind === "codex" ? " in Codex settings" : " for this project"}`}
                onCheckedChange={(enabled) => void setEnabled(server, enabled)}
              >
                {content}
              </MenuCheckboxItem>
            );
          }
          return (
            <div key={server.name} className="px-2 py-1.5 text-sm">
              {content}
            </div>
          );
        })}
      </div>
    </MenuSubPopup>
  );
}

export function ComposerConnectionsDialog({
  open,
  onOpenChange,
  sessionBusy = false,
  ...props
}: ConnectionTargetProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionBusy?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        {...composerFloatingLayerProps}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>Manage connections</DialogTitle>
          <DialogDescription>
            {mcpDisplayText(props.providerLabel, 100)} MCP connections.{" "}
            {connectionScope(props.providerKind)}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {open ? (
            <McpServersPanel
              key={connectionTargetKey(props)}
              environmentId={props.environmentId}
              target={props.target}
              providerKind={props.providerKind}
              sessionBusy={props.target.threadId !== undefined && sessionBusy}
            />
          ) : null}
          <details className="space-y-2 text-sm">
            <summary className="cursor-pointer font-medium">Add a connection</summary>
            <p className="text-xs text-muted-foreground">
              {props.providerKind === "codex"
                ? "Use codex mcp add in a terminal to configure a server, then refresh status here. Connections use this Codex provider's sign-in and settings."
                : "Use claude mcp add in a terminal in this project folder to configure a server, then refresh status here. Only connections exposed by Claude Code are shown."}
            </p>
            <p className="text-xs text-muted-foreground">
              Your provider's desktop app may have its own connector catalog. Connections from
              another app are not copied automatically.
            </p>
          </details>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
