import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { AdvancedPreferencesPanel } from "./SettingsPanels";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import { IntegrationsSettingsPanel } from "./IntegrationsSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import type { SettingsPath } from "./settingsSearch";

export function SettingsDestination({
  to,
  title,
  description,
}: {
  to: SettingsPath;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="flex min-h-16 items-center gap-4 rounded-lg px-3 py-3 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring sm:px-4"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

export function AdvancedSettings() {
  return (
    <SettingsPageContainer
      heading="Advanced"
      description="Runtime preferences and maintenance for this installation."
    >
      <AdvancedPreferencesPanel />
      <SettingsSection title="Maintenance">
        <SettingsDestination
          to="/settings/storage"
          title="Storage & cleanup"
          description="Review local storage and protect work before removing it."
        />
        <SettingsDestination
          to="/settings/source-control"
          title="Git behavior"
          description="Pulls, merges, branch names and writing preferences."
        />
        <SettingsDestination
          to="/settings/diagnostics"
          title="Diagnostics"
          description="Logs and connection details for troubleshooting."
        />
      </SettingsSection>
      <details className="rounded-lg border border-border/60">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          Manage existing setup
        </summary>
        <p className="px-4 pb-2 text-sm text-muted-foreground">
          Previously configured integrations and jobs remain available here.
        </p>
        <SettingsDestination
          to="/settings/existing-integrations"
          title="Saved integrations"
          description="Manage other agents, usage sources and device hosts already configured."
        />
        <SettingsDestination
          to="/settings/connections"
          title="Existing connections"
          description="Review connected computers and revoke access or turn off sharing."
        />
        <SettingsDestination
          to="/settings/scheduled-tasks"
          title="Existing scheduled tasks"
          description="Edit, pause or delete tasks and review their history."
        />
        <SettingsDestination
          to="/settings/snap-shot"
          title="SnapShots"
          description="Manage screen capture access and shortcuts."
        />
      </details>
    </SettingsPageContainer>
  );
}

export function ExistingIntegrationsSettings() {
  const { environment } = useSettingsScope();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProviderSettingsPanel
        mode="existing"
        {...(environment ? { environmentId: environment.environmentId } : {})}
        scoped
      />
      <IntegrationsSettingsPanel mode="existing-devices" />
    </div>
  );
}
