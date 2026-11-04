import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@starkfuture/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
  readonly localSession?: OrchestrationV2AppThread["localSession"];
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    ...(input.localSession === undefined ? {} : { localSession: input.localSession }),
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// Grok's instance offers no Auto-accept edits; the Codex instance advertises no
// restriction.
const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
// Only this instance leaves permissions to the provider's own settings.
const inheritingInstanceId = ProviderInstanceId.make("claude_inherit");
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    driverKind: instanceId === inheritingInstanceId ? "claudeAgent" : instanceId,
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
        ...(instanceId === inheritingInstanceId ? { nativePermissionInherit: true } : {}),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    FileSystem.layerNoop({
      stat: (path) =>
        Effect.succeed({
          type: path === "/original-cli-folder" ? "Directory" : "File",
        } as FileSystem.File.Info),
    }),
  ),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect(
    "resumes an imported conversation in its original folder without treating it as a worktree",
    () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const now = yield* DateTime.now;
        const thread = makeThread({
          now,
          worktreePath: null,
          localSession: { providerSessionId: "native-session", cwd: "/original-cli-folder" },
        });
        const resolved = yield* policy.resolve({ thread, modelSelection });
        assert.equal(resolved.cwd, "/original-cli-folder");
        assert.equal(thread.worktreePath, null);
      }),
  );

  it.effect("refuses to replace an unavailable imported folder with the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const error = yield* policy
        .resolve({
          thread: makeThread({
            now,
            worktreePath: null,
            localSession: { providerSessionId: "native-session", cwd: "/missing-cli-folder" },
          }),
          modelSelection,
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "local-session-folder-unavailable");
      assert.include(error.message, "original folder");
    }),
  );

  it.effect("prefers an explicitly attached worktree over an imported folder", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({
          now,
          worktreePath: "/project-worktree",
          localSession: { providerSessionId: "native-session", cwd: "/missing-cli-folder" },
        }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      // A provider that advertises no restriction runs every mode as stored.
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );

  it.effect("inherits the provider's settings only where the driver supports it", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const inheritingThread = {
        ...makeThread({ now, worktreePath: null, runtimeMode: "approval-required" }),
        permissionSource: "inherit" as const,
      };
      const supported = yield* policy.resolve({
        thread: inheritingThread,
        modelSelection: { instanceId: inheritingInstanceId, model: "claude-sonnet-4-6" },
      });
      assert.equal(supported.permissionSource, "inherit");
      // Elsewhere the chat runs its stored preset exactly as before.
      const unsupported = yield* policy.resolve({ thread: inheritingThread, modelSelection });
      assert.isUndefined(unsupported.permissionSource);
      assert.equal(unsupported.runtimeMode, "approval-required");
      // A legacy chat without a source never inherits.
      const legacy = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null, runtimeMode: "auto" }),
        modelSelection: { instanceId: inheritingInstanceId, model: "claude-sonnet-4-6" },
      });
      assert.isUndefined(legacy.permissionSource);
      assert.deepStrictEqual(yield* policy.permissionCapabilities(inheritingInstanceId), {
        driver: "claudeAgent",
        supportedRuntimeModes: undefined,
        nativePermissionInherit: true,
      });
    }),
  );
});
