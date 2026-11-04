import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTask,
  ScheduledTaskListRunsResult,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

const run = (state: string) => ({
  id: `scheduled-run:${state}`,
  taskId: "scheduled-task:runs",
  trigger: "manual",
  state,
  error: null,
  threadId: "thread-1",
  webhookDeliveryId: null,
  createdAt: "2026-10-29T10:00:00.000Z",
  startedAt: "2026-10-29T10:00:00.000Z",
  endedAt: null,
});

const task = {
  id: "scheduled-task:runs",
  title: "Nightly review",
  prompt: "Review the open pull requests.",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: "project-runs",
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-29T09:00:00.000Z",
  updatedAt: "2026-10-29T09:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const decodeRunList = Schema.decodeUnknownSync(ScheduledTaskListRunsResult);

describe("ScheduledTaskRun", () => {
  it("keeps a task whose newest run is in a state this client does not know", () => {
    const decoded = decodeTask({
      ...task,
      latestRun: run("paused-by-policy"),
    });
    expect(decoded.id).toBe("scheduled-task:runs");
    expect(decoded.latestRun).toBeUndefined();
    expect(decodeTask({ ...task, latestRun: run("running") }).latestRun?.state).toBe("running");
  });

  it("drops only the runs this client cannot read from a run list", () => {
    const decoded = decodeRunList({
      runs: [run("succeeded"), run("paused-by-policy"), run("waiting")],
    });
    expect(decoded.runs.map((entry) => entry.state)).toEqual(["succeeded", "waiting"]);
  });
});
