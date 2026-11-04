import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Where a thread's history began: started in Stark, imported from a Claude Code
 * or Codex CLI session, or migrated from Stark V1.
 */
export const ThreadHistoryOrigin = Schema.Literals(["stark", "agent-session", "v1"]);
export type ThreadHistoryOrigin = typeof ThreadHistoryOrigin.Type;

export const ThreadHistoryArchivedFilter = Schema.Literals(["exclude", "include", "only"]);
export type ThreadHistoryArchivedFilter = typeof ThreadHistoryArchivedFilter.Type;

/**
 * Where a history page stopped. History sorts newest first by `updatedAt`,
 * then by thread id, so the id orders threads updated at the same instant.
 * `beforeMessage` is set when a query ran out of its message budget inside
 * this thread: the next page reads the thread's messages older than that one,
 * then older threads. Without it, the next page starts after this thread.
 */
export const OrchestrationThreadHistoryCursor = Schema.Struct({
  updatedAt: IsoDateTime,
  threadId: ThreadId,
  beforeMessage: Schema.optionalKey(
    Schema.Struct({
      createdAt: IsoDateTime,
      messageId: MessageId,
    }),
  ),
});
export type OrchestrationThreadHistoryCursor = typeof OrchestrationThreadHistoryCursor.Type;

/**
 * Lists one environment's threads, archived ones included unless excluded,
 * newest first. Without a query every thread passing the filters is listed;
 * with one, a thread is listed when its title or a finished message matches.
 */
export const OrchestrationSearchThreadHistoryInput = Schema.Struct({
  query: Schema.optionalKey(TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200))),
  /** Defaults to `include`. */
  archived: Schema.optionalKey(ThreadHistoryArchivedFilter),
  origins: Schema.optionalKey(Schema.Array(ThreadHistoryOrigin).check(Schema.isMaxLength(3))),
  providerInstanceIds: Schema.optionalKey(
    Schema.Array(ProviderInstanceId).check(Schema.isMaxLength(32)),
  ),
  projectIds: Schema.optionalKey(Schema.Array(ProjectId).check(Schema.isMaxLength(64))),
  updatedAfter: Schema.optionalKey(IsoDateTime),
  /** Continues after this entry; pass the previous page's `nextCursor`. */
  after: Schema.optionalKey(OrchestrationThreadHistoryCursor),
  /** Defaults to 30. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadHistoryInput =
  typeof OrchestrationSearchThreadHistoryInput.Type;

export const OrchestrationThreadHistoryMatch = Schema.Struct({
  source: Schema.Literals(["title", "user", "assistant"]),
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadHistoryMatch = typeof OrchestrationThreadHistoryMatch.Type;

export const OrchestrationThreadHistoryEntry = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  providerInstanceId: ProviderInstanceId,
  origin: ThreadHistoryOrigin,
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** The thread's first finished user message, shortened to 240 characters. */
  firstPrompt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(240))),
  /** Why the thread matched the query; `null` without a query. */
  match: Schema.NullOr(OrchestrationThreadHistoryMatch),
});
export type OrchestrationThreadHistoryEntry = typeof OrchestrationThreadHistoryEntry.Type;

/**
 * One page of history. A page can hold fewer than `limit` entries while
 * `nextCursor` is set: each request reads a bounded number of threads and
 * messages, so a rare query or a very long conversation continues from the
 * cursor. `null` means nothing older is left.
 */
export const OrchestrationSearchThreadHistoryResult = Schema.Struct({
  entries: Schema.Array(OrchestrationThreadHistoryEntry),
  nextCursor: Schema.NullOr(OrchestrationThreadHistoryCursor),
});
export type OrchestrationSearchThreadHistoryResult =
  typeof OrchestrationSearchThreadHistoryResult.Type;
