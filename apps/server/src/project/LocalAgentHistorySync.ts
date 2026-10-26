import {
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  type AgentSessionSyncConfig,
  type AgentSessionSyncStatus,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const projects = yield* ProjectService.ProjectService;
  let running = false;
  let generation = 0;
  let lastSyncedAt: string | null = null;
  let lastResult: AgentSessionSyncStatus["lastResult"] = null;
  let error: string | null = null;
  const configuration = settings.getSettings.pipe(
    Effect.map((value) => value.localAgentHistory),
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
  );
  const status = Effect.gen(function* () {
    return {
      ...(yield* configuration),
      running,
      lastSyncedAt,
      lastResult,
      error,
    } satisfies AgentSessionSyncStatus;
  });
  const check = Effect.gen(function* () {
    const config = yield* configuration;
    if (!config.enabled || config.projectId === null || running) return;
    running = true;
    const checkGeneration = generation;
    yield* importer
      .importRecentAgentThreads({ projectId: config.projectId, scope: "all-local" })
      .pipe(
        Effect.tap((result) =>
          Effect.gen(function* () {
            if (checkGeneration !== generation) return;
            lastResult = result;
            lastSyncedAt = DateTime.formatIso(yield* DateTime.now);
            error = null;
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            if (checkGeneration !== generation) return;
            error = "Local chat sync could not finish. Check the destination folder and try again.";
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            running = false;
          }),
        ),
      );
  });
  const configure = Effect.fn("LocalAgentHistorySync.configure")(function* (
    config: AgentSessionSyncConfig,
  ) {
    if (config.enabled) {
      if (config.projectId === null)
        return yield* new AgentSessionScanError({
          operation: "read-projects",
          cause: "Choose a destination folder.",
        });
      const project = yield* projects
        .getById(config.projectId)
        .pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
          ),
        );
      if (Option.isNone(project))
        return yield* new AgentSessionImportProjectNotFoundError({ projectId: config.projectId });
    }
    const previous = yield* configuration;
    yield* settings
      .updateSettings({ localAgentHistory: config })
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
        ),
      );
    generation += 1;
    if (previous.projectId !== config.projectId) {
      lastResult = null;
      lastSyncedAt = null;
    }
    error = null;
    return yield* status;
  });
  // One scoped worker per server, independent of the number of open clients.
  // Each scan is bounded; unchanged source files never reread message bodies.
  yield* check.pipe(Effect.ignore, Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
  return { status, configure, check };
});
export class LocalAgentHistorySync extends Context.Service<
  LocalAgentHistorySync,
  Effect.Success<typeof make>
>()("stark-code/project/LocalAgentHistorySync") {}
export const layer = Layer.effect(LocalAgentHistorySync, make);
