import {
  EnvironmentId,
  NodeId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@starkfuture/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { EMPTY_THREAD_HISTORY_META } from "./threadHistoryMerge.ts";
import type { EnvironmentThreadState } from "./threads.ts";

const requestId = RuntimeRequestId.make("approval");
const nodeId = NodeId.make("approval-node");
const parentNodeId = NodeId.make("command-node");
const runId = RunId.make("run");

function fixture(): OrchestrationV2ThreadProjection {
  const base = {
    threadId: v2Projection.thread.id,
    runId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "waiting" as const,
    title: null,
    startedAt: v2Now,
    completedAt: null,
    updatedAt: v2Now,
  };
  return {
    ...v2Projection,
    nodes: [
      {
        id: nodeId,
        threadId: base.threadId,
        runId,
        parentNodeId,
        rootNodeId: parentNodeId,
        kind: "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: v2Now,
        completedAt: null,
      },
    ],
    runtimeRequests: [
      {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
        createdAt: v2Now,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        ...base,
        id: TurnItemId.make("command"),
        nodeId: parentNodeId,
        type: "command_execution",
        input: "git reset --hard HEAD",
      },
      {
        ...base,
        id: TurnItemId.make("approval-item"),
        nodeId,
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "Read the repository",
      },
      {
        ...base,
        id: TurnItemId.make("unrelated"),
        nodeId: NodeId.make("unrelated"),
        type: "command_execution",
        input: "git status",
      },
    ],
  };
}

describe("exact approval command association", () => {
  it("uses the linked command rather than agent prose or the latest sibling command", () => {
    const approval = derivePendingThreadRequests(fixture()).approvals[0];
    expect(approval?.command).toBe("git reset --hard HEAD");
    expect(approval?.detail).toBe("Read the repository");
  });
  it("refuses a different run, a subagent parent, or absent command evidence", () => {
    const original = fixture();
    for (const projection of [
      { ...original, nodes: [] },
      {
        ...original,
        nodes: original.nodes.map((node) => ({ ...node, runId: RunId.make("another") })),
      },
      {
        ...original,
        nodes: original.nodes.map((node) => ({ ...node, parentNodeId: NodeId.make("subagent") })),
      },
      {
        ...original,
        turnItems: original.turnItems.filter((item) => item.type !== "command_execution"),
      },
    ]) {
      expect(derivePendingThreadRequests(projection).approvals[0]?.command).toBeUndefined();
    }
  });
  it("updates the shared pending-request selector when exact command evidence arrives later", () => {
    const projection = fixture();
    const state = (
      data: OrchestrationV2ThreadProjection,
    ): AsyncResult.AsyncResult<EnvironmentThreadState, never> =>
      AsyncResult.success({
        data: Option.some(data),
        status: "live",
        error: Option.none(),
        history: EMPTY_THREAD_HISTORY_META,
      });
    const source = Atom.make(state({ ...projection, nodes: [] }));
    const detail = createEnvironmentThreadDetailAtoms(() => source);
    const registry = AtomRegistry.make();
    const ref = { environmentId: EnvironmentId.make("env"), threadId: projection.thread.id };
    expect(registry.get(detail.pendingRequestsAtom(ref))?.approvals[0]?.command).toBeUndefined();
    registry.set(source, state(projection));
    expect(registry.get(detail.pendingRequestsAtom(ref))?.approvals[0]?.command).toBe(
      "git reset --hard HEAD",
    );
    registry.set(
      source,
      state({
        ...projection,
        turnItems: projection.turnItems.map((item) =>
          item.type === "command_execution" && item.nodeId === parentNodeId
            ? { ...item, input: "git status" }
            : item,
        ),
      }),
    );
    expect(registry.get(detail.pendingRequestsAtom(ref))?.approvals[0]?.command).toBe("git status");
    registry.dispose();
  });
});
