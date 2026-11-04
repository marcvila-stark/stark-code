import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { HistoryPage } from "../components/history/HistoryPage";
import { parseHistorySearch, type HistorySearch } from "../components/history/history.logic";

export const Route = createFileRoute("/_chat/history")({
  validateSearch: parseHistorySearch,
  component: HistoryRouteView,
});

function HistoryRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Filters replace the entry, so Back leaves History instead of stepping
  // through every filter, and returning to History restores the last ones.
  const onSearchChange = useCallback(
    (next: HistorySearch) => void navigate({ search: next, replace: true }),
    [navigate],
  );
  return <HistoryPage search={search} onSearchChange={onSearchChange} />;
}
