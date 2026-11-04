import {
  EnvironmentId,
  OrchestrationSearchThreadHistoryInput,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadHistoryCursor,
  type OrchestrationSearchThreadHistoryResult,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadHistoryEntry,
  type OrchestrationThreadSearchMatch,
} from "@starkfuture/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSearchResultsState {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isLoading: boolean;
}

const ThreadSearchKey = Schema.fromJsonString(
  Schema.Tuple([Schema.Array(EnvironmentId), OrchestrationSearchThreadsInput.fields.query]),
);
const decodeThreadSearchKey = Schema.decodeUnknownOption(ThreadSearchKey);

export function makeThreadSearchKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
): string {
  return JSON.stringify([
    [...environmentIds].sort((left, right) => left.localeCompare(right)),
    query,
  ]);
}

function parseThreadSearchKey(key: string) {
  return decodeThreadSearchKey(key);
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

/**
 * Combines one search query atom per environment. Invalid search keys, failed
 * requests, and disconnected environments contribute no content matches,
 * preserving local title search as the compatibility fallback.
 */
export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false };
      }

      const [environmentIds, query] = parsedKey.value;
      const matches: EnvironmentThreadSearchMatch[] = [];
      let isLoading = false;

      for (const environmentId of environmentIds) {
        const result = get(options.getSearchAtom(environmentId, query));
        isLoading ||= result.waiting;
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) {
          matches.push(
            ...value.matches.map((match) => ({
              ...match,
              environmentId,
            })),
          );
        }
      }

      return { matches, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}

export interface EnvironmentThreadHistoryEntry extends OrchestrationThreadHistoryEntry {
  readonly environmentId: EnvironmentId;
}

/** What every environment's history pages share; each page adds its own cursor. */
export type ThreadHistoryFilters = Omit<OrchestrationSearchThreadHistoryInput, "after" | "limit">;

export interface ThreadHistoryOlderPage {
  readonly environmentId: EnvironmentId;
  readonly after: OrchestrationThreadHistoryCursor;
}

export interface ThreadHistoryState {
  /** Newest first, across environments, holding back entries another environment may still precede. */
  readonly entries: ReadonlyArray<EnvironmentThreadHistoryEntry>;
  readonly isLoading: boolean;
  readonly failedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** True while any environment has older threads to read. */
  readonly hasOlder: boolean;
  /** The pages to request next for "Show older"; empty while those pages load. */
  readonly older: ReadonlyArray<ThreadHistoryOlderPage>;
}

const EMPTY_THREAD_HISTORY: ThreadHistoryState = {
  entries: [],
  isLoading: false,
  failedEnvironmentIds: [],
  hasOlder: false,
  older: [],
};

/** Orders history newest first: updated time, then thread id, as the server pages it. */
function compareHistoryPosition(
  left: OrchestrationThreadHistoryCursor,
  right: OrchestrationThreadHistoryCursor,
): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? -1 : 1;
  if (left.threadId !== right.threadId) return left.threadId > right.threadId ? -1 : 1;
  return 0;
}

/** One page's request, with a fixed key order so equal requests share an atom. */
export function threadHistoryPageInput(
  filters: ThreadHistoryFilters,
  after: OrchestrationThreadHistoryCursor | null,
): OrchestrationSearchThreadHistoryInput {
  return {
    ...(filters.query === undefined ? {} : { query: filters.query }),
    ...(filters.archived === undefined ? {} : { archived: filters.archived }),
    ...(filters.origins === undefined ? {} : { origins: filters.origins }),
    ...(filters.providerInstanceIds === undefined
      ? {}
      : { providerInstanceIds: filters.providerInstanceIds }),
    ...(filters.projectIds === undefined ? {} : { projectIds: filters.projectIds }),
    ...(filters.updatedAfter === undefined ? {} : { updatedAfter: filters.updatedAfter }),
    ...(after === null ? {} : { after }),
  };
}

/**
 * Merges each environment's loaded history pages into one newest-first list.
 * An environment with older threads left can still produce entries newer than
 * what others already returned, so entries older than the newest such cursor
 * are kept back, not dropped, until that environment's next page arrives.
 * Failed environments stop holding others back.
 */
