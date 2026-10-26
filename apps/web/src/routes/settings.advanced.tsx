import { createFileRoute } from "@tanstack/react-router";
import { AdvancedSettings } from "../components/settings/AlphaSettings";

export const Route = createFileRoute("/settings/advanced")({
  component: AdvancedSettings,
});
