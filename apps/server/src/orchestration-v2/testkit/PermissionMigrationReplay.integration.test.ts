/**
 * The startup permission freeze (PLAN-002 §2, C1) on a store seeded the way
 * older servers wrote it: every kind of saved chat, events without a
 * permission source, and scheduled-task rows. The freeze must narrow exactly
 * the chats whose stored mode is broader than what they ran, through events a
 * rebuild replays, once.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2PermissionMigrationReason,
  type ModelSelection,
  type RuntimeMode,
  ThreadId,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../Orchestrator.ts";
import * as PermissionFreeze from "../PermissionFreeze.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import {
  claudeSelection,
  codexSelection,
  goneSelection,
  layerPermissionRuntime,
  LEGACY_CREATED_AT,
  legacyThread,
  projectId,
  setSnapshots,
  storedEventTypes,
  threadOf,
  totalEventCount,
  writeLegacyThreads,
} from "./PermissionTestkit.ts";

const id = (name: string) => ThreadId.make(`thread:freeze:${name}`);

/** Every kind of chat an older server saved, with what the freeze must leave it at. */
const SEEDED: ReadonlyArray<{
  readonly thread: OrchestrationV2AppThread;
  readonly expected: RuntimeMode;
  readonly reason?: OrchestrationV2PermissionMigrationReason;
}> = [
  {
    thread: legacyThread({
      threadId: id("claude-bypass"),
      modelSelection: claudeSelection,
      runtimeMode: "full-access",
    }),
    expected: "approval-required",
    reason: "claude-bypass-not-allowed",
  },
  {
    // Plan keeps its interaction mode; only the preset under it narrows.
    thread: legacyThread({
      threadId: id("claude-bypass-plan"),
      modelSelection: claudeSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
    }),
    expected: "approval-required",
    reason: "claude-bypass-not-allowed",
  },
  {
    thread: legacyThread({
      threadId: id("claude-fork"),
      modelSelection: claudeSelection,
      runtimeMode: "full-access",
      lineage: {
        parentThreadId: id("claude-bypass"),
        relationshipToParent: "fork",
        rootThreadId: id("claude-bypass"),
      },
    }),
    expected: "approval-required",
    reason: "claude-bypass-not-allowed",
  },
  {
    // A native subagent's thread copies its parent's mode; it is read-only to
    // users but its stored mode must not stay broader either.
    thread: legacyThread({
      threadId: id("claude-native-child"),
      modelSelection: claudeSelection,
      runtimeMode: "full-access",
      createdBy: "agent",
      creationSource: "provider",
      lineage: {
        parentThreadId: id("claude-bypass"),
        relationshipToParent: "subagent",
        rootThreadId: id("claude-bypass"),
      },
    }),
    expected: "approval-required",
    reason: "claude-bypass-not-allowed",
  },
  {
    // A Stark worker started through MCP.
    thread: legacyThread({
      threadId: id("claude-worker"),
      modelSelection: claudeSelection,
      runtimeMode: "full-access",
      createdBy: "agent",
      creationSource: "mcp",
      lineage: {
        parentThreadId: id("claude-bypass"),
        relationshipToParent: "subagent",
        rootThreadId: id("claude-bypass"),
      },
    }),
    expected: "approval-required",
    reason: "claude-bypass-not-allowed",
  },
  {
    thread: {
      ...legacyThread({
        threadId: id("claude-v1-import"),
        modelSelection: claudeSelection,
        runtimeMode: "full-access",
        creationSource: "server",
      }),
      historyOrigin: "v1_import",
    },
    expected: "approval-required",
    reason: "claude-bypass-not-allowed",
  },
  {
    thread: legacyThread({
      threadId: id("claude-archived"),
      modelSelection: claudeSelection,
      runtimeMode: "full-access",
      archivedAt: LEGACY_CREATED_AT,
    }),
    expected: "approval-required",
    reason: "claude-bypass-not-allowed",
  },
  {
    thread: legacyThread({
      threadId: id("claude-auto"),
      modelSelection: claudeSelection,
      runtimeMode: "auto",
    }),
    expected: "auto",
  },
  {
    thread: legacyThread({
      threadId: id("codex-auto"),
      modelSelection: codexSelection,
      runtimeMode: "auto",
    }),
    expected: "approval-required",
    reason: "provider-clamped",
  },
  {
    thread: legacyThread({
      threadId: id("codex-full"),
      modelSelection: codexSelection,
      runtimeMode: "full-access",
    }),
    expected: "approval-required",
    reason: "provider-clamped",
  },
  {
    thread: legacyThread({
      threadId: id("codex-supervised"),
      modelSelection: codexSelection,
      runtimeMode: "approval-required",
    }),
    expected: "approval-required",
  },
  {
    // A provider this build no longer has: only a mode a later instance could
    // silently activate is narrowed.
    thread: legacyThread({
      threadId: id("gone-full"),
      modelSelection: goneSelection,
      runtimeMode: "full-access",
    }),
    expected: "approval-required",
    reason: "mode-not-offered",
  },
  {
    thread: legacyThread({
      threadId: id("gone-auto"),
      modelSelection: goneSelection,
      runtimeMode: "auto",
    }),
    expected: "auto",
  },
  {
    // A chat a newer client stored as inheriting is never frozen.
    thread: legacyThread({
      threadId: id("claude-inherit"),
      modelSelection: claudeSelection,
      runtimeMode: "full-access",
      permissionSource: "inherit",
    }),
    expected: "full-access",
  },
];

