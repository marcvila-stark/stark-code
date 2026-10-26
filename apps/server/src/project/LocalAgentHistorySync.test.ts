import { assert, it } from "@effect/vitest";
import {
  AgentSessionScanError,
  ProjectId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionSyncConfig,
} from "@starkfuture/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as LocalAgentHistorySync from "./LocalAgentHistorySync.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

const projectId = ProjectId.make("local-chat-destination");
const disabled: AgentSessionSyncConfig = { enabled: false, projectId: null };
const enabled: AgentSessionSyncConfig = { enabled: true, projectId };
const importedResult: AgentSessionImportResult = {
  importedCount: 3,
  skippedCount: 1,
  updatedCount: 2,
};
type Import = AgentSessionImporter.AgentSessionImporter["Service"]["importRecentAgentThreads"];
const layerTest = (options: {
  config?: AgentSessionSyncConfig;
  importThreads: Import;
  projectExists?: boolean;
}) =>
  LocalAgentHistorySync.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest({ localAgentHistory: options.config ?? disabled })),
    Layer.provide(
      Layer.mock(AgentSessionImporter.AgentSessionImporter)({
        importRecentAgentThreads: options.importThreads,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeed(
            options.projectExists === false
              ? Option.none()
              : Option.some({ id: projectId, workspaceRoot: "/main/workspace" } as never),
          ),
      }),
    ),
  );

it.effect("disabled discovery never imports, including scheduled checks", () => {
  const calls: AgentSessionImportInput[] = [];
  return Effect.gen(function* () {
    const service = yield* LocalAgentHistorySync.LocalAgentHistorySync;
    yield* service.check;
    yield* TestClock.adjust("2 minutes");
    assert.deepEqual(calls, []);
    assert.deepEqual(yield* service.status, {
      ...disabled,
      running: false,
      lastSyncedAt: null,
      lastResult: null,
      error: null,
    });
  }).pipe(
    Effect.provide(
      layerTest({
        importThreads: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return importedResult;
          }),
      }),
    ),
  );
});

it.effect("persisted enabled discovery imports all local chats when the service starts", () =>
  Effect.gen(function* () {
    const imported = yield* Deferred.make<void>();
    const calls: AgentSessionImportInput[] = [];
    yield* Effect.gen(function* () {
      const service = yield* LocalAgentHistorySync.LocalAgentHistorySync;
      yield* Deferred.await(imported);
      yield* TestClock.adjust("0 millis");
      assert.deepEqual(calls, [{ projectId, scope: "all-local" }]);
      const status = yield* service.status;
      assert.deepEqual(status.lastResult, importedResult);
      assert.isNotNull(status.lastSyncedAt);
      assert.isFalse(status.running);
    }).pipe(
      Effect.provide(
        layerTest({
          config: enabled,
          importThreads: (input) =>
            Effect.gen(function* () {
              calls.push(input);
              yield* Deferred.succeed(imported, undefined);
              return importedResult;
            }),
        }),
      ),
    );
  }),
);

it.effect("rejects a missing destination without enabling discovery", () =>
  Effect.gen(function* () {
    const service = yield* LocalAgentHistorySync.LocalAgentHistorySync;
    const error = yield* service.configure(enabled).pipe(Effect.flip);
    assert.equal(error._tag, "AgentSessionImportProjectNotFoundError");
    assert.isFalse((yield* service.status).enabled);
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepEqual((yield* settings.getSettings).localAgentHistory, disabled);
  }).pipe(
    Effect.provide(
      layerTest({
        projectExists: false,
        importThreads: () => Effect.die("Missing destination must not import"),
      }),
    ),
  ),
);

it.effect("reports a generic failure without exposing transcript or credential details", () =>
  Effect.gen(function* () {
    const service = yield* LocalAgentHistorySync.LocalAgentHistorySync;
    yield* TestClock.adjust("0 millis");
    yield* service.configure(enabled);
    yield* service.check;
    const status = yield* service.status;
    assert.equal(
      status.error,
      "Local chat sync could not finish. Check the destination folder and try again.",
    );
    assert.notInclude(status.error ?? "", "token=private");
    assert.isFalse(status.running);
    assert.isNull(status.lastResult);
  }).pipe(
    Effect.provide(
      layerTest({
        importThreads: () =>
          Effect.fail(
            new AgentSessionScanError({
              operation: "read-projects",
              cause: "https://private.invalid/?token=private transcript text",
            }),
          ),
      }),
    ),
  ),
);

it.effect("concurrent manual and scheduled checks share one in-flight import", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    yield* Effect.gen(function* () {
      const service = yield* LocalAgentHistorySync.LocalAgentHistorySync;
      yield* TestClock.adjust("0 millis");
      yield* service.configure(enabled);
      const first = yield* service.check.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* service.check;
      yield* TestClock.adjust("30 seconds");
      yield* service.check;
      assert.equal(calls, 1);
      assert.isTrue((yield* service.status).running);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      assert.isFalse((yield* service.status).running);
      assert.deepEqual((yield* service.status).lastResult, importedResult);
    }).pipe(
      Effect.provide(
        layerTest({
          importThreads: () =>
            Effect.gen(function* () {
              calls += 1;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return importedResult;
            }),
        }),
      ),
    );
  }),
);

it.effect("disabling preserves the last import result and stops subsequent imports", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* LocalAgentHistorySync.LocalAgentHistorySync;
    yield* TestClock.adjust("0 millis");
    yield* service.configure(enabled);
    yield* service.check;
    const before = yield* service.status;
    const after = yield* service.configure({ enabled: false, projectId });
    assert.deepEqual(after.lastResult, before.lastResult);
    assert.equal(after.lastSyncedAt, before.lastSyncedAt);
    yield* service.check;
    yield* TestClock.adjust("2 minutes");
    assert.equal(calls, 1);
    assert.deepEqual((yield* service.status).lastResult, importedResult);
  }).pipe(
    Effect.provide(
      layerTest({
        importThreads: () =>
          Effect.sync(() => {
            calls += 1;
            return importedResult;
          }),
      }),
    ),
  );
});
