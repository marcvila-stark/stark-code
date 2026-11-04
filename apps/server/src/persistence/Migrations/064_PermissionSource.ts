import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Where a chat's permissions come from. Rows written before this column are
  // `override`: a missing source must never widen what a saved chat runs with.
  yield* sql`
    ALTER TABLE orchestration_v2_projection_threads
    ADD COLUMN permission_source TEXT NOT NULL DEFAULT 'override'
  `;

  // One row per scheduled task the startup permission freeze narrowed, written
  // in the same transaction as the task row. Threads keep their own trail on
  // the thread, written through events.
  yield* sql`
    CREATE TABLE IF NOT EXISTS permission_migration_audit (
      migration_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      from_runtime_mode TEXT NOT NULL,
      to_runtime_mode TEXT NOT NULL,
      reason TEXT NOT NULL,
      migrated_at TEXT NOT NULL,
      PRIMARY KEY (migration_id, subject_kind, subject_id)
    )
  `;
});
