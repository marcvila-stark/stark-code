/**
 * Stark workers (delegated chats) get an explicit, recorded policy (PLAN-002
 * §3.4 `childPolicy`, C4) and never run Bypass (O5), whoever sends the
 * request: Stark's MCP tools or a client dispatching the command directly.
 * Native subagents are not covered here: they inherit inside the provider.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2ChildPolicy,
  type PermissionSource,
  type RuntimeMode,
  ThreadId,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../Orchestrator.ts";
import {
  causeOf,
  claudeId,
  claudeSelection,
  codexId,
  codexSelection,
  createThread,
  layerPermissionRuntime,
  projectionOf,
  sendMessage,
  setSnapshots,
  threadOf,
} from "./PermissionTestkit.ts";

/** A parent chat with an active run, ready to delegate. */
const parentWithRun = (input: {
  readonly name: string;
  readonly runtimeMode: RuntimeMode;
  readonly permissionSource?: PermissionSource;
}) =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make(`thread:delegation:${input.name}`);
    yield* createThread({
      threadId: parentThreadId,
      modelSelection: claudeSelection,
      runtimeMode: input.runtimeMode,
      ...(input.permissionSource === undefined ? {} : { permissionSource: input.permissionSource }),
    });
    yield* sendMessage({
      threadId: parentThreadId,
      key: "delegate",
      dispatchMode: { type: "start_immediately" },
    });
    const run = (yield* projectionOf(parentThreadId)).runs.at(-1)!;
    return { parentThreadId, run };
  });

const delegate = (input: {
  readonly parent: Effect.Success<ReturnType<typeof parentWithRun>>;
  readonly key: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly childPolicy?: OrchestrationV2ChildPolicy;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const task = `Worker task ${input.key}`;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${input.parent.parentThreadId}:${input.key}`),
      parentThreadId: input.parent.parentThreadId,
      parentRunId: input.parent.run.id,
      parentNodeId: input.parent.run.rootNodeId!,
      task,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      ...(input.childPolicy === undefined ? {} : { childPolicy: input.childPolicy }),
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const parent = yield* projectionOf(input.parent.parentThreadId);
    const subagent = parent.subagents.find((candidate) => candidate.prompt === task)!;
    return { subagent, child: yield* threadOf(subagent.childThreadId!) };
  });

it.layer(layerPermissionRuntime)("workers run an explicit, recorded policy", (it) => {
  it.effect("records a same-instance worker's preset and stores it as an override", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const parent = yield* parentWithRun({ name: "same-instance", runtimeMode: "auto" });
      const { subagent, child } = yield* delegate({
        parent,
        key: "edits",
        modelSelection: claudeSelection,
        runtimeMode: "auto-accept-edits",
      });
      assert.deepStrictEqual(subagent.childPolicy, {
        source: "override",
        preset: "auto-accept-edits",
        providerInstanceId: claudeId,
        containment: "same-instance",
      });
      assert.deepInclude(child, { permissionSource: "override", runtimeMode: "auto-accept-edits" });
    }),
  );

  it.effect("labels a worker on another provider as contained only by its floor", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const parent = yield* parentWithRun({ name: "cross-provider", runtimeMode: "auto" });
      const { subagent, child } = yield* delegate({
        parent,
        key: "codex-floor",
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
      });
      assert.deepStrictEqual(subagent.childPolicy, {
        source: "override",
        preset: "approval-required",
        providerInstanceId: codexId,
        containment: "cross-provider-floor",
      });
      assert.deepInclude(child, { permissionSource: "override", runtimeMode: "approval-required" });
    }),
  );

  it.effect("never lets a worker inherit, even under a parent that does", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true });
      const parent = yield* parentWithRun({
        name: "inheriting-parent",
        runtimeMode: "approval-required",
        permissionSource: "inherit",
      });
      assert.equal((yield* threadOf(parent.parentThreadId)).permissionSource, "inherit");
      const { child } = yield* delegate({
        parent,
        key: "manual",
        modelSelection: claudeSelection,
        runtimeMode: "approval-required",
      });
      assert.equal(child.permissionSource, "override");
    }),
  );

  // A Codex worker asked for Auto runs Supervised, and is stored as what it
  // runs (O3), like thread.create, permission changes and the freeze.
  it.effect("stores the preset a worker actually runs", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const parent = yield* parentWithRun({ name: "stores-effective", runtimeMode: "auto" });
      const { child } = yield* delegate({
        parent,
        key: "codex-auto",
        modelSelection: codexSelection,
        runtimeMode: "auto",
      });
      assert.equal(child.runtimeMode, "approval-required");
    }),
  );
});

describe("children never run Bypass (O5)", () => {
  it.layer(layerPermissionRuntime)("refusals", (it) => {
    it.effect.each([
      ["with Bypass off", false],
      ["with Bypass allowed", true],
    ] as const)("refuses a Bypass worker sent directly by a client, %s", ([, bypass]) =>
      Effect.gen(function* () {
        yield* setSnapshots({ claudeBypassAllowed: bypass });
        const parent = yield* parentWithRun({
          name: `bypass-parent-${bypass}`,
          runtimeMode: bypass ? "full-access" : "auto",
        });
        const refused = yield* delegate({
          parent,
          key: "bypass",
          modelSelection: claudeSelection,
          runtimeMode: "full-access",
        }).pipe(Effect.flip);
        assert.include(causeOf(refused), "cannot use Bypass");
        assert.lengthOf((yield* projectionOf(parent.parentThreadId)).subagents, 0);
      }),
    );

    it.effect("refuses a recorded child policy that claims Bypass", () =>
      Effect.gen(function* () {
        yield* setSnapshots({ claudeBypassAllowed: true });
        const parent = yield* parentWithRun({ name: "bypass-policy", runtimeMode: "full-access" });
        const refused = yield* delegate({
          parent,
          key: "policy-bypass",
          modelSelection: claudeSelection,
          runtimeMode: "full-access",
          childPolicy: {
            source: "override",
            preset: "full-access",
            providerInstanceId: claudeId,
            containment: "same-instance",
          },
        }).pipe(Effect.flip);
        assert.include(causeOf(refused), "cannot use Bypass");
      }),
    );
  });
});
