/**
 * The startup permission freeze (PLAN-002 §2). Before any work resumes, every
 * saved chat and scheduled task whose stored mode is broader than what its
 * provider actually ran is narrowed to that mode, so a later change (an
 * account allowing Bypass, a provider that stops clamping) can never activate
 * a broader mode it never ran with.
 *
 * Threads change through `thread.permission.migrate` events, never projection
 * patches, so a rebuild reproduces the result. Scheduled tasks change with an
 * audit row in the same transaction. Both are idempotent per migration id.
 *
 * Startup does not go on to recovery while an eligible chat is unfrozen: a
 * chat the freeze could not read or migrate fails the run, and the next
 * startup tries again. The one exception is a chat whose saved state cannot
 * be decoded. Nothing can run it while it is unreadable, so it is quarantined
 * instead of blocking every startup: logged, recorded in the audit table and
 * tried again on the next startup.
 */
import {
  ClaudeSettings,
  CommandId,
  ModelSelection,
  type ProviderInstanceConfigMap,
  type RuntimeMode,
  ThreadId,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import {
  PERMISSION_FREEZE_MIGRATION_ID,
  type PermissionCapabilities,
  permissionFreezeFor,
} from "./PermissionPolicy.ts";
import { ProjectionStoreV2, type ProjectionStoreV2Error } from "./ProjectionStore.ts";

const CLAUDE_MODES_WITHOUT_BYPASS: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
];

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeModelSelectionJson = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));

/**
 * What an instance runs, read from settings rather than live snapshots, which
 * may still be probing at startup. Claude offers full access only while its
 * account allows Bypass; every other driver's modes are decided by the clamp.
 */
export function freezeCapabilities(
  instances: ProviderInstanceConfigMap,
  instanceId: string,
): Pick<PermissionCapabilities, "driver" | "supportedRuntimeModes"> {
  const instance = Object.hasOwn(instances, instanceId)
    ? instances[instanceId as keyof typeof instances]
    : undefined;
  if (instance === undefined) return { driver: undefined, supportedRuntimeModes: undefined };
  if (instance.driver !== "claudeAgent") {
    return { driver: instance.driver, supportedRuntimeModes: undefined };
  }
  const settings = decodeClaudeSettings(instance.config ?? {});
  const bypassAllowed = Option.isSome(settings) && settings.value.allowBypassPermissions === true;
  return {
    driver: instance.driver,
    supportedRuntimeModes: bypassAllowed
      ? [...CLAUDE_MODES_WITHOUT_BYPASS, "full-access"]
      : CLAUDE_MODES_WITHOUT_BYPASS,
  };
}

export interface PermissionFreezeSummary {
  readonly migratedThreadCount: number;
  readonly migratedScheduledTaskCount: number;
  /**
   * Eligible chats left unmigrated because their saved state cannot be
   * decoded: quarantined with an audit row, unable to run while unreadable,
   * and tried again on the next startup. Any other failure fails the run.
   */
  readonly failedThreadCount: number;
}

export class PermissionFreezeError extends Schema.TaggedError<PermissionFreezeError>()(
  "PermissionFreezeError",
  {
    stage: Schema.Literals([
      "read-settings",
      "read-threads",
      "migrate-threads",
      "read-tasks",
      "migrate-task",
    ]),
    /** The chats still unfrozen, for `migrate-threads`. */
    threadIds: Schema.optional(Schema.Array(Schema.String)),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const threads =
      this.threadIds === undefined || this.threadIds.length === 0
        ? ""
        : ` (${this.threadIds.join(", ")}); recovery waits until they are frozen`;
    return `The startup permission freeze could not ${this.stage.replace("-", " ")}${threads}.`;
  }
}

/** The audit reason for a chat the freeze could not read and so left unmigrated. */
export const PERMISSION_FREEZE_QUARANTINE_REASON = "quarantined-unreadable";

