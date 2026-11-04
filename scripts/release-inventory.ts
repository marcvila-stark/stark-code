#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off preferSchemaOverJson:off - Maintainer rehearsal tool that reads a disposable profile with plain Node before any app runtime exists.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

/**
 * Captures what a Stark Code profile has persisted, so a before/after pair
 * proves an update kept it: chats and messages, drafts and their attachment
 * references, settings, projects and folder associations, provider and model
 * selections, permission modes, scheduled tasks, runs, approvals, migration
 * history, attachments and backups.
 *
 * It reads a private copy of the database, never the profile's own files, and
 * refuses while a server still runs against the profile. Credentials are never
 * written: secret-looking settings keep only their presence and length, the
 * encrypted desktop stores only their entry counts, `secrets/` only file names,
 * and webhook tokens are not selected at all. Other free text is hashed unless
 * it carries the rehearsal's distinctive token.
 *
 * It imports only Node built-ins, so it can be copied and run on its own.
 */

const INVENTORY_SCHEMA = 1;
const DEFAULT_DISTINCTIVE = "UPD-[A-Za-z0-9_-]+";
const SECRET_KEY =
  /token|secret|password|passphrase|credential|api[-_]?key|bearer|cookie|authorization|private|signing/i;
const RAW_VALUE_KEY =
  /model|provider|runtimeMode|interactionMode|theme|bypass|permission|approval|channel|locale|font|envMode/i;
export const COMPOSER_DRAFTS_KEY = "starkcode:composer-drafts:v1";
export const PROMPT_STASH_KEY = "starkcode:prompt-stash:v2";

// U2: backupDirectoryCandidates
/**
 * Where U2 writes verified backups (`<id>/manifest.json`). Both candidates are
 * listed until U2's location is integrated. Kept here, not in the shared
 * seams module, so this file runs on its own (R2 copies it to another account).
 */
function backupDirectoryCandidates(starkHome: string): ReadonlyArray<string> {
  return [NodePath.join(starkHome, "backups"), NodePath.join(starkHome, "userdata", "backups")];
}

const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const shortHash = (value: string) => `sha256:${sha256(value).slice(0, 16)}`;

// ---------------------------------------------------------------------------
// Inventory shape

export type SettingLeaf =
  | { readonly kind: "value"; readonly value: string | number | boolean | null }
  | { readonly kind: "hash"; readonly hash: string }
  | { readonly kind: "redacted"; readonly length: number };

export interface ThreadInventory {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: string | null;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly messageCount: number;
  readonly messagesByRole: Readonly<Record<string, number>>;
  readonly messageChain: string;
  /** With `--baseline`: the chain over the baseline's message count. */
  readonly messageChainAtBaseline?: string;
  readonly attachmentIds: ReadonlyArray<string>;
  readonly distinctive: ReadonlyArray<string>;
}

export interface DraftInventory {
  readonly key: string;
  readonly promptHash: string;
  readonly promptLength: number;
  readonly distinctive: ReadonlyArray<string>;
  readonly imageIds: ReadonlyArray<string>;
  readonly fileAttachmentIds: ReadonlyArray<string>;
  readonly modelSelections: unknown;
  readonly activeProvider: string | null;
  readonly runtimeMode: string | null;
  readonly interactionMode: string | null;
}

