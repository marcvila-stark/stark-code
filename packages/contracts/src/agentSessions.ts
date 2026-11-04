import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Coding agent home directories the scanner knows how to read. */
export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

/** File identity saved with an imported session so bounded retries can skip unchanged history. */
export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  inode: Schema.NullOr(Schema.Number),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

/**
 * Empty for now. Kept as a struct so future scan options (source filters,
 * explicit roots) can be added without a new method.
 */
export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A directory that at least one agent CLI has run in, suitable for import as a
 * Stark Code project. `alreadyImported` marks candidates that already have an
 * active project rooted at the same path.
 */
/**
 * Git identity of a candidate directory, read from `.git/config` without
 * spawning git. `remoteKey` is the normalized origin URL, shared by every
 * clone of the same repository so the client can group them. `repository`
 * is the GitHub `owner/name` when the origin is on GitHub.
 */
export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  /**
   * `null` when the directory is not the root of a git repository. Missing on
   * servers that predate the git scan, where the client cannot tell repositories
   * from plain folders and should treat every candidate as a standalone project.
   */
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(Schema.Literals(["recent-project", "all-local"])),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  /** Sessions that now have a thread, including ones an earlier import created. */
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  /**
   * The part of `importedCount` that an earlier import had already brought in;
   * the difference is what this import added. Missing on older servers, which
   * cannot tell the two apart.
   */
  alreadyImportedCount: Schema.optionalKey(NonNegativeInt),
  /**
   * Sessions Stark Code itself ran for one of its threads. They are already in
   * History under that thread, so they are not imported and not part of
   * `importedCount`. Missing on older servers, which import them as well.
   */
  alreadyRunByStarkCount: Schema.optionalKey(NonNegativeInt),
  updatedCount: Schema.optional(NonNegativeInt),
  unchangedCount: Schema.optional(NonNegativeInt),
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}

const AGENT_SESSION_IMPORT_THREAD_PREFIX = "import:";
const isProviderInstanceId = Schema.is(ProviderInstanceId);

/**
 * The thread an imported CLI session lives in. The id is stable, so importing
 * the same session again finds the same thread, and the server recognizes an
 * imported thread by it: keep the format, threads imported earlier depend on it.
 */
export function agentSessionImportThreadId(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
}): ThreadId {
  return ThreadId.make(
    `${AGENT_SESSION_IMPORT_THREAD_PREFIX}${input.providerInstanceId}:${input.providerSessionId}`,
  );
}

/** The CLI session a thread was imported from, or `null` for any other thread. */
export function parseAgentSessionImportThreadId(threadId: string): {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
} | null {
  if (!threadId.startsWith(AGENT_SESSION_IMPORT_THREAD_PREFIX)) return null;
  const rest = threadId.slice(AGENT_SESSION_IMPORT_THREAD_PREFIX.length);
  // Instance ids are slugs, so the first colon ends the instance id.
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const providerInstanceId = rest.slice(0, separator);
  const providerSessionId = rest.slice(separator + 1);
  if (!isProviderInstanceId(providerInstanceId) || providerSessionId.trim() === "") return null;
  return { providerInstanceId, providerSessionId };
}

/** Local history discovery is opt-in and never launches a provider. */
export const AgentSessionSyncConfig = Schema.Struct({
  enabled: Schema.Boolean,
  projectId: Schema.NullOr(ProjectId),
});
export type AgentSessionSyncConfig = typeof AgentSessionSyncConfig.Type;

export const AgentSessionSyncStatus = Schema.Struct({
  ...AgentSessionSyncConfig.fields,
  running: Schema.Boolean,
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  lastResult: Schema.NullOr(AgentSessionImportResult),
  error: Schema.NullOr(Schema.String),
});
export type AgentSessionSyncStatus = typeof AgentSessionSyncStatus.Type;
