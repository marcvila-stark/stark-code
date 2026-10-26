import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2PendingRuntimeRequestSummary,
} from "@starkfuture/contracts";
import { collectNeedsYou, prioritizePendingRequest } from "./needsYou";
import { makeThreadFixture } from "./test-fixtures";

const request = (
  id: string,
  kind: OrchestrationV2PendingRuntimeRequestSummary["kind"],
  at = "2026-10-20T12:00:00Z",
) => ({
  id: RuntimeRequestId.make(id),
  kind,
  createdAt: DateTime.makeUnsafe(at),
});
const pending = (
  id: string,
  environment = "local",
  kind: OrchestrationV2PendingRuntimeRequestSummary["kind"] = "user_input",
) => {
  const thread = makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make(environment),
    title: id,
  });
  return {
    ...thread,
    source: { ...thread.source, pendingRuntimeRequest: request(`request-${id}`, kind) },
  };
};

it("collects pending requests across folders and environments, hides resolved/deleted, and preserves exact identities", () => {
  const local = pending("local-question");
  const remote = pending("remote-sign-in", "remote", "auth_refresh");
  const deleted = { ...pending("deleted"), deletedAt: "2026-10-20T12:00:00Z" };
  const resolved = makeThreadFixture({ id: ThreadId.make("resolved") });
  const projects = [local, remote].map((thread) => ({
    id: thread.projectId,
    environmentId: thread.environmentId,
    title: `${thread.environmentId} folder`,
    workspaceRoot: `/work/${thread.environmentId}`,
    scripts: [],
    defaultModelSelection: null,
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
  }));
  const entries = collectNeedsYou([remote, deleted, local, resolved, local], projects);
  expect(entries).toHaveLength(2);
  expect(entries.find((entry) => entry.title === local.title)).toMatchObject({
    threadRef: { environmentId: local.environmentId, threadId: local.id },
    requestId: "request-local-question",
    folder: "local folder",
    kind: "question",
  });
  expect(entries.find((entry) => entry.title === remote.title)).toMatchObject({
    threadRef: { environmentId: remote.environmentId, threadId: remote.id },
    kind: "sign-in",
    folder: "remote folder",
  });
  expect(collectNeedsYou([resolved], projects)).toEqual([]);
});

it("keeps native attention tied to its host and existing chat without inventing a runtime request", () => {
  const thread = makeThreadFixture();
  const native = {
    environmentId: thread.environmentId,
    threadId: String(thread.id),
    terminalId: "native-agent-claude",
    provider: "claude" as const,
    kind: "permission" as const,
    sessionId: "session",
    requestedAt: "2026-10-20T12:00:00Z",
  };
  expect(
    collectNeedsYou(
      [thread],
      [],
      [native, { ...native, environmentId: EnvironmentId.make("other") }],
    ),
  ).toMatchObject([
    {
      threadRef: { environmentId: thread.environmentId, threadId: thread.id },
      terminalId: native.terminalId,
      requestId: null,
      kind: "approval",
      provider: "Claude · terminal",
    },
  ]);
  expect(collectNeedsYou([], [], [native])).toEqual([]);
});

it("prioritizes the chosen request without changing other pending requests or stale selections", () => {
  const requests = ["first", "second", "third"].map((id) => ({
    requestId: RuntimeRequestId.make(id),
  }));
  expect(prioritizePendingRequest(requests, requests[1]!.requestId)).toEqual([
    requests[1],
    requests[0],
    requests[2],
  ]);
  expect(requests.map((item) => item.requestId)).toEqual(["first", "second", "third"]);
  expect(prioritizePendingRequest(requests, RuntimeRequestId.make("resolved"))).toBe(requests);
});

it("keeps native Codex input generic, labels explicit kinds, and removes resolved status", () => {
  const thread = makeThreadFixture();
  for (const [kind, expectedKind] of [
    ["input", "input"],
    ["permission", "approval"],
    ["question", "question"],
    ["auth", "sign-in"],
  ] as const) {
    expect(
      collectNeedsYou(
        [thread],
        [],
        [
          {
            environmentId: thread.environmentId,
            threadId: thread.id,
            terminalId: "native-agent-codex",
            provider: "codex",
            kind,
            requestedAt: "2026-10-20T12:00:00Z",
          },
        ],
      ),
    ).toMatchObject([
      {
        requestId: null,
        kind: expectedKind,
        provider: "Codex · terminal",
        nativeProvider: "codex",
      },
    ]);
  }
  expect(collectNeedsYou([thread], [], [])).toEqual([]);
});
