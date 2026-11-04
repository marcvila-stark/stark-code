import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@starkfuture/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@starkfuture/contracts";
import { useId, useMemo, useState } from "react";

import { agentSessionImport } from "../../state/agentSessions";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { importResultSummary } from "./history.logic";

export interface ImportedSessionsTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const projectKey = (target: ImportedSessionsTarget) =>
  JSON.stringify([target.environmentId, target.projectId]);

/**
 * Imports the Claude Code and Codex sessions that ran in one project's folder
 * on that project's machine. Importing again adds only new sessions.
 */
export function ImportSessionsDialog({
  open,
  onOpenChange,
  defaultProject,
  onImported,
  onShowImported,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly defaultProject: ImportedSessionsTarget | null;
  /** Runs after a successful import, before the result toast's Show is pressed. */
  readonly onImported: () => void;
  readonly onShowImported: (target: ImportedSessionsTarget) => void;
}) {
  const id = useId();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const importSessions = useAtomCommand(agentSessionImport, { reportFailure: false });
  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const importable = useMemo(
    () => projects.filter((project) => project.isScratch !== true),
    [projects],
  );
  const showMachine = new Set(importable.map((project) => project.environmentId)).size > 1;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const selected =
    importable.find(
      (project) =>
        projectKey({ environmentId: project.environmentId, projectId: project.id }) ===
        (selectedKey ?? (defaultProject === null ? null : projectKey(defaultProject))),
    ) ??
    importable[0] ??
    null;
  const canImport = useAtomValue(
    agentSessionImport.permissionAtom(selected?.environmentId ?? null),
  );
  const machine = selected === null ? null : environmentLabels.get(selected.environmentId);
  const items = Object.fromEntries(
    importable.map((project) => [
      projectKey({ environmentId: project.environmentId, projectId: project.id }),
      showMachine
        ? `${project.title} · ${environmentLabels.get(project.environmentId) ?? project.environmentId}`
        : project.title,
    ]),
  );

  const runImport = async () => {
    if (selected === null || importing) return;
    const target = { environmentId: selected.environmentId, projectId: selected.id };
    setImporting(true);
    const result = await importSessions({
      environmentId: selected.environmentId,
      input: { projectId: selected.id, expectedWorkspaceRoot: selected.workspaceRoot },
    });
    setImporting(false);
    if (result._tag === "Success") {
      onImported();
      const summary = importResultSummary(result.value);
      toastManager.add({
        type: "success",
        title: summary.title,
        ...(summary.description === null ? {} : { description: summary.description }),
        actionProps: { children: "Show", onClick: () => onShowImported(target) },
      });
      onOpenChange(false);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not import sessions",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void runImport();
          }}
        >
          <DialogHeader>
            <DialogTitle>Import Claude Code and Codex sessions</DialogTitle>
            <DialogDescription>
              Imported sessions appear in History. The first message you send in one continues the
              same CLI session.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {selected === null ? (
              <p className="text-sm text-muted-foreground">
                Add a project first. Sessions are imported into the project whose folder they ran
                in.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-project`}>
                  Project
                  <Select
                    value={projectKey({
                      environmentId: selected.environmentId,
                      projectId: selected.id,
                    })}
                    items={items}
                    onValueChange={(value) => {
                      if (typeof value === "string") setSelectedKey(value);
                    }}
                  >
                    <SelectTrigger id={`${id}-project`} className="min-w-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {Object.entries(items).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Label>
                <p className="text-sm text-muted-foreground">
                  Imports sessions from the last 30 days that ran in{" "}
                  <span className="font-mono text-foreground">{selected.workspaceRoot}</span>
                  {machine ? ` on ${machine}` : ""}. Up to 100 sessions; long sessions keep the
                  first prompt and the latest messages. Sessions run in worktrees or subfolders are
                  not included.
                </p>
                {canImport ? null : (
                  <p role="alert" className="text-sm text-destructive">
                    This connection cannot add threads on {machine ?? "this machine"}.
                  </p>
                )}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={selected === null || !canImport || importing}>
              {importing ? <Spinner size="sm" /> : null}
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
