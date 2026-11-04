import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import type * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Permission tests never launch a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const orchestration = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "mcp-pending-request-permissions" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
const tools = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(
    ThreadManagement.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
    ),
  ),
);
const callerId = ThreadId.make("thread:permission-caller");
const otherId = ThreadId.make("thread:permission-other");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:permission-tests"),
  requestNamespace: "permission-tests",
  thread: {
    threadId: callerId,
    providerSessionId: "caller-session",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "permission-tests", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "permission-tests", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const seed = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  for (const threadId of [callerId, otherId]) {
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:permission-tests"),
      title: "Permissions",
      modelSelection: { instanceId, model: "gpt-5" },
      // Codex runs Supervised under the brand, so that is all either thread
      // holds; a stored Bypass would refuse the caller before the boundary here.
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`start:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Wait for input",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const sessionId = ProviderSessionId.make(`session:${threadId}`);
    yield* projections.apply({
      id: EventId.make(`session:${threadId}`),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: "gpt-5",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    for (const kind of ["permission", "user_input"] as const) {
      const requestId = RuntimeRequestId.make(`${threadId}:${kind}`);
      const nodeId = NodeId.make(`node:${requestId}`);
      yield* projections.apply({
        id: EventId.make(`request:${requestId}`),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: sessionId },
          createdAt: now,
          resolvedAt: null,
        },
      });
      if (kind === "permission") {
        // The approval card carries the choices an answer is checked against.
        yield* projections.apply({
          id: EventId.make(`item:${requestId}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${requestId}`),
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
            requestKind: "permission",
            options: [
              { decision: "accept", label: "Allow once" },
              { decision: "decline", label: "Deny" },
            ],
          },
        });
      }
      if (kind === "user_input") {
        yield* projections.apply({
          id: EventId.make(`item:${requestId}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${requestId}`),
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
            type: "user_input_request",
            requestId,
            questions: [{ id: "color", header: "Color", question: "Which color?", options: [] }],
          },
        });
      }
    }
  }
});

// The tables orchestration V2 writes: its events and receipts share the
// application event log; only the effect outbox keeps a V2 table.
const durableCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{
    readonly events: number;
    readonly receipts: number;
    readonly effects: number;
  }>`
    SELECT (SELECT COUNT(*) FROM orchestration_events) AS events,
      (SELECT COUNT(*) FROM orchestration_command_receipts) AS receipts,
      (SELECT COUNT(*) FROM orchestration_v2_effect_outbox) AS effects
  `;
  return counts!;
});

it.layer(orchestration)("MCP pending request permission boundary", (it) => {
  it.effect(
    "cannot approve its own or another thread's requests, even as a full-access client",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const before = yield* durableCounts;
        // The seed's own commands are counted, so a write below would show.
        assert.isAbove(before.events, 0);
        assert.isAbove(before.receipts, 0);
        const outsideAgent = {
          ...scope,
          thread: undefined,
          client: { sessionId: "outside", label: "Outside agent", access: "full-access" as const },
        };
        for (const invocation of [scope, outsideAgent]) {
          for (const threadId of [callerId, otherId]) {
            const requestId = RuntimeRequestId.make(`${threadId}:permission`);
            const list = yield* call("stark_pending_request_list", { threadId }, invocation);
            assert.deepEqual(list.structuredContent, { requestIds: [`${threadId}:user_input`] });
            for (const name of ["stark_pending_request_read", "stark_pending_request_respond"]) {
              const result = yield* call(
                name,
                {
                  threadId,
                  requestId,
                  answers: { permission: "yes" },
                  decision: "acceptAlways",
                },
                invocation,
              );
              assert.isTrue(result.isError);
              assert.include(JSON.stringify(result.content), "invalid_request");
            }
            assert.equal(
              (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
              "pending",
            );
          }
        }
        assert.deepEqual(yield* durableCounts, before);
      }).pipe(Effect.provide(tools)),
  );

  it.effect("answers user questions without forwarding an injected permission decision", () =>
    Effect.gen(function* () {
      yield* seed;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const requestId = RuntimeRequestId.make(`${callerId}:user_input`);
      const result = yield* call("stark_pending_request_respond", {
        requestId,
        answers: { color: "Blue" },
        decision: "acceptAlways",
      });
      assert.isFalse(result.isError, JSON.stringify(result.content));
      const request = yield* projections.getRuntimeRequest(callerId, requestId);
      assert.equal(request?.status, "resolved");
      assert.deepEqual(request?.answers, { color: "Blue" });
      assert.isUndefined(request?.decision);
      assert.equal(
        (yield* projections.getRuntimeRequest(
          callerId,
          RuntimeRequestId.make(`${callerId}:permission`),
        ))?.status,
        "pending",
      );
    }).pipe(Effect.provide(tools)),
  );

  it.effect("still accepts and persists a human client's permission decision", () =>
    Effect.gen(function* () {
      yield* seed;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const requestId = RuntimeRequestId.make(`${callerId}:permission`);
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("human-approval"),
        threadId: callerId,
        requestId,
        decision: "accept",
      });
      const request = yield* projections.getRuntimeRequest(callerId, requestId);
      assert.equal(request?.status, "resolved");
      assert.equal(request?.decision, "accept");
    }),
  );
});
