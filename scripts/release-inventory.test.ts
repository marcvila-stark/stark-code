// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off - The inventory reads a disposable SQLite profile built in a temp directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  captureInventory,
  compareInventories,
  COMPOSER_DRAFTS_KEY,
  flattenSettings,
  type Inventory,
  inventoryDrafts,
  PROMPT_STASH_KEY,
  ProfileInUseError,
  readRendererStorageOverCdp,
} from "./release-inventory.ts";

const SECRETS = {
  apiKey: "sk-live-DO-NOT-LEAK-1234567890",
  bearer: "bearer-DO-NOT-LEAK-abcdef",
  webhookSecret: "whsec-DO-NOT-LEAK-zyx",
  signingKey: "signing-key-DO-NOT-LEAK",
};

const temporaryRoots: string[] = [];
const openDatabases: NodeSqlite.DatabaseSync[] = [];
afterEach(async () => {
  for (const db of openDatabases.splice(0)) db.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const SCHEMA = `
  CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
  CREATE TABLE orchestration_v2_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL);
  CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT);
  CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
  CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, default_model_selection_json TEXT, created_at TEXT NOT NULL, deleted_at TEXT);
  CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL);
  CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY, title TEXT NOT NULL, enabled INTEGER NOT NULL, schedule_json TEXT NOT NULL, project_id TEXT NOT NULL, model_selection_json TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, created_at TEXT NOT NULL, next_run_at TEXT, run_count INTEGER NOT NULL, webhook_token TEXT, webhook_secret TEXT);
  CREATE TABLE scheduled_task_runs (run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, trigger_kind TEXT NOT NULL, dispatch_state TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE orchestration_v2_effect_outbox (effect_id TEXT PRIMARY KEY, status TEXT NOT NULL);
  CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY);
`;

const DRAFTS = JSON.stringify({
  state: {
    draftsByThreadKey: {
      "env:thread-3": {
        prompt: "UPD-run1-T3 half typed",
        attachments: [
          { id: "img-1", name: "a.png", mimeType: "image/png", sizeBytes: 3, dataUrl: "data:" },
        ],
        files: [
          {
            id: "f-1",
            name: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 4,
            attachmentId: "pending-file-1",
          },
        ],
        modelSelectionByProvider: {
          claudeAgent: { provider: "claudeAgent", model: "claude-opus" },
        },
        activeProvider: "claudeAgent",
        runtimeMode: "approval-required",
      },
    },
    draftThreadsByThreadKey: { "env:new-thread": { projectId: "project-1" } },
  },
  version: 9,
});

/** A profile shaped like a Stark home after the rehearsal fixture was created. */
async function makeProfile() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-inventory-test-"));
  temporaryRoots.push(home);
  const stateDir = NodePath.join(home, "userdata");
  await NodeFSP.mkdir(NodePath.join(stateDir, "attachments"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(stateDir, "secrets"));
  await NodeFSP.writeFile(
    NodePath.join(stateDir, "secrets", "server-signing-key.bin"),
    SECRETS.signingKey,
  );
  await NodeFSP.writeFile(NodePath.join(stateDir, "attachments", "thread-1-att-1.png"), "png!");
  await NodeFSP.writeFile(NodePath.join(stateDir, "attachments", "pending-file-1.md"), "notes");
  await NodeFSP.writeFile(
    NodePath.join(stateDir, "settings.json"),
    JSON.stringify({
      defaultModelSelection: { provider: "codex", model: "gpt-5" },
      allowBypassPermissions: false,
      providers: {
        anthropic: { env: { ANTHROPIC_API_KEY: SECRETS.apiKey }, homePath: "/Users/x/.claude" },
      },
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(stateDir, "client-settings.json"),
    JSON.stringify({ theme: "dark" }),
  );
  await NodeFSP.writeFile(
    NodePath.join(stateDir, "saved-environments.json"),
    JSON.stringify({ environments: [{ id: "e1", encryptedBearerToken: SECRETS.bearer }] }),
  );

  const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "statev2.sqlite"));
  openDatabases.push(db);
  // Keep committed rows in the WAL so the capture must copy it to see them.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO effect_sql_migrations VALUES (62, 'ThreadFailureLookupIndex', 'x'), (63, 'ScheduledTaskRuns', 'x');
    INSERT INTO projection_projects VALUES ('project-1', 'Fixture A', '/tmp/fixture-a', '{"provider":"codex","model":"gpt-5"}', '2026-10-30T10:00:00Z', NULL);
    INSERT INTO orchestration_v2_projection_threads VALUES
      ('thread-1', 'project-1', 'UPD-run1-T1 pasted image', 'codex', 'full-access', 'default', '2026-10-30T10:01:00Z', NULL, NULL, '{}', 'codex'),
      ('thread-2', 'project-1', 'Private customer thread', 'claudeAgent', 'approval-required', 'default', '2026-10-30T10:02:00Z', NULL, NULL, '{}', 'claude_personal');
    INSERT INTO orchestration_v2_projection_messages VALUES
      ('m1', 'thread-1', 'user', 0, '2026-10-30T10:01:01Z', 'x', '{"text":"hello UPD-run1-T1","attachments":[{"type":"image","id":"thread-1-att-1"}]}'),
      ('m2', 'thread-1', 'assistant', 0, '2026-10-30T10:01:02Z', 'x', '{"text":"hi"}'),
      ('m3', 'thread-2', 'user', 0, '2026-10-30T10:02:01Z', 'x', '{"text":"confidential"}');
    INSERT INTO orchestration_v2_projection_runs VALUES ('run-1', 'thread-1', 1, 'completed'), ('run-2', 'thread-2', 1, 'waiting');
    INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('req-1', 'thread-2', 'approval', 'declined', '2026-10-30T10:02:02Z');
    INSERT INTO scheduled_tasks VALUES ('task-1', 'UPD-run1 disabled task', 0, '{"kind":"interval","minutes":5}', 'project-1', '{"provider":"codex","model":"gpt-5"}', 'approval-required', 'default', '2026-10-30T10:03:00Z', '2027-01-01T00:00:00Z', 0, 'tok', '${SECRETS.webhookSecret}');
    INSERT INTO orchestration_v2_effect_outbox VALUES ('e1', 'succeeded');
    INSERT INTO auth_sessions VALUES ('s1');
  `);
  for (const [index, type] of ["thread.created", "message.added", "message.added"].entries()) {
    db.prepare(
      "INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)",
    ).run(`event-${index}`, "thread-1", type, "2026-10-30T10:00:00Z", `{"n":${index}}`);
  }
  return { home, stateDir, db };
}

const capture = (home: string, extra: Partial<Parameters<typeof captureInventory>[0]> = {}) =>
  captureInventory({
    home,
    rendererStorage: {
      source: "file",
      values: { [COMPOSER_DRAFTS_KEY]: DRAFTS, [PROMPT_STASH_KEY]: null },
    },
    isProcessAlive: () => false,
    now: () => new Date("2026-10-30T12:00:00Z"),
    ...extra,
  });

const failures = (report: ReturnType<typeof compareInventories>) =>
  report.findings.filter((finding) => finding.level === "failure").map((finding) => finding.area);

describe("capture", () => {
  it("records chats, drafts, settings, projects, providers, modes and tasks without credentials", async () => {
    const profile = await makeProfile();
    const inventory = await capture(profile.home);

    expect(inventory.database.migrations.map((migration) => migration.id)).toEqual([62, 63]);
    expect(inventory.database.events).toMatchObject({ count: 3, maxSequence: 3 });
    const [first, second] = inventory.database.threads;
    expect(first).toMatchObject({
      title: "UPD-run1-T1 pasted image",
      provider: "codex",
      runtimeMode: "full-access",
      messageCount: 2,
      messagesByRole: { user: 1, assistant: 1 },
      attachmentIds: ["thread-1-att-1"],
      distinctive: ["UPD-run1-T1"],
    });
    // Titles without the rehearsal token are private content and are hashed.
    expect(second?.title).toMatch(/^sha256:/);
    expect(second).toMatchObject({ provider: "claude_personal", runtimeMode: "approval-required" });
    expect(inventory.database.projects).toEqual([
      expect.objectContaining({
        workspaceRoot: "/tmp/fixture-a",
        defaultModelSelection: { provider: "codex", model: "gpt-5" },
      }),
    ]);
    expect(inventory.database.scheduledTasks[0]).toMatchObject({
      enabled: false,
      hasWebhook: true,
    });
    expect(inventory.settings["settings.json"]).toMatchObject({
      "defaultModelSelection.model": { kind: "value", value: "gpt-5" },
      allowBypassPermissions: { kind: "value", value: false },
      "providers.anthropic.env.ANTHROPIC_API_KEY": {
        kind: "redacted",
        length: SECRETS.apiKey.length,
      },
    });
    expect(inventory.encryptedStores["saved-environments.json"]).toEqual({
      present: true,
      entries: 1,
    });
    expect(inventory.secrets).toEqual(["server-signing-key.bin"]);
    expect(inventory.renderer.drafts?.[0]).toMatchObject({
      key: "env:thread-3",
      distinctive: ["UPD-run1-T3"],
      imageIds: ["img-1"],
      fileAttachmentIds: ["pending-file-1"],
      activeProvider: "claudeAgent",
      runtimeMode: "approval-required",
    });
    expect(inventory.renderer.draftThreads).toEqual(["env:new-thread"]);
    expect(inventory.renderer.missingAttachmentRefs).toEqual([]);

    const serialized = JSON.stringify(inventory);
    for (const secret of Object.values(SECRETS)) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("confidential");
    expect(serialized).not.toContain("Private customer thread");
  });

  it("refuses while a server still runs against the profile", async () => {
    const profile = await makeProfile();
    await NodeFSP.writeFile(
      NodePath.join(profile.stateDir, "server-runtime.json"),
      JSON.stringify({ version: 1, pid: 4242, port: 1, origin: "x", startedAt: "x" }),
    );
    await expect(capture(profile.home, { isProcessAlive: (pid) => pid === 4242 })).rejects.toThrow(
      ProfileInUseError,
    );
  });

  it("never touches the profile's own database files", async () => {
    const profile = await makeProfile();
    const before = (await NodeFSP.readdir(profile.stateDir)).toSorted();
    const walBefore = await NodeFSP.stat(NodePath.join(profile.stateDir, "statev2.sqlite-wal"));
    await capture(profile.home);
    expect((await NodeFSP.readdir(profile.stateDir)).toSorted()).toEqual(before);
    const walAfter = await NodeFSP.stat(NodePath.join(profile.stateDir, "statev2.sqlite-wal"));
    expect(walAfter.size).toBe(walBefore.size);
    expect(walAfter.mtimeMs).toBe(walBefore.mtimeMs);
  });
});

describe("compare", () => {
  async function beforeAndAfter(
    mutate: (profile: Awaited<ReturnType<typeof makeProfile>>) => Promise<void> | void,
    options: { drafts?: string } = {},
  ) {
    const profile = await makeProfile();
    const before = await capture(profile.home);
    await mutate(profile);
    const after = await capture(profile.home, {
      baseline: before,
      rendererStorage: {
        source: "file",
        values: { [COMPOSER_DRAFTS_KEY]: options.drafts ?? DRAFTS, [PROMPT_STASH_KEY]: null },
      },
    });
    return { before, after };
  }

  it("passes an upgrade that only appends a migration, events and messages", async () => {
    const { before, after } = await beforeAndAfter(({ db }) => {
      db.exec(`
        INSERT INTO effect_sql_migrations VALUES (64, 'UpdateRehearsalMarker', 'x');
        INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json) VALUES ('event-9', 'thread-1', 'message.added', 'x', '{}');
        INSERT INTO orchestration_v2_projection_messages VALUES ('m4', 'thread-1', 'user', 0, '2026-10-30T11:00:00Z', 'x', '{"text":"continued after update"}');
      `);
    });
    const report = compareInventories(before, after);
    expect(report.verdict).toBe("pass");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "allowed",
          area: "migrations",
          detail: "applied 64 UpdateRehearsalMarker",
        }),
        expect.objectContaining({ level: "info", area: "messages" }),
      ]),
    );
  });

  it("fails on a dropped message, a rewritten event and a lost or changed setting", async () => {
    const { before, after } = await beforeAndAfter(async ({ db, stateDir }) => {
      db.exec(`
        DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'm2';
        UPDATE orchestration_v2_events SET payload_json = '{"n":"rewritten"}' WHERE sequence = 2;
      `);
      await NodeFSP.writeFile(
        NodePath.join(stateDir, "settings.json"),
        JSON.stringify({ defaultModelSelection: { provider: "codex", model: "gpt-4" } }),
      );
    });
    const report = compareInventories(before, after);
    expect(report.verdict).toBe("fail");
    expect(failures(report)).toEqual(expect.arrayContaining(["messages", "events", "settings"]));
  });

  it("fails on a lost draft and a missing draft attachment", async () => {
    const { before, after } = await beforeAndAfter(
      ({ stateDir }) => NodeFSP.rm(NodePath.join(stateDir, "attachments", "pending-file-1.md")),
      {
        drafts: JSON.stringify({
          state: { draftsByThreadKey: {}, draftThreadsByThreadKey: {} },
          version: 9,
        }),
      },
    );
    const report = compareInventories(before, after);
    expect(failures(report)).toEqual(expect.arrayContaining(["drafts", "attachments"]));
  });

  it("fails on replayed work: a new run, a new scheduled run, a reopened approval, an earlier next run", async () => {
    const { before, after } = await beforeAndAfter(({ db }) => {
      db.exec(`
        INSERT INTO orchestration_v2_projection_runs VALUES ('run-3', 'thread-1', 2, 'running');
        INSERT INTO scheduled_task_runs VALUES ('srun-1', 'task-1', 'schedule', 'dispatched', 'x');
        UPDATE orchestration_v2_projection_runtime_requests SET status = 'pending' WHERE runtime_request_id = 'req-1';
        UPDATE scheduled_tasks SET next_run_at = '2026-10-30T12:05:00Z' WHERE task_id = 'task-1';
      `);
    });
    const report = compareInventories(before, after);
    expect(failures(report)).toEqual(
      expect.arrayContaining(["runs", "scheduled-tasks", "approvals"]),
    );
    expect(report.findings.filter((finding) => finding.area === "scheduled-tasks")).toHaveLength(2);
    expect(
      failures(compareInventories(before, after, { allowNewRuns: true })).filter(
        (area) => area === "runs",
      ),
    ).toEqual([]);
  });

  it("fails when a project's folder association or a credential store is lost", async () => {
    const { before, after } = await beforeAndAfter(async ({ db, stateDir }) => {
      db.exec("UPDATE projection_projects SET workspace_root = '/tmp/elsewhere'");
      await NodeFSP.rm(NodePath.join(stateDir, "saved-environments.json"));
    });
    expect(failures(compareInventories(before, after))).toEqual(
      expect.arrayContaining(["projects", "credentials"]),
    );
  });

  it("is incomplete, not passing, when drafts or the event prefix were not captured", async () => {
    const profile = await makeProfile();
    const before = await capture(profile.home, { rendererStorage: undefined });
    profile.db.exec(
      "INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json) VALUES ('event-9', 'thread-1', 'x', 'x', '{}')",
    );
    const after = await capture(profile.home, { rendererStorage: undefined });
    const report = compareInventories(before, after);
    expect(report.verdict).toBe("incomplete");
    expect(
      report.findings
        .filter((finding) => finding.level === "unverified")
        .map((finding) => finding.area),
    ).toEqual(expect.arrayContaining(["events", "drafts"]));
  });
});

describe("helpers", () => {
  it("redacts secret-looking keys anywhere in a settings tree", () => {
    const leaves = flattenSettings({
      providers: [{ name: "x", auth: { token: "abc" } }],
      ui: { fontSize: 13, label: "Work" },
    });
    expect(leaves["providers[0].auth.token"]).toEqual({ kind: "redacted", length: 3 });
    expect(leaves["ui.fontSize"]).toEqual({ kind: "value", value: 13 });
    expect(leaves["ui.label"]).toMatchObject({ kind: "hash" });
  });

  it("reads drafts stored with or without the zustand wrapper", () => {
    const bare = inventoryDrafts(
      JSON.stringify({ draftsByThreadKey: { k: { prompt: "UPD-x" } } }),
      /UPD-\w+/,
    );
    expect(bare?.drafts[0]).toMatchObject({ key: "k", distinctive: ["UPD-x"] });
    expect(inventoryDrafts(null, /x/)).toBeNull();
  });

  it("only reads renderer storage from a DevTools port on this machine", async () => {
    await expect(
      readRendererStorageOverCdp("http://192.168.1.5:9333", [COMPOSER_DRAFTS_KEY], async () => {
        throw new Error("network must not be used");
      }),
    ).rejects.toThrow("must be on this machine");
  });

  it("keeps the inventory schema stable for stored before/after files", async () => {
    const profile = await makeProfile();
    const inventory: Inventory = await capture(profile.home);
    expect(Object.keys(inventory).toSorted()).toEqual([
      "attachments",
      "backups",
      "capturedAt",
      "database",
      "desktopProfile",
      "distinctivePattern",
      "encryptedStores",
      "home",
      "label",
      "renderer",
      "schema",
      "secrets",
      "settings",
    ]);
  });
});
