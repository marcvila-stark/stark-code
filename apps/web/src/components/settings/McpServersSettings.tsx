import { useState } from "react";
import { ProjectId, ProviderInstanceId } from "@starkfuture/contracts";
import { useProjects } from "../../state/entities";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";
import { McpServersPanel } from "../chat/McpServersPanel";
import { SettingsScopeSentence } from "./SettingsScopeSentence";
import { SettingsDestination } from "./AlphaSettings";
import { Link } from "@tanstack/react-router";

export function McpServersSettings() {
  const { environment, scope } = useSettingsScope();
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environment?.environmentId &&
      ((scope.kind !== "project" && scope.kind !== "checkout") ||
        scope.members.some(
          (member) =>
            member.environmentId === project.environmentId &&
            member.id === project.id,
        )),
  );
  const providers =
    environment?.serverConfig?.providers.filter(
      (provider) =>
        provider.driver === "codex" || provider.driver === "claudeAgent",
    ) ?? [];
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const project =
    projects.find((entry) => entry.id === projectId) ?? projects[0];
  const provider =
    providers.find((entry) => entry.instanceId === instanceId) ?? providers[0];
  return (
    <SettingsPageContainer showScope={false}>
      <div className="rounded-lg border border-border/60">
        <SettingsDestination
          to="/settings/integrations"
          title="Browser & privacy"
          description="Import sign-ins, manage isolated profiles and choose what agents can access."
        />
        <Link
          to="/settings/source-control"
          search={{ view: "accounts" }}
          className="block px-4 py-3 text-sm hover:bg-muted/40"
        >
          <span className="block font-medium">GitHub accounts</span>
          <span className="mt-1 block text-muted-foreground">
            Connect GitHub or manage existing source control credentials.
          </span>
        </Link>
      </div>
      <div>
        {!environment || !project || !provider ? (
          <>
            <div className="stark-settings-intro">
              <h1>Connected tools</h1>
              <p>Connections for the selected agent and folder.</p>
            </div>
            <div className="stark-settings-scope">
              <SettingsScopeSentence />
            </div>
          </>
        ) : null}
        {!environment ? (
          <p className="text-sm text-muted-foreground">
            Connect a computer to view its connected tools.
          </p>
        ) : !project || !provider ? (
          <p className="text-sm text-muted-foreground">
            Choose a folder and connect Claude or Codex to inspect its tools.
          </p>
        ) : (
          <McpServersPanel
            showHeading={false}
            presentation="settings"
            key={`${environment.environmentId}:${project.id}:${provider.instanceId}`}
            environmentId={environment.environmentId}
            target={{
              projectId: project.id,
              providerInstanceId: provider.instanceId,
            }}
            scopeControls={
              <>
                <SettingsScopeSentence />
                <div
                  className="stark-mcp-scope"
                  aria-label={`${environment.label} · ${project.workspaceRoot}`}
                >
                  <label>
                    <span className="sr-only">Folder</span>
                    <select
                      aria-label="Connected tools folder"
                      value={project.id}
                      onChange={(event) =>
                        setProjectId(ProjectId.make(event.target.value))
                      }
                    >
                      {projects.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span aria-hidden className="text-muted-foreground">
                    /
                  </span>
                  <label>
                    <span className="sr-only">Agent</span>
                    <select
                      aria-label="Connected tools agent"
                      value={provider.instanceId}
                      onChange={(event) =>
                        setInstanceId(
                          ProviderInstanceId.make(event.target.value),
                        )
                      }
                    >
                      {providers.map((entry) => (
                        <option key={entry.instanceId} value={entry.instanceId}>
                          {entry.displayName ?? entry.instanceId}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            }
          />
        )}
      </div>
    </SettingsPageContainer>
  );
}
