import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ContextHandoffId,
  OrchestrationV2Command,
  ProviderDriverKind,
  ThreadId,
} from "@starkfuture/contracts";

import { continuesImportedAgentSession } from "./AgentSessionContinuation.ts";

import {
  appendContextHandoffId,
  canReplayCommandReceipt,
  shouldPrepareLegacyImportHandoff,
} from "./Orchestrator.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

it("does not resend an imported CLI session's transcript to that session", () => {
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      continuesImportedAgentSession: true,
    }),
  );
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      continuesImportedAgentSession: false,
    }),
  );
});

it("recognizes the native session an imported thread came from", () => {
  const threadId = ThreadId.make("import:claudeAgent:6f1c2f0e-3b7a-4c55-9d7e-1a2b3c4d5e6f");
  const nativeThreadRef = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
    nativeThreadRef: { driver: ProviderDriverKind.make("claudeAgent"), nativeId, strength },
  });

  assert.isTrue(
    continuesImportedAgentSession({
      threadId,
      providerThread: nativeThreadRef("6f1c2f0e-3b7a-4c55-9d7e-1a2b3c4d5e6f"),
    }),
  );
  // A fresh session that replaced it after a failed resume holds none of it.
  assert.isFalse(
    continuesImportedAgentSession({ threadId, providerThread: nativeThreadRef("fresh-session") }),
  );
  assert.isFalse(
    continuesImportedAgentSession({
      threadId,
      providerThread: nativeThreadRef("6f1c2f0e-3b7a-4c55-9d7e-1a2b3c4d5e6f", "weak"),
    }),
  );
  assert.isFalse(continuesImportedAgentSession({ threadId, providerThread: undefined }));
  assert.isFalse(
    continuesImportedAgentSession({
      threadId: ThreadId.make("thread-native"),
      providerThread: nativeThreadRef("thread-native"),
    }),
  );
});

it("records a reissued legacy handoff on an existing provider thread", () => {
  const existingHandoffId = ContextHandoffId.make("handoff:legacy-import:existing");
  const retryHandoffId = ContextHandoffId.make("handoff:legacy-import:retry");

  assert.deepEqual(appendContextHandoffId([existingHandoffId], retryHandoffId), [
    existingHandoffId,
    retryHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], existingHandoffId), [
    existingHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], null), [existingHandoffId]);
});

it("only replays a command receipt for the thread it was recorded against", () => {
  const threadA = ThreadId.make("thread-a");
  const threadB = ThreadId.make("thread-b");

  assert.strictEqual(canReplayCommandReceipt(threadA, threadA), true);
  // A reused command id aimed at another thread must not report the first
  // thread's success as this thread's (v1 #5246).
  assert.strictEqual(canReplayCommandReceipt(threadA, threadB), false);
});

it("links and unlinks a pull request through thread.metadata.update (#8160)", () => {
  // The fold is exercised through the schema: a command carrying the link
  // must round-trip, and one without it must leave the field untouched.
  const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
  const linked = decode({
    type: "thread.metadata.update",
    commandId: "command-link",
    threadId: "thread-1",
    linkedPullRequest: {
      projectId: "project-1",
      repository: "example/stark-code",
      number: 8160,
      url: "https://github.com/example/stark-code/pull/8160",
    },
  });
  assert.deepStrictEqual(
    (linked as Extract<typeof linked, { type: "thread.metadata.update" }>).linkedPullRequest,
    {
      projectId: "project-1",
      repository: "example/stark-code",
      number: 8160,
      url: "https://github.com/example/stark-code/pull/8160",
    },
  );
  const unlinked = decode({
    type: "thread.metadata.update",
    commandId: "command-unlink",
    threadId: "thread-1",
    linkedPullRequest: null,
  });
  assert.strictEqual(
    (unlinked as Extract<typeof unlinked, { type: "thread.metadata.update" }>).linkedPullRequest,
    null,
  );
});
