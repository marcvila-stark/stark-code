import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AgentSessionImportResult,
  type ThreadHistoryOrigin,
} from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import type {
  EnvironmentThreadHistoryEntry,
  ThreadHistoryFilters,
} from "@starkfuture/client-runtime/state/thread-search";

export const HISTORY_STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
] as const;
export type HistoryStatus = (typeof HISTORY_STATUS_OPTIONS)[number]["value"];

export const HISTORY_ORIGIN_OPTIONS = [
  { value: "any", label: "Any origin" },
  { value: "stark", label: "Started in Stark" },
  { value: "agent-session", label: "Imported from a CLI" },
  { value: "v1", label: "From Stark V1" },
] as const;
export type HistoryOriginFilter = (typeof HISTORY_ORIGIN_OPTIONS)[number]["value"];

export const HISTORY_UPDATED_OPTIONS = [
  { value: "any", label: "Any time", days: null },
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
] as const;
export type HistoryUpdatedPreset = (typeof HISTORY_UPDATED_OPTIONS)[number]["value"];

/**
 * The History page's URL search params; defaults are left out of the URL.
 * Parsed keys stay present as `undefined` when unset, because the router lays
 * the parsed params over the raw ones and an omitted key would let an unparsed
 * value through. The folder pair is the exception: other routes type those
 * keys without `undefined`, so a lone or invalid one may leak through and is
 * ignored unless both are set (see `historyFolder`).
 */
export interface HistorySearch {
  readonly q?: string | undefined;
  readonly status?: Exclude<HistoryStatus, "all"> | undefined;
  readonly origin?: Exclude<HistoryOriginFilter, "any"> | undefined;
  readonly updated?: Exclude<HistoryUpdatedPreset, "any"> | undefined;
  readonly provider?: ProviderInstanceId | undefined;
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  /** Opens the import dialog, for links from the command palette. */
  readonly import?: true | undefined;
}

