import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@starkfuture/contracts";
import type * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for answer validation"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "approval-answers" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("refuses an approval answer that arrives before the request's card", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:answer-before-card");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-answer-before-card"),
      threadId,
      projectId: ProjectId.make("project:answer-before-card"),
      title: "Answers",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const sessionId = ProviderSessionId.make("session:answer-before-card");
    yield* projections.apply({
      id: EventId.make("attach-answer-before-card"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: "gpt-5.1-codex",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    const requestId = RuntimeRequestId.make("request:answer-before-card");
    const nodeId = NodeId.make("node:answer-before-card");
    // The adapter published the request; its card is still on the way.
    yield* projections.apply({
      id: EventId.make("request:answer-before-card"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: sessionId },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const respond = (key: string, decision: "accept" | "acceptForSession") =>
      orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`respond:answer-before-card:${key}`),
        threadId,
        requestId,
        decision,
      });
    const early = yield* respond("early", "acceptForSession").pipe(Effect.flip);
    assert.include(String(Reflect.get(Object(early), "cause")), "have not arrived yet");
    assert.equal((yield* projections.getRuntimeRequest(threadId, requestId))?.status, "pending");

    yield* projections.apply({
      id: EventId.make("card:answer-before-card"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("card:answer-before-card"),
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "approval_request",
        requestId,
        requestKind: "command",
        options: [
          { decision: "accept", label: "Allow once" },
          { decision: "decline", label: "Deny" },
        ],
      },
    });
    // With the card, the answer is checked against what it offers.
    const unoffered = yield* respond("unoffered", "acceptForSession").pipe(Effect.flip);
    assert.include(String(Reflect.get(Object(unoffered), "cause")), "no longer offered");
    yield* respond("offered", "accept");
    const answered = yield* projections.getRuntimeRequest(threadId, requestId);
    assert.equal(answered?.status, "resolved");
    assert.equal(answered?.chosen?.optionId, "once:0");
  }).pipe(Effect.provide(layerTest)),
);
