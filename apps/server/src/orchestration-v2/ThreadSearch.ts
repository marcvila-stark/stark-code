import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  parseAgentSessionImportThreadId,
  type OrchestrationSearchThreadHistoryInput,
  type OrchestrationSearchThreadHistoryResult,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadHistoryCursor,
  type OrchestrationThreadHistoryEntry,
  type ThreadHistoryOrigin,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@starkfuture/shared/nodeSqliteClient";

/** Carries no query text: search input is user content. */
export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const SearchRequest = Schema.Struct({ pattern: Schema.String, limit: Schema.Int });
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** At most 240 characters from the start, whitespace collapsed. */
function buildPromptPreview(text: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  return normalizedText.length <= 240 ? normalizedText : `${normalizedText.slice(0, 239)}…`;
}

const HISTORY_DEFAULT_LIMIT = 30;
// A query reads threads newest first, HISTORY_SCAN_BATCH per statement, and
// hands back a cursor after HISTORY_SCAN_BUDGET threads or
// HISTORY_MESSAGE_BUDGET messages. No statement reads more than
// HISTORY_MESSAGE_BATCH messages, so other reads run in between and cancelling
// the request stops it between statements. On a 3,001-thread, 238,000-message
// benchmark the 1,000 newest threads held about 79,000 messages and took about
// 290 ms to read: an ordinary history still pages by threads, and a request
// costs about that much however long one conversation grows.
const HISTORY_SCAN_BATCH = 50;
const HISTORY_SCAN_BUDGET = 1_000;
const HISTORY_MESSAGE_BUDGET = 100_000;
const HISTORY_MESSAGE_BATCH = 10_000;

const HistoryCandidateRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  providerInstanceId: ProviderInstanceId,
  historyOrigin: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  titleMatch: Schema.Number,
});
type HistoryCandidateRow = typeof HistoryCandidateRow.Type;
const decodeHistoryCandidates = Schema.decodeUnknownEffect(Schema.Array(HistoryCandidateRow));
const decodeFirstPrompts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ threadId: ThreadId, text: Schema.NullOr(Schema.String) })),
);
const decodeMessageCounts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ count: Schema.Number })),
);
const MessagePosition = Schema.Struct({ createdAt: IsoDateTime, messageId: MessageId });
type MessagePosition = typeof MessagePosition.Type;
const decodeMessageWindows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...MessagePosition.fields, count: Schema.Number })),
);
const HistoryMessageMatch = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  source: OrchestrationThreadSearchSource,
  messageCreatedAt: IsoDateTime,
});
type HistoryMessageMatch = typeof HistoryMessageMatch.Type;
const decodeHistoryMessageMatches = Schema.decodeUnknownEffect(Schema.Array(HistoryMessageMatch));
const decodeMessageTexts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ messageId: MessageId, text: Schema.String })),
);

/** A thread on a history page and, unless its title matched, its best message match. */
interface HistoryPageRow {
  readonly row: HistoryCandidateRow;
  readonly message: HistoryMessageMatch | null;
}

const historyPosition = (
  position: Pick<OrchestrationThreadHistoryCursor, "updatedAt" | "threadId">,
): OrchestrationThreadHistoryCursor => ({
  updatedAt: position.updatedAt,
  threadId: position.threadId,
});

function historyOrigin(row: HistoryCandidateRow): ThreadHistoryOrigin {
  if (parseAgentSessionImportThreadId(row.threadId) !== null) return "agent-session";
  return row.historyOrigin === "v1_import" ? "v1" : "stark";
}

/** At most 240 characters, centred near the first match. */
function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

/**
 * `search` looks through the finished user and assistant messages of active V2
 * threads in active projects. `searchHistory` lists every thread of active
 * projects, archived ones too, and matches titles as well as messages. Legacy
 * V1 transcripts that have not been imported yet are not searched.
 */
export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
    readonly searchHistory: (
      input: OrchestrationSearchThreadHistoryInput,
    ) => Effect.Effect<OrchestrationSearchThreadHistoryResult, ThreadSearchError>;
  }
>()("stark-code/orchestration-v2/ThreadSearch") {}

export interface ThreadSearchOptions {
  /** Messages one history request reads at most. */
  readonly historyMessageBudget?: number;
  /** Messages one history statement reads at most. */
  readonly historyMessageBatch?: number;
}