export interface Inventory {
  readonly schema: typeof INVENTORY_SCHEMA;
  readonly capturedAt: string;
  readonly label: string | null;
  readonly home: string;
  readonly distinctivePattern: string;
  readonly database: {
    readonly present: boolean;
    readonly migrations: ReadonlyArray<{ readonly id: number; readonly name: string }>;
    readonly events: {
      readonly count: number;
      readonly maxSequence: number;
      readonly chain: string;
      readonly prefix?: { readonly upToSequence: number; readonly chain: string };
    };
    readonly threads: ReadonlyArray<ThreadInventory>;
    readonly projects: ReadonlyArray<{
      readonly projectId: string;
      readonly title: string;
      readonly workspaceRoot: string;
      readonly defaultModelSelection: unknown;
      readonly deleted: boolean;
    }>;
    readonly runs: ReadonlyArray<{
      readonly runId: string;
      readonly threadId: string;
      readonly status: string;
    }>;
    readonly runtimeRequests: ReadonlyArray<{
      readonly requestId: string;
      readonly threadId: string;
      readonly kind: string;
      readonly status: string;
    }>;
    readonly scheduledTasks: ReadonlyArray<{
      readonly taskId: string;
      readonly title: string;
      readonly enabled: boolean;
      readonly scheduleHash: string;
      readonly projectId: string;
      readonly modelSelection: unknown;
      readonly runtimeMode: string;
      readonly interactionMode: string;
      readonly nextRunAt: string | null;
      readonly runCount: number;
      readonly hasWebhook: boolean;
    }>;
    readonly scheduledTaskRuns: ReadonlyArray<{
      readonly runId: string;
      readonly taskId: string;
      readonly triggerKind: string;
      readonly dispatchState: string;
    }>;
    readonly outboxByStatus: Readonly<Record<string, number>>;
    readonly authSessionCount: number;
  };
  readonly settings: Readonly<Record<string, Readonly<Record<string, SettingLeaf>> | null>>;
  readonly encryptedStores: Readonly<
    Record<string, { readonly present: boolean; readonly entries: number | null }>
  >;
  readonly secrets: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<{
    readonly name: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
  readonly renderer: {
    readonly source: "cdp" | "file" | "not-captured";
    readonly drafts: ReadonlyArray<DraftInventory> | null;
    readonly draftThreads: ReadonlyArray<string> | null;
    readonly stash: ReadonlyArray<{
      readonly id: string;
      readonly promptHash: string;
      readonly fileAttachmentIds: ReadonlyArray<string>;
    }> | null;
    readonly missingAttachmentRefs: ReadonlyArray<string>;
  };
  readonly backups: ReadonlyArray<{
    readonly path: string;
    readonly reason: string | null;
    readonly appVersion: string | null;
    readonly createdAt: string | null;
  }>;
  readonly desktopProfile: {
    readonly path: string | null;
    readonly entries: ReadonlyArray<string>;
  };
}

// ---------------------------------------------------------------------------
// Helpers

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await NodeFSP.readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function distinctiveTokens(text: string, pattern: RegExp): ReadonlyArray<string> {
  return [...new Set(text.match(new RegExp(pattern.source, "g")) ?? [])].toSorted();
}

/**
 * Flattens a JSON settings document into `path → leaf`. Secret-looking keys
 * keep only their length; selection and permission keys keep their value so a
 * diff is readable; everything else is hashed.
 */
export function flattenSettings(document: unknown): Record<string, SettingLeaf> {
  const leaves: Record<string, SettingLeaf> = {};
  const visit = (value: unknown, path: string, secret: boolean, raw: boolean) => {
    if (Array.isArray(value)) {
      if (value.length === 0) leaves[path] = { kind: "value", value: "[]" };
      value.forEach((item, index) => visit(item, `${path}[${index}]`, secret, raw));
      return;
    }
    const record = asRecord(value);
    if (record !== undefined) {
      const keys = Object.keys(record).toSorted();
      if (keys.length === 0) leaves[path] = { kind: "value", value: "{}" };
      for (const key of keys) {
        visit(
          record[key],
          path === "" ? key : `${path}.${key}`,
          secret || SECRET_KEY.test(key),
          raw || RAW_VALUE_KEY.test(key),
        );
      }
      return;
    }
    const scalar = value === undefined ? null : (value as string | number | boolean | null);
    if (secret) {
      leaves[path] = { kind: "redacted", length: String(scalar ?? "").length };
    } else if (raw || typeof scalar === "boolean" || scalar === null) {
      leaves[path] = { kind: "value", value: scalar };
    } else {
      leaves[path] = { kind: "hash", hash: shortHash(String(scalar)) };
    }
  };
  visit(document, "", false, false);
  return leaves;
}

// ---------------------------------------------------------------------------
// Database

const tableNames = (db: NodeSqlite.DatabaseSync) =>
  new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );

const columnNames = (db: NodeSqlite.DatabaseSync, table: string) =>
  new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );

type Row = Record<string, unknown>;
const text = (value: unknown) =>
  typeof value === "string" ? value : value == null ? "" : String(value);

