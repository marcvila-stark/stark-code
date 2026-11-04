import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per trigger occurrence of a scheduled task. `occurrence_key` is
  // the dedupe gate: a scheduler slot, a Run now click id or a webhook
  // delivery id reserves at most one run. Dispatch state (what this server
  // did) and agent state (the orchestration run it started, versioned by the
  // event sequence it was observed at) are kept apart.
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_created_at TEXT NOT NULL,
      project_id TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      occurrence_key TEXT NOT NULL UNIQUE,
      dispatch_kind TEXT NOT NULL,
      command_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      webhook_delivery_id TEXT,
      thread_id TEXT,
      dispatch_state TEXT NOT NULL,
      error TEXT,
      agent_run_id TEXT,
      agent_status TEXT,
      agent_sequence INTEGER NOT NULL DEFAULT 0,
      agent_started_at TEXT,
      agent_ended_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
    ON scheduled_task_runs(task_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_message
    ON scheduled_task_runs(message_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_agent_run
    ON scheduled_task_runs(agent_run_id)
    WHERE agent_run_id IS NOT NULL
  `;
});