/** The chosen folder, only when the URL names both its environment and project. */
export function historyFolder(
  search: HistorySearch,
): { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null {
  return isEnvironmentId(search.environmentId) && isProjectId(search.projectId)
    ? { environmentId: search.environmentId, projectId: search.projectId }
    : null;
}

const MAX_QUERY_LENGTH = 200;
const MIN_QUERY_LENGTH = 2;
const isProviderInstanceId = Schema.is(ProviderInstanceId);
const isEnvironmentId = Schema.is(EnvironmentId);
const isProjectId = Schema.is(ProjectId);

// Kept as typed, spaces included, since the search box shows it back; the
// router parses `?q=2026` as a number, which is still a search.
function searchText(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && text.trim() !== ""
    ? text.slice(0, MAX_QUERY_LENGTH)
    : undefined;
}

/** The query sent to the server: trimmed, and none below two characters. */
export function historyQuery(search: HistorySearch): string | null {
  const query = search.q?.trim() ?? "";
  return query.length >= MIN_QUERY_LENGTH ? query : null;
}

export function parseHistorySearch(raw: Record<string, unknown>): HistorySearch {
  // A folder belongs to one environment, so both are kept or neither.
  const folder =
    isEnvironmentId(raw.environmentId) && isProjectId(raw.projectId)
      ? { environmentId: raw.environmentId, projectId: raw.projectId }
      : {};
  return {
    q: searchText(raw.q),
    status: raw.status === "active" || raw.status === "archived" ? raw.status : undefined,
    origin:
      raw.origin === "stark" || raw.origin === "agent-session" || raw.origin === "v1"
        ? raw.origin
        : undefined,
    updated:
      raw.updated === "7d" || raw.updated === "30d" || raw.updated === "90d"
        ? raw.updated
        : undefined,
    provider: isProviderInstanceId(raw.provider) ? raw.provider : undefined,
    ...folder,
    import: raw.import === true || raw.import === "1" || raw.import === 1 ? true : undefined,
  };
}

/**
 * The params after a filter change: `patch` is validated like the URL and
 * unset keys are left out, so a cleared filter leaves the URL. The import
 * dialog param is dropped, since it only opens the dialog once.
 */
export function nextHistorySearch(
  current: HistorySearch,
  patch: Readonly<Record<string, unknown>>,
): HistorySearch {
  const next = parseHistorySearch({ ...current, import: undefined, ...patch });
  return {
    ...(next.q === undefined ? {} : { q: next.q }),
    ...(next.status === undefined ? {} : { status: next.status }),
    ...(next.origin === undefined ? {} : { origin: next.origin }),
    ...(next.updated === undefined ? {} : { updated: next.updated }),
    ...(next.provider === undefined ? {} : { provider: next.provider }),
    ...historyFolder(next),
    ...(next.import === undefined ? {} : { import: next.import }),
  };
}

/** What the server is asked for. A one-character query searches nothing yet. */
export function historyFilters(search: HistorySearch, now: number): ThreadHistoryFilters {
  const query = historyQuery(search);
  const days = HISTORY_UPDATED_OPTIONS.find((option) => option.value === search.updated)?.days;
  const folder = historyFolder(search);
  return {
    ...(query === null ? {} : { query }),
    archived:
      search.status === "active" ? "exclude" : search.status === "archived" ? "only" : "include",
    ...(search.origin === undefined ? {} : { origins: [search.origin] }),
    ...(search.provider === undefined ? {} : { providerInstanceIds: [search.provider] }),
    ...(folder === null ? {} : { projectIds: [folder.projectId] }),
    ...(days === undefined || days === null
      ? {}
      : { updatedAfter: new Date(startOfDay(now) - days * 86_400_000).toISOString() }),
  };
}

// Whole days keep the request, and so its cached result, stable while the page is open.
function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Environments the search runs on: one when a folder is chosen, else every one that can. */
export function historyEnvironmentIds(
  search: HistorySearch,
  supported: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentId> {
  const folder = historyFolder(search);
  if (folder === null) return supported;
  return supported.includes(folder.environmentId) ? [folder.environmentId] : [];
}

export type HistoryRowAction = "open" | "unarchive" | "continue";

/**
 * Open always works, archived threads included. Unarchive applies to archived
 * threads. Continue is offered for an imported CLI session whose provider is
 * enabled, installed and available, since the next message resumes that
 * session. Without it, a message fails as on any thread whose provider is
 * unavailable, and choosing another provider hands it the imported
 * conversation once.
 */
export function historyRowActions(
  entry: Pick<EnvironmentThreadHistoryEntry, "archivedAt" | "origin">,
  options: { readonly providerReady: boolean },
): ReadonlyArray<HistoryRowAction> {
  if (entry.archivedAt !== null) return ["open", "unarchive"];
  return entry.origin === "agent-session" && options.providerReady
    ? ["continue", "open"]
    : ["open"];
}

const CLI_LABEL_BY_DRIVER: Readonly<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
};

export function historyOriginLabel(
  origin: ThreadHistoryOrigin,
  driverKind: string | null,
): string | null {
  if (origin === "v1") return "From Stark V1";
  if (origin !== "agent-session") return null;
  const cli = driverKind === null ? undefined : CLI_LABEL_BY_DRIVER[driverKind];
  return cli === undefined ? "Imported from a CLI" : `Imported from ${cli}`;
}

function sessions(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`;
}

/**
 * The import toast. `importedCount` also counts sessions an earlier import
 * brought in; servers that report `alreadyImportedCount` let the toast say
 * how many are new. Older servers cannot tell, so the toast does not claim it.
 * Sessions Stark Code ran for its own threads are not imported and are named
 * apart.
 */
export function importResultSummary(result: AgentSessionImportResult): {
  readonly title: string;
  readonly description: string | null;
} {
  const skipped = result.skippedCount > 0 ? `${sessions(result.skippedCount)} skipped` : null;
  if (result.alreadyImportedCount === undefined) {
    return {
      title:
        result.importedCount === 0
          ? "No sessions to import"
          : `${sessions(result.importedCount)} in History`,
      description: skipped,
    };
  }
  const added = Math.max(0, result.importedCount - result.alreadyImportedCount);
  const ranInStark = result.alreadyRunByStarkCount ?? 0;
  const parts = [
    ...(result.alreadyImportedCount > 0
      ? [`${sessions(result.alreadyImportedCount)} already imported`]
      : []),
    ...(ranInStark > 0 ? [`${sessions(ranInStark)} already in Stark Code`] : []),
    ...(skipped === null ? [] : [skipped]),
  ];
  return {
    title: added === 0 ? "No new sessions" : `Imported ${sessions(added)}`,
    description: parts.length === 0 ? null : parts.join(" · "),
  };
}
