import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type {
  EnvironmentId,
  ProjectId,
  ServerProvider,
  StarkPublishedPagesStatus,
} from "@starkfuture/contracts";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsSearchTarget } from "./settingsLayout";
import {
  mcpSetupFindings,
  pagesSetupFindings,
  previewBrowserSetup,
  providerSetupFindings,
  type SetupFinding,
} from "./setupDoctor";

function Finding({ finding }: { finding: SetupFinding }) {
  return (
    <li className="space-y-1 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{finding.title}</span>
        <span
          className={`shrink-0 text-xs ${finding.state === "attention" ? "text-warning-foreground" : "text-muted-foreground"}`}
        >
          {
            {
              ready: "Reported ready",
              attention: "Needs attention",
              unknown: "Not confirmed",
              disabled: "Disabled",
              "not-installed": "Not installed",
              installing: "Installing",
              unavailable: "Unavailable",
            }[finding.state]
          }
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{finding.detail}</p>
    </li>
  );
}

function McpInspection({
  environmentId,
  projectId,
  provider,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  provider: ServerProvider;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.mcpServers({
      environmentId,
      input: { projectId, providerInstanceId: provider.instanceId },
    }),
  );
  return (
    <>
      {mcpSetupFindings(
        provider.displayName ?? provider.instanceId,
        query.data,
        query.error !== null,
      ).map((finding) => (
        <Finding key={finding.id} finding={finding} />
      ))}
      <li className="pb-2">
        <Button variant="ghost" size="sm" disabled={query.isPending} onClick={query.refresh}>
          Check {provider.displayName ?? provider.instanceId} connections again
        </Button>
      </li>
    </>
  );
}

/** The headless browser HTML previews need, with the only control that installs it. */
function PreviewBrowserSetup({ environmentId }: { environmentId: EnvironmentId }) {
  const status = useAtomValue(serverEnvironment.previewBrowserStatus({ environmentId, input: {} }));
  const allowed = useAtomValue(
    serverEnvironment.installPreviewBrowser.permissionAtom(environmentId),
  );
  const install = useAtomCommand(serverEnvironment.installPreviewBrowser);
  const [starting, setStarting] = useState(false);
  const { finding, installLabel } = previewBrowserSetup(
    status._tag === "Success" ? status.value : null,
    status._tag === "Failure",
  );
  return (
    <SettingsSearchTarget id="preview-browser" className="outline-none">
      <ul>
        <Finding finding={finding} />
      </ul>
      {installLabel === null ? null : (
        <div className="space-y-1 pb-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!allowed || starting}
            onClick={() => {
              setStarting(true);
              void install({ environmentId, input: {} }).finally(() => setStarting(false));
            }}
          >
            {starting ? "Starting install…" : installLabel}
          </Button>
          {allowed ? null : (
            <p className="text-xs text-muted-foreground">
              Installing needs permission to manage agents on this machine.
            </p>
          )}
        </div>
      )}
    </SettingsSearchTarget>
  );
}

/**
 * Checks existing setup reports on demand. No install, login, reconnect or model
 * request, except the preview browser install the user starts from its row.
 */
export function SetupDoctorPanel({
  environmentId,
  environmentLabel,
  providers,
  projects,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  providers: readonly ServerProvider[];
  projects: readonly { id: ProjectId; title: string }[];
}) {
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const project = projects.find((entry) => entry.id === projectId) ?? projects[0];
  const [inspecting, setInspecting] = useState(false);
  const [pages, setPages] = useState<{
    kit: boolean | null;
    status: StarkPublishedPagesStatus | null;
    failed: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const candidates = providers.filter(
    (provider) =>
      provider.enabled && provider.installed && ["claudeAgent", "codex"].includes(provider.driver),
  );
  const pagesAvailable = Boolean(
    window.desktopBridge?.getStarkWorkbenchAvailable && window.desktopBridge?.publishedPages,
  );
  const inspect = async () => {
    setInspecting(true);
    const bridge = window.desktopBridge;
    if (!bridge?.getStarkWorkbenchAvailable || !bridge.publishedPages || busy) return;
    setBusy(true);
    const [kit, status] = await Promise.allSettled([
      bridge.getStarkWorkbenchAvailable(),
      bridge.publishedPages.status(),
    ]);
    setPages({
      kit: kit.status === "fulfilled" ? kit.value : null,
      status: status.status === "fulfilled" ? status.value : null,
      failed: status.status === "rejected",
    });
    setBusy(false);
  };
  return (
    <FoldedSettingsSection
      id="setup-doctor"
      title="Setup doctor"
      summary="Agent readiness and connection diagnostics"
      revealForTargets={["preview-browser"]}
    >
      <div className="space-y-3 px-3 pb-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          Reported setup on {environmentLabel}. These checks do not install software, reconnect
          tools, change sign-ins or verify your full team configuration.
        </p>
        {!connected ? (
          <p className="text-sm text-warning-foreground">
            This computer is disconnected. Agent rows below are its last reported state.
          </p>
        ) : null}
        <ul className="divide-y divide-border/60">
          {providerSetupFindings(providers).map((finding) => (
            <Finding key={finding.id} finding={finding} />
          ))}
        </ul>
        {connected && environment?.serverConfig?.environment.capabilities.previewBrowserInstall ? (
          <PreviewBrowserSetup environmentId={environmentId} />
        ) : null}
        {projects.length > 1 ? (
          <label className="flex items-center gap-3 text-xs">
            Folder
            <select
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
              value={project?.id}
              onChange={(event) => {
                setProjectId(event.target.value as ProjectId);
                setInspecting(false);
              }}
            >
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>
          </label>
        ) : project ? (
          <p className="text-xs text-muted-foreground">Connections for {project.title}.</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Open a folder before checking its MCP connections.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!connected || busy || (inspecting && !pagesAvailable)}
            onClick={() => void inspect()}
          >
            {busy
              ? "Checking…"
              : inspecting
                ? pagesAvailable
                  ? "Check Pages again"
                  : "Connections inspected"
                : "Inspect connections"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void navigate({ to: "/settings/mcp-servers", search: { machine: environmentId } })
            }
          >
            Open Connected tools
          </Button>
        </div>
        {inspecting ? (
          <>
            <p className="text-xs text-muted-foreground">
              Connection checks use this profile and folder. Existing chats and native shells can
              have different connections.
            </p>
            <ul className="divide-y divide-border/60">
              {connected && project
                ? candidates.map((provider) => (
                    <McpInspection
                      key={`${project.id}:${provider.instanceId}`}
                      environmentId={environmentId}
                      projectId={project.id}
                      provider={provider}
                    />
                  ))
                : null}
              {pagesSetupFindings({
                available: pagesAvailable,
                kit: pages?.kit ?? null,
                status: pages?.status ?? null,
                failed: pages?.failed ?? false,
              }).map((finding) => (
                <Finding key={finding.id} finding={finding} />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </FoldedSettingsSection>
  );
}
