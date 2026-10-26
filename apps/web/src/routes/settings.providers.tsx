import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@starkfuture/contracts";

import { isAlphaAgentDriver } from "../components/settings/ProviderSettingsPanel.logic";
import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { ProjectDefaultsSettings } from "../components/settings/ProjectDefaultsSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { SettingsDestination } from "../components/settings/AlphaSettings";

/**
 * Providers are machine state, so the page shows one environment at a time:
 * the chosen one from the settings scope selector.
 * A project crumb narrows candidates to where that project is registered.
 */
function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its providers.`
          : "Connect an environment to set up its providers."}
      </p>
    );
  }
  const targetedDriver = target.instanceId
    ? (environment.serverConfig?.settings.providerInstances[target.instanceId]?.driver ??
      environment.serverConfig?.providers.find(
        (provider) => provider.instanceId === target.instanceId,
      )?.driver)
    : undefined;
  const isExistingIntegration = targetedDriver !== undefined && !isAlphaAgentDriver(targetedDriver);
  return (
    <>
      <ProviderSettingsPanel
        environmentId={environment.environmentId}
        mode={isExistingIntegration ? "existing" : "alpha"}
        {...(target.instanceId ? { instanceId: target.instanceId } : {})}
        projectIds={
          scope.kind === "project" || scope.kind === "checkout"
            ? scope.members
                .filter((member) => member.environmentId === environment.environmentId)
                .map((member) => member.id)
            : []
        }
        scoped
      />
      <SettingsPageContainer showScope={false}>
        {!isExistingIntegration ? (
          <ProjectDefaultsSettings category="general" section="agents" />
        ) : null}
        <SettingsDestination
          to="/settings/permissions"
          title="Saved approval rules"
          description="Review what Claude and Codex may do, and forget previous approvals."
        />
      </SettingsPageContainer>
    </>
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
