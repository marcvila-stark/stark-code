import { createFileRoute } from "@tanstack/react-router";

import { SourceControlSettingsPanel } from "../components/settings/SourceControlSettings";

export const Route = createFileRoute("/settings/source-control")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(raw.view === "accounts" ? { view: "accounts" as const } : {}),
  }),
  component: () => <SourceControlSettingsPanel view={Route.useSearch().view ?? "advanced"} />,
});