function readDatabase(
  dbPath: string,
  options: {
    readonly distinctive: RegExp;
    readonly rawTitles: boolean;
    readonly baseline: Inventory | undefined;
  },
): Inventory["database"] {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    const tables = tableNames(db);
    const all = (sql: string): Row[] => db.prepare(sql).all() as Row[];
    const has = (table: string) => tables.has(table);

    const migrations = has("effect_sql_migrations")
      ? all("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id").map(
          (row) => ({
            id: Number(row["migration_id"]),
            name: text(row["name"]),
          }),
        )
      : [];

    let chain = "";
    let count = 0;
    let maxSequence = 0;
    let prefix: { upToSequence: number; chain: string } | undefined;
    const prefixAt = options.baseline?.database.events.maxSequence;
    if (has("orchestration_v2_events")) {
      if (prefixAt === 0) prefix = { upToSequence: 0, chain: "" };
      for (const row of db
        .prepare(
          "SELECT sequence, event_id, event_type, thread_id, payload_json FROM orchestration_v2_events ORDER BY sequence",
        )
        .iterate() as Iterable<Row>) {
        const sequence = Number(row["sequence"]);
        chain = sha256(
          `${chain}\u0000${sequence}\u0000${text(row["event_id"])}\u0000${text(row["event_type"])}\u0000${text(row["thread_id"])}\u0000${sha256(text(row["payload_json"]))}`,
        );
        count += 1;
        maxSequence = sequence;
        if (prefixAt !== undefined && sequence === prefixAt)
          prefix = { upToSequence: sequence, chain };
      }
    }

    const baselineThreads = new Map(
      (options.baseline?.database.threads ?? []).map((thread) => [thread.threadId, thread]),
    );
    const messagesByThread = new Map<string, Row[]>();
    if (has("orchestration_v2_projection_messages")) {
      for (const row of all(
        "SELECT message_id, thread_id, role, created_at, payload_json FROM orchestration_v2_projection_messages ORDER BY thread_id, created_at, message_id",
      )) {
        const list = messagesByThread.get(text(row["thread_id"])) ?? [];
        list.push(row);
        messagesByThread.set(text(row["thread_id"]), list);
      }
    }

    const threadColumns = has("orchestration_v2_projection_threads")
      ? columnNames(db, "orchestration_v2_projection_threads")
      : new Set<string>();
    const threads: ThreadInventory[] = has("orchestration_v2_projection_threads")
      ? all(
          `SELECT thread_id, project_id, title, default_provider, ${threadColumns.has("provider_instance_id") ? "provider_instance_id" : "NULL AS provider_instance_id"}, runtime_mode, interaction_mode, archived_at, deleted_at FROM orchestration_v2_projection_threads ORDER BY created_at, thread_id`,
        ).map((row) => {
          const threadId = text(row["thread_id"]);
          const messages = messagesByThread.get(threadId) ?? [];
          const byRole: Record<string, number> = {};
          const attachmentIds = new Set<string>();
          const found = new Set<string>();
          let messageChain = "";
          let chainAtBaseline: string | undefined;
          const baselineCount = baselineThreads.get(threadId)?.messageCount;
          if (baselineCount === 0) chainAtBaseline = "";
          messages.forEach((message, index) => {
            const role = text(message["role"]);
            byRole[role] = (byRole[role] ?? 0) + 1;
            const payload = asRecord(parseJson(text(message["payload_json"]))) ?? {};
            const body = text(payload["text"]);
            for (const token of distinctiveTokens(body, options.distinctive)) found.add(token);
            for (const attachment of Array.isArray(payload["attachments"])
              ? payload["attachments"]
              : []) {
              const id = asRecord(attachment)?.["id"];
              if (typeof id === "string") attachmentIds.add(id);
            }
            messageChain = sha256(
              `${messageChain}\u0000${text(message["message_id"])}\u0000${role}\u0000${sha256(body)}`,
            );
            if (baselineCount !== undefined && index + 1 === baselineCount)
              chainAtBaseline = messageChain;
          });
          const title = text(row["title"]);
          const titleTokens = distinctiveTokens(title, options.distinctive);
          return {
            threadId,
            projectId: text(row["project_id"]),
            title: options.rawTitles || titleTokens.length > 0 ? title : shortHash(title),
            provider: text(row["provider_instance_id"]) || text(row["default_provider"]) || null,
            runtimeMode: text(row["runtime_mode"]),
            interactionMode: text(row["interaction_mode"]),
            archived: row["archived_at"] != null,
            deleted: row["deleted_at"] != null,
            messageCount: messages.length,
            messagesByRole: byRole,
            messageChain,
            ...(chainAtBaseline === undefined ? {} : { messageChainAtBaseline: chainAtBaseline }),
            attachmentIds: [...attachmentIds].toSorted(),
            distinctive: [...new Set([...titleTokens, ...found])].toSorted(),
          };
        })
      : [];

    const projectColumns = has("projection_projects")
      ? columnNames(db, "projection_projects")
      : new Set<string>();
    const projects = has("projection_projects")
      ? all(
          `SELECT project_id, title, workspace_root, ${projectColumns.has("default_model_selection_json") ? "default_model_selection_json" : "NULL AS default_model_selection_json"}, deleted_at FROM projection_projects ORDER BY created_at, project_id`,
        ).map((row) => ({
          projectId: text(row["project_id"]),
          title: text(row["title"]),
          workspaceRoot: text(row["workspace_root"]),
          defaultModelSelection: parseJson(text(row["default_model_selection_json"])) ?? null,
          deleted: row["deleted_at"] != null,
        }))
      : [];

    const runs = has("orchestration_v2_projection_runs")
      ? all(
          "SELECT run_id, thread_id, status FROM orchestration_v2_projection_runs ORDER BY thread_id, ordinal",
        ).map((row) => ({
          runId: text(row["run_id"]),
          threadId: text(row["thread_id"]),
          status: text(row["status"]),
        }))
      : [];

    const runtimeRequests = has("orchestration_v2_projection_runtime_requests")
      ? all(
          "SELECT runtime_request_id, thread_id, kind, status FROM orchestration_v2_projection_runtime_requests ORDER BY created_at, runtime_request_id",
        ).map((row) => ({
          requestId: text(row["runtime_request_id"]),
          threadId: text(row["thread_id"]),
          kind: text(row["kind"]),
          status: text(row["status"]),
        }))
      : [];

    const taskColumns = has("scheduled_tasks")
      ? columnNames(db, "scheduled_tasks")
      : new Set<string>();
    // webhook_token and webhook_secret are never selected; only their presence.
    const scheduledTasks = has("scheduled_tasks")
      ? all(
          `SELECT task_id, title, enabled, schedule_json, project_id, model_selection_json, runtime_mode, interaction_mode, next_run_at, run_count, ${taskColumns.has("webhook_token") ? "webhook_token IS NOT NULL" : "0"} AS has_webhook FROM scheduled_tasks ORDER BY created_at, task_id`,
        ).map((row) => {
          const title = text(row["title"]);
          return {
            taskId: text(row["task_id"]),
            title:
              options.rawTitles || distinctiveTokens(title, options.distinctive).length > 0
                ? title
                : shortHash(title),
            enabled: Number(row["enabled"]) === 1,
            scheduleHash: shortHash(text(row["schedule_json"])),
            projectId: text(row["project_id"]),
            modelSelection: parseJson(text(row["model_selection_json"])) ?? null,
            runtimeMode: text(row["runtime_mode"]),
            interactionMode: text(row["interaction_mode"]),
            nextRunAt: row["next_run_at"] == null ? null : text(row["next_run_at"]),
            runCount: Number(row["run_count"]),
            hasWebhook: Number(row["has_webhook"]) === 1,
          };
        })
      : [];

    const scheduledTaskRuns = has("scheduled_task_runs")
      ? all(
          "SELECT run_id, task_id, trigger_kind, dispatch_state FROM scheduled_task_runs ORDER BY created_at, run_id",
        ).map((row) => ({
          runId: text(row["run_id"]),
          taskId: text(row["task_id"]),
          triggerKind: text(row["trigger_kind"]),
          dispatchState: text(row["dispatch_state"]),
        }))
      : [];

    const outboxByStatus: Record<string, number> = {};
    if (has("orchestration_v2_effect_outbox")) {
      for (const row of all(
        "SELECT status, COUNT(*) AS n FROM orchestration_v2_effect_outbox GROUP BY status",
      )) {
        outboxByStatus[text(row["status"])] = Number(row["n"]);
      }
    }
    const authSessionCount = has("auth_sessions")
      ? Number((all("SELECT COUNT(*) AS n FROM auth_sessions")[0] ?? {})["n"] ?? 0)
      : 0;

    return {
      present: true,
      migrations,
      events: { count, maxSequence, chain, ...(prefix === undefined ? {} : { prefix }) },
      threads,
      projects,
      runs,
      runtimeRequests,
      scheduledTasks,
      scheduledTaskRuns,
      outboxByStatus,
      authSessionCount,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Renderer storage (drafts and stash)

export function inventoryDrafts(
  rawDrafts: string | null | undefined,
  distinctive: RegExp,
): { drafts: DraftInventory[]; draftThreads: string[] } | null {
  if (rawDrafts == null) return null;
  const parsed = asRecord(parseJson(rawDrafts));
  const state = asRecord(parsed?.["state"]) ?? parsed;
  if (state === undefined) return null;
  const drafts = Object.entries(asRecord(state["draftsByThreadKey"]) ?? {})
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const draft = asRecord(value) ?? {};
      const prompt = text(draft["prompt"]);
      const ids = (list: unknown, field: string) =>
        (Array.isArray(list) ? list : [])
          .map((item) => asRecord(item)?.[field])
          .filter((id): id is string => typeof id === "string")
          .toSorted();
      return {
        key,
        promptHash: shortHash(prompt),
        promptLength: prompt.length,
        distinctive: distinctiveTokens(prompt, distinctive),
        imageIds: ids(draft["attachments"], "id"),
        fileAttachmentIds: ids(draft["files"], "attachmentId"),
        modelSelections: draft["modelSelectionByProvider"] ?? null,
        activeProvider:
          typeof draft["activeProvider"] === "string" ? draft["activeProvider"] : null,
        runtimeMode: typeof draft["runtimeMode"] === "string" ? draft["runtimeMode"] : null,
        interactionMode:
          typeof draft["interactionMode"] === "string" ? draft["interactionMode"] : null,
      };
    });
  return {
    drafts,
    draftThreads: Object.keys(asRecord(state["draftThreadsByThreadKey"]) ?? {}).toSorted(),
  };
}