export function mergeThreadHistoryPages<E>(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly pages: ReadonlyArray<
      AsyncResult.AsyncResult<OrchestrationSearchThreadHistoryResult, E>
    >;
  }>,
): ThreadHistoryState {
  const loaded: Array<EnvironmentThreadHistoryEntry> = [];
  const failedEnvironmentIds: Array<EnvironmentId> = [];
  const remaining: Array<{
    readonly environmentId: EnvironmentId;
    readonly cursor: OrchestrationThreadHistoryCursor;
    readonly loading: boolean;
  }> = [];
  let isLoading = false;

  for (const environment of environments) {
    let cursor: OrchestrationThreadHistoryCursor | null = null;
    let loadedPages = 0;
    let loading = false;
    let failed = false;
    for (const page of environment.pages) {
      const value = Option.getOrNull(AsyncResult.value(page));
      if (value === null) {
        if (AsyncResult.isFailure(page)) failed = true;
        else loading = true;
        break;
      }
      loading ||= page.waiting;
      loadedPages += 1;
      cursor = value.nextCursor;
      for (const entry of value.entries) {
        loaded.push({ ...entry, environmentId: environment.environmentId });
      }
    }
    isLoading ||= loading;
    if (failed) {
      failedEnvironmentIds.push(environment.environmentId);
    } else if (cursor !== null && loadedPages > 0) {
      remaining.push({ environmentId: environment.environmentId, cursor, loading });
    }
  }

  let frontier: OrchestrationThreadHistoryCursor | null = null;
  for (const environment of remaining) {
    if (frontier === null || compareHistoryPosition(environment.cursor, frontier) < 0) {
      frontier = environment.cursor;
    }
  }
  const visible =
    frontier === null
      ? loaded
      : loaded.filter((entry) => compareHistoryPosition(entry, frontier) <= 0);
  visible.sort(
    (left, right) =>
      compareHistoryPosition(left, right) ||
      (left.environmentId < right.environmentId
        ? -1
        : left.environmentId > right.environmentId
          ? 1
          : 0),
  );
  const older =
    frontier === null
      ? []
      : remaining
          .filter(
            (environment) =>
              !environment.loading && compareHistoryPosition(environment.cursor, frontier) === 0,
          )
          .map((environment) => ({
            environmentId: environment.environmentId,
            after: environment.cursor,
          }));

  return {
    entries: visible,
    isLoading,
    failedEnvironmentIds,
    hasOlder: remaining.length > 0,
    older,
  };
}

const ThreadHistoryKey = Schema.fromJsonString(
  Schema.Struct({
    filters: OrchestrationSearchThreadHistoryInput,
    environments: Schema.Array(
      Schema.Struct({
        environmentId: EnvironmentId,
        cursors: Schema.Array(Schema.NullOr(OrchestrationThreadHistoryCursor)),
      }),
    ),
  }),
);
const decodeThreadHistoryKey = Schema.decodeUnknownOption(ThreadHistoryKey);

/**
 * Names one merged history view: the shared filters, and per environment the
 * cursor of every page loaded so far (`null` for the first page).
 */
export function makeThreadHistoryKey(
  filters: ThreadHistoryFilters,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly cursors: ReadonlyArray<OrchestrationThreadHistoryCursor | null>;
  }>,
): string {
  return JSON.stringify({
    filters: threadHistoryPageInput(filters, null),
    environments: [...environments]
      .sort((left, right) => left.environmentId.localeCompare(right.environmentId))
      .map((environment) => ({
        environmentId: environment.environmentId,
        cursors: environment.cursors,
      })),
  });
}

export function threadHistoryEntryKey(
  entry: Pick<EnvironmentThreadHistoryEntry, "environmentId" | "threadId">,
): string {
  return JSON.stringify([entry.environmentId, entry.threadId]);
}

/** One merged history view per key, built from one query atom per loaded page. */
export function createThreadHistoryResultsAtomFamily<E>(options: {
  readonly getHistoryAtom: (
    environmentId: EnvironmentId,
    input: OrchestrationSearchThreadHistoryInput,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadHistoryResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadHistoryState => {
      const parsedKey = decodeThreadHistoryKey(key);
      if (Option.isNone(parsedKey)) return EMPTY_THREAD_HISTORY;
      const { filters, environments } = parsedKey.value;
      return mergeThreadHistoryPages(
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          pages: environment.cursors.map((cursor) =>
            get(
              options.getHistoryAtom(
                environment.environmentId,
                threadHistoryPageInput(filters, cursor),
              ),
            ),
          ),
        })),
      );
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}
