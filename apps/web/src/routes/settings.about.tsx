import { createFileRoute } from "@tanstack/react-router";
import { AboutPreferencesPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/about")({
  component: AboutPreferencesPanel,
});
