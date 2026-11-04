import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@starkfuture/client-runtime/state/runtime";
import {
  threadHistoryEntryKey,
  type EnvironmentThreadHistoryEntry,
} from "@starkfuture/client-runtime/state/thread-search";
import type { EnvironmentId, ProjectId } from "@starkfuture/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, ArchiveX, DownloadIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useThreadActions } from "../../hooks/useThreadActions";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useThreadHistory } from "../../state/queries";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  HISTORY_ORIGIN_OPTIONS,
  HISTORY_STATUS_OPTIONS,
  HISTORY_UPDATED_OPTIONS,
  historyEnvironmentIds,
  historyFilters,
  historyFolder,
  historyOriginLabel,
  historyQuery,
  historyRowActions,
  nextHistorySearch,
  type HistorySearch,
} from "./history.logic";
import { ImportSessionsDialog, type ImportedSessionsTarget } from "./ImportSessionsDialog";

const ALL = "all";

const folderKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  JSON.stringify([environmentId, projectId]);

function FilterSelect({
  label,
  value,
  items,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly items: Readonly<Record<string, string>>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger aria-label={label} size="sm" className="w-auto">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {Object.entries(items).map(([itemValue, itemLabel]) => (
          <SelectItem key={itemValue} value={itemValue}>
            {itemLabel}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Every thread on the connected environments, archived and imported ones
 * included, newest first. Filters live in the URL so Back restores them.
 */
export function HistoryPage({
  search,
  onSearchChange,
}: {
  readonly search: HistorySearch;
  readonly onSearchChange: (next: HistorySearch) => void;
}) {
  useEscapeToGoBack();
  const navigate = useNavigate();
  const { unarchiveThread } = useThreadActions();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [importRequested, setImportRequested] = useState(false);
  // The palette opens the dialog through the URL, also while History is open.
  const importOpen = importRequested || search.import === true;
  const [now] = useState(() => Date.now());

  const connected = useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
  );
  const supportedIds = useMemo(
    () =>
      connected
        .filter((environment) => environment.serverConfig?.threadHistorySearch === true)
        .map((environment) => environment.environmentId),
    [connected],
  );
  const unsupportedLabels = connected
    .filter(
      (environment) =>
        environment.serverConfig !== null && environment.serverConfig?.threadHistorySearch !== true,
    )
    .map((environment) => environment.label);
  const environmentIds = useMemo(
    () => historyEnvironmentIds(search, supportedIds),
    [search, supportedIds],
  );
  const filters = useMemo(() => historyFilters(search, now), [search, now]);
  const history = useThreadHistory(environmentIds, filters);

  const providerEntries = useMemo(() => {
    const byKey = new Map<
      string,
      { readonly label: string; readonly driverKind: string; readonly ready: boolean }
    >();
    for (const environment of connected) {
      for (const entry of deriveProviderInstanceEntries(
        environment.serverConfig?.providers ?? [],
      )) {
        byKey.set(`${environment.environmentId}:${entry.instanceId}`, {
          label: entry.displayName,
          driverKind: entry.driverKind,
          ready: entry.enabled && entry.installed && entry.isAvailable,
        });
      }
    }
    return byKey;
  }, [connected]);
  const providerItems = useMemo(() => {
    const items: Record<string, string> = { [ALL]: "Any provider" };
    for (const [key, entry] of providerEntries) {
      const instanceId = key.slice(key.indexOf(":") + 1);
      items[instanceId] ??= entry.label;
    }
    return items;
  }, [providerEntries]);

  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const showMachine = supportedIds.length > 1;
  const historyProjects = projects.filter((project) =>
    supportedIds.includes(project.environmentId),
  );
  const projectTitle = (environmentId: EnvironmentId, projectId: ProjectId) =>
    historyProjects.find(
      (project) => project.environmentId === environmentId && project.id === projectId,
    )?.title ?? null;
  const folderItems: Record<string, string> = { [ALL]: "Any folder" };
  const folderByKey = new Map<string, { environmentId: EnvironmentId; projectId: ProjectId }>();
  for (const project of historyProjects) {
    const key = folderKey(project.environmentId, project.id);
    folderByKey.set(key, { environmentId: project.environmentId, projectId: project.id });
    folderItems[key] = showMachine
      ? `${project.title} · ${environmentLabels.get(project.environmentId) ?? project.environmentId}`
      : project.title;
  }

  const update = (patch: Readonly<Record<string, unknown>>) =>
    onSearchChange(nextHistorySearch(search, patch));

  const openThread = (entry: EnvironmentThreadHistoryEntry) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(entry.environmentId, entry.threadId)),
    });

  const unarchive = async (entry: EnvironmentThreadHistoryEntry) => {
    const result = await unarchiveThread(scopeThreadRef(entry.environmentId, entry.threadId));
    if (result._tag === "Success") {
      history.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to unarchive thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  // Only the imported sessions of that folder, whatever was filtered before.
  const showImported = (target: ImportedSessionsTarget) =>
    onSearchChange(
      nextHistorySearch(
        {},
        {
          origin: "agent-session",
          environmentId: target.environmentId,
          projectId: target.projectId,
        },
      ),
    );

  const folder = historyFolder(search);
  const searching = historyQuery(search) !== null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} />
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="gap-5">
            <div className="flex items-start justify-between gap-6">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">History</h1>
                <p className="mt-3 text-sm text-muted-foreground">
                  Every thread on your connected machines, including archived threads and sessions
                  imported from Claude Code or Codex.
                </p>
              </div>
              <Button variant="outline" onClick={() => setImportRequested(true)}>
                <DownloadIcon />
                Import sessions…
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <InputGroup className="min-w-60 flex-1">
                <InputGroupAddon>
                  <SearchIcon aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  nativeInput
                  type="search"
                  aria-label="Search history"
                  placeholder="Search titles and messages"
                  value={search.q ?? ""}
                  onChange={(event) => update({ q: event.target.value || undefined })}
                />
              </InputGroup>
              <FilterSelect
                label="Status"
                value={search.status ?? "all"}
                items={Object.fromEntries(
                  HISTORY_STATUS_OPTIONS.map((option) => [option.value, option.label]),
                )}
                onChange={(value) => update({ status: value === "all" ? undefined : value })}
              />
              <FilterSelect
                label="Origin"
                value={search.origin ?? "any"}
                items={Object.fromEntries(
                  HISTORY_ORIGIN_OPTIONS.map((option) => [option.value, option.label]),
                )}
                onChange={(value) => update({ origin: value === "any" ? undefined : value })}
              />
              <FilterSelect
                label="Updated"
                value={search.updated ?? "any"}
                items={Object.fromEntries(
                  HISTORY_UPDATED_OPTIONS.map((option) => [option.value, option.label]),
                )}
                onChange={(value) => update({ updated: value === "any" ? undefined : value })}
              />
              <FilterSelect
                label="Provider"
                value={search.provider ?? ALL}
                items={providerItems}
                onChange={(value) => update({ provider: value === ALL ? undefined : value })}
              />
              <FilterSelect
                label="Folder"
                value={folder === null ? ALL : folderKey(folder.environmentId, folder.projectId)}
                items={folderItems}
                onChange={(value) =>
                  update(
                    folderByKey.get(value) ?? { environmentId: undefined, projectId: undefined },
                  )
                }
              />
            </div>

            {unsupportedLabels.map((label) => (
              <p key={label} className="text-sm text-muted-foreground">
                Update Stark Code on {label} to search its history.
              </p>
            ))}
            {history.failedEnvironmentIds.map((environmentId) => (
              <p key={environmentId} role="alert" className="text-sm text-destructive">
                Could not search {environmentLabels.get(environmentId) ?? environmentId}.
              </p>
            ))}

            <ul className="flex flex-col divide-y divide-border">
              {history.entries.map((entry) => {
                const provider = providerEntries.get(
                  `${entry.environmentId}:${entry.providerInstanceId}`,
                );
                // Default provider instances are named after their driver.
                const originLabel = historyOriginLabel(
                  entry.origin,
                  provider?.driverKind ?? entry.providerInstanceId,
                );
                const folder = projectTitle(entry.environmentId, entry.projectId);
                const actions = historyRowActions(entry, {
                  providerReady: provider?.ready === true,
                });
                const snippet =
                  entry.match !== null && entry.match.source !== "title"
                    ? entry.match.snippet
                    : null;
                return (
                  <li
                    key={threadHistoryEntryKey(entry)}
                    className="flex items-start justify-between gap-4 py-3"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <button
                        type="button"
                        className="truncate text-left text-sm font-medium hover:underline focus-visible:underline focus-visible:outline-none"
                        onClick={() => void openThread(entry)}
                      >
                        {entry.title}
                      </button>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        {folder ? <span>{folder}</span> : null}
                        {showMachine ? (
                          <span>{environmentLabels.get(entry.environmentId)}</span>
                        ) : null}
                        {provider ? <span>{provider.label}</span> : null}
                        <span>{formatRelativeTimeLabel(entry.updatedAt)}</span>
                        {entry.archivedAt !== null ? (
                          <Badge size="sm" variant="secondary">
                            <ArchiveIcon />
                            Archived
                          </Badge>
                        ) : null}
                        {originLabel ? (
                          <Badge size="sm" variant="info">
                            {originLabel}
                          </Badge>
                        ) : null}
                      </div>
                      {entry.firstPrompt ? (
                        <p className="line-clamp-2 text-sm text-muted-foreground">
                          {entry.firstPrompt}
                        </p>
                      ) : null}
                      {snippet ? (
                        <p className="line-clamp-2 text-xs text-muted-foreground italic">
                          {snippet}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {actions.map((action) =>
                        action === "continue" ? (
                          <Button key={action} size="xs" onClick={() => void openThread(entry)}>
                            Continue
                          </Button>
                        ) : action === "unarchive" ? (
                          <Button
                            key={action}
                            size="xs"
                            variant="outline"
                            onClick={() => void unarchive(entry)}
                          >
                            <ArchiveX />
                            Unarchive
                          </Button>
                        ) : (
                          <Button
                            key={action}
                            size="xs"
                            variant="outline"
                            onClick={() => void openThread(entry)}
                          >
                            Open
                          </Button>
                        ),
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="flex justify-center py-2 text-sm text-muted-foreground">
              {history.isPending ? (
                <Spinner size="sm" tone="muted" />
              ) : history.older.length > 0 ? (
                <Button variant="outline" size="sm" onClick={history.showOlder}>
                  {searching ? "Search older threads" : "Show older"}
                </Button>
              ) : history.entries.length === 0 ? (
                <span>
                  {supportedIds.length === 0
                    ? "No connected machine can search its history."
                    : searching
                      ? "No threads match."
                      : "No threads yet."}
                </span>
              ) : null}
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      <ImportSessionsDialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportRequested(open);
          if (!open && search.import === true) update({});
        }}
        defaultProject={folder}
        onImported={history.refresh}
        onShowImported={showImported}
      />
    </SidebarInset>
  );
}