const insertTask = (taskId: string, selection: ModelSelection, runtimeMode: RuntimeMode) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, next_run_at, last_run_at,
        last_run_status, last_run_error, run_count
      )
      VALUES (
        ${taskId}, 'Nightly', 'Run the tests', 1, '{"type":"interval","everyMs":3600000}',
        ${projectId}, NULL, '{"type":"root"}', ${JSON.stringify(selection)}, ${runtimeMode},
        'default', 'user', 'web', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
        NULL, NULL, 'never', NULL, 0
      )
    `,
  );

const threadsById = Effect.forEach(SEEDED, ({ thread }) => threadOf(thread.id)).pipe(
  Effect.map((threads) => new Map(threads.map((thread) => [thread.id, thread]))),
);

it.layer(layerPermissionRuntime)("startup permission freeze on a seeded store", (it) => {
  it.effect("narrows exactly the chats broader than what they ran, through audited events", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeBypassAllowed: false });
      yield* writeLegacyThreads(SEEDED.map(({ thread }) => thread));
      // Seeded as written: no source, so every one reads as an override.
      for (const { thread } of SEEDED) {
        assert.equal((yield* threadOf(thread.id)).runtimeMode, thread.runtimeMode);
      }

      const freeze = yield* PermissionFreeze.PermissionFreeze;
      const summary = yield* freeze.run();
      const narrowed = SEEDED.filter(({ reason }) => reason !== undefined);
      assert.deepStrictEqual(summary, {
        migratedThreadCount: narrowed.length,
        migratedScheduledTaskCount: 0,
        failedThreadCount: 0,
      });

      for (const { thread, expected, reason } of SEEDED) {
        const after = yield* threadOf(thread.id);
        assert.equal(after.runtimeMode, expected, thread.id);
        // Interaction mode, source and position in the sidebar are untouched.
        assert.equal(after.interactionMode, thread.interactionMode, thread.id);
        assert.equal(after.permissionSource, thread.permissionSource, thread.id);
        assert.equal(String(after.updatedAt), String(thread.updatedAt), thread.id);
        if (reason === undefined) {
          assert.isUndefined(after.permissionMigrations, thread.id);
          assert.notInclude(yield* storedEventTypes(thread.id), "thread.permission-migrated");
          continue;
        }
        assert.deepStrictEqual(
          after.permissionMigrations?.map(({ migrationId, from, to }) => ({
            migrationId,
            from,
            to,
            reason: after.permissionMigrations?.[0]?.reason,
          })),
          [{ migrationId: "perm-v1", from: thread.runtimeMode, to: expected, reason }],
          thread.id,
        );
        // The audit trail is an event, so a rebuild reproduces it.
        assert.deepEqual(
          (yield* storedEventTypes(thread.id)).filter(
            (type) => type === "thread.permission-migrated",
          ),
          ["thread.permission-migrated"],
          thread.id,
        );
      }
    }),
  );

  it.effect("is a no-op on the next startup and after a projection rebuild", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeBypassAllowed: false });
      const before = yield* threadsById;
      const events = yield* totalEventCount;
      const freeze = yield* PermissionFreeze.PermissionFreeze;
      assert.deepStrictEqual(yield* freeze.run(), {
        migratedThreadCount: 0,
        migratedScheduledTaskCount: 0,
        failedThreadCount: 0,
      });
      assert.equal(yield* totalEventCount, events);

      // A rebuild replays the freeze from its events and nothing else changes.
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* maintenance.rebuild;
      const rebuilt = yield* threadsById;
      for (const [threadId, thread] of before) {
        const after = rebuilt.get(threadId)!;
        assert.equal(after.runtimeMode, thread.runtimeMode, threadId);
        assert.equal(after.permissionSource, thread.permissionSource, threadId);
        assert.deepEqual(
          after.permissionMigrations?.map(({ migrationId, from, to, reason }) => [
            migrationId,
            from,
            to,
            reason,
          ]),
          thread.permissionMigrations?.map(({ migrationId, from, to, reason }) => [
            migrationId,
            from,
            to,
            reason,
          ]),
          threadId,
        );
      }
      assert.equal(yield* totalEventCount, events);
      assert.equal((yield* freeze.run()).migratedThreadCount, 0);
    }),
  );

  it.effect("keeps a frozen chat frozen after the account allows Bypass", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeBypassAllowed: true });
      const freeze = yield* PermissionFreeze.PermissionFreeze;
      assert.equal((yield* freeze.run()).migratedThreadCount, 0);
      const frozen = yield* threadOf(id("claude-bypass"));
      assert.equal(frozen.runtimeMode, "approval-required");
      // What the next launch sends: Manual, not the Bypass the chat once stored.
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const resolved = yield* policy.resolve({ thread: frozen, modelSelection: claudeSelection });
      assert.equal(resolved.runtimeMode, "approval-required");
      assert.isUndefined(resolved.permissionSource);

      // The user can still choose Bypass explicitly; a later startup respects it.
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.permission.set",
        commandId: CommandId.make("freeze:explicit-bypass"),
        threadId: id("claude-bypass"),
        permissionSource: "override",
        runtimeMode: "full-access",
      });
      assert.equal((yield* threadOf(id("claude-bypass"))).runtimeMode, "full-access");
      yield* setSnapshots({ claudeBypassAllowed: false });
      // Bypass turned off again: the chat already ran its migration, and a stored
      // full access cannot run, so the next launch is refused rather than widened.
      assert.equal((yield* freeze.run()).migratedThreadCount, 0);
      const offAgain = yield* policy.resolve({
        thread: yield* threadOf(id("claude-bypass")),
        modelSelection: claudeSelection,
      });
      assert.equal(offAgain.runtimeMode, "approval-required");
    }),
  );

  it.effect("freezes scheduled tasks with one audit row each, once", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeBypassAllowed: false });
      const sql = yield* SqlClient.SqlClient;
      yield* insertTask("task:freeze:claude-full", claudeSelection, "full-access");
      yield* insertTask("task:freeze:claude-auto", claudeSelection, "auto");
      yield* insertTask("task:freeze:codex-edits", codexSelection, "auto-accept-edits");
      yield* insertTask("task:freeze:gone-full", goneSelection, "full-access");
      const freeze = yield* PermissionFreeze.PermissionFreeze;
      assert.equal((yield* freeze.run()).migratedScheduledTaskCount, 3);
      const rows = yield* sql<{ readonly task_id: string; readonly runtime_mode: string }>`
        SELECT task_id, runtime_mode FROM scheduled_tasks
        WHERE task_id LIKE 'task:freeze:%' ORDER BY task_id
      `;
      assert.deepStrictEqual(rows, [
        { task_id: "task:freeze:claude-auto", runtime_mode: "auto" },
        { task_id: "task:freeze:claude-full", runtime_mode: "approval-required" },
        { task_id: "task:freeze:codex-edits", runtime_mode: "approval-required" },
        { task_id: "task:freeze:gone-full", runtime_mode: "approval-required" },
      ]);
      const audit = yield* sql<{
        readonly subject_id: string;
        readonly from_runtime_mode: string;
        readonly reason: string;
      }>`
        SELECT subject_id, from_runtime_mode, reason FROM permission_migration_audit
        WHERE subject_id LIKE 'task:freeze:%' ORDER BY subject_id
      `;
      assert.deepStrictEqual(audit, [
        {
          subject_id: "task:freeze:claude-full",
          from_runtime_mode: "full-access",
          reason: "claude-bypass-not-allowed",
        },
        {
          subject_id: "task:freeze:codex-edits",
          from_runtime_mode: "auto-accept-edits",
          reason: "provider-clamped",
        },
        {
          subject_id: "task:freeze:gone-full",
          from_runtime_mode: "full-access",
          reason: "mode-not-offered",
        },
      ]);
      // A second startup, even with Bypass allowed now, changes nothing.
      yield* setSnapshots({ claudeBypassAllowed: true });
      assert.equal((yield* freeze.run()).migratedScheduledTaskCount, 0);
    }),
  );
});