const makeWithOptions = Effect.fnUntraced(function* (options: ThreadSearchOptions = {}) {
  const sql = yield* SqlClient.SqlClient;
  const messageBudget = Math.max(1, options.historyMessageBudget ?? HISTORY_MESSAGE_BUDGET);
  const messageBatch = Math.max(1, options.historyMessageBatch ?? HISTORY_MESSAGE_BATCH);

  // One best match per thread: user messages outrank assistant ones, then the
  // newest message wins. Threads order by match kind, then recency.
  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ pattern, limit }) => sql`
      WITH candidate AS (
        SELECT
          threads.thread_id,
          threads.project_id,
          messages.role,
          json_extract(messages.payload_json, '$.text') AS match_text,
          messages.created_at AS message_created_at,
          messages.message_id,
          threads.updated_at AS thread_updated_at
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
      ),
      ranked AS (
        SELECT
          thread_id,
          project_id,
          role AS source,
          match_text,
          message_created_at,
          CASE role WHEN 'user' THEN 0 ELSE 1 END AS match_rank,
          thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE role WHEN 'user' THEN 0 ELSE 1 END ASC,
              message_created_at DESC,
              message_id ASC
          ) AS thread_match_rank
        FROM candidate
      )
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        source,
        match_text AS "matchText",
        message_created_at AS "messageCreatedAt"
      FROM ranked
      WHERE thread_match_rank = 1
      ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC
      LIMIT ${limit}
    `,
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      const rows = yield* searchRows({
        pattern: `%${escapeLikePattern(input.query)}%`,
        limit: input.limit ?? 50,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadSearchError({
              operation: Schema.isSchemaError(cause) ? "decode" : "query",
              cause,
            }),
        ),
      );
      return {
        matches: rows.map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          source: row.source,
          snippet: buildSearchSnippet(row.matchText, input.query),
          messageCreatedAt: row.messageCreatedAt,
        })),
      };
    },
  );

  const originClause = (origin: ThreadHistoryOrigin) => {
    const imported = sql`substr(threads.thread_id, 1, 7) = 'import:'`;
    const fromV1 = sql`json_extract(threads.payload_json, '$.historyOrigin') IS 'v1_import'`;
    switch (origin) {
      case "agent-session":
        return imported;
      case "v1":
        return sql`(${fromV1} AND NOT ${imported})`;
      case "stark":
        return sql`NOT ${fromV1}`;
    }
  };

  // Newest first by (updated_at, thread_id), resuming strictly after `after`,
  // or at its thread when the scan stopped inside it.
  const selectHistoryCandidates = (input: {
    readonly filters: OrchestrationSearchThreadHistoryInput;
    readonly pattern: string | null;
    readonly after: OrchestrationThreadHistoryCursor | null;
    readonly limit: number;
  }) => {
    const { filters, after } = input;
    const archived = filters.archived ?? "include";
    const clauses = [
      sql`threads.deleted_at IS NULL`,
      sql`projects.deleted_at IS NULL`,
      // Subagent work is reached through its parent thread.
      sql`json_extract(threads.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'`,
      ...(archived === "exclude"
        ? [sql`threads.archived_at IS NULL`]
        : archived === "only"
          ? [sql`threads.archived_at IS NOT NULL`]
          : []),
      ...(filters.providerInstanceIds === undefined || filters.providerInstanceIds.length === 0
        ? []
        : [
            sql`COALESCE(threads.provider_instance_id, threads.default_provider) IN ${sql.in(
              filters.providerInstanceIds,
            )}`,
          ]),
      ...(filters.projectIds === undefined || filters.projectIds.length === 0
        ? []
        : [sql`threads.project_id IN ${sql.in(filters.projectIds)}`]),
      ...(filters.updatedAfter === undefined
        ? []
        : [sql`threads.updated_at >= ${filters.updatedAfter}`]),
      ...(filters.origins === undefined || filters.origins.length === 0
        ? []
        : [sql.or(filters.origins.map(originClause))]),
      ...(after === null
        ? []
        : after.beforeMessage === undefined
          ? [
              sql`(threads.updated_at < ${after.updatedAt} OR (threads.updated_at = ${after.updatedAt} AND threads.thread_id < ${after.threadId}))`,
            ]
          : [
              sql`(threads.updated_at < ${after.updatedAt} OR (threads.updated_at = ${after.updatedAt} AND threads.thread_id <= ${after.threadId}))`,
            ]),
    ];
    return sql`
      SELECT
        threads.thread_id AS "threadId",
        threads.project_id AS "projectId",
        threads.title AS "title",
        COALESCE(threads.provider_instance_id, threads.default_provider) AS "providerInstanceId",
        json_extract(threads.payload_json, '$.historyOrigin') AS "historyOrigin",
        threads.archived_at AS "archivedAt",
        threads.created_at AS "createdAt",
        threads.updated_at AS "updatedAt",
        ${input.pattern === null ? sql`0` : sql`threads.title LIKE ${input.pattern} ESCAPE '!'`} AS "titleMatch"
      FROM orchestration_v2_projection_threads AS threads
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE ${sql.and(clauses)}
      ORDER BY threads.updated_at DESC, threads.thread_id DESC
      LIMIT ${input.limit}
    `.pipe(Effect.flatMap(decodeHistoryCandidates));
  };

  // Messages of these threads in every role, counted up to `cap`.
  const countMessages = (threadIds: ReadonlyArray<ThreadId>, cap: number) =>
    sql`
      SELECT COUNT(*) AS "count"
      FROM (
        SELECT 1
        FROM orchestration_v2_projection_messages AS messages
        WHERE messages.thread_id IN ${sql.in(threadIds)}
        LIMIT ${cap}
      )
    `.pipe(
      Effect.flatMap(decodeMessageCounts),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  // Up to `size` of one thread's messages, newest first and older than
  // `before`: how many there are and the oldest of them.
  const selectMessageWindow = (threadId: ThreadId, before: MessagePosition | null, size: number) =>
    sql`
      WITH window_messages AS MATERIALIZED (
        SELECT messages.created_at, messages.message_id
        FROM orchestration_v2_projection_messages AS messages
        WHERE messages.thread_id = ${threadId}
          ${before === null ? sql`` : sql`AND (messages.created_at, messages.message_id) < (${before.createdAt}, ${before.messageId})`}
        ORDER BY messages.created_at DESC, messages.message_id DESC
        LIMIT ${size}
      )
      SELECT
        (SELECT COUNT(*) FROM window_messages) AS "count",
        created_at AS "createdAt",
        message_id AS "messageId"
      FROM window_messages
      ORDER BY created_at ASC, message_id ASC
      LIMIT 1
    `.pipe(
      Effect.flatMap(decodeMessageWindows),
      Effect.map((rows) => rows[0]),
    );

  // The best match per thread among the messages read, ranked as in `search`.
  // Without `range` every message of the threads is read, `limit` being their
  // count. With it, one thread's `limit` messages from `range.from` on, oldest
  // first. Either way `limit` holds the statement to the count taken before,
  // even if messages arrive in between.
  const selectMessageMatches = (input: {
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly pattern: string;
    readonly limit: number;
    readonly range: { readonly from: MessagePosition } | null;
  }) =>
    sql`
      WITH read_messages AS (
        SELECT
          messages.thread_id,
          messages.message_id,
          messages.role,
          messages.created_at,
          CASE
            WHEN messages.streaming = 0 AND messages.role IN ('user', 'assistant')
              THEN json_extract(messages.payload_json, '$.text') LIKE ${input.pattern} ESCAPE '!'
            ELSE 0
          END AS matched
        FROM orchestration_v2_projection_messages AS messages
        WHERE messages.thread_id IN ${sql.in(input.threadIds)}
          ${input.range === null ? sql`` : sql`AND (messages.created_at, messages.message_id) >= (${input.range.from.createdAt}, ${input.range.from.messageId})`}
        ${input.range === null ? sql`` : sql`ORDER BY messages.created_at ASC, messages.message_id ASC`}
        LIMIT ${input.limit}
      ),
      ranked AS (
        SELECT
          thread_id,
          message_id,
          role,
          created_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE role WHEN 'user' THEN 0 ELSE 1 END ASC,
              created_at DESC,
              message_id ASC
          ) AS thread_match_rank
        FROM read_messages
        WHERE matched = 1
      )
      SELECT
        thread_id AS "threadId",
        message_id AS "messageId",
        role AS "source",
        created_at AS "messageCreatedAt"
      FROM ranked
      WHERE thread_match_rank = 1
    `.pipe(
      Effect.flatMap(decodeHistoryMessageMatches),
      Effect.map((rows) => new Map(rows.map((row) => [row.threadId, row]))),
    );

  const selectFirstPrompts = (threadIds: ReadonlyArray<ThreadId>) =>
    sql`
      SELECT
        threads.thread_id AS "threadId",
        (
          SELECT json_extract(messages.payload_json, '$.text')
          FROM orchestration_v2_projection_messages AS messages
          WHERE messages.thread_id = threads.thread_id
            AND messages.role = 'user'
            AND messages.streaming = 0
          ORDER BY messages.created_at ASC, messages.message_id ASC
          LIMIT 1
        ) AS "text"
      FROM orchestration_v2_projection_threads AS threads
      WHERE threads.thread_id IN ${sql.in(threadIds)}
    `.pipe(
      Effect.flatMap(decodeFirstPrompts),
      Effect.map((rows) => new Map(rows.map((row) => [row.threadId, row.text]))),
    );

  const selectMessageTexts = (messageIds: ReadonlyArray<MessageId>) =>
    sql`
      SELECT
        messages.message_id AS "messageId",
        json_extract(messages.payload_json, '$.text') AS "text"
      FROM orchestration_v2_projection_messages AS messages
      WHERE messages.message_id IN ${sql.in(messageIds)}
    `.pipe(
      Effect.flatMap(decodeMessageTexts),
      Effect.map((rows) => new Map(rows.map((row) => [row.messageId, row.text]))),
    );

  // Reads threads newest first until more than `limit` match, a budget runs
  // out, or no thread is left.
  const scanHistoryMatches = Effect.fnUntraced(function* (
    input: OrchestrationSearchThreadHistoryInput,
    pattern: string,
    limit: number,
  ) {
    const page: Array<HistoryPageRow> = [];
    const scan: {
      messageBudget: number;
      /** Every thread up to here is decided; the input cursor until one is. */
      after: OrchestrationThreadHistoryCursor | null;
      /** Where the message budget ran out inside a thread. */
      stoppedInside: OrchestrationThreadHistoryCursor | null;
      exhausted: boolean;
    } = {
      messageBudget,
      after: input.after ?? null,
      stoppedInside: null,
      exhausted: false,
    };

    // Reads one thread's messages newest first, a window per statement,
    // starting before `from`. False when the budget ran out first. The match
    // is the best of the first window that has one, so in a conversation
    // longer than a window a newer assistant match can win over an older user
    // match.
    const readThread = Effect.fnUntraced(function* (
      row: HistoryCandidateRow,
      from: MessagePosition | null,
    ) {
      let before = from;
      while (true) {
        const size = Math.min(scan.messageBudget, messageBatch);
        if (size === 0) {
          if (before !== null) {
            scan.stoppedInside = { ...historyPosition(row), beforeMessage: before };
          }
          return false;
        }
        const window = yield* selectMessageWindow(row.threadId, before, size);
        if (window === undefined) break;
        scan.messageBudget -= window.count;
        const oldest = { createdAt: window.createdAt, messageId: window.messageId };
        const message = (yield* selectMessageMatches({
          threadIds: [row.threadId],
          pattern,
          limit: window.count,
          range: { from: oldest },
        })).get(row.threadId);
        if (message !== undefined) {
          page.push({ row, message });
          break;
        }
        if (window.count < size) break;
        before = oldest;
      }
      scan.after = historyPosition(row);
      return true;
    });

    // Decides `rows` in order. Threads whose messages fit the budget are read
    // in one statement; otherwise the rows are halved, down to a thread read
    // on its own. False when the page filled or the budget ran out first.
    const decideRows = Effect.fnUntraced(function* (rows: ReadonlyArray<HistoryCandidateRow>) {
      const groups = rows.length === 0 ? [] : [rows];
      while (groups.length > 0) {
        if (page.length >= limit) return false;
        const group = groups.shift()!;
        const unread = group.filter((row) => row.titleMatch !== 1).map((row) => row.threadId);
        const cap = Math.min(scan.messageBudget, messageBatch);
        const count = unread.length === 0 ? 0 : yield* countMessages(unread, cap + 1);
        if (count <= cap) {
          const matches =
            count === 0
              ? new Map<ThreadId, HistoryMessageMatch>()
              : yield* selectMessageMatches({
                  threadIds: unread,
                  pattern,
                  limit: count,
                  range: null,
                });
          scan.messageBudget -= count;
          for (const row of group) {
            const message = matches.get(row.threadId);
            if (row.titleMatch === 1) page.push({ row, message: null });
            else if (message !== undefined) page.push({ row, message });
          }
          scan.after = historyPosition(group.at(-1)!);
        } else if (group.length === 1) {
          if (!(yield* readThread(group[0]!, null))) return false;
        } else if (cap === 0) {
          return false;
        } else {
          const middle = Math.ceil(group.length / 2);
          groups.unshift(group.slice(0, middle), group.slice(middle));
        }
      }
      return true;
    });

    for (let scanned = 0; scanned < HISTORY_SCAN_BUDGET; scanned += HISTORY_SCAN_BATCH) {
      const resumeFrom = scan.after?.beforeMessage ?? null;
      const rows = yield* selectHistoryCandidates({
        filters: input,
        pattern,
        after: scan.after,
        limit: HISTORY_SCAN_BATCH,
      });
      const head = rows[0];
      // The thread the previous page stopped inside, unless it changed since.
      const resumesHead =
        resumeFrom !== null &&
        head !== undefined &&
        head.titleMatch !== 1 &&
        head.threadId === scan.after?.threadId &&
        head.updatedAt === scan.after.updatedAt;
      const decided = resumesHead
        ? (yield* readThread(head, resumeFrom)) && (yield* decideRows(rows.slice(1)))
        : yield* decideRows(rows);
      if (!decided) break;
      if (rows.length < HISTORY_SCAN_BATCH) {
        scan.exhausted = true;
        break;
      }
      if (page.length >= limit) break;
    }
    return { page, ...scan };
  });

  const searchHistory: ThreadSearch["Service"]["searchHistory"] = Effect.fn(
    "ThreadSearch.searchHistory",
  )(
    function* (input) {
      const limit = input.limit ?? HISTORY_DEFAULT_LIMIT;
      const query = input.query ?? null;
      let page: ReadonlyArray<HistoryPageRow>;
      let after: OrchestrationThreadHistoryCursor | null;
      let exhausted: boolean;

      if (query === null) {
        // Listing needs no message reads: one statement, one row past the page.
        after = input.after === undefined ? null : historyPosition(input.after);
        const rows = yield* selectHistoryCandidates({
          filters: input,
          pattern: null,
          after,
          limit: limit + 1,
        });
        page = rows.map((row) => ({ row, message: null }));
        exhausted = rows.length <= limit;
      } else {
        const scan = yield* scanHistoryMatches(input, `%${escapeLikePattern(query)}%`, limit);
        page = scan.page;
        after = scan.stoppedInside ?? scan.after;
        exhausted = scan.exhausted;
      }

      // Past a cut page, the next one starts after its last entry. Otherwise
      // every thread up to `after` was read, matching or not.
      const cut = page.length > limit;
      const entriesRows = page.slice(0, limit);
      const lastEntry = entriesRows.at(-1);
      const nextCursor: OrchestrationThreadHistoryCursor | null =
        cut && lastEntry !== undefined ? historyPosition(lastEntry.row) : exhausted ? null : after;
      if (entriesRows.length === 0) return { entries: [], nextCursor };

      const firstPrompts = yield* selectFirstPrompts(
        entriesRows.map((entry) => entry.row.threadId),
      );
      const messageIds = entriesRows.flatMap((entry) =>
        entry.message === null ? [] : [entry.message.messageId],
      );
      const messageTexts =
        messageIds.length === 0
          ? new Map<MessageId, string>()
          : yield* selectMessageTexts(messageIds);

      const entries = entriesRows.map(({ row, message }): OrchestrationThreadHistoryEntry => {
        const firstPrompt = firstPrompts.get(row.threadId) ?? null;
        const messageText = message === null ? undefined : messageTexts.get(message.messageId);
        return {
          threadId: row.threadId,
          projectId: row.projectId,
          title: row.title,
          providerInstanceId: row.providerInstanceId,
          origin: historyOrigin(row),
          archivedAt: row.archivedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          firstPrompt: firstPrompt === null ? null : buildPromptPreview(firstPrompt),
          match:
            query === null
              ? null
              : row.titleMatch === 1
                ? {
                    source: "title",
                    snippet: buildSearchSnippet(row.title, query),
                    messageCreatedAt: null,
                  }
                : message === null || messageText === undefined
                  ? null
                  : {
                      source: message.source,
                      snippet: buildSearchSnippet(messageText, query),
                      messageCreatedAt: message.messageCreatedAt,
                    },
        };
      });
      return { entries, nextCursor };
    },
    // Statements run on the reader worker when the database has one, so a
    // long scan neither blocks the event loop nor queues writes behind it.
    NodeSqliteClient.readOnly,
    Effect.mapError(
      (cause) =>
        new ThreadSearchError({
          operation: Schema.isSchemaError(cause) ? "decode" : "query",
          cause,
        }),
    ),
  );

  return ThreadSearch.of({ search, searchHistory });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = makeWithOptions();

export const layer = Layer.effect(ThreadSearch, make);

export const layerWithOptions = (options: ThreadSearchOptions) =>
  Layer.effect(ThreadSearch, makeWithOptions(options));
