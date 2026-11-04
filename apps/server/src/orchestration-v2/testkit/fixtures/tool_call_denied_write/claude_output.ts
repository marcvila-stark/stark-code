import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@starkfuture/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertReplayLabelPrefixCount,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { TOOL_CALL_DENIED_WRITE_PROMPT, TOOL_CALL_DENIED_WRITE_TARGET } from "./input.ts";

export function assertToolCallDeniedWriteClaudeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_DENIED_WRITE_PROMPT]);
  assertAssistantTextIncludes(projection, "write permission denied");

  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["file-change"]);
  assertAllRuntimeRequestsResolved(projection);
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.decision),
    ["decline"],
  );
  assertReplayLabelPrefixCount(transcript, "permission.request:", 1);
  assertReplayLabelPrefixCount(transcript, "permission.response:", 1);

  const writes = projection.turnItems.filter((item) => item.type === "file_change");
  assert.lengthOf(writes, 1);
  assert.equal(writes[0]?.status, "failed");

  // The declined card showed the file the Write would create and its content;
  // the answered approval keeps the file but not the diff.
  const pending = result.domainEvents.flatMap((event) =>
    event.type === "turn-item.updated" &&
    event.payload.type === "approval_request" &&
    event.payload.status === "waiting"
      ? [event.payload]
      : [],
  );
  assert.lengthOf(pending, 1);
  const [proposed] = pending[0]?.proposedChanges ?? [];
  assert.isTrue(proposed?.path.endsWith(`/${TOOL_CALL_DENIED_WRITE_TARGET}`));
  assert.equal(proposed?.operation, "add");
  assert.include(proposed?.patch, "+approval fixture\n");
  const resolved = projection.turnItems.find((item) => item.type === "approval_request");
  assert.deepEqual(resolved?.type === "approval_request" ? resolved.proposedChanges : [], [
    { path: proposed?.path ?? "", operation: "add" },
  ]);
}
