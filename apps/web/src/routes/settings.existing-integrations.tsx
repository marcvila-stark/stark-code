import { createFileRoute } from "@tanstack/react-router";
import { ExistingIntegrationsSettings } from "../components/settings/AlphaSettings";

export const Route = createFileRoute("/settings/existing-integrations")({
  component: ExistingIntegrationsSettings,
});
