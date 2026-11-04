import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope, ScheduledTaskUpsertInput } from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { DispatchSettingsWrite } from "../orchestration-v2/DispatchSettingsWrite.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { upsertScheduledTaskForSession } from "../ws.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      // Cross the due time before the scheduler's first five-second tick.
      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("saves a task at the project's default mode and the preset its provider runs", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      // A Claude instance offering every mode but Bypass, and a clamped Codex.
      Layer.mock(RuntimePolicy.RuntimePolicyV2)({
        permissionCapabilities: (instanceId) =>
          Effect.succeed(
            instanceId === "claudeAgent"
              ? {
                  driver: "claudeAgent",
                  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto"],
                  nativePermissionInherit: false,
                }
              : {
                  driver: "codex",
                  supportedRuntimeModes: undefined,
                  nativePermissionInherit: false,
                },
          ),
      }),
      ServerSettings.layerTest({ defaultRuntimeMode: "auto-accept-edits" }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const base = {
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-task-permissions",
        workspaceStrategy: { type: "root" },
        interactionMode: "default",
      };
      // No mode from the client: the project's default, never full access.
      const defaulted = yield* service.upsert(
        yield* decodeUpsertInput({
          ...base,
          id: "scheduled-task:default-mode",
          modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
        }),
      );
      expect(defaulted.task.runtimeMode).toBe("auto-accept-edits");
      // Full access without Bypass is stored as the Manual it runs.
      const claudeFull = yield* service.upsert(
        yield* decodeUpsertInput({
          ...base,
          id: "scheduled-task:claude-full",
          modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
        }),
      );
      expect(claudeFull.task.runtimeMode).toBe("approval-required");
      // A provider Stark always runs Supervised refuses full access outright.
      const refused = yield* service
        .upsert(
          yield* decodeUpsertInput({
            ...base,
            id: "scheduled-task:codex-full",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
          }),
        )
        .pipe(Effect.flip);
      expect(refused.message).toContain("Full access is not available");
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("never lets an omitted mode widen a task for a sender without settings-write", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(RuntimePolicy.RuntimePolicyV2)({
        permissionCapabilities: () =>
          Effect.succeed({
            driver: "claudeAgent",
            supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto"],
            nativePermissionInherit: false,
          }),
      }),
      ServerSettings.layerTest({ defaultRuntimeMode: "auto" }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const operateOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(DispatchSettingsWrite, false));
      const base = {
        id: "scheduled-task:omitted-mode",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-omitted-mode",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
        interactionMode: "default",
      };
      const manual = yield* operateOnly(
        service.upsert(yield* decodeUpsertInput({ ...base, runtimeMode: "approval-required" })),
      );
      expect(manual.task.runtimeMode).toBe("approval-required");

      // Omitting the mode resolves to the project's Auto: a widening like asking for it.
      const widened = yield* operateOnly(
        service.upsert(yield* decodeUpsertInput({ ...base, title: "Edited" })),
      ).pipe(Effect.flip);
      expect(widened.message).toContain("needs permission to change settings");
      const [stored] = (yield* service.list()).tasks;
      expect(stored?.runtimeMode).toBe("approval-required");
      expect(stored?.title).toBe("Review");
      // The ws handler carries the session's grant into the same check.
      const overWs = yield* upsertScheduledTaskForSession(
        { scopes: [AuthOrchestrationOperateScope] },
        yield* decodeUpsertInput({ ...base, title: "Edited" }),
      ).pipe(Effect.flip);
      expect(overWs.message).toContain("needs permission to change settings");

      // A sender with settings-write may, and an operate-only sender may narrow again.
      const granted = yield* service
        .upsert(yield* decodeUpsertInput({ ...base, title: "Edited" }))
        .pipe(Effect.provideService(DispatchSettingsWrite, true));
      expect(granted.task.runtimeMode).toBe("auto");
      const keptOrNarrowed = yield* operateOnly(
        service.upsert(yield* decodeUpsertInput({ ...base, runtimeMode: "auto-accept-edits" })),
      );
      expect(keptOrNarrowed.task.runtimeMode).toBe("auto-accept-edits");

      // A new task gets the project's default, as every new chat does (O9).
      const created = yield* operateOnly(
        service.upsert(
          yield* decodeUpsertInput({ ...base, id: "scheduled-task:omitted-mode-new" }),
        ),
      );
      expect(created.task.runtimeMode).toBe("auto");
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
