import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@starkfuture/contracts";
import type * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// Two Claude instances: they share no native settings, so neither can show a
// child on the other stays within its parent's rules.
const claudeAdapter = (instanceId: ProviderInstanceId) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed for delegation dispatch"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];
const work = ProviderInstanceId.make("claude-work");
const personal = ProviderInstanceId.make("claude-personal");
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "child-policy" },
    ProviderAdapterRegistry.layerFromAdapters([claudeAdapter(work), claudeAdapter(personal)]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

/** A parent thread on the work instance with an active run to delegate from. */
const startParent = (
  name: string,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode = "default",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${name}`),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: name,
      modelSelection: { instanceId: work, model: "claude-sonnet-4-6" },
      runtimeMode,
      interactionMode,
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`start-${name}`),
      threadId,
      messageId: MessageId.make(`message:${name}`),
      text: "Delegate some work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadProjection(threadId)).runs[0]!;
    return { threadId, run };
  });

/** A client dispatching the delegation directly, as a WS client can. */
const delegate = (
  parent: Effect.Success<ReturnType<typeof startParent>>,
  name: string,
  input: {
    readonly instanceId: ProviderInstanceId;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly childPolicy?: {
      readonly source: "override";
      readonly preset: RuntimeMode;
      readonly providerInstanceId: ProviderInstanceId;
      readonly containment: "same-instance" | "cross-provider-floor";
    };
  },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate-${name}`),
      parentThreadId: parent.threadId,
      parentRunId: parent.run.id,
      parentNodeId: parent.run.rootNodeId!,
      task: "Review the change",
      modelSelection: { instanceId: input.instanceId, model: "claude-sonnet-4-6" },
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode ?? "default",
      ...(input.childPolicy === undefined ? {} : { childPolicy: input.childPolicy }),
      createdBy: "user",
      creationSource: "web",
    });
  });

const recordedChild = (parentThreadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const task = parent.subagents.at(-1)!;
    const child = yield* projections.getThreadProjection(task.childThreadId!);
    return { task, child: child.thread };
  });

const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => String(Reflect.get(Object(error), "cause"))));

it.effect("refuses a direct delegation to another instance above its narrowest mode", () =>
  Effect.gen(function* () {
    const parent = yield* startParent("cross-auto", "approval-required");
    const cause = yield* refusal(
      delegate(parent, "cross-auto", { instanceId: personal, runtimeMode: "auto" }),
    );
    assert.include(cause, 'Pass runtimeMode "approval-required"');
    // The narrowest mode, named explicitly, starts with a recorded floor policy.
    yield* delegate(parent, "cross-floor", {
      instanceId: personal,
      runtimeMode: "approval-required",
    });
    const { task, child } = yield* recordedChild(parent.threadId);
    assert.equal(child.runtimeMode, "approval-required");
    assert.deepEqual(task.childPolicy, {
      source: "override",
      preset: "approval-required",
      providerInstanceId: personal,
      containment: "cross-provider-floor",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never trusts a child policy the sender supplies", () =>
  Effect.gen(function* () {
    const parent = yield* startParent("forged", "approval-required");
    // A forged "same-instance Auto" policy for a cross-instance Auto worker.
    const cause = yield* refusal(
      delegate(parent, "forged-auto", {
        instanceId: personal,
        runtimeMode: "auto",
        childPolicy: {
          source: "override",
          preset: "auto",
          providerInstanceId: personal,
          containment: "same-instance",
        },
      }),
    );
    assert.include(cause, "does not share this thread's provider settings");
    // An accepted delegation records the policy the orchestrator computed.
    yield* delegate(parent, "forged-floor", {
      instanceId: personal,
      runtimeMode: "approval-required",
      childPolicy: {
        source: "override",
        preset: "approval-required",
        providerInstanceId: personal,
        containment: "same-instance",
      },
    });
    const { task } = yield* recordedChild(parent.threadId);
    assert.equal(task.childPolicy?.containment, "cross-provider-floor");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a same-instance child within its parent's mode and never Bypass", () =>
  Effect.gen(function* () {
    const manual = yield* startParent("same-manual", "approval-required");
    const above = yield* refusal(
      delegate(manual, "same-manual-auto", { instanceId: work, runtimeMode: "auto" }),
    );
    assert.include(above, "broader than parent mode approval-required");

    const auto = yield* startParent("same-auto", "auto");
    const bypass = yield* refusal(
      delegate(auto, "same-auto-bypass", { instanceId: work, runtimeMode: "full-access" }),
    );
    assert.include(bypass, "Child agents cannot use Bypass permissions");
    yield* delegate(auto, "same-auto-edits", {
      instanceId: work,
      runtimeMode: "auto-accept-edits",
    });
    const { task, child } = yield* recordedChild(auto.threadId);
    assert.equal(child.runtimeMode, "auto-accept-edits");
    assert.deepEqual(task.childPolicy, {
      source: "override",
      preset: "auto-accept-edits",
      providerInstanceId: work,
      containment: "same-instance",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a child that leaves its Plan parent's interaction mode", () =>
  Effect.gen(function* () {
    const parent = yield* startParent("plan", "auto", "plan");
    const cause = yield* refusal(
      delegate(parent, "plan-default", {
        instanceId: work,
        runtimeMode: "auto",
        interactionMode: "default",
      }),
    );
    assert.include(cause, "Child interaction mode default is broader than parent mode plan");
    yield* delegate(parent, "plan-plan", {
      instanceId: work,
      runtimeMode: "auto",
      interactionMode: "plan",
    });
    const { child } = yield* recordedChild(parent.threadId);
    assert.equal(child.interactionMode, "plan");
  }).pipe(Effect.provide(layerTest)),
);
