import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@starkfuture/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_WRITE_PROMPT,
} from "../shared.ts";

export function assertToolCallRestrictedGranularOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "file_change",
    "approval_request",
    "assistant_message",
  ]);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["file-change"]);
  assertAllRuntimeRequestsResolved(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_WRITE_PROMPT]);

  // The pending card showed the file Codex announced in item/started with its
  // content; once answered, the approval keeps the file but not the diff.
  const pending = result.domainEvents.flatMap((event) =>
    event.type === "turn-item.updated" &&
    event.payload.type === "approval_request" &&
    event.payload.status === "waiting"
      ? [event.payload]
      : [],
  );
  assert.lengthOf(pending, 1);
  const [proposed] = pending[0]?.proposedChanges ?? [];
  assert.isTrue(proposed?.path.endsWith("/.codex-probe-write-action.txt"));
  assert.equal(proposed?.operation, "add");
  assert.include(proposed?.patch, "+codex app-server approval fixture.\n");
  const resolved = projection.turnItems.find((item) => item.type === "approval_request");
  assert.deepEqual(resolved?.type === "approval_request" ? resolved.proposedChanges : [], [
    { path: proposed?.path ?? "", operation: "add" },
  ]);
}
