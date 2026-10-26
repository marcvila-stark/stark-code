import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import type {
  AgentSessionImportResult,
  AgentSessionSyncStatus,
  EnvironmentId,
  ProjectId,
} from "@starkfuture/contracts";
import { useEffect, useRef, useState } from "react";

import {
  agentSessionImport,
  agentSessionSyncConfigure,
  agentSessionSyncStatus,
} from "../../state/agentSessions";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

function importSummary(result: AgentSessionImportResult) {
  const parts = [`${result.importedCount} imported`];
  if (result.updatedCount) parts.push(`${result.updatedCount} updated`);
  if (result.unchangedCount) parts.push(`${result.unchangedCount} already up to date`);
  if (result.skippedCount) parts.push(`${result.skippedCount} skipped`);
  return parts.join(" · ");
}

export function LocalChatImportDialog({ onClose }: { readonly onClose: () => void }) {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [busy, setBusy] = useState(false);
  const environmentId =
    selectedEnvironmentId ?? primaryId ?? environments[0]?.environmentId ?? null;
  const environment = environments.find((entry) => entry.environmentId === environmentId);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup variant="brand" className="w-full sm:w-[32rem]">
        <DialogHeader>
          <DialogTitle>Import local chats</DialogTitle>
          <DialogDescription>
            Bring your Claude Code and Codex CLI conversations into Stark Code.
          </DialogDescription>
        </DialogHeader>
        {environments.length > 1 ? (
          <div className="px-6 pt-2">
            <label className="grid gap-2 text-sm">
              <span>Computer with the local history</span>
              <Select
                value={environmentId}
                onValueChange={(value) => setSelectedEnvironmentId(value)}
                disabled={busy}
              >
                <SelectTrigger aria-label="Computer with the local history">
                  <SelectValue>{environment?.label ?? "Choose a computer"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </div>
        ) : null}
        {environment ? (
          <LocalChatImportContent
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.label}
            connected={environment.connection.phase === "connected"}
            onBusyChange={setBusy}
            onClose={onClose}
          />
        ) : (
          <>
            <DialogPanel>
              <p className="text-sm text-muted-foreground">Connect a computer first.</p>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function LocalChatImportContent({
  environmentId,
  environmentLabel,
  connected,
  onBusyChange,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const canImport = useAtomValue(agentSessionImport.permissionAtom(environmentId));
  const canConfigure = useAtomValue(agentSessionSyncConfigure.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    connected ? agentSessionSyncStatus({ environmentId, input: {} }) : null,
  );
  const runImport = useAtomCommand(agentSessionImport, { reportFailure: false });
  const configure = useAtomCommand(agentSessionSyncConfigure, { reportFailure: false });
  const [savedStatus, setSavedStatus] = useState<{
    value: AgentSessionSyncStatus;
    queryUpdatedAt: number;
  } | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [keepInSync, setKeepInSync] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<AgentSessionImportResult | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const status =
    savedStatus?.queryUpdatedAt === query.dataUpdatedAt ? savedStatus.value : query.data;
  const refreshStatus = query.refresh;
  const projectId = selectedProjectId ?? status?.projectId ?? projects[0]?.id ?? null;
  const project = projects.find((entry) => entry.id === projectId);
  const syncEnabled = keepInSync ?? (status?.projectId ? status.enabled : true);
  const result = lastResult ?? status?.lastResult;
  const isBusy = busy || status?.running === true;
  const canWrite = connected && canImport && canConfigure;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (!connected) return;
    const refreshVisible = () => {
      if (document.visibilityState === "visible" && !inFlight.current) refreshStatus();
    };
    refreshVisible();
    const timer = window.setInterval(refreshVisible, 5_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [connected, refreshStatus]);

  async function changeSync(enabled: boolean) {
    if (!canWrite || inFlight.current || !status) return;
    if (status.projectId === null || projectId !== status.projectId) {
      setKeepInSync(enabled);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await configure({
        environmentId,
        input: { enabled, projectId: status.projectId },
      });
      if (response._tag !== "Success") throw squashAtomCommandFailure(response);
      if (!mounted.current) return;
      setSavedStatus({ value: response.value, queryUpdatedAt: query.dataUpdatedAt });
      setKeepInSync(null);
      query.refresh();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not change automatic import.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function importChats() {
    if (!project || !canWrite || inFlight.current || isBusy || !status) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const response = await runImport({
        environmentId,
        input: {
          projectId: project.id,
          expectedWorkspaceRoot: project.workspaceRoot,
          scope: "all-local",
        },
      });
      if (response._tag !== "Success") throw squashAtomCommandFailure(response);
      if (!mounted.current) return;
      setLastResult(response.value);
      const configured = await configure({
        environmentId,
        input: { enabled: syncEnabled, projectId: project.id },
      });
      if (configured._tag !== "Success") throw squashAtomCommandFailure(configured);
      if (!mounted.current) return;
      setSavedStatus({ value: configured.value, queryUpdatedAt: query.dataUpdatedAt });
      setKeepInSync(null);
      query.refresh();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not import chats. Try again.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      <DialogPanel>
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Reads local Claude Code and Codex history on {environmentLabel}. Your original histories
            stay unchanged. Nothing is sent to an agent.
          </p>
          {projects.length ? (
            <div className="space-y-2">
              <label htmlFor="local-chat-destination" className="text-sm font-medium">
                Show imported chats in
              </label>
              <Select
                value={projectId}
                disabled={isBusy || status?.enabled === true || !status}
                onValueChange={(value) => {
                  setSelectedProjectId(value);
                  setLastResult(null);
                }}
              >
                <SelectTrigger id="local-chat-destination" aria-label="Show imported chats in">
                  <SelectValue>{project?.title ?? "Choose a folder"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {project ? (
                <p className="break-all text-xs text-muted-foreground">{project.workspaceRoot}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                One folder in the sidebar; each chat keeps its original working folder.
                {status?.enabled ? " Stop syncing before choosing another destination." : ""}
              </p>
            </div>
          ) : (
            <p className="text-sm">Open a folder first, then return here to import your chats.</p>
          )}
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <div className="space-y-1">
              <label htmlFor="local-chat-sync" className="text-sm font-medium">
                Keep local chats in sync
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                New CLI chats appear automatically while Stark Code is running. Turning this off
                keeps the chats already imported.
              </p>
              {status?.projectId === null ? (
                <p className="text-xs text-muted-foreground">Starts after your first import.</p>
              ) : null}
            </div>
            <Switch
              id="local-chat-sync"
              checked={syncEnabled}
              disabled={!canWrite || busy || !status}
              onCheckedChange={(enabled) => void changeSync(enabled)}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Imports message text, not every tool output or attachment. Once you continue an imported
            chat here, Stark Code manages its new turns.
          </p>
          {!status && connected && !query.error ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading import settings…
            </p>
          ) : null}
          {status?.lastSyncedAt ? (
            <p className="text-xs text-muted-foreground">
              Last checked {new Date(status.lastSyncedAt).toLocaleString()}.
            </p>
          ) : null}
          {isBusy ? (
            <p role="status" className="text-sm">
              Checking local history…
            </p>
          ) : result ? (
            <div role="status" className="space-y-1 text-sm">
              <p>{importSummary(result)}</p>
              {result.truncated ? (
                <p className="text-muted-foreground">
                  {syncEnabled
                    ? "More history remains. Automatic sync continues in batches; very large transcripts may stay incomplete."
                    : "More history remains. Import again to continue; very large transcripts may stay incomplete."}
                </p>
              ) : null}
            </div>
          ) : null}
          {!connected ? (
            <p role="alert" className="text-sm">
              Reconnect to {environmentLabel} to import chats.
            </p>
          ) : !canWrite ? (
            <p role="alert" className="text-sm">
              This connection cannot import or sync chats.
            </p>
          ) : null}
          {error || query.error || status?.error ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>{error ?? query.error ?? status?.error}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !connected}
                onClick={() => query.refresh()}
              >
                Refresh status
              </Button>
            </div>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Close
        </Button>
        <Button
          disabled={!project || !canWrite || isBusy || !status}
          onClick={() => void importChats()}
        >
          {busy ? "Importing…" : lastResult ? "Check again" : "Import all local chats"}
        </Button>
      </DialogFooter>
    </>
  );
}
