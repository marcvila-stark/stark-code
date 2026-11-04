import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@starkfuture/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const runRow = (runId: string, occurrenceKey: string) => ({
  run_id: runId,
  task_id: "existing",
  task_created_at: "2026-10-01T00:00:00.000Z",
  project_id: "project",
  trigger_kind: "scheduled",
  occurrence_key: occurrenceKey,
  dispatch_kind: "launch",
  command_id: `scheduled-task:${occurrenceKey}`,
  message_id: `scheduled-task-message:${occurrenceKey}`,
  dispatch_state: "dispatching",
  created_at: "2026-10-01T00:00:00.000Z",
});

layer("063_ScheduledTaskRuns", (it) => {
  it.effect("adds run history without touching tasks or relay claims", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`INSERT INTO scheduled_task_webhook_relay_deliveries ${sql.insert({
        relay_delivery_id: "relay-1",
        task_id: "existing",
        seen_at: "2026-10-01T00:00:00.000Z",
      })}`;
      yield* runMigrations({ toMigrationInclusive: 63 });

      const claims = yield* sql<{
        relay_delivery_id: string;
      }>`SELECT relay_delivery_id FROM scheduled_task_webhook_relay_deliveries`;
      assert.deepEqual(claims, [{ relay_delivery_id: "relay-1" }]);

      yield* sql`INSERT INTO scheduled_task_runs ${sql.insert(runRow("run-1", "slot-1"))}`;
      // A second run for the same occurrence is refused by the table itself.
      const duplicate = yield* sql`INSERT INTO scheduled_task_runs ${sql.insert(
        runRow("run-2", "slot-1"),
      )}`.pipe(Effect.exit);
      assert.equal(duplicate._tag, "Failure");
      const [count] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM scheduled_task_runs`;
      assert.equal(count?.count, 1);

      const [row] = yield* sql<{
        agent_sequence: number;
        agent_status: string | null;
      }>`SELECT agent_sequence, agent_status FROM scheduled_task_runs WHERE run_id = 'run-1'`;
      assert.deepEqual(row, { agent_sequence: 0, agent_status: null });
    }),
  );
});