export class PermissionFreeze extends Context.Service<
  PermissionFreeze,
  {
    /** Runs the freeze once; a second run changes nothing. */
    readonly run: (
      migrationId?: string,
    ) => Effect.Effect<PermissionFreezeSummary, PermissionFreezeError>;
  }
>()("stark-code/orchestration-v2/PermissionFreeze") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStoreV2;
  const orchestrator = yield* OrchestratorV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // Numbers this process's runs, so each run's commands get their own ids.
  let runCount = 0;
  return PermissionFreeze.of({
    run: (migrationId = PERMISSION_FREEZE_MIGRATION_ID) =>
      Effect.gen(function* () {
        const attempt = `${DateTime.toEpochMillis(yield* DateTime.now)}.${runCount++}`;
        return yield* runPermissionFreeze({
          migrationId,
          attempt,
          sql,
          projections,
          orchestrator,
          serverSettings,
        });
      }),
  });
});

export const layer = Layer.effect(PermissionFreeze, make);

/** Whether a projection read failed because the saved thread cannot be decoded. */
const isUnreadableThread = (error: ProjectionStoreV2Error): boolean =>
  error._tag === "ProjectionStoreReadError" && Schema.isSchemaError(error.cause);

const runPermissionFreeze = Effect.fn("PermissionFreeze.run")(function* (input: {
  readonly migrationId: string;
  /**
   * Unique to this run. A failed dispatch records a rejected receipt under its
   * command id, so reusing an id across runs would replay a transient
   * failure forever. A successful migration stays idempotent through its
   * migration id on the thread, which later runs read before dispatching.
   */
  readonly attempt: string;
  readonly sql: SqlClient.SqlClient;
  readonly projections: ProjectionStoreV2["Service"];
  readonly orchestrator: OrchestratorV2["Service"];
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
}) {
  const { migrationId, sql, projections, orchestrator } = input;
  const failAt =
    (stage: PermissionFreezeError["stage"]) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new PermissionFreezeError({ stage, cause })));
  const instances = deriveProviderInstanceConfigMap(
    yield* input.serverSettings.getSettings.pipe(failAt("read-settings")),
  );

  // Only a chat stored above Supervised can need narrowing.
  const candidates = yield* sql<{ readonly thread_id: string; readonly runtime_mode: RuntimeMode }>`
    SELECT thread_id, runtime_mode FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND runtime_mode <> 'approval-required'
      AND permission_source = 'override'
    ORDER BY thread_id
  `.pipe(failAt("read-threads"));
  /** The freeze this chat still needs, `none` when it needs none, or the read's failure. */
  const pendingFreeze = (threadId: ThreadId) =>
    projections.getThread(threadId).pipe(
      Effect.map((thread) => {
        const freeze = permissionFreezeFor({
          thread,
          capabilities: freezeCapabilities(instances, thread.providerInstanceId),
          migrationId,
        });
        return freeze === undefined ? ("none" as const) : freeze;
      }),
      // Deleted since the candidate query: nothing left to run.
      Effect.catchTags({
        ProjectionStoreThreadNotFoundError: () => Effect.succeed("none" as const),
      }),
    );
  let migratedThreadCount = 0;
  const quarantined: Array<ThreadId> = [];
  const unfrozen: Array<{ readonly threadId: ThreadId; readonly cause: unknown }> = [];
  for (const candidate of candidates) {
    const threadId = ThreadId.make(candidate.thread_id);
    const pending = yield* pendingFreeze(threadId).pipe(Effect.result);
    if (Result.isFailure(pending)) {
      if (!isUnreadableThread(pending.failure)) {
        unfrozen.push({ threadId, cause: pending.failure });
        continue;
      }
      yield* sql`
        INSERT INTO permission_migration_audit (
          migration_id, subject_kind, subject_id,
          from_runtime_mode, to_runtime_mode, reason, migrated_at
        )
        VALUES (
          ${migrationId}, 'thread', ${threadId},
          ${candidate.runtime_mode}, ${candidate.runtime_mode},
          ${PERMISSION_FREEZE_QUARANTINE_REASON}, ${DateTime.formatIso(yield* DateTime.now)}
        )
        ON CONFLICT (migration_id, subject_kind, subject_id)
        DO UPDATE SET migrated_at = excluded.migrated_at
      `.pipe(failAt("migrate-threads"));
      yield* Effect.logWarning(
        "Quarantined a saved chat whose permissions could not be frozen: it cannot be read, so it cannot run; the next startup tries again",
        { threadId, cause: pending.failure },
      );
      quarantined.push(threadId);
      continue;
    }
    if (pending.success === "none") continue;
    const migrated = yield* orchestrator
      .dispatch({
        type: "thread.permission.migrate",
        commandId: CommandId.make(`permission-freeze:${migrationId}:${threadId}:${input.attempt}`),
        threadId,
        migrationId,
        ...pending.success,
      })
      .pipe(Effect.result);
    if (Result.isSuccess(migrated)) {
      migratedThreadCount++;
      continue;
    }
    // The chat may have changed under the dispatch, such as another startup
    // freezing it first. It is done only if it no longer needs this freeze.
    const after = yield* pendingFreeze(threadId).pipe(Effect.result);
    if (Result.isSuccess(after) && after.success === "none") continue;
    unfrozen.push({ threadId, cause: migrated.failure });
  }
  if (unfrozen.length > 0) {
    yield* Effect.logError("Could not freeze saved chats' permissions; recovery waits for them", {
      threadIds: unfrozen.map((entry) => entry.threadId),
    });
  }

  const tasks = yield* sql<{
    readonly task_id: string;
    readonly runtime_mode: RuntimeMode;
    readonly model_selection_json: string;
  }>`
    SELECT task_id, runtime_mode, model_selection_json FROM scheduled_tasks
    WHERE runtime_mode <> 'approval-required'
      AND NOT EXISTS (
        SELECT 1 FROM permission_migration_audit
        WHERE migration_id = ${migrationId}
          AND subject_kind = 'scheduled_task'
          AND subject_id = scheduled_tasks.task_id
      )
    ORDER BY task_id
  `.pipe(failAt("read-tasks"));
  let migratedScheduledTaskCount = 0;
  const migratedAt = DateTime.formatIso(yield* DateTime.now);
  for (const task of tasks) {
    const modelSelection = decodeModelSelectionJson(task.model_selection_json);
    const freeze = permissionFreezeFor({
      thread: { runtimeMode: task.runtime_mode },
      capabilities: Option.isSome(modelSelection)
        ? freezeCapabilities(instances, modelSelection.value.instanceId)
        : { driver: undefined, supportedRuntimeModes: undefined },
      migrationId,
    });
    if (freeze === undefined) continue;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          UPDATE scheduled_tasks SET runtime_mode = ${freeze.to}
          WHERE task_id = ${task.task_id} AND runtime_mode = ${freeze.from}
        `;
          yield* sql`
          INSERT INTO permission_migration_audit (
            migration_id, subject_kind, subject_id,
            from_runtime_mode, to_runtime_mode, reason, migrated_at
          )
          VALUES (
            ${migrationId}, 'scheduled_task', ${task.task_id},
            ${freeze.from}, ${freeze.to}, ${freeze.reason}, ${migratedAt}
          )
          ON CONFLICT DO NOTHING
        `;
        }),
      )
      .pipe(failAt("migrate-task"));
    migratedScheduledTaskCount++;
  }

  if (unfrozen.length > 0) {
    return yield* new PermissionFreezeError({
      stage: "migrate-threads",
      threadIds: unfrozen.map((entry) => entry.threadId),
      cause: unfrozen.map((entry) => entry.cause),
    });
  }

  return {
    migratedThreadCount,
    migratedScheduledTaskCount,
    failedThreadCount: quarantined.length,
  } satisfies PermissionFreezeSummary;
});
