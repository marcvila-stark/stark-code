import { createFileRoute } from "@tanstack/react-router";
import { PagesHome } from "../components/PagesHome";

export const Route = createFileRoute("/_chat/pages")({
  validateSearch: (search: Record<string, unknown>): { folder?: string } =>
    typeof search.folder === "string" ? { folder: search.folder } : {},
  component: PagesRoute,
});

function PagesRoute() {
  const { folder } = Route.useSearch();
  return <PagesHome key={folder ?? "company"} folder={folder} />;
}
