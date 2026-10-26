import { scopeProjectRef } from "@starkfuture/client-runtime/environment";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
  normalizeProjectPathForDispatch,
} from "@starkfuture/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
} from "@starkfuture/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { newProjectId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { readProjects, useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const PERMISSION_MESSAGE = "This connection cannot open folders.";
const PROJECT_EVENT_WAIT_MS = 10_000;

/** Opening a workspace never scans descendants or imports provider history. */
export function FolderStep({
  environmentIds,
  isOpening,
  setIsOpening,
  onDone,
  showIntroduction = true,
  onCancel,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly isOpening: boolean;
  readonly setIsOpening: (value: boolean) => void;
  readonly onDone: (projectRef?: ScopedProjectRef, isCurrent?: () => boolean) => Promise<boolean>;
  readonly showIntroduction?: boolean;
  readonly onCancel?: () => void;
}) {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironment();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const environmentId =
    selectedId !== null && environmentIds.includes(selectedId)
      ? selectedId
      : (environmentIds.find((id) => id === primary?.environmentId) ?? environmentIds[0] ?? null);
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const canOpen = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const projects = useProjects();
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [landingProject, setLandingProject] = useState<{
    readonly projectRef: ScopedProjectRef;
    readonly receipt: number;
  } | null>(null);
  const nextReceipt = useRef(0);
  const handledReceipt = useRef<number | null>(null);
  const attempts = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const accepted = useRef(new Map<string, ScopedProjectRef>());
  const completionProject = useRef<ScopedProjectRef | undefined>(undefined);
  const busy = useRef(false);
  const generation = useRef(0);
  const target = useRef(environmentId);
  useEffect(() => {
    if (target.current !== environmentId) {
      generation.current += 1;
      busy.current = false;
      setIsOpening(false);
      setLandingProject(null);
      setError("");
    }
    target.current = environmentId;
  }, [environmentId, setIsOpening]);

  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, []);

  const finish = useCallback(
    async (projectRef?: ScopedProjectRef) => {
      const current = generation.current;
      const completed = await onDone(projectRef, () => current === generation.current);
      if (current !== generation.current) return;
      if (!completed) {
        busy.current = false;
        setIsOpening(false);
      }
    },
    [onDone, setIsOpening],
  );

  useEffect(() => {
    if (
      landingProject === null ||
      handledReceipt.current === landingProject.receipt ||
      !projects.some(
        (project) =>
          project.id === landingProject.projectRef.projectId &&
          project.environmentId === landingProject.projectRef.environmentId,
      )
    ) {
      return;
    }
    handledReceipt.current = landingProject.receipt;
    void finish(landingProject.projectRef);
  }, [landingProject, projects, finish]);

  useEffect(() => {
    if (landingProject === null) return;
    const timeout = setTimeout(() => {
      if (handledReceipt.current === landingProject.receipt) return;
      setLandingProject(null);
      setError("The folder was opened, but this connection has not caught up. Try again.");
      busy.current = false;
      setIsOpening(false);
    }, PROJECT_EVENT_WAIT_MS);
    return () => clearTimeout(timeout);
  }, [landingProject, setIsOpening]);

  const release = () => {
    busy.current = false;
    setIsOpening(false);
  };

  const openPath = async (value: string, id: EnvironmentId, current: number) => {
    if (current !== generation.current || target.current !== id) return;
    const workspaceRoot = normalizeProjectPathForDispatch(value.trim());
    // Folder validation runs before the server commits the create receipt.
    // Retaining this attempt also makes a lost create response safe to retry.
    if (
      !workspaceRoot ||
      !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(workspaceRoot) ||
      workspaceRoot.includes("\0")
    ) {
      setError("Enter the full path to your main folder.");
      release();
      return;
    }
    if (!readEnvironmentScope(id, AuthOrchestrationOperateScope)) {
      setError(PERMISSION_MESSAGE);
      release();
      return;
    }
    setPath(workspaceRoot);
    const key = JSON.stringify([id, workspaceRoot]);
    const existing = findProjectByPath(
      readProjects().filter((project) => project.environmentId === id),
      workspaceRoot,
    );
    let projectRef = existing ? scopeProjectRef(id, existing.id) : accepted.current.get(key);
    if (!projectRef) {
      let attempt = attempts.current.get(key);
      if (!attempt) {
        const projectId = newProjectId();
        attempt = {
          projectId,
          commandId: CommandId.make(`onboarding:folder:open:${projectId}`),
        };
        attempts.current.set(key, attempt);
      }
      try {
        const result = await createProject({
          environmentId: id,
          input: {
            projectId: attempt.projectId,
            commandId: attempt.commandId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (current !== generation.current || target.current !== id) return;
        if (result._tag !== "Success") {
          setError("Could not open that folder. Check the path and try again.");
          release();
          return;
        }
      } catch {
        if (current !== generation.current || target.current !== id) return;
        setError("Could not open that folder. Check the path and try again.");
        release();
        return;
      }
      projectRef = scopeProjectRef(id, attempt.projectId);
      accepted.current.set(key, projectRef);
    }
    completionProject.current = projectRef;
    setLandingProject({ projectRef, receipt: nextReceipt.current++ });
  };

  const start = () => {
    if (busy.current || environmentId === null || target.current !== environmentId) return null;
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      setError(PERMISSION_MESSAGE);
      return null;
    }
    busy.current = true;
    setIsOpening(true);
    setError("");
    return { id: environmentId, current: generation.current };
  };

  // The native picker returns host paths. Other computers, including WSL, use
  // the full-path field until their picker can be routed to the right filesystem.
  const canBrowse =
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    environmentId === primary?.environmentId &&
    environment?.entry.target?._tag === "PrimaryConnectionTarget" &&
    (navigator.platform.startsWith("Mac") || navigator.platform.startsWith("Linux"));

  const chooseFolder = async () => {
    const operation = start();
    if (!operation) return;
    try {
      const picked = await readLocalApi()?.dialogs.pickFolder();
      if (operation.current !== generation.current || target.current !== operation.id) return;
      if (!picked) {
        release();
        return;
      }
      await openPath(picked, operation.id, operation.current);
    } catch {
      if (operation.current !== generation.current || target.current !== operation.id) return;
      setError("Could not choose a folder. Enter its full path below or try again.");
      release();
    }
  };

  const visibleError = !canOpen ? PERMISSION_MESSAGE : error === PERMISSION_MESSAGE ? "" : error;
  return (
    <>
      {showIntroduction ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Choose your main folder
          </h1>
          <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
            Open the folder you work from. Your main folder becomes one workspace.
          </p>
        </>
      ) : null}
      {environmentIds.length > 1 ? (
        <label className="mt-5 block space-y-2 text-sm">
          <span>Computer</span>
          <select
            aria-label="Computer"
            value={environmentId ?? ""}
            disabled={isOpening}
            onChange={(event) => {
              const id = environmentIds.find((candidate) => candidate === event.target.value);
              if (!id || busy.current) return;
              setSelectedId(id);
              setPath("");
              setError("");
            }}
          >
            {environmentIds.map((id) => (
              <option key={id} value={id}>
                {environments.find((entry) => entry.environmentId === id)?.label ?? "Computer"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {canBrowse ? (
        <div className="mt-5">
          <Button disabled={isOpening || !canOpen} onClick={() => void chooseFolder()}>
            Choose folder…
          </Button>
        </div>
      ) : null}
      <form
        className="mt-5 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const operation = start();
          if (operation) void openPath(path, operation.id, operation.current);
        }}
      >
        <label htmlFor="onboarding-main-folder" className="text-sm font-medium">
          Main folder
        </label>
        <Input
          id="onboarding-main-folder"
          value={path}
          placeholder="Full folder path"
          autoComplete="off"
          spellCheck={false}
          disabled={isOpening}
          onChange={(event) => {
            setPath(event.target.value);
            setError("");
          }}
        />
        {visibleError ? (
          <p role="alert" className="text-sm text-destructive">
            {visibleError}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <Button
            type="button"
            variant="ghost-muted"
            disabled={isOpening}
            onClick={() => {
              if (busy.current) return;
              if (onCancel) {
                onCancel();
                return;
              }
              busy.current = true;
              setIsOpening(true);
              void finish(completionProject.current);
            }}
          >
            {onCancel ? "Cancel" : "Choose later"}
          </Button>
          <Button type="submit" disabled={isOpening || !canOpen || path.trim().length === 0}>
            {isOpening ? "Opening…" : "Open folder"}
          </Button>
        </div>
      </form>
    </>
  );
}
