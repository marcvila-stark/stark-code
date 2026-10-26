import { createFileRoute } from "@tanstack/react-router";
import { PermissionRulesSettings } from "../components/settings/PermissionRulesSettings";
export const Route = createFileRoute("/settings/permissions")({
  component: PermissionRulesSettings,
});