function inventoryStash(rawStash: string | null | undefined) {
  if (rawStash == null) return null;
  const parsed = asRecord(parseJson(rawStash));
  const state = asRecord(parsed?.["state"]) ?? parsed;
  const entries = Array.isArray(state?.["entries"]) ? state["entries"] : [];
  return entries.map((entry) => {
    const record = asRecord(entry) ?? {};
    return {
      id: text(record["id"]),
      promptHash: shortHash(text(record["prompt"])),
      fileAttachmentIds: (Array.isArray(record["files"]) ? record["files"] : [])
        .map((file) => asRecord(file)?.["attachmentId"])
        .filter((id): id is string => typeof id === "string")
        .toSorted(),
    };
  });
}

/** Reads the renderer's localStorage values through the app's DevTools port. */
export async function readRendererStorageOverCdp(
  cdpUrl: string,
  keys: ReadonlyArray<string>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Record<string, string | null>> {
  const base = new URL(cdpUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
    throw new Error("The DevTools endpoint must be on this machine.");
  }
  const targets = (await (await fetchImpl(new URL("/json/list", base))).json()) as Array<{
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page =
    targets.find((target) => target.type === "page" && target.url?.startsWith("starkcode://")) ??
    targets.find((target) => target.type === "page");
  if (!page?.webSocketDebuggerUrl)
    throw new Error("No app window is exposed on the DevTools port.");
  const expression = `JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((key) => [key, localStorage.getItem(key)])))`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl!);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const message = asRecord(parseJson(String(event.data)));
      if (message?.["id"] !== 1) return;
      socket.close();
      const value = asRecord(asRecord(message["result"])?.["result"])?.["value"];
      const parsed = typeof value === "string" ? asRecord(parseJson(value)) : undefined;
      if (parsed === undefined) {
        reject(new Error("The app window did not return its storage."));
        return;
      }
      resolve(parsed as Record<string, string | null>);
    });
    socket.addEventListener("error", () => reject(new Error("DevTools connection failed.")));
  });
}

// ---------------------------------------------------------------------------
// Capture

