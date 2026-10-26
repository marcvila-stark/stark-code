import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const verifyLocalSession = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread:local-cli-history");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const localSession = {
    providerSessionId: "native-session",
    cwd: "/original/cli/folder",
    historyTruncated: true,
  };
  yield* store.apply({
    id: EventId.make("event:local-cli-history:created"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: ProjectId.make("project:main-folder"),
      title: "CLI history",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "claude-sonnet-5-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      localSession,
      activeProviderThreadId: null,
      historyOrigin: "v1_import",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const detail = yield* store.getThread(threadId);
  const shell = (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === threadId);
  assert.deepEqual(detail.localSession, localSession);
  assert.deepEqual(shell?.localSession, localSession);
  assert.isNull(shell?.worktreePath);
});

it.effect("SQL projections retain imported chat provenance without creating a worktree", () =>
  verifyLocalSession.pipe(
    Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  ),
);
it.effect("memory projections retain imported chat provenance without creating a worktree", () =>
  verifyLocalSession.pipe(Effect.provide(ProjectionStore.layerMemory)),
);
