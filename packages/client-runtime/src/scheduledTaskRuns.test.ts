import {
  EnvironmentId,
  ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskRunId,
  type ScheduledTaskRun,
  type ScheduledTaskRunNowInput,
} from "@starkfuture/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createRunNowClickIds,
  isScheduledTaskRunActive,
  runNowFailureOutcome,
  runScheduledTaskNowOnce,
  scheduledTaskRunDurationLabel,
  scheduledTaskRunStateLabel,
  scheduledTaskRunTone,
  scheduledTaskRunTriggerLabel,
  supportsScheduledTaskRuns,
} from "./scheduledTaskRuns.ts";

const run = (overrides: Partial<ScheduledTaskRun>): ScheduledTaskRun => ({
  id: ScheduledTaskRunId.make("scheduled-run:1"),
  taskId: ScheduledTaskId.make("scheduled-task:1"),
  trigger: "scheduled",
  state: "running",
  error: null,
  threadId: null,
  webhookDeliveryId: null,
  createdAt: "2026-10-29T10:00:00.000Z",
  startedAt: "2026-10-29T10:00:00.000Z",
  endedAt: null,
  ...overrides,
});

describe("scheduled task run presentation", () => {
  it("separates runs that may still change from finished ones", () => {
    expect(isScheduledTaskRunActive("waiting")).toBe(true);
    expect(isScheduledTaskRunActive("queued")).toBe(true);
    expect(isScheduledTaskRunActive("running")).toBe(true);
    expect(isScheduledTaskRunActive("succeeded")).toBe(false);
    expect(isScheduledTaskRunActive("interrupted")).toBe(false);
    expect(scheduledTaskRunTone("succeeded")).toBe("success");
    expect(scheduledTaskRunTone("interrupted")).toBe("error");
    expect(scheduledTaskRunTone("skipped")).toBe("muted");
    expect(scheduledTaskRunStateLabel("queued")).toBe("Queued");
    expect(scheduledTaskRunTriggerLabel("manual")).toBe("Run now");
  });

  it("measures a finished run to its end and an active one to now", () => {
    const now = Date.parse("2026-10-29T11:05:30.000Z");
    expect(
      scheduledTaskRunDurationLabel(
        run({ state: "succeeded", endedAt: "2026-10-29T10:00:45.000Z" }),
        now,
      ),
    ).toBe("45s");
    expect(
      scheduledTaskRunDurationLabel(
        run({ state: "failed", endedAt: "2026-10-29T10:03:12.000Z" }),
        now,
      ),
    ).toBe("3m 12s");
    expect(scheduledTaskRunDurationLabel(run({ state: "running" }), now)).toBe("1h 5m");
    // Not started yet, or finished without an end time: nothing to measure.
    expect(scheduledTaskRunDurationLabel(run({ state: "waiting", startedAt: null }), now)).toBe(
      null,
    );
    expect(scheduledTaskRunDurationLabel(run({ state: "succeeded" }), now)).toBe(null);
  });

  it("offers run history only on servers that advertise it", () => {
    expect(supportsScheduledTaskRuns({ scheduledTaskRuns: true })).toBe(true);
    expect(supportsScheduledTaskRuns({})).toBe(false);
    expect(supportsScheduledTaskRuns(null)).toBe(false);
  });
});

describe("Run now click ids", () => {
  it("reuses one id while a click is pending or its outcome is unknown", () => {
    let next = 0;
    const ids = createRunNowClickIds(() => `click-${++next}`);
    const first = ids.begin("env:task");
    // A second click before the first answers belongs to the same intent.
    expect(ids.begin("env:task")).toBe(first);
    ids.end("env:task", "known");
    ids.end("env:task", "unknown");
    // The connection dropped before an answer: retrying must not start a second run.
    expect(ids.begin("env:task")).toBe(first);
    ids.end("env:task", "known");
    expect(ids.begin("env:task")).toBe("click-2");
    expect(ids.begin("env:other")).toBe("click-3");
  });

  it("treats only the server's own answers as a known outcome", () => {
    expect(runNowFailureOutcome({ _tag: "ScheduledTaskError", message: "Not found." })).toBe(
      "known",
    );
    expect(runNowFailureOutcome({ _tag: "EnvironmentAuthorizationError" })).toBe("known");
    expect(runNowFailureOutcome({ _tag: "EnvironmentRpcUnavailableError" })).toBe("unknown");
    expect(runNowFailureOutcome(new Error("socket closed"))).toBe("unknown");
  });
});

describe("runScheduledTaskNowOnce", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const taskId = ScheduledTaskId.make("scheduled-task:1");

  it("sends the same id again after a lost answer and a new one after the server answers", async () => {
    let next = 0;
    const clickIds = createRunNowClickIds(() => `click-${++next}`);
    const sent: Array<ScheduledTaskRunNowInput> = [];
    const answers = [
      AsyncResult.failure(Cause.fail(new Error("socket closed"))),
      AsyncResult.success("ran"),
      AsyncResult.failure(Cause.fail(new ScheduledTaskError({ message: "Not found." }))),
      AsyncResult.success("ran"),
    ];
    const run = async (target: { readonly input: ScheduledTaskRunNowInput }) => {
      sent.push(target.input);
      return answers.shift()!;
    };
    for (let click = 0; click < 4; click++) {
      await runScheduledTaskNowOnce({
        clickIds,
        environmentId,
        taskId,
        keepsRunHistory: true,
        run,
      });
    }
    expect(sent.map((input) => input.commandId)).toEqual([
      "click-1",
      "click-1",
      "click-2",
      "click-3",
    ]);
  });

  it("leaves the id out for servers without run history", async () => {
    const sent: Array<ScheduledTaskRunNowInput> = [];
    await runScheduledTaskNowOnce({
      clickIds: createRunNowClickIds(() => "unused"),
      environmentId,
      taskId,
      keepsRunHistory: false,
      run: async (target) => {
        sent.push(target.input);
        return AsyncResult.success("ran");
      },
    });
    expect(sent).toEqual([{ id: taskId }]);
  });
});