export class ProfileInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileInUseError";
  }
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface CaptureOptions {
  readonly home: string;
  readonly desktopDataDir?: string | undefined;
  readonly label?: string | undefined;
  readonly distinctive?: string | undefined;
  readonly rawTitles?: boolean | undefined;
  readonly baseline?: Inventory | undefined;
  /** localStorage values, from `--renderer-storage` or `--cdp`. */
  readonly rendererStorage?:
    | { readonly source: "cdp" | "file"; readonly values: Record<string, string | null> }
    | undefined;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

/** Copies the database out (main file plus WAL) and inventories the copy. */
export async function captureInventory(options: CaptureOptions): Promise<Inventory> {
  const home = NodePath.resolve(options.home);
  const stateDir = NodePath.join(home, "userdata");
  const distinctive = new RegExp(options.distinctive ?? DEFAULT_DISTINCTIVE);

  const runtime = asRecord(
    parseJson((await readOptional(NodePath.join(stateDir, "server-runtime.json"))) ?? ""),
  );
  const pid = typeof runtime?.["pid"] === "number" ? runtime["pid"] : undefined;
  if (pid !== undefined && (options.isProcessAlive ?? processAlive)(pid)) {
    throw new ProfileInUseError(
      `A Stark server (pid ${pid}) still runs against ${home}. Quit the app first so the capture is consistent.`,
    );
  }

  let database: Inventory["database"];
  const dbPath = NodePath.join(stateDir, "statev2.sqlite");
  const copyDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stark-inventory-"));
  try {
    await NodeFSP.chmod(copyDir, 0o700);
    const copied = NodePath.join(copyDir, "statev2.sqlite");
    await NodeFSP.copyFile(dbPath, copied);
    await NodeFSP.copyFile(`${dbPath}-wal`, `${copied}-wal`).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
      },
    );
    database = readDatabase(copied, {
      distinctive,
      rawTitles: options.rawTitles ?? false,
      baseline: options.baseline,
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    database = {
      present: false,
      migrations: [],
      events: { count: 0, maxSequence: 0, chain: "" },
      threads: [],
      projects: [],
      runs: [],
      runtimeRequests: [],
      scheduledTasks: [],
      scheduledTaskRuns: [],
      outboxByStatus: {},
      authSessionCount: 0,
    };
  } finally {
    await NodeFSP.rm(copyDir, { recursive: true, force: true });
  }

  const settings: Record<string, Record<string, SettingLeaf> | null> = {};
  for (const name of [
    "settings.json",
    "keybindings.json",
    "desktop-settings.json",
    "client-settings.json",
  ]) {
    const raw = await readOptional(NodePath.join(stateDir, name));
    settings[name] =
      raw === undefined ? null : flattenSettings(parseJson(raw) ?? { unreadable: true });
  }
  const environmentId = await readOptional(NodePath.join(stateDir, "environment-id"));
  if (environmentId !== undefined) {
    settings["environment-id"] = { "": { kind: "hash", hash: shortHash(environmentId.trim()) } };
  }

  const encryptedStores: Record<string, { present: boolean; entries: number | null }> = {};
  for (const name of ["saved-environments.json", "connection-catalog.json"]) {
    const raw = await readOptional(NodePath.join(stateDir, name));
    const parsed = raw === undefined ? undefined : parseJson(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Object.values(asRecord(parsed) ?? {}).find((value) => Array.isArray(value));
    encryptedStores[name] = {
      present: raw !== undefined,
      entries: Array.isArray(list) ? list.length : null,
    };
  }

  const secrets = (
    await NodeFSP.readdir(NodePath.join(stateDir, "secrets")).catch(() => [])
  ).toSorted();

  const attachments: Array<{ name: string; bytes: number; sha256: string }> = [];
  for (const name of (
    await NodeFSP.readdir(NodePath.join(stateDir, "attachments")).catch(() => [])
  ).toSorted()) {
    const filePath = NodePath.join(stateDir, "attachments", name);
    const stat = await NodeFSP.stat(filePath);
    if (!stat.isFile()) continue;
    attachments.push({ name, bytes: stat.size, sha256: sha256(await NodeFSP.readFile(filePath)) });
  }

  const draftInventory = inventoryDrafts(
    options.rendererStorage?.values[COMPOSER_DRAFTS_KEY],
    distinctive,
  );
  const stash = inventoryStash(options.rendererStorage?.values[PROMPT_STASH_KEY]);
  const referenced = [
    ...(draftInventory?.drafts.flatMap((draft) => draft.fileAttachmentIds) ?? []),
    ...(stash?.flatMap((entry) => entry.fileAttachmentIds) ?? []),
    ...database.threads.flatMap((thread) => thread.attachmentIds),
  ];
  const missingAttachmentRefs = [...new Set(referenced)]
    .filter((id) => !attachments.some((file) => file.name === id || file.name.startsWith(`${id}.`)))
    .toSorted();

  const backups: Array<{
    path: string;
    reason: string | null;
    appVersion: string | null;
    createdAt: string | null;
  }> = [];
  for (const dir of backupDirectoryCandidates(home)) {
    for (const entry of (await NodeFSP.readdir(dir).catch(() => [])).toSorted()) {
      const manifest = asRecord(
        parseJson((await readOptional(NodePath.join(dir, entry, "manifest.json"))) ?? ""),
      );
      backups.push({
        path: NodePath.relative(home, NodePath.join(dir, entry)),
        reason: typeof manifest?.["reason"] === "string" ? manifest["reason"] : null,
        appVersion:
          typeof asRecord(manifest?.["app"])?.["version"] === "string"
            ? (asRecord(manifest?.["app"])?.["version"] as string)
            : null,
        createdAt: typeof manifest?.["createdAt"] === "string" ? manifest["createdAt"] : null,
      });
    }
  }

  const desktopProfilePath =
    options.desktopDataDir === undefined ? null : NodePath.resolve(options.desktopDataDir);
  const desktopEntries =
    desktopProfilePath === null
      ? []
      : (await NodeFSP.readdir(desktopProfilePath).catch(() => [])).toSorted();

  return {
    schema: INVENTORY_SCHEMA,
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    label: options.label ?? null,
    home,
    distinctivePattern: distinctive.source,
    database,
    settings,
    encryptedStores,
    secrets,
    attachments,
    renderer: {
      source: options.rendererStorage?.source ?? "not-captured",
      drafts: draftInventory?.drafts ?? null,
      draftThreads: draftInventory?.draftThreads ?? null,
      stash,
      missingAttachmentRefs,
    },
    backups,
    desktopProfile: { path: desktopProfilePath, entries: desktopEntries },
  };
}

// ---------------------------------------------------------------------------
// Compare

export type FindingLevel = "failure" | "unverified" | "allowed" | "info";

export interface Finding {
  readonly level: FindingLevel;
  readonly area: string;
  readonly detail: string;
}

export interface CompareOptions {
  /** Runs started after the before capture, for example a continued conversation. */
  readonly allowNewRuns?: boolean;
  /** Approvals raised after the before capture by a run the tester started. */
  readonly allowNewRequests?: boolean;
}

export interface CompareReport {
  readonly verdict: "pass" | "fail" | "incomplete";
  readonly findings: ReadonlyArray<Finding>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// Mirrors the open statuses the projection store treats as waiting on a person.
const OPEN_REQUEST = /^(pending|waiting)$/;
const TERMINAL_RUN = /^(completed|interrupted|failed|cancelled|rolled_back)$/;

/**
 * Compares two captures of the same profile. Data may grow (new events,
 * appended messages, new migrations) but nothing captured before may be lost
 * or rewritten, no run or scheduled run may appear that the tester did not
 * start, and no resolved approval may reopen.
 */
export function compareInventories(
  before: Inventory,
  after: Inventory,
  options: CompareOptions = {},
): CompareReport {
  const findings: Finding[] = [];
  const add = (level: FindingLevel, area: string, detail: string) =>
    findings.push({ level, area, detail });

  if (!before.database.present) add("unverified", "database", "the before capture has no database");
  if (!after.database.present) add("failure", "database", "the after capture has no database");

  const beforeMigrations = before.database.migrations;
  const afterMigrations = after.database.migrations;
  if (!same(afterMigrations.slice(0, beforeMigrations.length), beforeMigrations)) {
    add(
      "failure",
      "migrations",
      "the migration history before the update is not a prefix of the history after it",
    );
  } else {
    for (const migration of afterMigrations.slice(beforeMigrations.length)) {
      add("allowed", "migrations", `applied ${migration.id} ${migration.name}`);
    }
  }

  const beforeEvents = before.database.events;
  const afterEvents = after.database.events;
  if (afterEvents.maxSequence < beforeEvents.maxSequence) {
    add(
      "failure",
      "events",
      `the event log shrank from ${beforeEvents.maxSequence} to ${afterEvents.maxSequence}`,
    );
  } else if (afterEvents.maxSequence === beforeEvents.maxSequence) {
    if (afterEvents.chain !== beforeEvents.chain) add("failure", "events", "events were rewritten");
  } else if (afterEvents.prefix?.upToSequence !== beforeEvents.maxSequence) {
    add(
      "unverified",
      "events",
      "the after capture has no prefix hash; capture it with --baseline <before>",
    );
  } else if (afterEvents.prefix.chain !== beforeEvents.chain) {
    add("failure", "events", `events up to ${beforeEvents.maxSequence} were rewritten`);
  } else {
    add(
      "info",
      "events",
      `${afterEvents.maxSequence - beforeEvents.maxSequence} new events after ${beforeEvents.maxSequence}`,
    );
  }

  const afterThreads = new Map(after.database.threads.map((thread) => [thread.threadId, thread]));
  for (const thread of before.database.threads) {
    const next = afterThreads.get(thread.threadId);
    const name = `${thread.title} (${thread.threadId})`;
    if (next === undefined) {
      add("failure", "threads", `${name} is gone`);
      continue;
    }
    for (const field of [
      "title",
      "projectId",
      "provider",
      "runtimeMode",
      "interactionMode",
      "archived",
      "deleted",
    ] as const) {
      if (!same(thread[field], next[field])) {
        add(
          "failure",
          "threads",
          `${name}: ${field} changed from ${String(thread[field])} to ${String(next[field])}`,
        );
      }
    }
    if (next.messageCount < thread.messageCount) {
      add(
        "failure",
        "messages",
        `${name}: ${thread.messageCount - next.messageCount} message(s) lost`,
      );
    } else if (next.messageCount === thread.messageCount) {
      if (next.messageChain !== thread.messageChain)
        add("failure", "messages", `${name}: messages were rewritten`);
    } else if (next.messageChainAtBaseline === undefined) {
      add(
        "unverified",
        "messages",
        `${name}: grew by ${next.messageCount - thread.messageCount}; capture with --baseline to verify the earlier messages`,
      );
    } else if (next.messageChainAtBaseline !== thread.messageChain) {
      add("failure", "messages", `${name}: earlier messages were rewritten`);
    } else {
      add("info", "messages", `${name}: ${next.messageCount - thread.messageCount} new message(s)`);
    }
    for (const id of thread.attachmentIds) {
      if (!next.attachmentIds.includes(id))
        add("failure", "messages", `${name}: attachment ${id} no longer referenced`);
    }
  }
  for (const thread of after.database.threads) {
    if (!before.database.threads.some((candidate) => candidate.threadId === thread.threadId)) {
      add("info", "threads", `new thread ${thread.title} (${thread.threadId})`);
    }
  }

  const afterProjects = new Map(
    after.database.projects.map((project) => [project.projectId, project]),
  );
  for (const project of before.database.projects) {
    const next = afterProjects.get(project.projectId);
    if (next === undefined) add("failure", "projects", `project ${project.title} is gone`);
    else if (!same(project, next))
      add(
        "failure",
        "projects",
        `project ${project.title} changed (folder, title, default model or deletion)`,
      );
  }

  const beforeRuns = new Map(before.database.runs.map((run) => [run.runId, run]));
  for (const run of after.database.runs) {
    const previous = beforeRuns.get(run.runId);
    if (previous === undefined) {
      add(
        options.allowNewRuns ? "allowed" : "failure",
        "runs",
        `new run ${run.runId} in thread ${run.threadId} (${run.status})`,
      );
    } else if (TERMINAL_RUN.test(previous.status) && !TERMINAL_RUN.test(run.status)) {
      add("failure", "runs", `run ${run.runId} went from ${previous.status} back to ${run.status}`);
    }
  }
  for (const run of before.database.runs) {
    if (!after.database.runs.some((candidate) => candidate.runId === run.runId)) {
      add("failure", "runs", `run ${run.runId} is gone`);
    }
  }

  const beforeRequests = new Map(
    before.database.runtimeRequests.map((request) => [request.requestId, request]),
  );
  for (const request of after.database.runtimeRequests) {
    const previous = beforeRequests.get(request.requestId);
    if (previous === undefined) {
      if (OPEN_REQUEST.test(request.status)) {
        add(
          options.allowNewRequests ? "allowed" : "failure",
          "approvals",
          `new open request ${request.requestId} (${request.kind}, ${request.status})`,
        );
      }
    } else if (!OPEN_REQUEST.test(previous.status) && OPEN_REQUEST.test(request.status)) {
      add(
        "failure",
        "approvals",
        `request ${request.requestId} reopened: ${previous.status} → ${request.status}`,
      );
    }
  }

  const afterTasks = new Map(after.database.scheduledTasks.map((task) => [task.taskId, task]));
  for (const task of before.database.scheduledTasks) {
    const next = afterTasks.get(task.taskId);
    if (next === undefined) {
      add("failure", "scheduled-tasks", `task ${task.title} is gone`);
      continue;
    }
    for (const field of [
      "title",
      "enabled",
      "scheduleHash",
      "projectId",
      "modelSelection",
      "runtimeMode",
      "interactionMode",
      "hasWebhook",
    ] as const) {
      if (!same(task[field], next[field]))
        add("failure", "scheduled-tasks", `task ${task.title}: ${field} changed`);
    }
    if (task.nextRunAt !== null && next.nextRunAt !== null && next.nextRunAt < task.nextRunAt) {
      add(
        "failure",
        "scheduled-tasks",
        `task ${task.title}: next run moved earlier (${task.nextRunAt} → ${next.nextRunAt}), which can replay work`,
      );
    }
  }
  const beforeTaskRuns = new Set(before.database.scheduledTaskRuns.map((run) => run.runId));
  for (const run of after.database.scheduledTaskRuns) {
    if (!beforeTaskRuns.has(run.runId)) {
      add(
        "failure",
        "scheduled-tasks",
        `new scheduled run ${run.runId} of task ${run.taskId} (${run.triggerKind})`,
      );
    }
  }

  for (const [file, leaves] of Object.entries(before.settings)) {
    const next = after.settings[file];
    if (leaves === null) continue;
    if (next == null) {
      add("failure", "settings", `${file} is gone`);
      continue;
    }
    for (const [path, leaf] of Object.entries(leaves)) {
      const nextLeaf = next[path];
      if (nextLeaf === undefined)
        add("failure", "settings", `${file}: ${path || "(root)"} was lost`);
      else if (!same(leaf, nextLeaf))
        add("failure", "settings", `${file}: ${path || "(root)"} changed`);
    }
    for (const path of Object.keys(next)) {
      if (!(path in leaves)) add("info", "settings", `${file}: ${path} is new`);
    }
  }

  for (const [name, store] of Object.entries(before.encryptedStores)) {
    const next = after.encryptedStores[name];
    if (store.present && (next === undefined || !next.present))
      add("failure", "credentials", `${name} is gone`);
    else if (store.present && next !== undefined && (next.entries ?? 0) < (store.entries ?? 0)) {
      add("failure", "credentials", `${name} lost entries (${store.entries} → ${next.entries})`);
    }
  }
  for (const name of before.secrets) {
    if (!after.secrets.includes(name)) add("failure", "credentials", `secrets/${name} is gone`);
  }

  const afterAttachments = new Map(after.attachments.map((file) => [file.name, file]));
  for (const file of before.attachments) {
    const next = afterAttachments.get(file.name);
    if (next === undefined) add("failure", "attachments", `${file.name} is gone`);
    else if (next.sha256 !== file.sha256) add("failure", "attachments", `${file.name} changed`);
  }
  for (const id of after.renderer.missingAttachmentRefs) {
    if (!before.renderer.missingAttachmentRefs.includes(id)) {
      add("failure", "attachments", `attachment ${id} is referenced but its file is missing`);
    }
  }

  if (before.renderer.drafts === null || after.renderer.drafts === null) {
    add(
      "unverified",
      "drafts",
      "drafts were not captured on both sides (pass --cdp or --renderer-storage)",
    );
  } else {
    const afterDrafts = new Map(after.renderer.drafts.map((draft) => [draft.key, draft]));
    for (const draft of before.renderer.drafts) {
      const next = afterDrafts.get(draft.key);
      if (next === undefined) add("failure", "drafts", `draft ${draft.key} is gone`);
      else if (!same(draft, next))
        add("failure", "drafts", `draft ${draft.key} changed (prompt, attachments, model or mode)`);
    }
  }
  if (before.renderer.stash !== null && after.renderer.stash !== null) {
    for (const entry of before.renderer.stash) {
      if (!after.renderer.stash.some((candidate) => same(candidate, entry))) {
        add("failure", "stash", `stash entry ${entry.id} is gone or changed`);
      }
    }
  }

  for (const backup of after.backups) {
    if (!before.backups.some((candidate) => candidate.path === backup.path)) {
      add(
        "info",
        "backups",
        `new backup ${backup.path} (${backup.reason ?? "no reason"}, from ${backup.appVersion ?? "unknown version"})`,
      );
    }
  }

  const verdict = findings.some((finding) => finding.level === "failure")
    ? "fail"
    : findings.some((finding) => finding.level === "unverified")
      ? "incomplete"
      : "pass";
  return { verdict, findings };
}

// ---------------------------------------------------------------------------
// CLI

const usage = `Usage:
  node scripts/release-inventory.ts renderer --cdp http://127.0.0.1:<port> --out <file>
  node scripts/release-inventory.ts capture --home <stark home> --out <file>
      [--desktop-data <electron profile dir>] [--cdp http://127.0.0.1:<port>]
      [--renderer-storage <json>] [--baseline <before.json>] [--label <text>]
      [--distinctive <regex>] [--raw-titles]
  node scripts/release-inventory.ts compare <before.json> <after.json>
      [--allow-new-runs] [--allow-new-requests] [--out <report.json>]

Save renderer storage while the app runs; quit the app before capturing. Use --baseline <before.json> when capturing
"after" so appended events and messages can be checked against the earlier ones.`;

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = NodeUtil.parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      out: { type: "string" },
      "desktop-data": { type: "string" },
      cdp: { type: "string" },
      "renderer-storage": { type: "string" },
      baseline: { type: "string" },
      label: { type: "string" },
      distinctive: { type: "string" },
      "raw-titles": { type: "boolean", default: false },
      "allow-new-runs": { type: "boolean", default: false },
      "allow-new-requests": { type: "boolean", default: false },
    },
  });
  if (command === "renderer" && values.cdp && values.out) {
    // Run while the app is open: drafts and the stash live in the renderer.
    const storage = await readRendererStorageOverCdp(values.cdp, [
      COMPOSER_DRAFTS_KEY,
      PROMPT_STASH_KEY,
    ]);
    await NodeFSP.writeFile(values.out, `${JSON.stringify(storage, null, 2)}\n`, { mode: 0o600 });
    console.log(`Saved renderer storage → ${values.out}`);
    return 0;
  }
  if (command === "capture" && values.home && values.out) {
    const keys = [COMPOSER_DRAFTS_KEY, PROMPT_STASH_KEY];
    const rendererStorage = values.cdp
      ? { source: "cdp" as const, values: await readRendererStorageOverCdp(values.cdp, keys) }
      : values["renderer-storage"]
        ? {
            source: "file" as const,
            values: JSON.parse(
              await NodeFSP.readFile(values["renderer-storage"], "utf8"),
            ) as Record<string, string | null>,
          }
        : undefined;
    const inventory = await captureInventory({
      home: values.home,
      desktopDataDir: values["desktop-data"],
      label: values.label,
      distinctive: values.distinctive,
      rawTitles: values["raw-titles"],
      baseline: values.baseline
        ? (JSON.parse(await NodeFSP.readFile(values.baseline, "utf8")) as Inventory)
        : undefined,
      rendererStorage,
    });
    await NodeFSP.writeFile(values.out, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
    console.log(
      `Captured ${inventory.database.threads.length} threads, ${inventory.database.events.count} events, ${inventory.renderer.drafts?.length ?? "no"} drafts → ${values.out}`,
    );
    return 0;
  }
  if (command === "compare" && positionals.length === 2) {
    const [beforePath, afterPath] = positionals as [string, string];
    const report = compareInventories(
      JSON.parse(await NodeFSP.readFile(beforePath, "utf8")) as Inventory,
      JSON.parse(await NodeFSP.readFile(afterPath, "utf8")) as Inventory,
      { allowNewRuns: values["allow-new-runs"], allowNewRequests: values["allow-new-requests"] },
    );
    for (const finding of report.findings) {
      console.log(`${finding.level.toUpperCase().padEnd(10)} ${finding.area}: ${finding.detail}`);
    }
    console.log(`Verdict: ${report.verdict}`);
    if (values.out) await NodeFSP.writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
    return report.verdict === "pass" ? 0 : 1;
  }
  console.error(usage);
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : cause);
      process.exitCode = 1;
    },
  );
}
