import { CODEX_PRIVACY_ARGS } from "@starkfuture/shared/providerPrivacy";
import * as NodeOS from "node:os";

import { historyResponseItems } from "@starkfuture/provider-core/server/handoffBudget";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ComposerContextId,
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@starkfuture/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import { projectComposerContextForProvider } from "@starkfuture/shared/composerContextReferences";
import { SpawnExecutableResolution } from "@starkfuture/shared/shell";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexError from "effect-codex-app-server/errors";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@starkfuture/shared/mcpApp";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import * as McpProviderSessions from "@starkfuture/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@starkfuture/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@starkfuture/provider-core/server/ProviderContinuationRequests";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { UserShellCommandRunner } from "../../shell/UserShellCommandRunner.ts";
import { makeReplayServerConfig, withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const replayTranscriptJson = Schema.fromJsonString(CodexReplay.CodexAppServerReplayTranscript);
const encodeReplayTranscriptJson = Schema.encodeEffect(replayTranscriptJson);
const decodeReplayTranscriptJson = Schema.decodeUnknownEffect(replayTranscriptJson);
const encodeStringJson = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

describe("Codex context usage compatibility", () => {
  const previous: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6-astra",
  };
  it("retains measured usage for reasoning-only changes in either direction", () => {
    const low: ModelSelection = { ...previous, options: [{ id: "reasoningEffort", value: "low" }] };
    assert.isTrue(CodexAdapterV2.canReuseCodexContextUsage(previous, low));
    assert.isTrue(CodexAdapterV2.canReuseCodexContextUsage(low, previous));
    assert.isTrue(
      CodexAdapterV2.canReuseCodexContextUsage(low, {
        ...low,
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    );
  });
  it("invalidates usage for model, instance, context-window and unknown option changes", () => {
    for (const next of [
      { ...previous, model: "other-model" },
      { ...previous, instanceId: ProviderInstanceId.make("other-codex") },
      { ...previous, options: [{ id: "contextWindow", value: "32k" }] },
      { ...previous, options: [{ id: "customOption", value: "value" }] },
    ])
      assert.isFalse(CodexAdapterV2.canReuseCodexContextUsage(previous, next));
  });
});

describe("CodexAdapterV2 file change approvals", () => {
  it("uses nonblank reasons before sorted file operations and renamed paths", () => {
    const fileChanges = {
      "/tmp/removed.md": { type: "delete" as const, content: "gone" },
      "/tmp/added.ts": { type: "add" as const, content: "export {};" },
      "/tmp/moved.ts": {
        type: "update" as const,
        unified_diff: "@@",
        move_path: "/tmp/renamed.ts",
      },
    };
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: "  Update configuration. ",
        fileChanges,
      }),
      "Update configuration.",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", fileChanges }),
      "add /tmp/added.ts\nupdate /tmp/moved.ts -> /tmp/renamed.ts\ndelete /tmp/removed.md",
    );
  });

  it("falls back to a nonblank grant root and omits empty details", () => {
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", grantRoot: " /workspace " }),
      "/workspace",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges: {}, grantRoot: "/workspace" }),
      "/workspace",
    );
    assert.isUndefined(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: " ",
        grantRoot: " ",
        fileChanges: {},
      }),
    );
  });

  it("bounds large patch descriptions without losing the remaining count", () => {
    const fileChanges = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `/tmp/file-${String(index).padStart(2, "0")}.ts`,
        { type: "add" as const, content: "" },
      ]),
    );
    const detail = CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges });
    assert.equal(detail?.split("\n").length, 21);
    assert.isTrue(detail?.startsWith("add /tmp/file-00.ts") ?? false);
    assert.isTrue(detail?.endsWith("+5 more") ?? false);
    assert.notInclude(detail, "file-20.ts");
  });
});

describe("CodexAdapterV2 context usage", () => {
  it("uses the current context rather than cumulative processed tokens", () => {
    const usage = CodexAdapterV2.codexProviderTurnTokenUsage(
      {
        total: {
          totalTokens: 180_000,
          inputTokens: 160_000,
          cachedInputTokens: 20_000,
          outputTokens: 20_000,
          reasoningOutputTokens: 5_000,
        },
        last: {
          totalTokens: 50_000,
          inputTokens: 45_000,
          cachedInputTokens: 10_000,
          outputTokens: 5_000,
          reasoningOutputTokens: 1_000,
        },
        modelContextWindow: 200_000,
      },
      "2026-08-29T00:00:00.000Z",
    );

    assert.deepEqual(usage, {
      usedTokens: 50_000,
      maxTokens: 200_000,
      inputTokens: 45_000,
      cachedInputTokens: 10_000,
      outputTokens: 5_000,
      reasoningOutputTokens: 1_000,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
  });
});

describe("CodexAdapterV2 assistant message streaming", () => {
  it.effect("makes accumulated assistant text visible after the bounded flush interval", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<
        ReadonlyArray<{
          readonly turnId: string;
          readonly itemId: string;
          readonly text: string;
          readonly completed: boolean;
        }>
      >([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "partial" });
      assert.deepEqual(yield* Ref.get(updates), []);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "partial",
          completed: false,
        },
      ]);
    }),
  );

  it.effect("coalesces multiple token deltas into one assistant update per interval", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "one" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: " two" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: " three" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "one two three",
          completed: false,
        },
      ]);
    }),
  );

  it.effect("flushes buffered text synchronously before item and turn completion", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "item final" });
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
      });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "turn final" });
      yield* coalescer.flushTurn("turn-1");

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-1", text: "item final", completed: true },
        { turnId: "turn-1", itemId: "message-2", text: "turn final", completed: true },
      ]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      assert.equal((yield* Ref.get(updates)).length, 2);
    }),
  );

  it.effect("retains buffered text until completion updates are emitted", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const failNext = yield* Ref.make(true);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) =>
          Ref.getAndSet(failNext, false).pipe(
            Effect.flatMap((shouldFail) =>
              shouldFail
                ? Effect.die("projection unavailable")
                : Ref.update(updates, (current) => [...current, update]),
            ),
          ),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "turn final" });
      const failedFlush = yield* coalescer.flushTurn("turn-1").pipe(Effect.exit);
      assert.equal(failedFlush._tag, "Failure");
      yield* coalescer.flushTurn("turn-1");

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "item final" });
      yield* Ref.set(failNext, true);
      const failedComplete = yield* coalescer
        .complete({ turnId: "turn-1", itemId: "message-2" })
        .pipe(Effect.exit);
      assert.equal(failedComplete._tag, "Failure");
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-2",
      });

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-1", text: "turn final", completed: true },
        { turnId: "turn-1", itemId: "message-2", text: "item final", completed: true },
      ]);
    }),
  );

  it.effect("can discard an empty completion without emitting an assistant update", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
        finalText: "",
        emitEmpty: false,
      });

      assert.equal(completedText, "");
      assert.deepEqual(yield* Ref.get(updates), []);

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "buffered" });
      assert.equal(
        yield* coalescer.complete({
          turnId: "turn-1",
          itemId: "message-2",
          emitEmpty: false,
        }),
        "buffered",
      );
      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-2",
          text: "buffered",
          completed: true,
        },
      ]);
    }),
  );

  it.effect("treats explicit empty final text as authoritative over buffered deltas", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({
        turnId: "turn-1",
        itemId: "message-1",
        delta: "stale buffered text",
      });
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
        finalText: "",
      });

      assert.equal(completedText, "");
      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "",
          completed: true,
        },
      ]);
    }),
  );
});

describe("CodexAdapterV2 runtime policy", () => {
  it.effect("derives concrete Codex turn policies from every Stark runtime mode", () =>
    Effect.gen(function* () {
      const build = (
        runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
      ) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: `native-${runtimeMode}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode,
            interactionMode: "default",
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
        });

      const approvalRequired = yield* build("approval-required");
      const autoAcceptEdits = yield* build("auto-accept-edits");
      const auto = yield* build("auto");
      const fullAccess = yield* build("full-access");

      assert.equal(approvalRequired.approvalPolicy, "untrusted");
      assert.equal(approvalRequired.approvalsReviewer, "user");
      assert.equal(approvalRequired.sandboxPolicy?.type, "readOnly");
      assert.equal(autoAcceptEdits.approvalPolicy, "on-request");
      assert.equal(autoAcceptEdits.approvalsReviewer, "user");
      assert.equal(autoAcceptEdits.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(auto.approvalPolicy, "on-request");
      assert.equal(auto.approvalsReviewer, "auto_review");
      assert.equal(auto.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(fullAccess.approvalPolicy, "never");
      assert.equal(fullAccess.approvalsReviewer, "user");
      assert.equal(fullAccess.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it.effect("leaves every permission key to Codex for a chat that inherits its settings", () =>
    Effect.gen(function* () {
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      const supervised = {
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
      } as const;
      const inherited = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-inherit",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: { ...supervised, permissionSource: "inherit" },
        modelSelection,
      });
      for (const key of ["approvalPolicy", "approvalsReviewer", "sandboxPolicy", "permissions"])
        assert.notProperty(inherited, key);
      // A saved chat says nothing about its source and keeps Stark's preset.
      const saved = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-inherit",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: supervised,
        modelSelection,
      });
      assert.deepInclude(saved, {
        approvalsReviewer: "user",
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "readOnly" },
      });
      // Only where Codex refused `untrusted` does Supervised ask with the granular policy.
      const fallback = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-inherit",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: supervised,
        modelSelection,
        untrustedFallback: true,
      });
      assert.deepEqual(fallback.approvalPolicy, {
        granular: {
          sandbox_approval: true,
          rules: true,
          skill_approval: true,
          request_permissions: true,
          mcp_elicitations: true,
        },
      });
      assert.deepEqual(fallback.sandboxPolicy, { type: "readOnly" });
    }),
  );

  it.effect("preserves explicit Codex turn policy overrides", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-override",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "readOnly",
          },
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      });

      assert.equal(params.approvalPolicy, "on-request");
      assert.equal(params.sandboxPolicy?.type, "readOnly");
    }),
  );

  it.effect("sends MCP app model context as untrusted Codex context", () =>
    Effect.gen(function* () {
      const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: null } as const;
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      const appContext = [{ key: "mcp_app_todos_list_todos_item-1", text: "Filtered to overdue" }];
      const alone = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-app-context",
        codexInput: [{ type: "text", text: "what's on my list?" }],
        runtimePolicy: policy,
        modelSelection,
        appContext,
      });
      assert.deepEqual(alone.additionalContext, {
        "mcp_app_todos_list_todos_item-1": { kind: "untrusted", value: "Filtered to overdue" },
      });
      // Alongside Stark's own context, both are kept.
      const withStark = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-app-context",
        codexInput: [{ type: "text", text: "what's on my list?" }],
        runtimePolicy: policy,
        modelSelection,
        hasStarkMcp: true,
        appContext,
      });
      assert.deepEqual(withStark.additionalContext?.["mcp_app_todos_list_todos_item-1"], {
        kind: "untrusted",
        value: "Filtered to overdue",
      });
      assert.isDefined(withStark.additionalContext?.["stark_code_runtime"]);
    }),
  );

  it.effect("adds default-mode developer instructions when the Stark MCP server is attached", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-orchestration-instructions",
        codexInput: [{ type: "text", text: "delegate this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasStarkMcp: true,
      });

      assert.equal(params.collaborationMode?.mode, "default");
      assert.include(
        params.additionalContext?.stark_code_orchestration?.value ?? "",
        "Use `delegate_task`",
      );
      assert.include(
        params.additionalContext?.stark_code_orchestration?.value ?? "",
        "structured object, never as JSON text",
      );
    }),
  );

  it.effect("omits default-mode collaboration settings without the Stark MCP server", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-default-without-stark-mcp",
        codexInput: [{ type: "text", text: "implement this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasStarkMcp: false,
      });

      assert.isUndefined(params.collaborationMode);
    }),
  );

  it.effect(
    "adds Stark plan-mode developer instructions when the Stark MCP server is attached",
    () =>
      Effect.gen(function* () {
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-plan-with-stark-mcp",
          codexInput: [{ type: "text", text: "plan this task" }],
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "plan",
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          hasStarkMcp: true,
        });

        assert.equal(params.collaborationMode?.mode, "plan");
        assert.include(
          params.collaborationMode?.settings.developer_instructions ?? "",
          "request_user_input",
        );
        assert.include(params.additionalContext?.stark_code_tools?.value ?? "", "preview_status");
      }),
  );

  it.effect("keeps Codex in plan mode without referencing unavailable Stark MCP tools", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-plan-without-stark-mcp",
        codexInput: [{ type: "text", text: "plan this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasStarkMcp: false,
      });

      assert.equal(params.collaborationMode?.mode, "plan");
      assert.notProperty(params.collaborationMode?.settings, "developer_instructions");
    }),
  );

  it.effect("compiles per-turn Codex model options and cwd from their owning inputs", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-model-options",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: "/workspace/model-options",
          reasoningEffort: "low",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "priority" },
          ],
        },
      });

      assert.equal(params.model, "gpt-5.4");
      assert.equal(params.effort, "xhigh");
      assert.equal(params.serviceTier, "priority");
      assert.equal(params.cwd, "/workspace/model-options");
      assert.equal(params.collaborationMode?.settings.model, "gpt-5.4");
      assert.equal(params.collaborationMode?.settings.reasoning_effort, "xhigh");

      // ChatGPT token sharing rejects service tiers, so managed sessions drop a stale pick.
      const managed = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-model-options",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/model-options",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [{ id: "serviceTier", value: "priority" }],
        },
        omitServiceTier: true,
      });
      assert.equal(managed.serviceTier, undefined);
    }),
  );
});

describe("CodexAdapterV2 process spawning", () => {
  it("injects cwd, model, and MCP authorization into thread-scoped params", () => {
    const threadId = ThreadId.make("thread-codex-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-codex-mcp"),
      threadId,
      providerSessionId: "mcp-session-codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      browserToolsAvailable: true,
    };

    assert.deepEqual(
      CodexAdapterV2.codexThreadRuntimeParams({
        mcpSession,
        modelSelection: { model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/thread-codex-mcp",
        },
      }),
      {
        cwd: "/workspace/thread-codex-mcp",
        model: "gpt-5.4",
        config: {
          ...CodexAdapterV2.CODEX_THREAD_CONFIG,
          mcp_servers: {
            "stark-code": {
              url: "http://127.0.0.1:43123/mcp",
              http_headers: {
                Authorization: "Bearer secret-codex-token",
              },
            },
          },
        },
      },
    );
  });

  it.effect("resolves Windows command shims through the shared spawn policy", () =>
    Effect.gen(function* () {
      const command = yield* CodexAdapterV2.makeCodexAppServerSpawnCommand({
        command: "codex",
        args: ["app-server", "argument with spaces"],
        cwd: "C:\\workspace",
        env: { CUSTOM: "1" },
        extendEnv: true,
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(command.command, '^"C:\\npm\\codex.cmd^"');
      assert.deepEqual(command.args, ['^"app-server^"', '^"argument^ with^ spaces^"']);
      assert.equal(command.options.shell, true);
      assert.equal(command.options.cwd, "C:\\workspace");
      assert.deepEqual(command.options.env, { CUSTOM: "1" });
      assert.equal(command.options.extendEnv, true);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {
        PATH: "C:\\Windows\\System32",
        HOST_ONLY: "1",
      }),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, environment) => {
        assert.equal(environment.HOST_ONLY, "1");
        assert.equal(environment.CUSTOM, "1");
        return "C:\\npm\\codex.cmd";
      }),
    ),
  );

  it.effect("uses direct execution for native executables", () =>
    Effect.gen(function* () {
      const command = yield* CodexAdapterV2.makeCodexAppServerSpawnCommand({
        command: "codex.exe",
        args: ["app-server"],
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(command.command, "C:\\bin\\codex.exe");
      assert.deepEqual(command.args, ["app-server"]);
      assert.equal(command.options.shell, false);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\bin\\codex.exe"),
    ),
  );

  it.effect("launches the app-server with the configured launch arguments", () =>
    Effect.gen(function* () {
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args);
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      });
      const factory = yield* CodexAdapterV2.CodexAppServerClientFactory.pipe(
        Effect.provide(CodexAdapterV2.layerAppServerClientFactory),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      );
      const open = (environment: NodeJS.ProcessEnv) =>
        factory
          .open({
            instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            threadId: ThreadId.make("thread-launch-args"),
            providerSessionId: ProviderSessionId.make("provider-session-launch-args"),
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            }),
            settings: {
              ...DEFAULT_CODEX_SETTINGS,
              launchArgs: " --strict-config -c model_reasoning_summary=detailed ",
            },
            environment,
          })
          .pipe(Effect.scoped, Effect.exit);

      yield* open({});
      yield* open({ STARK_CODE_CODEX_LAUNCH_ARGS: " --enable env-feature " });

      assert.deepEqual(spawnedArgs, [
        [
          "app-server",
          "--strict-config",
          "-c",
          "model_reasoning_summary=detailed",
          ...CODEX_PRIVACY_ARGS,
        ],
        ["app-server", "--enable", "env-feature", ...CODEX_PRIVACY_ARGS],
      ]);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("expands ~ in the configured binary path before spawning", () =>
    Effect.gen(function* () {
      const spawnedCommands: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedCommands.push(command.command);
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      });
      const path = yield* Path.Path;
      const adapter = yield* CodexAdapterV2.createCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: { ...DEFAULT_CODEX_SETTINGS, binaryPath: "~/bin/codex" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CodexAdapterV2.layerAppServerClientFactory,
            ServerConfig.layerTest(process.cwd(), { prefix: "stark-codex-binary-home-" }),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      );

      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-binary-home"),
          providerSessionId: ProviderSessionId.make("provider-session-binary-home"),
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        })
        .pipe(Effect.scoped, Effect.exit);

      assert.deepEqual(spawnedCommands, [path.join(NodeOS.homedir(), "bin", "codex")]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
      Effect.provideService(HostProcess.Platform, "linux"),
    ),
  );
});

describe("CodexAdapterV2 dynamic tool projection", () => {
  it.effect("keeps a failed Sky MCP call in Computer Use when its error has no metadata", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "failed-sky-js",
        server: "node_repl",
        tool: "js",
        status: "failed",
        arguments: {
          title: "Restrict the breakpoint to Git actions",
          code: "await sky.type_text({app:'Stark Code (Nightly)',text:'debug(ga.run)'});",
        },
        result: { content: [{ type: "text", text: "Illegal Unicode escape sequence" }] },
      });
      assert.equal(projection.title, "Restrict the breakpoint to Git actions");
      assert.equal(projection.toolSurface, "computer");
      assert.deepEqual(projection.toolSource, {
        key: "computer-use",
        name: "Computer Use",
        kind: "computer",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["inProgress", "completed", "failed"] as const)(
    "preserves a bare js action's title and computer surface when %s without result metadata",
    (status) =>
      Effect.gen(function* () {
        const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
          type: "dynamicToolCall",
          id: "bare-js",
          tool: "js",
          status,
          arguments: { code: "await sky.get_app_state(app);", title: "Read the desktop window" },
          contentItems: [],
          success: status !== "failed",
        });
        assert.equal(projection.title, "Read the desktop window");
        assert.equal(projection.toolSurface, "computer");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["cua_repl", "node_repl"])(
    "uses the %s call title while leaving other MCP titles as tool arguments",
    (server) =>
      Effect.gen(function* () {
        const call = {
          type: "mcpToolCall" as const,
          id: "inspect",
          server,
          tool: "js",
          status: "completed" as const,
          arguments: {
            code: "await game.getAXStateAndScreenshot();",
            title: "Inspect Saga music screen",
          },
          result: { content: [] },
        };
        assert.equal(
          (yield* CodexAdapterV2.projectCodexDynamicToolItem(call)).title,
          "Inspect Saga music screen",
        );
        assert.equal(
          (yield* CodexAdapterV2.projectCodexDynamicToolItem({
            ...call,
            arguments: { title: "  " },
          })).title,
          server === "cua_repl" ? "Computer use" : "Run JavaScript",
        );
        assert.equal(
          (yield* CodexAdapterV2.projectCodexDynamicToolItem({ ...call, server: "github" })).title,
          "js",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["inProgress", "completed", "failed"] as const)(
    "presents ordinary MCP calls when %s",
    (status) =>
      Effect.gen(function* () {
        const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
          type: "mcpToolCall",
          id: "weather-call",
          server: "weather",
          tool: "get_weather",
          status,
          arguments: { city: "Berlin" },
        });
        assert.equal(projection.title, "get weather");
        assert.deepEqual(projection.toolSource, {
          key: "mcp:weather",
          name: "weather",
          kind: "integration",
        });
        assert.deepEqual(projection.input, { city: "Berlin" });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses Codex connector names without reading a display title from arguments", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "connector-call",
        server: "_apps",
        tool: "connector_get_weather",
        status: "completed",
        arguments: { title: "Argument, not display metadata" },
        appContext: {
          connectorId: "weather-app",
          appName: "Weather",
          actionName: "Check weather",
        },
        result: {
          content: [],
          _meta: { source: { logoUrl: "https://example.com/weather.png" } },
        },
      });
      assert.equal(projection.title, "Check weather");
      assert.equal(projection.toolSource?.name, "Weather");
      assert.deepEqual(projection.toolIcon, {
        _tag: "themed-logo",
        logoUrl: "https://example.com/weather.png",
      });
      assert.deepEqual(projection.toolSource?.icon, projection.toolIcon);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves native browser and app icons alongside MCP tool output", () =>
    Effect.gen(function* () {
      const browser = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "browser",
        server: "browser",
        tool: "open",
        status: "completed",
        arguments: {},
        result: {
          content: [],
          _meta: {
            "codex/toolSurface": {
              kind: "browserUse",
              browserFamily: "Chrome",
              screenshot: {
                pageUrl: "https://example.com/docs",
                faviconUrl: "https://example.com/icon.png",
              },
            },
          },
        },
      });
      assert.equal(browser.toolSurface, "browser");
      assert.deepEqual(browser.toolIcon, {
        _tag: "website",
        pageUrl: "https://example.com/docs",
        faviconUrl: "https://example.com/icon.png",
      });
      assert.equal(browser.toolSource?.name, "Chrome");
      const app = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "app",
        server: "computer",
        tool: "click",
        status: "completed",
        arguments: {},
        result: {
          content: [],
          _meta: {
            "codex/toolSurface": {
              kind: "computerUse",
              app: { kind: "appId", appId: "com.apple.finder" },
            },
          },
        },
      });
      assert.deepEqual(app.toolIcon, {
        _tag: "native-app",
        app: { _tag: "app-id", appId: "com.apple.finder" },
      });
      assert.equal(app.toolSource?.name, "Finder");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves MCP arguments and prefers structured output", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "call-create-threads",
        server: "stark-code",
        tool: "create_threads",
        status: "completed",
        arguments: {
          threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
        },
        result: {
          content: [{ type: "text", text: '{"threads":[{"threadId":"thread:mcp:fixture:0"}]}' }],
          structuredContent: {
            threads: [{ threadId: "thread:mcp:fixture:0" }],
          },
        },
      });

      assert.deepEqual(projection, {
        toolName: "stark-code.create_threads",
        input: {
          threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
        },
        output: {
          threads: [{ threadId: "thread:mcp:fixture:0" }],
        },
        status: "completed",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves namespaced dynamic tool output", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "dynamicToolCall",
        id: "call-dynamic",
        namespace: "workspace",
        tool: "inspect",
        status: "failed",
        arguments: { path: "package.json" },
        contentItems: [{ type: "inputText", text: "inspection failed" }],
        success: false,
      });

      assert.deepEqual(projection, {
        toolName: "workspace.inspect",
        input: { path: "package.json" },
        output: [{ type: "inputText", text: "inspection failed" }],
        status: "failed",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("CodexAdapterV2 native protocol logging", () => {
  it.effect("logs decoded app-server frames once with credentials redacted", () =>
    Effect.gen(function* () {
      const writes: Array<{
        readonly event: unknown;
        readonly threadId: ThreadId | null;
      }> = [];
      const logger: ProviderEventLoggers.EventNdjsonLogger = {
        filePath: "/tmp/events.log",
        write: (event, threadId) =>
          Effect.sync(() => {
            writes.push({ event, threadId });
          }),
        close: () => Effect.void,
      };
      const threadId = ThreadId.make("thread-1");
      const providerSessionId = ProviderSessionId.make("provider-session-1");
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: logger,
        threadId,
        providerSessionId,
      });

      assert.notEqual(protocolLogger, undefined);
      if (protocolLogger === undefined) {
        return;
      }

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "thread/event",
          params: {
            id: "evt-1",
            http_headers: { Authorization: "Bearer secret-codex-token" },
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          },
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        payload:
          '{"method":"thread/event","params":{"http_headers":{"Authorization":"Bearer secret-codex-token"}}}\n',
      });

      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.threadId, threadId);
      assert.deepEqual(writes[0]?.event, {
        provider: "codex",
        protocol: "codex.app-server",
        kind: "protocol",
        providerSessionId,
        event: {
          direction: "incoming",
          stage: "decoded",
          payload: {
            method: "thread/event",
            params: {
              id: "evt-1",
              http_headers: { Authorization: "[REDACTED]" },
              usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
            },
          },
        },
      });
    }),
  );

  it.effect("filters streaming frames before redaction without losing decode failures", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: {
          filePath: "/tmp/events.log",
          write: (event) =>
            Effect.sync(() => {
              writes.push(event);
            }),
          close: () => Effect.void,
        },
        threadId: ThreadId.make("thread-1"),
        providerSessionId: ProviderSessionId.make("provider-session-1"),
      });
      assert.exists(protocolLogger);
      if (protocolLogger === undefined) return;

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "item/agentMessage/delta",
          get params() {
            throw new Error("delta must not be copied");
          },
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        get payload() {
          throw new Error("raw frame must not be parsed");
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "decode_failed",
        payload: { operation: "decode", method: "turn/completed", issueCount: 1 },
      });

      assert.equal(writes.length, 1);
      assert.nestedPropertyVal(writes[0], "event.stage", "decode_failed");
      assert.nestedPropertyVal(writes[0], "event.payload.method", "turn/completed");
    }),
  );

  it.effect("retains redacted failures when large payloads are summarized", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: {
          filePath: "/tmp/events.log",
          write: (event) =>
            Effect.sync(() => {
              writes.push(event);
            }),
          close: () => Effect.void,
        },
        threadId: ThreadId.make("thread-1"),
        providerSessionId: ProviderSessionId.make("provider-session-1"),
      });
      assert.exists(protocolLogger);
      if (protocolLogger === undefined) return;

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "error",
          params: {
            threadId: "native-thread",
            turnId: "native-turn",
            error: {
              code: "unauthorized",
              message: '{"message":"Unauthorized","Authorization":"Bearer secret-token"}',
            },
            history: "x".repeat(128 * 1_024),
          },
        },
      });

      const serialized = encodeUnknownJson(writes);
      assert.equal(writes.length, 1);
      assert.isBelow(serialized.length, 2_048);
      assert.notInclude(serialized, "secret-token");
      assert.include(serialized, "[REDACTED]");
      assert.nestedPropertyVal(writes[0], "event.payload.params.error.code", "unauthorized");
      assert.nestedPropertyVal(writes[0], "event.payload.params.turnId", "native-turn");
    }),
  );
});

describe("CodexAdapterV2 rollback mapping", () => {
  it.effect("derives native rollback count from durable provider turns", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider-thread-codex-rollback");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: ProviderSessionId.make("provider-session-codex-rollback"),
        appThreadId: ThreadId.make("thread-codex-rollback"),
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: "native-thread-codex-rollback",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerTurn = (
        id: string,
        ordinal: number,
        status: OrchestrationV2ProviderTurn["status"],
      ): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(id),
        providerThreadId,
        nodeId: NodeId.make(`node-${id}`),
        runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
        nativeTurnRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: `native-${id}`,
          strength: "strong",
        },
        ordinal,
        status,
        startedAt: now,
        completedAt: status === "running" || status === "pending" ? null : now,
      });
      const firstTurn = providerTurn("provider-turn-first", 1, "completed");
      const secondTurn = providerTurn("provider-turn-second", 2, "completed");
      const runningTurn = providerTurn("provider-turn-running", 3, "running");
      const interruptedTurn = providerTurn("provider-turn-interrupted", 4, "interrupted");
      // `/goal` control turns never reached Codex, so revert must not count them.
      const goalCommandTurn = {
        ...providerTurn("provider-turn-goal-command", 5, "completed"),
        nativeTurnRef: null,
      };

      const numTurns = yield* CodexAdapterV2.resolveCodexRollbackTurnCount({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-first"),
          appRunOrdinal: 1,
          providerTurn: firstTurn,
        },
        providerThreadTurns: [goalCommandTurn, interruptedTurn, runningTurn, secondTurn, firstTurn],
      });

      assert.equal(numTurns, 2);
    }),
  );
});

describe("CodexAdapterV2 fork boundary", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread-codex-fork-boundary");
  const makeProviderThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
    id: providerThreadId,
    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: ProviderSessionId.make("provider-session-codex-fork-boundary"),
    appThreadId: ThreadId.make("thread-codex-fork-boundary"),
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
      nativeId: "native-thread-codex-fork-boundary",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  });
  const makeProviderTurn = (
    id: string,
    ordinal: number,
    nativeId: string | null,
    now: DateTime.Utc,
  ): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(id),
    providerThreadId,
    nodeId: NodeId.make(`node-${id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
    nativeTurnRef:
      nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId, strength: "strong" },
    ordinal,
    status: "completed",
    startedAt: now,
    completedAt: now,
  });

  it.effect("resolves the selected provider turn to an inclusive native fork boundary", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, {
        lastTurnId: "native-turn-first",
        rollbackTurnCount: 0,
      });
    }),
  );

  it.effect("resolves the latest source turn to a native fork boundary without rollback", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: secondTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, {
        lastTurnId: "native-turn-second",
        rollbackTurnCount: 0,
      });
    }),
  );

  it.effect("keeps the rollback-count fallback when the boundary turn lacks a native id", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, null, now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 1 });
    }),
  );

  it.effect("keeps the rollback-count fallback when the boundary turn has no native ref", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn: OrchestrationV2ProviderTurn = {
        ...makeProviderTurn("provider-turn-first", 1, "native-turn-first", now),
        nativeTurnRef: null,
      };
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 1 });
    }),
  );

  it.effect("forks at head without a boundary when no provider turn is selected", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 0 });
    }),
  );

  it.effect("fails with a typed error when the selected source turn is missing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);

      const error = yield* Effect.flip(
        CodexAdapterV2.resolveCodexForkBoundary({
          sourceProviderThread: makeProviderThread(now),
          sourceProviderTurns: [firstTurn],
          providerTurnId: ProviderTurnId.make("provider-turn-missing"),
          targetThreadId: ThreadId.make("thread-codex-fork-target"),
        }),
      );

      assert.instanceOf(error, ProviderAdapter.ProviderAdapterForkThreadError);
      assert.include(String(error.cause), "provider-turn-missing");
    }),
  );
});

const nativeTerminalSkillQuote = projectComposerContextForProvider({
  text: "[Compare €review and $ship carefully](stark-context://v1/terminal/native_quote)",
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make("native_quote"),
      kind: "terminal",
      label: "Compare €review and $ship carefully",
      terminalId: "native-codex",
      terminalLabel: "Native Codex",
      lineStart: 4,
      lineEnd: 5,
      text: "€review then $ship with @example.txt\n𑿝review and £ship are quoted output.",
    },
  ],
});

describe("CodexAdapterV2 skill mentions", () => {
  it("preserves quoted terminal payloads and labels while normalizing outside mentions", () => {
    assert.equal(
      CodexAdapterV2.codexSkillMentionText(nativeTerminalSkillQuote),
      nativeTerminalSkillQuote,
    );
    assert.equal(
      CodexAdapterV2.codexSkillMentionText(
        `€review first\n${nativeTerminalSkillQuote}\nThen £ship`,
      ),
      `$review first\n${nativeTerminalSkillQuote}\nThen $ship`,
    );
    // An adjacent token still needs its original whitespace boundary.
    assert.equal(
      CodexAdapterV2.codexSkillMentionText(`${nativeTerminalSkillQuote}€review`),
      `${nativeTerminalSkillQuote}€review`,
    );
  });

  it("sends currency-sigil skill mentions as the $ mention Codex parses", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["€review do it", "$review do it"],
      ["£ship", "$ship"],
      ["please ¥review this diff", "please $review this diff"],
      ["first line\n₹ship it", "first line\n$ship it"],
      ["𑿝review then €2spec", "$review then $2spec"],
      ["$review", "$review"],
      ["costs €20", "costs €20"],
      ["€5k", "€5k"],
      ["budget €100M or €1e6", "budget €100M or €1e6"],
      ["5€review", "5€review"],
    ];
    for (const [text, expected] of cases) {
      assert.equal(CodexAdapterV2.codexSkillMentionText(text), expected, text);
    }
  });
});

describe("CodexAdapterV2 background command detail", () => {
  it("summarizes command, exit code, and output tail", () => {
    assert.equal(
      CodexAdapterV2.codexBackgroundCommandDetail({
        command: "sleep 20 && echo CODEX_BG_WAKE_DONE",
        exitCode: 0,
        aggregatedOutput: "CODEX_BG_WAKE_DONE\n",
      }),
      "Background command completed (exit 0): sleep 20 && echo CODEX_BG_WAKE_DONE\n\n" +
        "Output tail:\nCODEX_BG_WAKE_DONE",
    );
  });

  it("omits the output section and exit code when absent", () => {
    assert.equal(
      CodexAdapterV2.codexBackgroundCommandDetail({
        command: "sleep 20",
        exitCode: null,
        aggregatedOutput: null,
      }),
      "Background command completed: sleep 20",
    );
  });

  it("truncates long commands and keeps only the output tail", () => {
    const detail = CodexAdapterV2.codexBackgroundCommandDetail({
      command: "x".repeat(300),
      exitCode: 1,
      aggregatedOutput: `${"y".repeat(2000)}TAIL`,
    });
    assert.include(detail, `(exit 1): ${"x".repeat(200)}...`);
    assert.include(detail, "Output tail:\n...");
    assert.include(detail, "TAIL");
    assert.notInclude(detail, "y".repeat(1001));
  });
});

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  /** Text the adapter should send, when it differs from what the user typed. */
  readonly sentPrompt?: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "Stark Code", title: "Stark Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "Stark Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

function withSupervisedReplayPolicy(
  transcript: CodexReplay.CodexAppServerReplayTranscript,
): CodexReplay.CodexAppServerReplayTranscript {
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (
        entry.type !== "expect_outbound" ||
        !Predicate.isObject(entry.frame) ||
        entry.frame.method !== "turn/start" ||
        !Predicate.isObject(entry.frame.params)
      )
        return entry;
      return {
        ...entry,
        frame: {
          ...entry.frame,
          params: {
            ...entry.frame.params,
            approvalPolicy: "untrusted",
            sandboxPolicy: { type: "readOnly" },
          },
        },
      };
    }),
  };
}

function withReplayRequestId(
  entry: CodexReplay.CodexAppServerReplayEntry,
  id: number,
): CodexReplay.CodexAppServerReplayEntry {
  return entry.type !== "runtime_exit" && Predicate.isObject(entry.frame)
    ? { ...entry, frame: { ...entry.frame, id } }
    : entry;
}

describe("CodexAdapterV2 session initialize", () => {
  const openReplaySession = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
  ) =>
    Effect.gen(function* () {
      const driver = yield* CodexReplay.makeReplayDriver(
        transcript,
        beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
      );
      let initializeRequests = 0;
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        clientFactory: {
          open: (openInput) =>
            Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      Effect.sync(() => {
                        if (method === "initialize") initializeRequests++;
                      }).pipe(Effect.andThen(client.request(method, params))),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
      });
      const runtime = yield* adapter.openSession({
        threadId: ThreadId.make(`thread-${transcript.scenario}`),
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      return {
        ensureThread: (threadId: string) =>
          runtime.ensureThread({
            threadId: ThreadId.make(threadId),
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          }),
        initializeRequests: () => initializeRequests,
      };
    });

  const replayPreamble = (nativeThreadId: string) =>
    codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" });

  it.effect("sends one initialize when two threads start on a fresh session at once", () =>
    Effect.gen(function* () {
      const initializeAwaitingResponse = yield* Deferred.make<void>();
      const releaseInitialize = yield* Deferred.make<void>();
      // The transcript allows exactly one handshake: a second `initialize`
      // frame fails the replay, as Codex rejects it with "Already initialized".
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "concurrent-initialize",
          entries: [
            ...replayPreamble("concurrent-first").slice(0, 5),
            ...replayPreamble("concurrent-second")
              .slice(3, 5)
              .map((entry) => withReplayRequestId(entry, 3)),
          ],
        }),
        (entry) =>
          entry.label === "initialize"
            ? Deferred.succeed(initializeAwaitingResponse, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInitialize)),
              )
            : Effect.void,
      );

      const first = yield* session
        .ensureThread("thread-concurrent-first")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(initializeAwaitingResponse);
      // The second thread arrives while the handshake is still unanswered.
      const second = yield* session
        .ensureThread("thread-concurrent-second")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseInitialize, undefined);

      const providerThreads = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.equal(session.initializeRequests(), 1);
      assert.sameMembers(
        providerThreads.map((providerThread) => providerThread.nativeThreadRef?.nativeId),
        ["concurrent-first", "concurrent-second"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("retries initialize after a failed handshake", () =>
    Effect.gen(function* () {
      const preamble = replayPreamble("initialize-retry");
      const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
        ...preamble.slice(0, 1),
        {
          type: "emit_inbound",
          label: "initialize",
          frame: { id: 1, error: { code: -32603, message: "Codex is not ready." } },
        },
        ...preamble.slice(0, 2).map((entry) => withReplayRequestId(entry, 2)),
        ...preamble.slice(2, 3),
        ...preamble.slice(3, 5).map((entry) => withReplayRequestId(entry, 3)),
      ];
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({ scenario: "initialize-retry", entries }),
      );

      const failure = yield* session.ensureThread("thread-initialize-retry").pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterEnsureThreadError");
      const providerThread = yield* session.ensureThread("thread-initialize-retry");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "initialize-retry");
      assert.equal(session.initializeRequests(), 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("completes the handshake after a caller is interrupted mid-initialize", () =>
    Effect.gen(function* () {
      const initializeAwaitingResponse = yield* Deferred.make<void>();
      const releaseInitialize = yield* Deferred.make<void>();
      const preamble = replayPreamble("initialize-interrupted");
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "initialize-interrupted",
          entries: [
            ...preamble.slice(0, 2),
            // Codex handled the interrupted caller's `initialize`, so it
            // rejects the next one.
            ...preamble.slice(0, 1).map((entry) => withReplayRequestId(entry, 2)),
            {
              type: "emit_inbound",
              label: "initialize-rejected",
              frame: { id: 2, error: { code: -32600, message: "Already initialized" } },
            },
            ...preamble.slice(2, 3),
            ...preamble.slice(3, 5).map((entry) => withReplayRequestId(entry, 3)),
          ],
        }),
        (entry) =>
          entry.label === "initialize"
            ? Deferred.succeed(initializeAwaitingResponse, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInitialize)),
              )
            : Effect.void,
      );

      const interrupted = yield* session
        .ensureThread("thread-initialize-interrupted")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(initializeAwaitingResponse);
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.succeed(releaseInitialize, undefined);

      const providerThread = yield* session.ensureThread("thread-initialize-interrupted");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "initialize-interrupted");
      assert.equal(session.initializeRequests(), 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );
});

describe("CodexAdapterV2 post-settle continuation", () => {
  const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 5000; attempt++) {
        if (predicate()) {
          return;
        }
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(`Timed out waiting for ${label}.`);
    });

  const makeCodexReplayHarness = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    onEvent: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<unknown> = () =>
      Effect.void,
    onRequest: (method: string, params: unknown) => Effect.Effect<void> = () => Effect.void,
    readChildMetadata?: Parameters<typeof withCodexReplayChildMetadata>[2],
    beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
    wrapClient: (
      client: CodexClient.CodexAppServerClient["Service"],
    ) => CodexClient.CodexAppServerClient["Service"] = (client) => client,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
      const replayLayer =
        beforeEmitInbound === undefined
          ? CodexReplay.layerReplay(transcript)
          : CodexReplay.layerReplayWithDriver(
              yield* CodexReplay.makeReplayDriver(transcript, { beforeEmitInbound }),
            );
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
        open: (openInput) =>
          Layer.build(replayLayer).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.map((client) =>
                  withCodexReplayChildMetadata(client, transcript, readChildMetadata),
                ),
                Effect.map((client) =>
                  wrapClient({
                    ...client,
                    request: (method, params) =>
                      onRequest(method, params).pipe(
                        Effect.andThen(client.request(method, params)),
                      ),
                  } satisfies CodexClient.CodexAppServerClient["Service"]),
                ),
                Effect.provide(context),
              ),
            ),
          ),
      };
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        clientFactory,
        crypto: yield* Crypto.Crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }),
        },
      });
      const threadId = ThreadId.make(`thread-${transcript.scenario}`);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const firstTerminal = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.terminal"
                ? Deferred.succeed(firstTerminal, undefined)
                : Effect.void,
            ),
            Effect.andThen(onEvent(event)),
          ),
        ),
        Effect.forkScoped,
      );
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("Codex adapter runtime must expose hasPendingBackgroundWork.");
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const terminalEvents = () =>
        events.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        );
      const subagentUpdates = () =>
        events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "subagent.updated" }
          > => event.type === "subagent.updated",
        );
      return {
        runtime,
        providerThread,
        threadId,
        serverConfig,
        events,
        continuationRequests,
        terminalEvents,
        subagentUpdates,
        hasPendingBackgroundWork,
        firstTerminal: Deferred.await(firstTerminal),
      };
    });

  it.effect("preserves all proposed files on the exact approval before any edit is accepted", () =>
    Effect.gen(function* () {
      const nativeThreadId = "proposed-files-thread";
      const nativeTurnId = "proposed-files-turn";
      const prompt = "Propose the edits.";
      const changes = [
        { path: "/workspace/new.ts", kind: { type: "add" }, diff: "new\n" },
        {
          path: "/workspace/edited.ts",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
        { path: "/workspace/deleted.ts", kind: { type: "delete" }, diff: "gone\n" },
        {
          path: "/workspace/old.ts",
          kind: { type: "update", move_path: "/workspace/renamed.ts" },
          diff: "@@ -1 +1 @@\n-a\n+b\n",
        },
      ];
      const transcript = makeCodexReplayTranscript({
        scenario: "proposed-file-approval",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          ...[
            {
              id: "unrelated-item",
              changes: [{ path: "/wrong", kind: { type: "add" }, diff: "+wrong" }],
            },
            { id: "proposed-item", changes },
          ].map((item) => ({
            type: "emit_inbound" as const,
            label: `started-${item.id}`,
            frame: {
              method: "item/started",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                startedAtMs: 1,
                item: { ...item, type: "fileChange", status: "inProgress" },
              },
            },
          })),
          {
            type: "emit_inbound",
            label: "approval",
            frame: {
              id: 100,
              method: "item/fileChange/requestApproval",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                itemId: "proposed-item",
                reason: "Update these files.",
              },
            },
          },
          {
            type: "expect_outbound",
            label: "decline",
            frame: { id: 100, result: { decision: "decline" } },
          },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ],
      });
      const ready =
        yield* Deferred.make<Extract<OrchestrationV2TurnItem, { type: "approval_request" }>>();
      const harness = yield* makeCodexReplayHarness(transcript, (event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
          ? Deferred.succeed(ready, event.turnItem)
          : Effect.void,
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("proposed-files"),
          text: prompt,
        }),
      );
      const approval = yield* Deferred.await(ready);
      assert.deepEqual(approval.proposedChanges, [
        {
          operation: "add",
          path: "/workspace/new.ts",
          patch: "--- /dev/null\n+++ /workspace/new.ts\n@@ -0,0 +1,1 @@\n+new\n",
        },
        {
          operation: "update",
          path: "/workspace/edited.ts",
          patch: "--- /workspace/edited.ts\n+++ /workspace/edited.ts\n@@ -1 +1 @@\n-old\n+new\n",
        },
        {
          operation: "delete",
          path: "/workspace/deleted.ts",
          patch: "--- /workspace/deleted.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n",
        },
        {
          operation: "rename",
          path: "/workspace/renamed.ts",
          oldPath: "/workspace/old.ts",
          patch: "--- /workspace/old.ts\n+++ /workspace/renamed.ts\n@@ -1 +1 @@\n-a\n+b\n",
        },
      ]);
      assert.isFalse(
        harness.events.some(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "file_change",
        ),
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: approval.requestId,
        decision: "decline",
      });
      yield* harness.firstTerminal;
    }).pipe(
      Effect.scoped,
      Effect.provide([NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer]),
    ),
  );

  it.effect.each(["safe-prefix", "publish", "file-change", "permission"] as const)(
    "remembers only an offered native Codex prefix and rejects forged decisions for %s",
    (scenario) =>
      Effect.gen(function* () {
        const nativeThreadId = `approval-${scenario}`;
        const nativeTurnId = `approval-turn-${scenario}`;
        const prompt = "Do the requested operation.";
        const safe = scenario === "safe-prefix";
        const params = {
          threadId: nativeThreadId,
          turnId: nativeTurnId,
          itemId: "item-approval",
          ...(scenario === "file-change"
            ? { reason: "Change one file." }
            : scenario === "permission"
              ? { permissions: {}, cwd: "/workspace", startedAtMs: 1 }
              : {
                  command: safe ? "npm test -- --run" : "spage publish page",
                  proposedExecpolicyAmendment: safe ? ["npm", "test"] : ["spage", "publish"],
                  startedAtMs: 1,
                }),
        };
        const method =
          scenario === "file-change"
            ? "item/fileChange/requestApproval"
            : scenario === "permission"
              ? "item/permissions/requestApproval"
              : "item/commandExecution/requestApproval";
        const expected = safe
          ? {
              decision: {
                acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] },
              },
            }
          : scenario === "permission"
            ? { permissions: {}, scope: "turn" }
            : { decision: "accept" };
        const transcript = makeCodexReplayTranscript({
          scenario: `remember-${scenario}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            { type: "emit_inbound", label: "approval", frame: { id: 100, method, params } },
            {
              type: "expect_outbound",
              label: "approval-response",
              frame: { id: 100, result: expected },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`remember-${scenario}`),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
            ),
          "approval card",
        );
        const event = harness.events.find(
          (candidate) =>
            candidate.type === "turn_item.updated" &&
            candidate.turnItem.type === "approval_request",
        );
        if (event?.type !== "turn_item.updated" || event.turnItem.type !== "approval_request")
          return yield* Effect.die("Missing approval card");
        const options = event.turnItem.options ?? [];
        assert.equal(
          options.some((option) => option.decision === "acceptAlways"),
          safe,
        );
        const requestId = event.turnItem.requestId;
        if (!safe) {
          const error = yield* Effect.flip(
            harness.runtime.respondToRuntimeRequest({ requestId, decision: "acceptAlways" }),
          );
          assert.equal(error._tag, "ProviderAdapterRuntimeRequestResponseError");
          if (scenario === "publish") {
            assert.isFalse(options.some((option) => option.decision === "acceptForSession"));
            assert.equal(
              (yield* Effect.flip(
                harness.runtime.respondToRuntimeRequest({
                  requestId,
                  decision: "acceptForSession",
                }),
              ))._tag,
              "ProviderAdapterRuntimeRequestResponseError",
            );
          }
        } else
          assert.deepEqual(
            options.find((option) => option.decision === "acceptAlways")?.rulePreview,
            ['prefix_rule(pattern=["npm","test"], decision="allow")'],
          );
        yield* harness.runtime.respondToRuntimeRequest({
          requestId,
          decision: safe ? "acceptAlways" : "accept",
        });
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  const approvalItems = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
        ? [event.turnItem]
        : [],
    );

  it.effect("shows the files and diff a Codex file change proposes and follows newer patches", () =>
    Effect.gen(function* () {
      const nativeThreadId = "proposed-change-thread";
      const nativeTurnId = "proposed-change-turn";
      const itemId = "file-change-item";
      const prompt = "Write the notes.";
      const change = (diff: string) => ({
        path: "/workspace/src/a.ts",
        kind: { type: "update" },
        diff,
      });
      const added = { path: "/workspace/notes.md", kind: { type: "add" }, diff: "hello\n" };
      const fileChangeItem = (status: string, diff: string) => ({
        type: "fileChange",
        id: itemId,
        changes: [added, change(diff)],
        status,
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "proposed-file-change",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          {
            type: "emit_inbound",
            label: "item/started",
            frame: {
              method: "item/started",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                startedAtMs: 1,
                item: fileChangeItem("inProgress", "@@ -1 +1 @@\n-a\n+b\n"),
              },
            },
          },
          {
            type: "emit_inbound",
            label: "approval",
            frame: {
              id: 100,
              method: "item/fileChange/requestApproval",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                itemId,
                startedAtMs: 1,
                reason: null,
                grantRoot: null,
              },
            },
          },
          {
            type: "emit_inbound",
            label: "patch-updated",
            frame: {
              method: "item/fileChange/patchUpdated",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                itemId,
                changes: [added, change("@@ -1 +1 @@\n-a\n+c\n")],
              },
            },
          },
          {
            type: "expect_outbound",
            label: "approval-response",
            frame: { id: 100, result: { decision: "accept" } },
          },
          {
            type: "emit_inbound",
            label: "item/completed",
            frame: {
              method: "item/completed",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                completedAtMs: 2,
                item: fileChangeItem("completed", "@@ -1 +1 @@\n-a\n+c\n"),
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ],
      });
      const cardShown = yield* Deferred.make<void>();
      const cardRefreshed = yield* Deferred.make<void>();
      let cards = 0;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
            ? Deferred.succeed(++cards === 1 ? cardShown : cardRefreshed, undefined)
            : Effect.void,
        undefined,
        undefined,
        (entry) => (entry.label === "patch-updated" ? Deferred.await(cardShown) : Effect.void),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("proposed-file-change"),
          text: prompt,
        }),
      );
      yield* Deferred.await(cardRefreshed);
      const [first, refreshed] = approvalItems(harness.events);
      const expected = (line: string) => [
        {
          path: "/workspace/notes.md",
          operation: "add",
          patch: "--- /dev/null\n+++ /workspace/notes.md\n@@ -0,0 +1,1 @@\n+hello\n",
        },
        {
          path: "/workspace/src/a.ts",
          operation: "update",
          patch: `--- /workspace/src/a.ts\n+++ /workspace/src/a.ts\n@@ -1 +1 @@\n-a\n${line}\n`,
        },
      ];
      assert.deepEqual(first?.proposedChanges, expected("+b"));
      assert.deepEqual(refreshed?.proposedChanges, expected("+c"));
      assert.equal(refreshed?.id, first?.id);
      assert.equal(refreshed?.status, "waiting");
      if (refreshed?.type !== "approval_request") return yield* Effect.die("Missing approval");
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: refreshed.requestId,
        decision: "accept",
      });
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      assert.lengthOf(approvalItems(harness.events), 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("shows the files and diff of a legacy applyPatchApproval", () =>
    Effect.gen(function* () {
      const nativeThreadId = "legacy-patch-thread";
      const nativeTurnId = "legacy-patch-turn";
      const prompt = "Patch it.";
      const transcript = makeCodexReplayTranscript({
        scenario: "legacy-proposed-file-change",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          {
            type: "emit_inbound",
            label: "approval",
            frame: {
              id: 100,
              method: "applyPatchApproval",
              params: {
                conversationId: nativeThreadId,
                callId: "call-patch",
                fileChanges: {
                  "/workspace/old.md": { type: "delete", content: "bye\n" },
                  "/workspace/b.ts": {
                    type: "update",
                    unified_diff: "@@ -1 +1 @@\n-x\n+y\n",
                    move_path: "/workspace/c.ts",
                  },
                },
                reason: null,
                grantRoot: null,
              },
            },
          },
          {
            type: "expect_outbound",
            label: "approval-response",
            frame: { id: 100, result: { decision: "approved" } },
          },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ],
      });
      const cardShown = yield* Deferred.make<void>();
      const harness = yield* makeCodexReplayHarness(transcript, (event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
          ? Deferred.succeed(cardShown, undefined)
          : Effect.void,
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("legacy-proposed-file-change"),
          text: prompt,
        }),
      );
      yield* Deferred.await(cardShown);
      const [card] = approvalItems(harness.events);
      assert.deepEqual(card?.proposedChanges, [
        {
          path: "/workspace/c.ts",
          operation: "rename",
          oldPath: "/workspace/b.ts",
          patch: "--- /workspace/b.ts\n+++ /workspace/c.ts\n@@ -1 +1 @@\n-x\n+y\n",
        },
        {
          path: "/workspace/old.md",
          operation: "delete",
          patch: "--- /workspace/old.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n",
        },
      ]);
      if (card?.type !== "approval_request") return yield* Effect.die("Missing approval");
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: card.requestId,
        decision: "accept",
      });
      yield* harness.firstTerminal;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each(["supported", "unsupported", "invalid"] as const)(
    "delivers native history with %s app-server protocol",
    (response) =>
      Effect.gen(function* () {
        const nativeThreadId = `inject-${response}`;
        const prompt = "Only the current request";
        const history: ProviderAdapter.ProviderAdapterV2HistoricalContext = {
          context: "Historical conversation",
          messages: (["user", "assistant"] as const).map((role) => ({
            role,
            text:
              role === "user"
                ? "Original request\n" + "界".repeat(300)
                : "Partial interrupted work",
            threadId: ThreadId.make("source"),
            runId: RunId.make("source-run"),
            itemId: TurnItemId.make(`source-${role}`),
            providerThreadId: null,
            kind: `${role}_message`,
            status: "interrupted",
          })),
        };
        const items = historyResponseItems(history.messages, history.context);
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "current-turn",
          prompt,
        });
        const transcript = makeCodexReplayTranscript({
          scenario: `inject-${response}`,
          entries: [
            ...preamble.slice(0, -3),
            {
              type: "expect_outbound",
              label: "inject",
              frame: {
                id: 3,
                method: "thread/inject_items",
                params: { threadId: nativeThreadId, items },
              },
            },
            {
              type: "emit_inbound",
              label: "inject-result",
              frame:
                response === "supported"
                  ? { id: 3, result: {} }
                  : {
                      id: 3,
                      error: {
                        code: response === "unsupported" ? -32601 : -32602,
                        message: "Injection rejected",
                      },
                    },
            },
            ...(response === "invalid"
              ? []
              : preamble
                  .slice(-3)
                  .map((entry) =>
                    "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
                      ? { ...entry, frame: { ...entry.frame, id: 4 } }
                      : entry,
                  )),
          ],
        });
        const requests: string[] = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        const injection = yield* harness.runtime.injectHistory!({
          providerThread: harness.providerThread,
          ...history,
        }).pipe(Effect.result);
        if (response === "invalid") {
          assert.equal(injection._tag, "Failure");
          if (injection._tag === "Failure") {
            assert.equal(injection.failure._tag, "ProviderAdapterProtocolError");
            assert.propertyVal(injection.failure.cause, "code", -32602);
            assert.notProperty(injection.failure, "payload");
          }
          assert.notInclude(requests, "turn/start");
          return;
        }
        assert.equal(injection._tag, "Success");
        if (injection._tag === "Success") assert.equal(injection.success, response === "supported");
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("inject-attempt"),
            text: prompt,
          }),
        );
        assert.equal(requests.filter((method) => method === "turn/start").length, 1);
        assert.isBelow(requests.indexOf("thread/inject_items"), requests.indexOf("turn/start"));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("identifies sessions to Codex with the same client info as main", () =>
    Effect.gen(function* () {
      const transcript = makeCodexReplayTranscript({
        scenario: "initialize-client-info",
        entries: codexReplayPreamble({
          nativeThreadId: "client-info-thread",
          nativeTurnId: "unused",
          prompt: "unused",
        }).slice(0, 5),
      });
      const initializeParams: Array<unknown> = [];
      yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method, params) =>
          Effect.sync(() => {
            if (method === "initialize") initializeParams.push(params);
          }),
      );
      // Codex uses clientInfo.name as the request originator. Replays ignore the
      // version, so pin the whole value here.
      assert.deepEqual(initializeParams, [
        {
          clientInfo: { name: "Stark Code", title: "Stark Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("unsubscribes from the native thread when it is unloaded", () =>
    Effect.gen(function* () {
      const nativeThreadId = "unload-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "unused",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "unload-thread",
        entries: [
          // initialize + thread/start only; no turn runs.
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/unsubscribe",
            frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          // Response shape recorded from codex app-server 0.156.1.
          {
            type: "emit_inbound",
            label: "thread/unsubscribe",
            frame: { id: 3, result: { status: "unsubscribed" } },
          },
        ],
      });
      const requests: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) => Effect.sync(() => requests.push(method)),
      );
      assert.isDefined(harness.runtime.unloadThread);
      yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
      assert.deepEqual(requests, ["initialize", "thread/start", "thread/unsubscribe"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("keeps the app-server failure as the cause when an unload is rejected", () =>
    Effect.gen(function* () {
      const nativeThreadId = "unload-thread-rejected";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "unused",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "unload-thread-rejected",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/unsubscribe",
            frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          {
            type: "emit_inbound",
            label: "thread/unsubscribe",
            frame: { id: 3, error: { code: -32600, message: "invalid thread id" } },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const error = yield* harness.runtime.unloadThread!({
        providerThread: harness.providerThread,
      }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProtocolError");
      const cause = error._tag === "ProviderAdapterProtocolError" ? error.cause : undefined;
      assert.equal((cause as { _tag?: string } | undefined)?._tag, "CodexAppServerRequestError");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("waits for native start before interrupting an acknowledged queued turn", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-await-native-start",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/started",
            afterMs: 1000,
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
              },
            },
          },
          {
            type: "expect_outbound",
            label: "turn/interrupt",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: nativeTurnId },
            },
          },
          { type: "emit_inbound", label: "turn/interrupt", frame: { id: 4, result: {} } },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "interrupted" }),
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      assert.isFalse(interruptSent, "Stop must not reach Codex before native turn/started");
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(interrupt);
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("settles Stop when a queued native turn fails before starting", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-failed-before-native-start",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/failed",
            afterMs: 1000,
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                  startedAt: null,
                  error: {
                    message: "Failed before native start",
                    codexErrorInfo: null,
                    additionalDetails: null,
                  },
                },
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      assert.isFalse(interruptSent, "Stop must not reach Codex before native turn/started");
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(interrupt);
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "failed");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(interruptSent, "A terminal native turn must not receive turn/interrupt");
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("bounds Stop when a queued native turn never starts", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-never-starts",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(interrupt))._tag, "Failure");
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(interruptSent, "An unstarted native turn must not receive turn/interrupt");
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect(
    "sends outside currency-sigil skill mentions to Codex while preserving quoted terminal data",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "skill-sigil-thread";
        const nativeTurnId = "skill-sigil-turn";
        const transcript = makeCodexReplayTranscript({
          scenario: "skill-sigil-canonicalized",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: `€review do it\n${nativeTerminalSkillQuote}`,
              sentPrompt: `$review do it\n${nativeTerminalSkillQuote}`,
            }),
            {
              type: "expect_outbound",
              label: "turn/steer",
              frame: {
                id: 4,
                method: "turn/steer",
                params: {
                  expectedTurnId: nativeTurnId,
                  input: [{ type: "text", text: `${nativeTerminalSkillQuote}\nthen $ship it` }],
                  threadId: nativeThreadId,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/steer",
              frame: { id: 4, result: { turnId: nativeTurnId } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const turnInput = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("skill-sigil-attempt"),
          text: `€review do it\n${nativeTerminalSkillQuote}`,
        });
        yield* harness.runtime.startTurn(turnInput);
        yield* harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: turnInput.runId,
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId,
          }),
          message: {
            ...turnInput.message,
            messageId: MessageId.make("message-skill-sigil-steer"),
            text: `${nativeTerminalSkillQuote}\nthen £ship it`,
          },
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  const assistantMessages = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
        event.type === "message.updated" && event.message.role === "assistant",
    );
  const assistantTurnItems = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
        ? [event.turnItem]
        : [],
    );

  it.effect("keeps an asynchronous Codex question actionable after the turn completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "async-question-thread";
        const nativeTurnId = "async-question-turn";
        const usage = {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "async-question-and-billed-usage",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Continue while I decide.",
            }),
            {
              type: "emit_inbound",
              label: "question",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    type: "agentMessage",
                    id: "async-question-item",
                    text: "Which branch?",
                    delivery: "async",
                    questions: [{ title: "Which branch?", options: ["main", "dev"] }],
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "usage",
              frame: {
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "complete",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("async-question-attempt"),
            text: "Continue while I decide.",
          }),
        );
        yield* harness.firstTerminal;
        const requests = harness.events.flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
        );
        assert.lengthOf(requests, 1);
        assert.equal(requests[0]?.status, "pending");
        assert.deepEqual(requests[0]?.responseCapability, { type: "message" });
        const questionItem = harness.events.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
        );
        assert.equal(questionItem?.type, "turn_item.updated");
        if (
          questionItem?.type === "turn_item.updated" &&
          questionItem.turnItem.type === "user_input_request"
        ) {
          assert.deepEqual(
            questionItem.turnItem.questions[0]?.options.map((option) => option.label),
            ["main", "dev"],
          );
          assert.equal(questionItem.turnItem.responseMode, "message");
        }
        const questionNode = harness.events.find(
          (event) => event.type === "node.updated" && event.node.id === requests[0]?.nodeId,
        );
        assert.equal(
          questionNode?.type === "node.updated" && questionNode.node.countsForRun,
          false,
        );
        const contextReport = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.tokenUsage !== undefined,
        );
        assert.equal(contextReport?.type, "provider_turn.updated");
        if (contextReport?.type === "provider_turn.updated") {
          assert.equal(
            contextReport.providerTurn.runAttemptId,
            RunAttemptId.make("async-question-attempt"),
          );
          assert.equal(contextReport.providerTurn.providerThreadId, harness.providerThread.id);
          assert.equal(contextReport.providerTurn.tokenUsage?.usedTokens, 15);
          assert.equal(contextReport.providerTurn.tokenUsage?.maxTokens, 200_000);
        }
        const completed = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        assert.equal(completed?.type, "provider_turn.updated");
        if (completed?.type === "provider_turn.updated") {
          assert.deepEqual(completed.providerTurn.turnTokenUsage, {
            usageStatus: "complete",
            usageScope: "main_agent",
            hasSubagents: false,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 5,
            reasoningTokens: 1,
          });
        }
        assert.isEmpty(assistantMessages(harness.events));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("preserves Stark context on the wire and restores it after compaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "context-thread";
        const nativeTurnId = "context-turn";
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId,
          codexInput: [{ type: "text", text: "work" }],
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          hasStarkMcp: true,
        });
        assert.include(
          params.additionalContext?.stark_code_orchestration?.value ?? "",
          "delegate_task",
        );
        const entries = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
        const transcript = makeCodexReplayTranscript({
          scenario: "restore-context",
          entries: [
            ...entries.slice(0, 5),
            {
              type: "expect_outbound",
              label: "context turn",
              frame: { id: 3, method: "turn/start", params },
            },
            ...entries.slice(6),
            {
              type: "emit_inbound",
              label: "compacted",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "contextCompaction", id: "compact-context" },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "restore context",
              frame: {
                id: 4,
                method: "thread/inject_items",
                params: {
                  threadId: nativeThreadId,
                  items: Object.entries(params.additionalContext ?? {}).map(([key, entry]) => ({
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
                  })),
                },
              },
            },
            { type: "emit_inbound", label: "restored", frame: { id: 4, result: {} } },
            {
              type: "emit_inbound",
              label: "done",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("test"),
          threadId: harness.threadId,
          providerSessionId: "context-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer test",
          browserToolsAvailable: true,
        });
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("context-attempt"),
            text: "work",
          }),
        );
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("compacts Codex with the native RPC and completes the compaction turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "compact-thread";
        const nativeTurnId = "compact-turn";
        const item = { type: "contextCompaction", id: "compact-item" };
        const transcript = makeCodexReplayTranscript({
          scenario: "native-compaction",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "unused" }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "compact",
              frame: {
                id: 3,
                method: "thread/compact/start",
                params: { threadId: nativeThreadId },
              },
            },
            { type: "emit_inbound", label: "compact", frame: { id: 3, result: {} } },
            {
              type: "emit_inbound",
              label: "start",
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                },
              },
            },
            ...(["item/started", "item/completed"] as const).map((method) => ({
              type: "emit_inbound" as const,
              label: method,
              frame: { method, params: { threadId: nativeThreadId, turnId: nativeTurnId, item } },
            })),
            {
              type: "emit_inbound",
              label: "complete",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        assert.isDefined(harness.runtime.compactThread);
        yield* harness.runtime.compactThread!(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("compact-attempt"),
            text: "/compact",
          }),
        );
        yield* harness.firstTerminal;
        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          items.map((entry) => entry.status),
          ["running", "completed"],
        );
        assert.equal(items[0]?.id, items[1]?.id);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("projects Codex hooks, live context, and every edited rename path", () =>
    Effect.gen(function* () {
      const nativeThreadId = "hooks-context-thread";
      const nativeTurnId = "hooks-context-turn";
      const prompt = "inspect";
      const usage = {
        totalTokens: 15,
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1,
      };
      const transcript = makeCodexReplayTranscript({
        scenario: "hooks-context-paths",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          {
            type: "emit_inbound",
            frame: {
              method: "hook/completed",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                run: {
                  id: "guard",
                  displayOrder: 1,
                  eventName: "preToolUse",
                  executionMode: "sync",
                  handlerType: "command",
                  scope: "turn",
                  source: "project",
                  sourcePath: "/workspace/.codex/hooks.json",
                  startedAt: 0,
                  completedAt: 2,
                  durationMs: 2,
                  status: "blocked",
                  entries: [{ kind: "stop", text: "guard blocked rm" }],
                },
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              method: "thread/tokenUsage/updated",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              method: "item/completed",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                item: {
                  type: "fileChange",
                  id: "two-edits",
                  status: "completed",
                  changes: [
                    {
                      path: "/workspace/old.ts",
                      kind: { type: "update", move_path: "/workspace/new.ts" },
                      diff: "diff",
                    },
                    { path: "/workspace/other.ts", kind: { type: "add" }, diff: "diff" },
                  ],
                },
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("hooks-context"),
          text: prompt,
        }),
      );
      yield* harness.firstTerminal;
      const hook = harness.events
        .flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "hook_run"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      assert.equal(hook?.outcome, "blocked");
      assert.equal(hook?.source, "/workspace/.codex/hooks.json");
      const edit = harness.events
        .flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "file_change"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      assert.deepEqual(edit?.agentWrittenPaths, [
        "/workspace/old.ts",
        "/workspace/new.ts",
        "/workspace/other.ts",
      ]);
      assert.equal(edit?.changes?.[0]?.oldPath, "/workspace/old.ts");
      const context = yield* harness.runtime.readContextUsage!({ detail: "summary" });
      assert.equal(context.kind, "tokens-only");
      assert.equal(context.lastTurn?.inputTokens, 10);
      assert.equal(context.threadTotals?.reasoningTokens, 1);
      assert.deepEqual(context.categories, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { force: false, fails: false },
    { force: true, fails: false },
    { force: false, fails: true },
  ])(
    "reloads Codex MCP configuration once without a model turn, force=$force fails=$fails",
    (scenario) =>
      Effect.gen(function* () {
        const entries: CodexReplay.CodexAppServerReplayEntry[] = [
          ...codexReplayPreamble({
            nativeThreadId: "mcp-reload-thread",
            nativeTurnId: "unused",
            prompt: "unused",
          }).slice(0, 5),
          { type: "expect_outbound", frame: { id: 3, method: "config/mcpServer/reload" } },
          {
            type: "emit_inbound",
            frame: scenario.fails
              ? { id: 3, error: { code: -32603, message: "Private MCP connection detail" } }
              : { id: 3, result: {} },
          },
        ];
        const requested: string[] = [];
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({ scenario: "mcp-reload", entries }),
          undefined,
          (method) =>
            Effect.sync(() => {
              requested.push(method);
            }),
        );
        assert.equal(harness.runtime.mcpServers!.reconnectScope, "all");
        const result = yield* harness.runtime.mcpServers!.reload!({ force: scenario.force }).pipe(
          Effect.result,
        );
        if (scenario.fails) {
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.equal(result.failure._tag, "ProviderAdapterProtocolError");
            assert.include(
              result.failure.message,
              "Could not reload the MCP server. Check the provider's MCP configuration and retry.",
            );
            assert.notInclude(result.failure.message, "Private MCP connection detail");
          }
        } else {
          assert.equal(result._tag, "Success");
          if (result._tag === "Success")
            assert.deepEqual(result.success, { status: "reloaded", failedServers: [] });
        }
        assert.equal(requested.filter((method) => method === "config/mcpServer/reload").length, 1);
        assert.notInclude(requested, "config/value/write");
        assert.notInclude(requested, "mcpServerStatus/list");
        assert.notInclude(requested, "turn/start");
        assert.equal(
          harness.events.filter((event) => event.type === "provider_turn.updated").length,
          0,
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect.each([
    { previous: "ready", runtimeStatus: "failed", authStatus: "unsupported", expected: "failed" },
    {
      previous: "ready",
      runtimeStatus: "connected",
      authStatus: "unsupported",
      toolsError: "Transport closed while listing tools",
      expected: "failed",
    },
    {
      previous: "ready",
      runtimeStatus: "authenticationRequired",
      authStatus: "oAuth",
      expected: "needs-auth",
    },
    {
      previous: "ready",
      runtimeStatus: null,
      authStatus: "notLoggedIn",
      expected: "needs-auth",
    },
    {
      previous: "failed",
      runtimeStatus: "connected",
      authStatus: "unsupported",
      expected: "connected",
    },
    {
      previous: "failed",
      runtimeStatus: "disabled",
      authStatus: "unsupported",
      expected: "disabled",
    },
    {
      previous: "ready",
      runtimeStatus: null,
      authStatus: "unsupported",
      toolsError: "Could not list tools",
      expected: "failed",
    },
    {
      previous: "failed",
      runtimeStatus: null,
      authStatus: "oAuth",
      previousAuth: true,
      tools: { read: { name: "read", inputSchema: {} } },
      expected: "connected",
    },
  ])("uses current MCP snapshot $expected after an earlier $previous notification", (scenario) =>
    Effect.gen(function* () {
      const server = {
        name: "docs",
        authStatus: "unsupported",
        runtimeStatus: null,
        tools: {},
        resources: [],
        resourceTemplates: [],
      };
      const entries: CodexReplay.CodexAppServerReplayEntry[] = [
        ...codexReplayPreamble({
          nativeThreadId: "mcp-status-refresh-thread",
          nativeTurnId: "unused",
          prompt: "unused",
        }).slice(0, 5),
        {
          type: "expect_outbound",
          frame: {
            id: 3,
            method: "mcpServerStatus/list",
            params: { detail: "toolsAndAuthOnly", limit: 100 },
          },
        },
        {
          type: "emit_inbound",
          frame: {
            method: "mcpServer/startupStatus/updated",
            params: {
              name: "docs",
              status: scenario.previous,
              ...("previousAuth" in scenario ? { failureReason: "reauthenticationRequired" } : {}),
            },
          },
        },
        { type: "emit_inbound", frame: { id: 3, result: { data: [server], nextCursor: null } } },
        {
          type: "expect_outbound",
          frame: {
            id: 4,
            method: "mcpServerStatus/list",
            params: { detail: "toolsAndAuthOnly", limit: 100 },
          },
        },
        {
          type: "emit_inbound",
          frame: {
            id: 4,
            result: {
              data: [
                {
                  ...server,
                  runtimeStatus: scenario.runtimeStatus,
                  authStatus: scenario.authStatus,
                  ...("tools" in scenario ? { tools: scenario.tools } : {}),
                  ...("toolsError" in scenario ? { toolsError: scenario.toolsError } : {}),
                },
              ],
              nextCursor: null,
            },
          },
        },
      ];
      const requested: string[] = [];
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({ scenario: "mcp-status-refresh", entries }),
        undefined,
        (method) =>
          Effect.sync(() => {
            requested.push(method);
          }),
      );
      const mcp = harness.runtime.mcpServers!;
      assert.equal(
        (yield* mcp.list())[0]?.status,
        "previousAuth" in scenario
          ? "needs-auth"
          : scenario.previous === "ready"
            ? "connected"
            : "failed",
      );
      assert.equal((yield* mcp.list())[0]?.status, scenario.expected);
      assert.notInclude(requested, "config/mcpServer/reload");
      assert.notInclude(requested, "turn/start");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("reads MCP health and tool metadata without discovering remote resources", () =>
    Effect.gen(function* () {
      const entries: CodexReplay.CodexAppServerReplayEntry[] = [
        ...codexReplayPreamble({
          nativeThreadId: "mcp-health-metadata-thread",
          nativeTurnId: "unused",
          prompt: "unused",
        }).slice(0, 5),
        {
          type: "expect_outbound",
          frame: {
            id: 3,
            method: "mcpServerStatus/list",
            params: { detail: "toolsAndAuthOnly", limit: 100 },
          },
        },
        {
          type: "emit_inbound",
          frame: {
            id: 3,
            result: {
              data: [
                {
                  name: "docs",
                  authStatus: "oAuth",
                  runtimeStatus: "connected",
                  httpOrigin: "https://docs.example.test",
                  pluginId: "documentation",
                  tools: {
                    read: {
                      name: "read",
                      description: "Read a document",
                      inputSchema: {},
                      annotations: { readOnlyHint: true },
                    },
                  },
                  resources: [],
                  resourceTemplates: [],
                },
              ],
              nextCursor: null,
            },
          },
        },
      ];
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({ scenario: "mcp-health-metadata", entries }),
      );
      assert.deepEqual(yield* harness.runtime.mcpServers!.list(), [
        {
          name: "docs",
          endpointHost: "docs.example.test",
          source: "codex",
          status: "connected",
          tools: [{ name: "read", description: "Read a document", readOnly: true }],
          authKind: "oauth",
          locked: false,
          pluginName: "documentation",
          canSignOut: true,
          canSubmitCallback: false,
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("pages MCP status and applies quoted config keys without sending a model turn", () =>
    Effect.gen(function* () {
      const nativeThreadId = "mcp-status-thread";
      const server = {
        name: "docs.with.dot",
        authStatus: "unsupported",
        runtimeStatus: "connected",
        tools: { read: { name: "read", inputSchema: {} } },
        resources: [],
        resourceTemplates: [],
      };
      const request = (
        id: number,
        method: string,
        params: unknown,
      ): CodexReplay.CodexAppServerReplayEntry => ({
        type: "expect_outbound",
        frame: { id, method, ...(params === undefined ? {} : { params }) },
      });
      const result = (id: number, value: unknown): CodexReplay.CodexAppServerReplayEntry => ({
        type: "emit_inbound",
        frame: { id, result: value },
      });
      const entries: CodexReplay.CodexAppServerReplayEntry[] = [
        ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" }).slice(
          0,
          5,
        ),
        request(3, "mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 100 }),
        result(3, { data: [server], nextCursor: "more" }),
        request(4, "mcpServerStatus/list", {
          detail: "toolsAndAuthOnly",
          limit: 100,
          cursor: "more",
        }),
        result(4, { data: [{ ...server, name: "stark-code" }], nextCursor: null }),
        request(5, "config/value/write", {
          keyPath: 'mcp_servers."docs.with.dot".enabled',
          value: false,
          mergeStrategy: "upsert",
        }),
        result(5, { filePath: "/tmp/codex/config.toml", status: "ok", version: "1" }),
        request(6, "config/mcpServer/reload", undefined),
        result(6, {}),
        request(7, "mcpServer/oauth/login", { name: "docs.with.dot", timeoutSecs: 120 }),
        result(7, { authorizationUrl: "https://example.test/oauth" }),
        {
          type: "emit_inbound",
          frame: {
            method: "mcpServer/oauthLogin/completed",
            params: { name: "docs.with.dot", success: false, error: "private code must not leak" },
          },
        },
        request(8, "mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 100 }),
        result(8, { data: [{ ...server, runtimeStatus: null }], nextCursor: null }),
        request(9, "skills/list", { cwds: ["/workspace"], forceReload: false }),
        result(9, {
          data: [
            {
              cwd: "/workspace",
              errors: [],
              skills: [
                {
                  name: "loaded",
                  description: "Loaded skill",
                  path: "/workspace/SKILL.md",
                  enabled: true,
                  scope: "repo",
                },
              ],
            },
          ],
        }),
      ];
      const requested: string[] = [];
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({ scenario: "mcp-controls", entries }),
        undefined,
        (method, params) =>
          Effect.sync(() => {
            requested.push(method);
            if (method === "config/value/write")
              assert.deepEqual(params, {
                keyPath: 'mcp_servers."docs.with.dot".enabled',
                value: false,
                mergeStrategy: "upsert",
              });
          }),
      );
      const mcp = harness.runtime.mcpServers!;
      const rows = yield* mcp.list();
      assert.equal(rows.length, 2);
      assert.isTrue(rows[1]?.locked);
      yield* mcp.setEnabled("docs.with.dot", false);
      assert.equal((yield* mcp.startSignIn("docs.with.dot")).url, "https://example.test/oauth");
      assert.equal((yield* mcp.list())[0]?.status, "needs-auth");
      assert.equal((yield* harness.runtime.readSessionCatalog!()).skills[0]?.name, "loaded");
      assert.notInclude(requested, "turn/start");
      assert.equal(
        harness.events.filter((event) => event.type === "provider_turn.updated").length,
        0,
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(mcp.setEnabled("stark-code", false))));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each([
    { respond: false, interrupted: false, exitCode: 0 },
    { respond: true, interrupted: false, exitCode: 1 },
    { respond: true, interrupted: true, exitCode: null },
  ])(
    "runs user shell commands with live output, respond=$respond, interrupted=$interrupted",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = `shell-${scenario.respond}-${scenario.interrupted}`;
          const nativeTurnId = `${nativeThreadId}-turn`;
          const commandItem = {
            type: "commandExecution",
            id: "user-command",
            command: "/bin/zsh -lc pwd",
            cwd: "/workspace",
            source: "userShell",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          };
          const reply = codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "shell-reply",
            prompt: CodexAdapterV2.SHELL_REPLY_PROMPT,
          })
            .slice(5)
            .map((entry) =>
              entry.type === "expect_outbound" || entry.type === "emit_inbound"
                ? {
                    ...entry,
                    frame:
                      Predicate.isObject(entry.frame) && entry.frame.id === 3
                        ? { ...entry.frame, id: 4 }
                        : entry.frame,
                  }
                : entry,
            );
          const transcript = makeCodexReplayTranscript({
            scenario: `user-shell-${scenario.respond}-${scenario.interrupted}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "unused" }).slice(
                0,
                5,
              ),
              {
                type: "expect_outbound",
                frame: {
                  id: 3,
                  method: "thread/shellCommand",
                  params: { threadId: nativeThreadId, command: "pwd", timeoutMs: 600_000 },
                },
              },
              { type: "emit_inbound", frame: { id: 3, result: {} } },
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/started",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "item/started",
                  params: { threadId: nativeThreadId, turnId: nativeTurnId, item: commandItem },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "item/commandExecution/outputDelta",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: commandItem.id,
                    delta: "/work",
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "item/commandExecution/outputDelta",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: commandItem.id,
                    delta: "space\n",
                  },
                },
              },
              ...(!scenario.interrupted
                ? [
                    {
                      type: "emit_inbound" as const,
                      afterMs: 200,
                      frame: {
                        method: "item/completed",
                        params: {
                          threadId: nativeThreadId,
                          turnId: nativeTurnId,
                          item: {
                            ...commandItem,
                            status: scenario.exitCode === 0 ? "completed" : "failed",
                            aggregatedOutput: "/workspace\n",
                            exitCode: scenario.exitCode,
                            durationMs: 200,
                          },
                        },
                      },
                    },
                  ]
                : []),
              ...(scenario.interrupted
                ? [
                    {
                      type: "expect_outbound" as const,
                      frame: {
                        id: 4,
                        method: "turn/interrupt",
                        params: { threadId: nativeThreadId, turnId: nativeTurnId },
                      },
                    },
                    { type: "emit_inbound" as const, frame: { id: 4, result: {} } },
                  ]
                : []),
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({
                      id: nativeTurnId,
                      status: scenario.interrupted ? "interrupted" : "completed",
                    }),
                  },
                },
              },
              ...(scenario.respond && !scenario.interrupted
                ? [
                    ...reply,
                    {
                      type: "emit_inbound" as const,
                      frame: {
                        method: "item/completed",
                        params: {
                          threadId: nativeThreadId,
                          turnId: "shell-reply",
                          item: {
                            type: "agentMessage",
                            id: "reply-text",
                            text: "Command exited with 1.",
                            phase: "final_answer",
                          },
                        },
                      },
                    },
                    {
                      type: "emit_inbound" as const,
                      frame: {
                        method: "turn/completed",
                        params: {
                          threadId: nativeThreadId,
                          turn: makeCodexReplayTurn({ id: "shell-reply", status: "completed" }),
                        },
                      },
                    },
                  ]
                : []),
            ],
          });
          const requested: string[] = [];
          const commandStarted = yield* Deferred.make<void>();
          const liveOutput = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(
            transcript,
            (event) =>
              Effect.gen(function* () {
                if (
                  event.type !== "turn_item.updated" ||
                  event.turnItem.type !== "command_execution"
                )
                  return;
                yield* Deferred.succeed(commandStarted, undefined);
                if (event.turnItem.output === "/workspace\n")
                  yield* Deferred.succeed(liveOutput, undefined);
              }),
            (method) => Effect.sync(() => requested.push(method)),
          );
          const turnInput = makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("user-shell-attempt"),
            text: "pwd",
          });
          assert.isDefined(harness.runtime.runUserShellCommand);
          yield* harness.runtime.runUserShellCommand!({
            ...turnInput,
            message: {
              ...turnInput.message,
              userShell: { command: "pwd", respond: scenario.respond },
            },
          });
          yield* Deferred.await(commandStarted);
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(liveOutput);
          assert.equal(harness.terminalEvents().length, 0);
          if (scenario.interrupted) {
            const running = harness.events.flatMap((event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "running"
                ? [event.providerTurn]
                : [],
            )[0]!;
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId: running.id,
            });
          } else yield* TestClock.adjust("100 millis");
          yield* harness.firstTerminal;
          const commands = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
              ? [event.turnItem]
              : [],
          );
          assert.isTrue(
            commands.every(
              (item) => item.source === "user_shell" && item.runId === turnInput.runId,
            ),
          );
          assert.equal(commands.at(-1)?.input, "pwd");
          assert.equal(commands.at(-1)?.output, "/workspace\n");
          assert.equal(
            commands.at(-1)?.status,
            scenario.interrupted ? "interrupted" : scenario.exitCode === 0 ? "completed" : "failed",
          );
          if (scenario.interrupted) assert.isTrue(commands.at(-1)?.interrupted);
          else {
            assert.equal(commands.at(-1)?.exitCode, scenario.exitCode);
            assert.equal(commands.at(-1)?.durationMs, 200);
          }
          assert.equal(
            requested.filter((method) => method === "turn/start").length,
            scenario.respond && !scenario.interrupted ? 1 : 0,
          );
          assert.equal(
            requested.filter((method) => method === "turn/interrupt").length,
            scenario.interrupted ? 1 : 0,
          );
          assert.equal(harness.terminalEvents().length, 1);
          assert.equal(
            harness.terminalEvents()[0]?.status,
            scenario.interrupted ? "interrupted" : "completed",
          );
          const providerTurns = harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" ? [event.providerTurn] : [],
          );
          assert.isTrue(providerTurns.every((turn) => turn.runAttemptId === turnInput.attemptId));
          assert.deepEqual(
            providerTurns.filter((turn) => turn.status === "running").map((turn) => turn.ordinal),
            scenario.respond && !scenario.interrupted ? [1, 2] : [1],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("clears a rejected user shell start before a later unrelated native turn starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "failed-shell-start";
        const transcript = makeCodexReplayTranscript({
          scenario: "failed-user-shell-start",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "unused",
              prompt: "unused",
            }).slice(0, 5),
            {
              type: "expect_outbound",
              frame: {
                id: 3,
                method: "thread/shellCommand",
                params: { threadId: nativeThreadId, command: "pwd", timeoutMs: 600_000 },
              },
            },
            {
              type: "emit_inbound",
              frame: { id: 3, error: { code: -32001, message: "Unable to launch shell" } },
            },
            {
              type: "emit_inbound",
              afterMs: 1,
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: "unrelated", status: "inProgress" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const input = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("failed-shell-start"),
          text: "pwd",
        });
        const failure = yield* harness.runtime.runUserShellCommand!({
          ...input,
          message: { ...input.message, userShell: { command: "pwd", respond: false } },
        }).pipe(Effect.flip);
        assert.equal(failure._tag, "ProviderAdapterTurnStartError");
        yield* TestClock.adjust("1 millis");
        assert.isFalse(harness.events.some((event) => event.type === "provider_turn.updated"));
        assert.equal(harness.terminalEvents().length, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    { injectionSupported: true, respond: false },
    { injectionSupported: true, respond: true },
    { injectionSupported: false, respond: false },
  ])(
    "records old-Codex user shell fallback, injection supported=$injectionSupported, respond=$respond",
    ({ injectionSupported, respond }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = `fallback-${injectionSupported}`;
          const block =
            "<user_shell_command>\n<command>\npwd\n</command>\n<result>\nExit code: 0\nDuration: 0.2000 seconds\nOutput:\nfallback-output\n\n</result>\n</user_shell_command>";
          const transcript = makeCodexReplayTranscript({
            scenario: `shell-fallback-${injectionSupported}`,
            entries: [
              ...codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "unused",
                prompt: "unused",
              }).slice(0, 5),
              {
                type: "expect_outbound",
                frame: {
                  id: 3,
                  method: "thread/shellCommand",
                  params: { threadId: nativeThreadId, command: "pwd", timeoutMs: 600_000 },
                },
              },
              {
                type: "emit_inbound",
                frame: { id: 3, error: { code: -32601, message: "Method not found" } },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 4,
                  method: "thread/inject_items",
                  params: {
                    threadId: nativeThreadId,
                    items: [
                      {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: block }],
                      },
                    ],
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: injectionSupported
                  ? { id: 4, result: {} }
                  : { id: 4, error: { code: -32601, message: "Method not found" } },
              },
              ...(respond
                ? [
                    ...codexReplayPreamble({
                      nativeThreadId,
                      nativeTurnId: "fallback-reply",
                      prompt: CodexAdapterV2.SHELL_REPLY_PROMPT,
                    })
                      .slice(5)
                      .map((entry) =>
                        entry.type === "expect_outbound" || entry.type === "emit_inbound"
                          ? {
                              ...entry,
                              frame:
                                Predicate.isObject(entry.frame) && entry.frame.id === 3
                                  ? { ...entry.frame, id: 5 }
                                  : entry.frame,
                            }
                          : entry,
                      ),
                    {
                      type: "emit_inbound" as const,
                      frame: {
                        method: "turn/completed",
                        params: {
                          threadId: nativeThreadId,
                          turn: makeCodexReplayTurn({
                            id: "fallback-reply",
                            status: "completed",
                          }),
                        },
                      },
                    },
                  ]
                : []),
            ],
          });
          const invoked: Array<{ command: string; cwd: string | null; timeoutMs?: number }> = [];
          const runner = UserShellCommandRunner.of({
            run: (input) =>
              Effect.sync(() => {
                invoked.push(input);
              }).pipe(
                Effect.andThen(input.onOutput?.("fallback-output\n") ?? Effect.void),
                Effect.as({
                  stdout: "fallback-output\n",
                  stderr: "",
                  output: "fallback-output\n",
                  outputOmitted: false,
                  exitCode: 0,
                  signal: null,
                  durationMs: 200,
                  timedOut: false,
                  interrupted: false,
                }),
              ),
            cancel: () => Effect.void,
            saveOutput: ({ output }) => Effect.succeed({ output, outputOmitted: false }),
          });
          const harness = yield* makeCodexReplayHarness(transcript).pipe(
            Effect.provideService(UserShellCommandRunner, runner),
          );
          const input = makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`fallback-${injectionSupported}`),
            text: "pwd",
          });
          yield* harness.runtime.runUserShellCommand!({
            ...input,
            message: { ...input.message, userShell: { command: "pwd", respond } },
          });
          yield* harness.firstTerminal;
          assert.equal(invoked.length, 1);
          assert.equal(invoked[0]?.command, "pwd");
          assert.equal(invoked[0]?.cwd, "/workspace");
          assert.equal(invoked[0]?.timeoutMs, 600_000);
          const commands = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
              ? [event.turnItem]
              : [],
          );
          assert.equal(commands.at(-1)?.source, "user_shell");
          assert.equal(commands.at(-1)?.exitCode, 0);
          assert.equal(commands.at(-1)?.output, "fallback-output\n");
          const terminal = harness.terminalEvents()[0]!;
          assert.equal(terminal.status, injectionSupported ? "completed" : "failed");
          if (terminal.status === "failed")
            assert.include(
              terminal.failure.message,
              "This Codex version cannot record ! commands; update Codex.",
            );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("resumes a provider thread without requesting or decoding its history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-resume-metadata";
        const nativeThreadId = `native-${scenario}-thread`;
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "unused-turn",
          prompt: "unused-prompt",
        }).slice(0, 5);
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });

        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
        assert.equal(resumed.status, "idle");
        assert.equal(DateTime.toEpochMillis(resumed.updatedAt), 1782622450000);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each(
    (
      [
        ["recovers archived-session errors", "session saved-thread is archived", 0, ""],
        [
          "recovers unarchive hints",
          "Run `codex unarchive saved-thread` to unarchive it first.",
          0,
          "",
        ],
        ["preserves missing-thread errors", "thread not found", 3, "thread not found"],
        ["preserves missing-rollout errors", "no rollout found", 3, "no rollout found"],
        ["preserves authentication errors", "authentication failed", 3, "authentication failed"],
        [
          "preserves archived-workspace errors",
          "workspace is archived",
          3,
          "workspace is archived",
        ],
        [
          "preserves unrelated archive-path errors",
          "permission denied reading archived_sessions/saved-thread",
          3,
          "permission denied reading archived_sessions/saved-thread",
        ],
        [
          "propagates unarchive missing-thread errors",
          "session saved-thread is archived",
          4,
          "thread not found",
        ],
        [
          "propagates unarchive archived errors",
          "session saved-thread is archived",
          4,
          "session saved-thread is archived",
        ],
        [
          "propagates retry missing-thread errors",
          "session saved-thread is archived",
          5,
          "thread not found",
        ],
        [
          "does not retry archived errors twice",
          "session saved-thread is archived",
          5,
          "session saved-thread is archived",
        ],
      ] as const
    ).map(([name, resumeError, failAt, finalError]) => ({ name, resumeError, failAt, finalError })),
  )("$name", ({ name, resumeError, failAt, finalError }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "saved-thread";
        const params = {
          threadId: nativeThreadId,
          excludeTurns: true,
          cwd: CODEX_TEST_RUNTIME_POLICY.cwd,
          model: CODEX_TEST_MODEL_SELECTION.model,
          config: CodexAdapterV2.CODEX_THREAD_CONFIG,
        };
        const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "unused-turn",
            prompt: "unused-prompt",
          }).slice(0, 5),
          {
            type: "expect_outbound",
            label: "resume archived thread",
            frame: { id: 3, method: "thread/resume", params },
          },
          {
            type: "emit_inbound",
            label: "resume error",
            frame: { id: 3, error: { code: -32600, message: resumeError } },
          },
        ];
        if (failAt !== 3) {
          entries.push(
            {
              type: "expect_outbound",
              label: "unarchive same thread",
              frame: { id: 4, method: "thread/unarchive", params: { threadId: nativeThreadId } },
            },
            {
              type: "emit_inbound",
              label: "unarchive result",
              frame:
                failAt === 4
                  ? { id: 4, error: { code: -32600, message: finalError } }
                  : { id: 4, result: { thread: { turns: [{ type: "unknown-history-item" }] } } },
            },
          );
        }
        if (failAt === 0 || failAt === 5) {
          entries.push(
            {
              type: "expect_outbound",
              label: "retry identical resume",
              frame: { id: 5, method: "thread/resume", params },
            },
            {
              type: "emit_inbound",
              label: "retry result",
              frame:
                failAt === 5
                  ? { id: 5, error: { code: -32600, message: finalError } }
                  : {
                      id: 5,
                      result: {
                        thread: {
                          id: nativeThreadId,
                          updatedAt: 1782622450,
                          turns: [{ type: "unknown-history-item" }],
                        },
                      },
                    },
            },
          );
        }
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({ scenario: name, entries }),
        );
        const resume = harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        if (failAt !== 0) {
          const error = yield* Effect.flip(resume);
          assert.equal(error._tag, "ProviderAdapterResumeThreadError");
          assert.nestedPropertyVal(error, "cause.errorMessage", finalError);
          assert.nestedPropertyVal(
            error,
            "cause.method",
            failAt === 4 ? "thread/unarchive" : "thread/resume",
          );
          assert.nestedPropertyVal(error, "cause.requestId", String(failAt));
          return;
        }
        const resumed = yield* resume;
        assert.equal(resumed.id, harness.providerThread.id);
        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
        assert.deepEqual(
          resumed.nativeConversationHeadRef,
          harness.providerThread.nativeConversationHeadRef,
        );
        assert.equal(resumed.status, "idle");
        assert.equal(DateTime.toEpochMillis(resumed.updatedAt), 1782622450000);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("continues an interrupted native thread with empty input and reasoning summaries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-restart-promptless";
        const nativeThreadId = "native-restart-promptless";
        const nativeTurnId = "turn-restart-promptless";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId,
          prompt: "unused",
        }).slice(0, 5);
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
            {
              type: "expect_outbound",
              label: "continue",
              frame: {
                id: 4,
                method: "turn/start",
                params: {
                  threadId: nativeThreadId,
                  input: [],
                  cwd: "/workspace",
                  model: "gpt-5.4",
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandboxPolicy: { type: "dangerFullAccess" },
                  summary: "detailed",
                },
              },
            },
            {
              type: "emit_inbound",
              label: "continue",
              frame: {
                id: 4,
                result: { turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }) },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        yield* harness.runtime.startTurn({
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: resumed,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-restart-promptless"),
            text: "Continue where you left off.",
          }),
          restartContinuationOfRunId: RunId.make("run-before-restart"),
        });
        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("resolves retryable app-server errors on resumed provider activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-provider-api-retry";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Open github.com.",
            }),
            {
              type: "emit_inbound",
              label: "error/retry",
              frame: {
                method: "error",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  willRetry: true,
                  error: {
                    message: "Reconnecting... 2/5",
                    additionalDetails: "The response stream disconnected.",
                    codexErrorInfo: {
                      responseStreamDisconnected: { httpStatusCode: 529 },
                    },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/started/after-retry",
              frame: {
                method: "item/started",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1782622445000,
                  item: {
                    type: "commandExecution",
                    id: "command-after-provider-retry",
                    command: "pwd",
                    cwd: "/workspace",
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "inProgress",
                    commandActions: [{ type: "unknown", command: "pwd" }],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed/after-retry",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622445010,
                  item: {
                    type: "commandExecution",
                    id: "command-after-provider-retry",
                    command: "pwd",
                    cwd: "/workspace",
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "completed",
                    commandActions: [{ type: "unknown", command: "pwd" }],
                    aggregatedOutput: "/workspace\n",
                    exitCode: 0,
                    durationMs: 10,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-provider-api-retry"),
            text: "Open github.com.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex retry recovery");

        const retryItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.retry !== undefined
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(retryItems, 2);
        assert.equal(retryItems[0]?.status, "running");
        assert.equal(retryItems[0]?.failure.code, "responseStreamDisconnected");
        assert.deepEqual(retryItems[0]?.retry, {
          attempt: 2,
          maxAttempts: 5,
          retryDelayMs: null,
        });
        assert.equal(retryItems[1]?.id, retryItems[0]?.id);
        assert.equal(retryItems[1]?.status, "completed");
        assert.equal(retryItems[1]?.title, "Provider recovered");

        const recoveredIndex = harness.events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.status === "completed",
        );
        const resumedCommandIndex = harness.events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.input === "pwd",
        );
        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        assert.isAtLeast(recoveredIndex, 0);
        assert.isAbove(resumedCommandIndex, recoveredIndex);
        assert.isAbove(terminalIndex, resumedCommandIndex);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("stamps Codex items with their own start time, not the turn's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-item-start-times";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const commandLifecycle = (id: string, startedAtMs: number) =>
          (["started", "completed"] as const).map((phase) => ({
            type: "emit_inbound" as const,
            label: `item/${phase}/${id}`,
            frame: {
              method: `item/${phase}`,
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                ...(phase === "started" ? { startedAtMs } : { completedAtMs: startedAtMs + 10 }),
                item: {
                  type: "commandExecution",
                  id,
                  command: "pwd",
                  cwd: "/workspace",
                  processId: "42",
                  source: "unifiedExecStartup",
                  status: phase === "started" ? "inProgress" : "completed",
                  commandActions: [{ type: "unknown", command: "pwd" }],
                  aggregatedOutput: phase === "started" ? null : "/workspace\n",
                  exitCode: phase === "started" ? null : 0,
                  durationMs: phase === "started" ? null : 10,
                },
              },
            },
          }));
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Run two commands." }),
            ...commandLifecycle("first-command", 1782622445000),
            ...commandLifecycle("second-command", 1782622505000),
            ...(["started", "completed"] as const).map((phase) => ({
              type: "emit_inbound" as const,
              label: `item/${phase}/compaction`,
              frame: {
                method: `item/${phase}`,
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  ...(phase === "started"
                    ? { startedAtMs: 1782622565000 }
                    : { completedAtMs: 1782622575000 }),
                  item: { type: "contextCompaction", id: "compaction" },
                },
              },
            })),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-item-start-times"),
            text: "Run two commands.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex item start times");

        const startedAtByItem = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          (event.turnItem.type === "command_execution" || event.turnItem.type === "compaction")
            ? [[event.turnItem.nativeItemRef?.nativeId, event.turnItem.startedAt] as const]
            : [],
        );
        assert.deepEqual(
          startedAtByItem.map(([id, startedAt]) => [id, startedAt?.epochMilliseconds]),
          [
            ["first-command", 1782622445000],
            ["first-command", 1782622445000],
            ["second-command", 1782622505000],
            ["second-command", 1782622505000],
            ["compaction", 1782622565000],
            ["compaction", 1782622565000],
          ],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each(["completed", "interrupted"] as const)(
    "retains Codex reasoning parts when the turn is %s",
    (terminalStatus) =>
      Effect.scoped(
        Effect.gen(function* () {
          const scenario = `codex-reasoning-${terminalStatus}`;
          const nativeThreadId = `native-${scenario}-thread`;
          const nativeTurnId = `native-${scenario}-turn`;
          const prompt = "Explain the check.";
          const transcript = makeCodexReplayTranscript({
            scenario,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
              ...[
                {
                  method: "item/reasoning/summaryTextDelta",
                  params: { itemId: "thought", summaryIndex: 0, delta: "Summary " },
                },
                {
                  method: "item/reasoning/summaryTextDelta",
                  params: { itemId: "thought", summaryIndex: 0, delta: "one" },
                },
                {
                  method: "item/reasoning/summaryTextDelta",
                  params: { itemId: "thought", summaryIndex: 1, delta: "Summary two" },
                },
                {
                  method: "item/reasoning/textDelta",
                  params: { itemId: "thought", contentIndex: 0, delta: "Raw trace" },
                },
                {
                  method: "item/completed",
                  params: {
                    item: {
                      type: "commandExecution",
                      id: "after-thought",
                      command: "pwd",
                      cwd: "/workspace",
                      processId: "42",
                      source: "unifiedExecStartup",
                      status: "completed",
                      commandActions: [{ type: "unknown", command: "pwd" }],
                      aggregatedOutput: "/workspace",
                      exitCode: 0,
                      durationMs: 1,
                    },
                  },
                },
                ...(terminalStatus === "completed"
                  ? [
                      {
                        method: "item/completed",
                        params: {
                          item: {
                            type: "reasoning",
                            id: "thought",
                            summary: ["Final summary one", "Summary two"],
                            content: ["Raw trace"],
                          },
                        },
                      },
                      {
                        method: "item/completed",
                        params: {
                          item: {
                            type: "reasoning",
                            id: "completion-only",
                            summary: ["Completion without deltas"],
                            content: [],
                          },
                        },
                      },
                      {
                        method: "item/reasoning/textDelta",
                        params: {
                          itemId: "delta-only",
                          contentIndex: 0,
                          delta: "Retained when completion omits content",
                        },
                      },
                      {
                        method: "item/completed",
                        params: {
                          item: { type: "reasoning", id: "delta-only", summary: [], content: [] },
                        },
                      },
                    ]
                  : []),
              ].map((event, index) => ({
                type: "emit_inbound" as const,
                label: `reasoning-${index}`,
                frame: {
                  method: event.method,
                  params: { threadId: nativeThreadId, turnId: nativeTurnId, ...event.params },
                },
              })),
              {
                type: "emit_inbound",
                label: "turn/completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: terminalStatus }),
                  },
                },
              },
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`attempt-${scenario}`),
              text: prompt,
            }),
          );
          yield* harness.firstTerminal;
          const latest = new Map(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "reasoning"
                ? [[event.turnItem.id, event.turnItem] as const]
                : [],
            ),
          );
          assert.deepEqual(
            [...latest.values()].map((item) => item.text),
            terminalStatus === "completed"
              ? [
                  "Final summary one",
                  "Summary two",
                  "Raw trace",
                  "Completion without deltas",
                  "Retained when completion omits content",
                ]
              : ["Summary one", "Summary two", "Raw trace"],
          );
          assert.isTrue([...latest.values()].every((item) => item.status === terminalStatus));
          assert.isTrue([...latest.values()].every((item) => item.streaming === false));
          assert.isTrue(
            [...latest.values()].every(
              (item) => item.runId !== null && item.providerTurnId !== null,
            ),
          );
          assert.equal(new Set([...latest.values()].map((item) => item.ordinal)).size, latest.size);
          const command = harness.events.find(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          );
          assert.isDefined(command);
          if (command?.type === "turn_item.updated") {
            assert.isTrue(
              [...latest.values()]
                .slice(0, 3)
                .every((item) => item.ordinal < command.turnItem.ordinal),
            );
          }
          assert.deepEqual(assistantMessages(harness.events), []);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("streams a proposed plan a few times a second instead of once per delta", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-plan-delta-coalescing";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const prompt = "Plan the change.";
        // 100 deltas, 20 ms apart: a two second stream.
        const deltas = Array.from({ length: 100 }, (_, index) => `step ${index}\n`);
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            ...deltas.map((delta, index): CodexReplay.CodexAppServerReplayEntry => ({
              type: "emit_inbound",
              label: `item/plan/delta/${index}`,
              afterMs: 20,
              frame: {
                method: "item/plan/delta",
                params: { threadId: nativeThreadId, turnId: nativeTurnId, itemId: "plan", delta },
              },
            })),
            {
              type: "emit_inbound",
              label: "item/completed/plan",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "plan", id: "plan", text: "" },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`attempt-${scenario}`),
            text: prompt,
          }),
        );
        for (let step = 0; step < 200 && harness.terminalEvents().length === 0; step += 1) {
          yield* Effect.yieldNow;
          yield* TestClock.adjust("20 millis");
        }
        yield* harness.firstTerminal;

        const plans = harness.events.flatMap((event) =>
          event.type === "plan.updated" && event.plan.kind === "proposed_plan" ? [event.plan] : [],
        );
        const planItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "proposed_plan"
            ? [event.turnItem]
            : [],
        );
        // One update per 400 ms of the stream, plus the completion.
        assert.isAtLeast(plans.length, 2);
        assert.isAtMost(plans.length, 7);
        assert.equal(planItems.length, plans.length);
        assert.equal(plans.at(-1)?.markdown, deltas.join(""));
        assert.deepEqual(
          planItems.map((item) => item.streaming),
          [...Array.from({ length: planItems.length - 1 }, () => true), false],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const finalAnswerTranscript = (
    scenario: string,
    answers: ReadonlyArray<{
      readonly id: string;
      readonly text: string;
      readonly phase?: "commentary" | "final_answer" | null;
      readonly omitPhase?: boolean;
      readonly streamed?: boolean;
      readonly completionDelayMs?: number;
    }>,
  ) => {
    const nativeThreadId = `native-${scenario}-thread`;
    const nativeTurnId = `native-${scenario}-turn`;
    const prompt = "Reply with the requested recovery marker.";
    return makeCodexReplayTranscript({
      scenario,
      entries: [
        ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
        ...answers.flatMap(
          (answer, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => {
            const phase = answer.omitPhase
              ? {}
              : { phase: answer.phase === undefined ? ("final_answer" as const) : answer.phase };
            const completed: CodexReplay.CodexAppServerReplayEntry = {
              type: "emit_inbound",
              label: `item/completed/${answer.id}`,
              ...(answer.completionDelayMs === undefined
                ? {}
                : { afterMs: answer.completionDelayMs }),
              frame: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    id: answer.id,
                    text: answer.text,
                    ...phase,
                    memoryCitation: null,
                  },
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000 + index,
                },
              },
            };
            if (!answer.streamed) {
              return [completed];
            }
            return [
              {
                type: "emit_inbound",
                label: `item/started/${answer.id}`,
                frame: {
                  method: "item/started",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: answer.id,
                      text: "",
                      ...phase,
                      memoryCitation: null,
                    },
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    startedAtMs: 1782622440500 + index,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: `item/agentMessage/delta/${answer.id}`,
                frame: {
                  method: "item/agentMessage/delta",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: answer.id,
                    delta: answer.text,
                  },
                },
              },
              completed,
            ];
          },
        ),
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
            },
          },
        },
      ],
    });
  };

  it.effect("suppresses a trailing empty final answer after a non-empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-redundant-empty-final", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-redundant-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("streams text on the turn item and sends the message once, when it completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-streamed-message-once", [
          { id: "answer", text: "CODEX_RECOVERY_OK", streamed: true, completionDelayMs: 100 },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-streamed-message-once"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(
          () => assistantTurnItems(harness.events).length === 1,
          "streamed turn item",
        );
        assert.deepEqual(
          assistantTurnItems(harness.events).map(({ text, streaming }) => ({ text, streaming })),
          [{ text: "CODEX_RECOVERY_OK", streaming: true }],
        );
        assert.deepEqual(assistantMessages(harness.events), []);

        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.deepEqual(
          assistantMessages(harness.events).map(({ message }) => ({
            text: message.text,
            streaming: message.streaming,
          })),
          [{ text: "CODEX_RECOVERY_OK", streaming: false }],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("suppresses a later streamed duplicate final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-streamed-duplicate-final", [
          { id: "answer-original", text: "CODEX_RECOVERY_OK" },
          {
            id: "answer-duplicate",
            text: "CODEX_RECOVERY_OK",
            streamed: true,
            completionDelayMs: 100,
          },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-streamed-duplicate-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => assistantMessages(harness.events).length === 1, "original answer");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );

        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("buffers an overlapping later final stream until duplicate detection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-overlapping-duplicate-final";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const answerItem = (id: string, text: string) => ({
          type: "agentMessage" as const,
          id,
          text,
          phase: "final_answer" as const,
          memoryCitation: null,
        });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Reply with the requested recovery marker.",
            }),
            ...["answer-overlap-original", "answer-overlap-duplicate"].flatMap(
              (itemId, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
                {
                  type: "emit_inbound",
                  label: `item/started/${itemId}`,
                  frame: {
                    method: "item/started",
                    params: {
                      item: answerItem(itemId, ""),
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      startedAtMs: 1782622440500 + index,
                    },
                  },
                },
                {
                  type: "emit_inbound",
                  label: `item/agentMessage/delta/${itemId}`,
                  frame: {
                    method: "item/agentMessage/delta",
                    params: {
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      itemId,
                      delta: "CODEX_RECOVERY_OK",
                    },
                  },
                },
              ],
            ),
            {
              type: "emit_inbound",
              label: "item/completed/answer-overlap-original",
              afterMs: 100,
              frame: {
                method: "item/completed",
                params: {
                  item: answerItem("answer-overlap-original", "CODEX_RECOVERY_OK"),
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed/answer-overlap-duplicate",
              frame: {
                method: "item/completed",
                params: {
                  item: answerItem("answer-overlap-duplicate", "CODEX_RECOVERY_OK"),
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441001,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-overlapping-duplicate-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;

        assert.equal(new Set(assistantTurnItems(harness.events).map((item) => item.id)).size, 1);

        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(
          new Set(assistantMessages(harness.events).map((event) => event.message.id)).size,
          1,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("preserves a sole empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-sole-empty-final", [
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-sole-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          [""],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("suppresses a second empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-duplicate-empty-final", [
          { id: "answer-empty-original", text: "" },
          { id: "answer-empty-duplicate", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-duplicate-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          [""],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("preserves an empty final answer when only commentary preceded it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-commentary-then-empty-final", [
          { id: "answer-commentary", text: "Working on it.", phase: "commentary" },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-commentary-then-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["Working on it.", ""],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("suppresses an empty final answer after a non-empty unknown-phase answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-unknown-non-empty-then-empty-final", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK", phase: null },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-unknown-non-empty-then-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("suppresses a trailing empty answer with an omitted phase", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-final-then-empty-unknown", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
          { id: "answer-empty", text: "", omitPhase: true },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-final-then-empty-unknown"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("keeps a later non-empty final answer after an initial empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-empty-then-non-empty-final", [
          { id: "answer-empty", text: "" },
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-empty-then-non-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["", "CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const BG_SCENARIO = "codex-bg-exec-wake";
  const BG_NATIVE_THREAD = "native-codex-bg-thread";
  const BG_NATIVE_TURN = "native-codex-bg-turn";
  const BG_COMMAND_ITEM = "call-codex-bg-command";
  const BG_COMMAND = "sleep 20 && echo CODEX_BG_WAKE_DONE";
  const BG_PROMPT = "Start the sleep in the background and reply STARTED.";

  const backgroundCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
    type: "commandExecution",
    id: BG_COMMAND_ITEM,
    command: BG_COMMAND,
    cwd: "/workspace",
    processId: "4242",
    source: "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command: BG_COMMAND }],
    aggregatedOutput: status === "completed" ? "CODEX_BG_WAKE_DONE\n" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 25_000 : null,
  });

  const backgroundExecTranscript = makeCodexReplayTranscript({
    scenario: BG_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: BG_NATIVE_THREAD,
        nativeTurnId: BG_NATIVE_TURN,
        prompt: BG_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: backgroundCommandItem("inProgress"),
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-bg",
              text: "STARTED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: BG_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: backgroundCommandItem("completed"),
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
    ],
  });

  it.effect(
    "projects a post-settle background command completion and requests a continuation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(backgroundExecTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-bg-wake"),
              text: BG_PROMPT,
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.isTrue(
            yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
          );
          assert.lengthOf(harness.continuationRequests, 0);
          const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");

          yield* TestClock.adjust("30 seconds");
          yield* awaitUntil(
            () => harness.continuationRequests.length === 1,
            "continuation request",
          );
          const request = harness.continuationRequests[0];
          assert.equal(request?.threadId, harness.threadId);
          assert.equal(request?.providerThreadId, harness.providerThread.id);
          assert.equal(request?.driver, CodexAdapterV2.CODEX_DRIVER_KIND);
          assert.deepEqual(request?.notification, {
            source: { kind: "command" },
            outcome: "completed",
            summary: `Command "${BG_COMMAND}" finished (exit 0)`,
            detail: BG_COMMAND,
          });
          assert.equal(
            request?.detail,
            `Background command completed (exit 0): ${BG_COMMAND}\n\n` +
              "Output tail:\nCODEX_BG_WAKE_DONE",
          );

          const lateCommandUpdateIndex = () =>
            harness.events.findIndex(
              (event, index) =>
                index > terminalIndex &&
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "completed" &&
                event.turnItem.output === "CODEX_BG_WAKE_DONE\n" &&
                event.turnItem.exitCode === 0,
            );
          yield* awaitUntil(
            () => lateCommandUpdateIndex() > terminalIndex,
            "post-settle command projection",
          );
          assert.lengthOf(harness.terminalEvents(), 1);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  // "thread_unloaded": the thread was settled, so Stark unsubscribed and Codex
  // unloaded it (killing its terminals) before Stop arrived.
  const backgroundStopCases = [true, false, "still_running", "thread_unloaded"] as const;
  const makeBackgroundStopTranscript = (terminated: (typeof backgroundStopCases)[number]) => {
    const stillRunning = terminated === "still_running";
    return makeCodexReplayTranscript({
      scenario: `codex-bg-stop-${terminated}`,
      entries: [
        ...backgroundExecTranscript.entries.slice(0, -1),
        {
          type: "expect_outbound",
          label: "terminate-background-command",
          frame: {
            id: 4,
            method: "thread/backgroundTerminals/terminate",
            params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
          },
        },
        {
          type: "emit_inbound",
          label: "terminate-background-command",
          frame:
            terminated === "thread_unloaded"
              ? {
                  id: 4,
                  error: { code: -32600, message: `thread not found: ${BG_NATIVE_THREAD}` },
                }
              : { id: 4, result: { terminated: terminated === true } },
        },
        ...(terminated === false || stillRunning
          ? [
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 5,
                  method: "thread/backgroundTerminals/list",
                  params: { threadId: BG_NATIVE_THREAD },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: {
                  id: 5,
                  result: { data: stillRunning ? [{ processId: "4242" }] : [], nextCursor: null },
                },
              },
            ]
          : []),
        ...(stillRunning
          ? [
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 6,
                  method: "thread/backgroundTerminals/terminate",
                  params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: { id: 6, result: { terminated: false } },
              },
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 7,
                  method: "thread/backgroundTerminals/list",
                  params: { threadId: BG_NATIVE_THREAD },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: { id: 7, result: { data: [{ processId: "4242" }], nextCursor: null } },
              },
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 8,
                  method: "thread/backgroundTerminals/terminate",
                  params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: { id: 8, result: { terminated: true } },
              },
            ]
          : []),
        backgroundExecTranscript.entries.at(-1)!,
      ],
    });
  };

  it.effect.each(backgroundStopCases)(
    "stops a command after root completion when termination returns %s",
    (terminated) => {
      const stillRunning = terminated === "still_running";
      const transcript = makeBackgroundStopTranscript(terminated);
      return Effect.scoped(
        Effect.gen(function* () {
          const stopped = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(transcript, (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted"
              ? Deferred.succeed(stopped, undefined)
              : Effect.void,
          );
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-bg-stop"),
              text: BG_PROMPT,
            }),
          );
          yield* harness.firstTerminal;
          const terminal = harness.terminalEvents()[0]!;
          assert.equal(terminal.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.isFalse(
            yield* harness.runtime.hasPendingBackgroundWorkForThread!({
              ...harness.providerThread,
              id: ProviderThreadId.make("unrelated-provider-thread"),
            }),
          );
          if (stillRunning) {
            const failed = yield* harness.runtime
              .interruptTurn({
                providerThread: harness.providerThread,
                providerTurnId: terminal.providerTurnId,
                requestRuntimeRestart: true,
              })
              .pipe(Effect.exit);
            assert.equal(failed._tag, "Failure");
            assert.isTrue(yield* harness.hasPendingBackgroundWork);
          }
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: stillRunning
              ? ProviderTurnId.make("later-completed-turn")
              : terminal.providerTurnId,
            requestRuntimeRestart: true,
          });
          yield* Deferred.await(stopped);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.lengthOf(harness.terminalEvents(), 1);
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          assert.lengthOf(harness.continuationRequests, 0);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      );
    },
  );
  it.effect("interrupts a completed run's background command through orchestration", () => {
    const transcript = makeBackgroundStopTranscript(true);
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "stark-bg-stop-workspace-" });
        const localTranscript = withSupervisedReplayPolicy(
          yield* decodeReplayTranscriptJson(
            (yield* encodeReplayTranscriptJson(transcript)).replaceAll(
              yield* encodeStringJson("/workspace"),
              yield* encodeStringJson(cwd),
            ),
          ),
        );
        const replayDriver = yield* CodexReplay.makeReplayDriver(localTranscript);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        assert.equal(
          Number(yield* spawner.exitCode(ChildProcess.make("git", ["init", "--quiet"], { cwd }))),
          0,
        );
        assert.equal(
          Number(
            yield* spawner.exitCode(
              ChildProcess.make(
                "git",
                [
                  "-c",
                  "user.name=Test",
                  "-c",
                  "user.email=test@example.com",
                  "commit",
                  "--allow-empty",
                  "--quiet",
                  "-m",
                  "Initial commit",
                ],
                { cwd },
              ),
            ),
          ),
          0,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:background-stop");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-background-stop"),
            threadId,
            projectId: ProjectId.make("project:background-stop"),
            title: "Background stop",
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const waiting = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.type === "run.updated" && event.payload.status === "waiting",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-background-stop"),
            threadId,
            messageId: MessageId.make("message:background-stop"),
            text: BG_PROMPT,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          assert.isNull((yield* Ref.get(replayDriver.state)).failure);
          yield* Fiber.join(waiting);
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.at(-1)!;
          assert.equal(run.status, "completed");
          assert.equal(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks?.length,
            1,
          );
          const stopped = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "turn-item.updated" &&
                event.payload.type === "command_execution" &&
                event.payload.status === "interrupted",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-background-command"),
            threadId,
            runId: run.id,
          });
          yield* worker.drain();
          yield* Fiber.join(stopped);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
            "completed",
          );
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
            [],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "codex-background-stop", runtimePolicyOverride: { cwd } },
              CodexAdapterV2Testkit.layer({
                transcript: localTranscript,
                driver: replayDriver,
              }),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  // The app-server exits after the root turn, before the command's own
  // item/completed (Codex always sends one, so only a lost notification or a
  // gone process leaves it running). Nothing tracks the command any more, yet
  // the thread still shows it, and Stop is the only way to clear it.
  it.effect("Stop ends a background command no Codex process tracks any more", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "stark-bg-stale-workspace-" });
        const staleTranscript = makeCodexReplayTranscript({
          scenario: "codex-bg-stop-untracked",
          entries: [
            ...backgroundExecTranscript.entries.slice(0, -1),
            { type: "runtime_exit", status: "success" },
          ],
        });
        const localTranscript = withSupervisedReplayPolicy(
          yield* decodeReplayTranscriptJson(
            (yield* encodeReplayTranscriptJson(staleTranscript)).replaceAll(
              yield* encodeStringJson("/workspace"),
              yield* encodeStringJson(cwd),
            ),
          ),
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        for (const args of [
          ["init", "--quiet"],
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Initial commit",
          ],
        ]) {
          assert.equal(Number(yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }))), 0);
        }
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:background-stop-untracked");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-background-stop-untracked"),
            threadId,
            projectId: ProjectId.make("project:background-stop-untracked"),
            title: "Background stop untracked",
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                (event.payload.status === "waiting" || event.payload.status === "completed"),
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-background-stop-untracked"),
            threadId,
            messageId: MessageId.make("message:background-stop-untracked"),
            text: BG_PROMPT,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          yield* Fiber.join(settled);
          yield* worker.drain();
          const before = yield* orchestrator.getThreadShell(threadId);
          assert.deepEqual(
            before?.pendingBackgroundTasks?.map((task) => task.kind),
            ["command"],
            "the thread still shows the command the gone process never finished",
          );
          const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-background-untracked"),
            threadId,
            runId: run.id,
            holdQueue: true,
          });
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            projection.turnItems.flatMap((item) =>
              item.type === "command_execution" ? [item.status] : [],
            ),
            ["interrupted"],
          );
          assert.equal(projection.runs.at(-1)?.status, "completed");
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
            [],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "codex-background-stop-untracked", runtimePolicyOverride: { cwd } },
              CodexAdapterV2Testkit.layer({ transcript: localTranscript }),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  const PRE_SETTLE_SCENARIO = "codex-bg-exec-pre-settle";
  const PRE_SETTLE_NATIVE_THREAD = "native-codex-pre-settle-thread";
  const PRE_SETTLE_NATIVE_TURN = "native-codex-pre-settle-turn";

  const preSettleTranscript = makeCodexReplayTranscript({
    scenario: PRE_SETTLE_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: PRE_SETTLE_NATIVE_THREAD,
        nativeTurnId: PRE_SETTLE_NATIVE_TURN,
        prompt: BG_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: backgroundCommandItem("inProgress"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-pre-settle",
        frame: {
          method: "item/completed",
          params: {
            item: backgroundCommandItem("completed"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-pre-settle",
              text: "DONE",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: PRE_SETTLE_NATIVE_TURN, status: "completed" }),
          },
        },
      },
    ],
  });

  it.effect("does not request a continuation for a command that completes before settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(preSettleTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-bg-pre-settle"),
            text: BG_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "completed" &&
                event.turnItem.exitCode === 0,
            ),
          "pre-settle command projection",
        );

        yield* TestClock.adjust("30 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const INTERRUPT_SCENARIO = "codex-interrupt-mid-command";
  const INTERRUPT_NATIVE_THREAD = "native-codex-interrupt-thread";
  const INTERRUPT_NATIVE_TURN = "native-codex-interrupt-turn";
  const INTERRUPT_COMMAND_ITEM = "exec-codex-interrupt-command";
  const INTERRUPT_COMMAND_ITEM_TWO = "exec-codex-interrupt-command-two";
  const INTERRUPT_CHILD_COMMAND_ITEM = "exec-codex-interrupt-child-command";
  const INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-child-timeout-boundary";
  const INTERRUPT_CHILD_NATIVE_THREAD = "native-codex-interrupt-child-thread";
  const INTERRUPT_CHILD_NATIVE_TURN = "native-codex-interrupt-child-turn";
  const INTERRUPT_LATE_CHILD_NATIVE_TURN = "native-codex-interrupt-late-child-turn";
  const INTERRUPT_LATE_CHILD_2_NATIVE_TURN = "native-codex-interrupt-late-child-2-turn";
  const INTERRUPT_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-timeout-boundary";
  const INTERRUPT_TIMEOUT_LATE_ITEM = "exec-codex-interrupt-timeout-late";
  const INTERRUPT_COMMAND = "bash -c 'sleep 30; echo SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE'";
  const INTERRUPT_COMMAND_TWO = "bash -c 'sleep 20; echo SECOND_COMMAND'";
  const INTERRUPT_PROMPT = "Run a long foreground command and wait until interrupted.";

  const interruptCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
    type: "commandExecution",
    id: INTERRUPT_COMMAND_ITEM,
    command: INTERRUPT_COMMAND,
    cwd: "/workspace",
    processId: "57680",
    source: "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND }],
    aggregatedOutput: status === "completed" ? "SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE\n" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 30_000 : null,
  });

  const interruptMidCommandTranscript = makeCodexReplayTranscript({
    scenario: INTERRUPT_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: { id: 6, result: { data: [], nextCursor: null } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 7,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 7, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
    ],
  });

  it.effect("contains commands that start before and after the interrupt response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptMidCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-mid-command"),
            text: INTERRUPT_PROMPT,
          }),
        );

        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ),
          "running command item",
        );

        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        assert.isAtLeast(terminalIndex, 0);

        let lastCommandBeforeTerminal:
          | Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
          | undefined;
        for (let index = 0; index < terminalIndex; index++) {
          const event = harness.events[index];
          if (event?.type === "turn_item.updated" && event.turnItem.type === "command_execution") {
            lastCommandBeforeTerminal = event;
          }
        }
        assert.isDefined(lastCommandBeforeTerminal);
        assert.equal(lastCommandBeforeTerminal.turnItem.status, "interrupted");
        assert.isNotNull(lastCommandBeforeTerminal.turnItem.completedAt);

        const interruptedCommandsBeforeTerminal = harness.events
          .slice(0, terminalIndex)
          .flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted"
              ? [event.turnItem.input]
              : [],
          )
          .sort();
        assert.deepEqual(
          interruptedCommandsBeforeTerminal,
          [INTERRUPT_COMMAND, INTERRUPT_COMMAND_TWO].sort(),
        );

        const interruptedCommandIndex = harness.events.findIndex(
          (event, index) =>
            index < terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted",
        );
        assert.isAbove(
          terminalIndex,
          interruptedCommandIndex,
          "command terminalization must precede turn.terminal",
        );

        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        // Late provider item/completed after interrupt must not revive the card
        // or request a background-command wake continuation.
        yield* TestClock.adjust("30 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);

        const postTerminalCommandUpdates = harness.events.filter(
          (event, index) =>
            index > terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution",
        );
        assert.lengthOf(
          postTerminalCommandUpdates,
          0,
          "late item/completed after interrupt must not project",
        );

        const commandUpdates = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "turn_item.updated" }
          > => event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        assert.isAtLeast(commandUpdates.length, 2, "start + interrupt terminalization");
        assert.equal(commandUpdates[commandUpdates.length - 1]?.turnItem.status, "interrupted");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const interruptSubagentCommandTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-command",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/subAgentActivity-started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "call-codex-interrupt-subagent",
              kind: "started",
              agentThreadId: INTERRUPT_CHILD_NATIVE_THREAD,
              agentPath: "/root/stop_hold",
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/started/child",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/child-command",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_CHILD_COMMAND_ITEM,
              processId: "57682",
            },
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
            startedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/root",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/root",
        frame: { id: 4, result: {} },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/child",
        frame: {
          id: 5,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/child",
        frame: { id: 5, result: {} },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/child",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_CHILD_NATIVE_THREAD, processId: "57682" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/child",
        frame: { id: 6, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/root",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/child-completed-race",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_CHILD_NATIVE_TURN,
              status: "completed",
            }),
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  const assertChildProviderTerminalBeforeRoot = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    rootThreadId: ThreadId,
  ) => {
    const terminalIndex = events.findIndex((event) => event.type === "turn.terminal");
    const childProviderTurnIndex = events.findIndex(
      (event) =>
        event.type === "provider_turn.updated" &&
        event.threadId !== rootThreadId &&
        event.providerTurn.status === "interrupted",
    );
    const childProviderThreadIndex = events.findIndex(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.appThreadId !== rootThreadId &&
        event.providerThread.status === "idle",
    );
    assert.isAtLeast(childProviderTurnIndex, 0, "child provider turn must terminalize");
    assert.isAtLeast(childProviderThreadIndex, 0, "child provider thread must become idle");
    assert.isAbove(
      terminalIndex,
      childProviderTurnIndex,
      "child provider turn must terminalize before the root run",
    );
    assert.isAbove(
      terminalIndex,
      childProviderThreadIndex,
      "child provider thread must become idle before the root run",
    );
  };

  it.effect("contains descendant commands and keeps Stop authoritative", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-command"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        const childCommandUpdates = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "turn_item.updated" }
          > =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM,
        );
        assert.equal(childCommandUpdates.at(-1)?.turnItem.status, "interrupted");
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "interrupted");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const childInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/child",
  );
  const rootInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/root",
  );
  const interruptSubagentRequestFailureTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-request-failure",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, rootInterruptResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/completed/root-before-child-interrupt-failure",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
          },
        },
      },
      ...interruptSubagentCommandTranscript.entries.slice(
        rootInterruptResponseIndex + 1,
        childInterruptResponseIndex,
      ),
      {
        type: "emit_inbound",
        label: "turn/interrupt/child",
        frame: {
          id: 5,
          error: { code: -32_000, message: "child interrupt request failed" },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("terminalizes descendants before the root when an interrupt request fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentRequestFailureTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-request-failure"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptExit = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.exit);

        assert.equal(interruptExit._tag, "Failure");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const childTerminationResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" && entry.label === "thread/backgroundTerminals/terminate/child",
  );
  const interruptSubagentTimeoutTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-timeout",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "item/started/child-timeout-boundary",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM,
              processId: null,
            },
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
            startedAtMs: 1782622441600,
          },
        },
      },
    ],
  });

  it.effect("terminalizes timed-out descendants before the root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentTimeoutTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-timeout"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM &&
                event.turnItem.status === "running",
            ),
          "child timeout boundary item",
        );
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const rootCompletionIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/root",
  );
  const interruptLateSubagentTurnTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-late-subagent-turn",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, rootCompletionIndex),
      {
        type: "emit_inbound",
        label: "turn/started/late-child",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      ...interruptSubagentCommandTranscript.entries.slice(rootCompletionIndex, -1),
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child",
        frame: {
          id: 7,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child",
        frame: { id: 7, result: {} },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("interrupts descendants that start after the initial Stop snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptLateSubagentTurnTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-late-subagent-turn"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
            ),
          "late child provider turn",
        );
        yield* Fiber.join(interruptFiber);

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        const lateChildUpdates = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
        );
        assert.equal(lateChildUpdates.at(-1)?.providerTurn.status, "interrupted");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const interruptRescanLateSubagentTurnTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-rescan-late-subagent-turn",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/started/late-child-1",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child-1",
        frame: {
          id: 7,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/started/late-child-2",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child-1",
        frame: { id: 7, result: {} },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child-2",
        frame: {
          id: 8,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child-2",
        frame: { id: 8, result: {} },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("interrupts descendants discovered only by the final interrupt rescan", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptRescanLateSubagentTurnTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-rescan-late-subagent-turn"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
            ),
          "late child 1 provider turn",
        );
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");

        const rootTerminalIndex = harness.events.findIndex(
          (event) => event.type === "turn.terminal",
        );
        const lateChild1InterruptedIndex = harness.events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN &&
            event.providerTurn.status === "interrupted",
        );
        const lateChild2InterruptedIndex = harness.events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_2_NATIVE_TURN &&
            event.providerTurn.status === "interrupted",
        );
        assert.isAtLeast(
          lateChild1InterruptedIndex,
          0,
          "late child 1 must terminalize interrupted",
        );
        assert.isAtLeast(
          lateChild2InterruptedIndex,
          0,
          "late child 2 must terminalize interrupted",
        );
        assert.isAbove(
          rootTerminalIndex,
          lateChild1InterruptedIndex,
          "late child 1 must terminalize before the root run",
        );
        assert.isAbove(
          rootTerminalIndex,
          lateChild2InterruptedIndex,
          "late child 2 must terminalize before the root run",
        );
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const interruptTimeoutTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-timeout",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-at-timeout-boundary",
        afterMs: 9_999,
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
              command: "echo TIMEOUT_BOUNDARY",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo TIMEOUT_BOUNDARY" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622450500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 6, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/late",
        afterMs: 20_000,
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-after-timeout",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_LATE_ITEM,
              command: "echo LATE_AFTER_TIMEOUT",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo LATE_AFTER_TIMEOUT" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622470500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("bounds interrupt settlement and drops late completion events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptTimeoutTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-timeout"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.filter(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ).length === 1,
          "running command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.filter(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ).length === 2,
          "post-interrupt running command item",
        );

        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "timeout terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        const terminalProviderTurnsBeforeLateEvents = harness.events.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
        );
        assert.lengthOf(terminalProviderTurnsBeforeLateEvents, 1);

        const commandUpdatesBeforeLateEvents = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "turn_item.updated" }
          > => event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        const terminalCommands = commandUpdatesBeforeLateEvents.filter(
          (event) =>
            event.turnItem.status === "interrupted" &&
            event.turnItem.nativeItemRef?.nativeId !== INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
        );
        assert.lengthOf(terminalCommands, 2);
        const boundaryUpdates = commandUpdatesBeforeLateEvents.filter(
          (event) => event.turnItem.nativeItemRef?.nativeId === INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
        );
        const lastBoundaryUpdate = boundaryUpdates.at(-1);
        assert.isDefined(lastBoundaryUpdate);
        assert.equal(lastBoundaryUpdate.turnItem.status, "interrupted");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* TestClock.adjust("20 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
          ),
          terminalProviderTurnsBeforeLateEvents.length,
          "late completion must not duplicate provider-turn finalization",
        );
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
          commandUpdatesBeforeLateEvents.length,
          "late starts and completions must not project after timeout",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const interruptTerminationFailureTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-termination-failure",
    entries: [
      ...interruptMidCommandTranscript.entries
        .filter(
          (entry) => entry.type === "runtime_exit" || entry.label !== "item/completed/command-late",
        )
        .map((entry) =>
          entry.type === "emit_inbound" &&
          entry.label === "thread/backgroundTerminals/list/after-false"
            ? {
                ...entry,
                frame: {
                  id: 6,
                  result: {
                    data: [{ processId: "57680" }],
                    nextCursor: null,
                  },
                },
              }
            : entry,
        ),
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: {
          id: 8,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: { id: 8, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          result: { data: [{ processId: "57680" }], nextCursor: null },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("attempts every terminal and cleans up tracking when termination fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptTerminationFailureTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-termination-failure"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ),
          "running command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptExit = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          })
          .pipe(Effect.exit);

        assert.equal(interruptExit._tag, "Failure");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    {
      name: "usage",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    { name: "rate", code: "rateLimitExceeded", notification: false, expectedClass: "usage_limit" },
    {
      name: "ordinary",
      code: "contextWindowExceeded",
      notification: false,
      expectedClass: "provider_error",
    },
    {
      name: "notification",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "usage_limit",
    },
    {
      name: "replacement",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "provider_error",
    },
    {
      name: "known-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "late-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "matching-details",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "usage_limit",
    },
    {
      name: "deferred-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    { name: "retry", code: "usageLimitExceeded", notification: true, expectedClass: "usage_limit" },
  ] as const)("classifies Codex terminal failures from $name evidence", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = `native-limit-${scenario.name}`;
        const nativeTurnId = `turn-limit-${scenario.name}`;
        const message = "Provider stopped this request.";
        const resetAt = "2033-05-19T07:20:00.000Z";
        const snapshot = {
          type: "emit_inbound" as const,
          label: "account/rateLimits/updated",
          frame: {
            method: "account/rateLimits/updated",
            params: {
              rateLimits: {
                limitId: "codex",
                primary: { usedPercent: 100, resetsAt: 2000100000, windowDurationMins: 300 },
              },
            },
          },
        };
        const transcript = makeCodexReplayTranscript({
          scenario: `codex-limit-${scenario.name}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
            ...(scenario.name === "known-reset" || scenario.name === "deferred-reset"
              ? [snapshot]
              : []),
            ...(scenario.name === "deferred-reset"
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: "item/completed/subAgentActivity-started",
                    frame: {
                      method: "item/completed",
                      params: {
                        threadId: nativeThreadId,
                        turnId: nativeTurnId,
                        item: {
                          type: "subAgentActivity",
                          id: "limit-child-spawn",
                          kind: "started",
                          agentThreadId: "native-limit-child",
                          agentPath: "/root/limit_child",
                        },
                      },
                    },
                  },
                  {
                    type: "emit_inbound" as const,
                    label: "turn/started/child",
                    frame: {
                      method: "turn/started",
                      params: {
                        threadId: "native-limit-child",
                        turn: makeCodexReplayTurn({
                          id: "limit-child-turn",
                          status: "inProgress",
                        }),
                      },
                    },
                  },
                ]
              : []),
            ...(scenario.notification
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: "error",
                    frame: {
                      method: "error",
                      params: {
                        threadId: nativeThreadId,
                        turnId: nativeTurnId,
                        willRetry: scenario.name === "retry",
                        error: {
                          message,
                          codexErrorInfo: scenario.code,
                          additionalDetails:
                            scenario.name === "matching-details"
                              ? "Detailed provider allowance explanation."
                              : null,
                        },
                      },
                    },
                  },
                ]
              : []),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                    error: {
                      message: scenario.name === "replacement" ? "A different failure." : message,
                      ...(scenario.notification && scenario.name !== "matching-details"
                        ? {}
                        : { codexErrorInfo: scenario.code }),
                    },
                  },
                },
              },
            },
            ...(scenario.name === "late-reset" ? [snapshot] : []),
            ...(scenario.name === "deferred-reset"
              ? [
                  {
                    ...snapshot,
                    frame: {
                      method: "account/rateLimits/updated",
                      params: {
                        rateLimits: {
                          limitId: "codex",
                          primary: {
                            usedPercent: 100,
                            resetsAt: 2000200000,
                            windowDurationMins: 300,
                          },
                        },
                      },
                    },
                  },
                  {
                    type: "emit_inbound" as const,
                    label: "turn/completed/child",
                    frame: {
                      method: "turn/completed",
                      params: {
                        threadId: "native-limit-child",
                        turn: makeCodexReplayTurn({
                          id: "limit-child-turn",
                          status: "completed",
                        }),
                      },
                    },
                  },
                ]
              : []),
          ],
        });
        const resetReceipt = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.failure.resetAt === resetAt
            ? Deferred.succeed(resetReceipt, undefined)
            : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            text: "Continue.",
            attemptId: RunAttemptId.make(`attempt-limit-${scenario.name}`),
          }),
        );
        yield* harness.firstTerminal;
        const terminal = harness.terminalEvents()[0];
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.equal(terminal.failure.class, scenario.expectedClass);
        assert.equal(terminal.threadDisposition, "reusable");
        if (scenario.name === "known-reset" || scenario.name === "deferred-reset")
          assert.equal(terminal.failure.resetAt, resetAt);
        if (scenario.name === "matching-details")
          assert.equal(terminal.failure.message, "Detailed provider allowance explanation.");
        if (scenario.name === "late-reset") {
          yield* Deferred.await(resetReceipt);
          const item = harness.events.find(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "error" &&
              event.turnItem.failure.resetAt === resetAt,
          );
          assert.isDefined(item);
        }
        if (scenario.name === "retry") assert.equal(terminal.retry?.attempt, 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const FAILED_SCENARIO = "codex-failed-mid-command";
  const FAILED_NATIVE_THREAD = "native-codex-failed-thread";
  const FAILED_NATIVE_TURN = "native-codex-failed-turn";
  const FAILED_COMMAND_ITEM = "exec-codex-failed-command";
  const FAILED_COMMAND = "sleep 30";
  const FAILED_PROMPT = "Run a command that will be abandoned when the turn fails.";

  const failedMidCommandTranscript = makeCodexReplayTranscript({
    scenario: FAILED_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: FAILED_NATIVE_THREAD,
        nativeTurnId: FAILED_NATIVE_TURN,
        prompt: FAILED_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "commandExecution",
              id: FAILED_COMMAND_ITEM,
              command: FAILED_COMMAND,
              cwd: "/workspace",
              processId: "99",
              source: "unifiedExecStartup",
              status: "inProgress",
              commandActions: [{ type: "unknown", command: FAILED_COMMAND }],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
            threadId: FAILED_NATIVE_THREAD,
            turnId: FAILED_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: FAILED_NATIVE_THREAD,
            turn: {
              ...makeCodexReplayTurn({
                id: FAILED_NATIVE_TURN,
                status: "failed",
              }),
              error: { message: "provider failed mid-command" },
            },
          },
        },
      },
    ],
  });

  it.effect("terminalizes running command items before turn.terminal on failed turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(failedMidCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-failed-mid-command"),
            text: FAILED_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        const failedCommandIndex = harness.events.findIndex(
          (event, index) =>
            index < terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "failed",
        );
        assert.isAtLeast(failedCommandIndex, 0);
        assert.isAbove(
          terminalIndex,
          failedCommandIndex,
          "failed-turn command terminalization must precede turn.terminal",
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const MCP_APP_SCENARIO = "codex-mcp-app-capture";
  const MCP_APP_NATIVE_THREAD = "native-codex-mcp-app-thread";
  const MCP_APP_NATIVE_TURN = "native-codex-mcp-app-turn";
  const MCP_APP_ITEM = "mcp-weather-call";
  const MCP_APP_PROMPT = "Show the weather in Oslo.";
  const MCP_APP_RESOURCE = "ui://weather/dashboard";
  const MCP_APP_HTML = "<!doctype html><html><body><p>Weather</p><script>1</script></body></html>";
  const mcpAppToolItem = (status: "inProgress" | "completed") => ({
    type: "mcpToolCall",
    id: MCP_APP_ITEM,
    server: "weather",
    tool: "get_weather",
    status,
    arguments: { city: "Oslo" },
    mcpAppResourceUri: MCP_APP_RESOURCE,
    ...(status === "completed"
      ? { result: { content: [{ type: "text", text: "Sunny" }], structuredContent: { temp: 21 } } }
      : {}),
  });

  const mcpAppTranscript = makeCodexReplayTranscript({
    scenario: MCP_APP_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: MCP_APP_NATIVE_THREAD,
        nativeTurnId: MCP_APP_NATIVE_TURN,
        prompt: MCP_APP_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/app-tool",
        frame: {
          method: "item/started",
          params: {
            item: mcpAppToolItem("inProgress"),
            threadId: MCP_APP_NATIVE_THREAD,
            turnId: MCP_APP_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/app-tool",
        frame: {
          method: "item/completed",
          params: {
            item: mcpAppToolItem("completed"),
            threadId: MCP_APP_NATIVE_THREAD,
            turnId: MCP_APP_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: MCP_APP_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: MCP_APP_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "mcpServer/resource/read",
        frame: {
          id: 4,
          method: "mcpServer/resource/read",
          params: { threadId: MCP_APP_NATIVE_THREAD, server: "weather", uri: MCP_APP_RESOURCE },
        },
      },
      {
        type: "emit_inbound",
        label: "mcpServer/resource/read",
        frame: {
          id: 4,
          result: {
            contents: [
              {
                uri: MCP_APP_RESOURCE,
                mimeType: "text/html;profile=mcp-app",
                text: MCP_APP_HTML,
                _meta: { ui: { csp: { connectDomains: ["https://api.weather.test"] } } },
              },
            ],
          },
        },
      },
    ],
  });

  it.effect("captures an MCP app's resource and holds the turn open until it lands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const appCaptured = yield* Deferred.make<OrchestrationV2TurnItem>();
        const harness = yield* makeCodexReplayHarness(mcpAppTranscript, (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed"
            ? Deferred.succeed(appCaptured, event.turnItem)
            : Effect.void,
        );
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-mcp-app"),
            text: MCP_APP_PROMPT,
          }),
        );
        const item = yield* Deferred.await(appCaptured);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");

        // The completed tool row is emitted once, with the app, never as a bare row first.
        const completedRows = harness.events.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.status === "completed",
        );
        assert.lengthOf(completedRows, 1);

        assert.equal(item.type, "dynamic_tool");
        const output = item.type === "dynamic_tool" ? (item.output as Record<string, unknown>) : {};
        const reference = readMcpAppReference(output[MCP_APP_OUTPUT_KEY]);
        assert.deepEqual(
          { ...reference, attachmentId: undefined },
          {
            attachmentId: undefined,
            server: "weather",
            tool: "get_weather",
            resourceUri: MCP_APP_RESOURCE,
            csp: { connectDomains: ["https://api.weather.test"] },
          },
        );
        assert.deepEqual(output.result, {
          content: [{ type: "text", text: "Sunny" }],
          structuredContent: { temp: 21 },
        });

        const fileSystem = yield* FileSystem.FileSystem;
        const stored = yield* fileSystem.readFileString(
          resolveAttachmentPathById({
            attachmentsDir: harness.serverConfig.attachmentsDir,
            attachmentId: reference!.attachmentId,
          })!,
        );
        // Stored with the app's declared policy ahead of its scripts.
        assert.include(stored, "connect-src https://api.weather.test");
        assert.isBelow(stored.indexOf("Content-Security-Policy"), stored.indexOf("<script>"));
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  // The turn fails while the app's resource read is still outstanding (Codex
  // never answers it), so the capture must be cancelled and its tool row
  // settled before the terminal event closes ingestion.
  const failedMcpAppTranscript = makeCodexReplayTranscript({
    scenario: "codex-mcp-app-capture-failed-turn",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: MCP_APP_NATIVE_THREAD,
        nativeTurnId: MCP_APP_NATIVE_TURN,
        prompt: MCP_APP_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/app-tool",
        frame: {
          method: "item/completed",
          params: {
            item: mcpAppToolItem("completed"),
            threadId: MCP_APP_NATIVE_THREAD,
            turnId: MCP_APP_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "mcpServer/resource/read",
        frame: {
          id: 4,
          method: "mcpServer/resource/read",
          params: { threadId: MCP_APP_NATIVE_THREAD, server: "weather", uri: MCP_APP_RESOURCE },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: MCP_APP_NATIVE_THREAD,
            turn: {
              ...makeCodexReplayTurn({ id: MCP_APP_NATIVE_TURN, status: "failed" }),
              error: { message: "provider failed mid-capture" },
            },
          },
        },
      },
    ],
  });

  it.effect("settles a pending MCP app capture before a failed turn's terminal event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(failedMcpAppTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-mcp-app-failed"),
            text: MCP_APP_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        const rows = harness.events.flatMap((event, index) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed"
            ? [{ index, turnItem: event.turnItem }]
            : [],
        );
        // Settled once, as a plain tool row, ahead of the terminal event.
        assert.lengthOf(rows, 1);
        assert.isBelow(rows[0]!.index, terminalIndex);
        const output = rows[0]!.turnItem.type === "dynamic_tool" ? rows[0]!.turnItem.output : null;
        assert.isUndefined((output as Record<string, unknown> | null)?.[MCP_APP_OUTPUT_KEY]);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const ORPHAN_WAIT_SCENARIO = "codex-orphaned-dynamic-tool";
  const ORPHAN_WAIT_NATIVE_THREAD = "native-codex-orphan-wait-thread";
  const ORPHAN_WAIT_NATIVE_TURN = "native-codex-orphan-wait-turn";
  const ORPHAN_WAIT_ITEM = "exec-4669f3bb-78c9-4af1-b44e-daa340d2c538";
  const PERSISTENT_MONITOR_ITEM = "exec-persistent-monitor";
  const COMPLETED_WAIT_ITEM = "exec-completed-wait";
  const ORPHAN_WAIT_PROMPT = "Wait on two nested tasks, then finish.";

  const orphanedDynamicToolTranscript = makeCodexReplayTranscript({
    scenario: ORPHAN_WAIT_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: ORPHAN_WAIT_NATIVE_THREAD,
        nativeTurnId: ORPHAN_WAIT_NATIVE_TURN,
        prompt: ORPHAN_WAIT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/completed-wait",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "mcpToolCall",
              id: COMPLETED_WAIT_ITEM,
              server: "stark-code",
              tool: "stark_thread_wait",
              status: "inProgress",
              arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/completed-wait",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "mcpToolCall",
              id: COMPLETED_WAIT_ITEM,
              server: "stark-code",
              tool: "stark_thread_wait",
              status: "completed",
              arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
              result: { content: [{ type: "text", text: "idle" }] },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/orphan-wait",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "mcpToolCall",
              id: ORPHAN_WAIT_ITEM,
              server: "stark-code",
              tool: "stark_thread_wait",
              status: "inProgress",
              arguments: {
                threadId:
                  "thread:delegated-task:command%3Amcp%3Aaafffab1-e811-458a-ae83-558e542c61ff%3Adelegate-task%3Areview-mobile-reconnect-opus-20260815",
                timeoutMs: 30000,
              },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            startedAtMs: 1782622442500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/persistent-monitor",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "dynamicToolCall",
              id: PERSISTENT_MONITOR_ITEM,
              namespace: "grok",
              tool: "monitor",
              status: "inProgress",
              arguments: { persistent: true, command: "tail -f" },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            startedAtMs: 1782622443500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: ORPHAN_WAIT_NATIVE_TURN,
              status: "completed",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/persistent-monitor",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "dynamicToolCall",
              id: PERSISTENT_MONITOR_ITEM,
              namespace: "grok",
              tool: "monitor",
              status: "completed",
              arguments: { persistent: true, command: "tail -f" },
              result: { content: [{ type: "text", text: "stopped" }] },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            completedAtMs: 1782622473500,
          },
        },
      },
    ],
  });

  it.effect(
    "terminalizes leftover nonpersistent dynamic tools when a completed turn never closes them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const monitorCompleted = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(orphanedDynamicToolTranscript, (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nativeItemRef?.nativeId === PERSISTENT_MONITOR_ITEM &&
            event.turnItem.status === "completed"
              ? Deferred.succeed(monitorCompleted, undefined)
              : Effect.void,
          );
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-orphan-wait"),
              text: ORPHAN_WAIT_PROMPT,
            }),
          );
          yield* harness.firstTerminal;
          assert.equal(harness.terminalEvents()[0]?.status, "completed");

          const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
          const cancelledWait = harness.events.find(
            (event, index) =>
              index < terminalIndex &&
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === ORPHAN_WAIT_ITEM &&
              event.turnItem.status === "cancelled",
          );
          assert.isDefined(cancelledWait);
          assert.isAbove(
            terminalIndex,
            harness.events.indexOf(cancelledWait!),
            "orphaned wait terminalization must precede turn.terminal",
          );

          const completedWaitStatuses = new Set(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === COMPLETED_WAIT_ITEM
                ? [event.turnItem.status]
                : [],
            ),
          );
          assert.isTrue(
            completedWaitStatuses.has("completed"),
            "the wait that received item/completed must stay completed",
          );
          assert.isFalse(
            completedWaitStatuses.has("cancelled"),
            "a completed wait must not be rewritten as cancelled",
          );

          const persistentMonitorStatuses = new Set(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === PERSISTENT_MONITOR_ITEM
                ? [event.turnItem.status]
                : [],
            ),
          );
          assert.isTrue(persistentMonitorStatuses.has("running"));
          assert.isFalse(
            persistentMonitorStatuses.has("cancelled"),
            "persistent monitors must remain running after the root turn completes",
          );
          assert.isTrue(
            yield* harness.hasPendingBackgroundWork,
            "persistent dynamic tools must keep the session residency pin until they complete",
          );

          yield* TestClock.adjust("30 seconds");
          yield* Deferred.await(monitorCompleted);
          const lateMonitorUpdateIndex = harness.events.findIndex(
            (event, index) =>
              index > terminalIndex &&
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === PERSISTENT_MONITOR_ITEM &&
              event.turnItem.status === "completed",
          );
          assert.isAbove(
            lateMonitorUpdateIndex,
            terminalIndex,
            "persistent tool completion must follow turn.terminal",
          );
          assert.lengthOf(harness.terminalEvents(), 1);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  const RESUME_SCENARIO = "codex-resume-subagent";
  const RESUME_NATIVE_THREAD = "native-codex-resume-thread";
  const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";
  const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";
  const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";
  const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";
  const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

  const childAgentMessage = (input: {
    readonly id: string;
    readonly text: string;
    readonly turnId: string;
    readonly completedAtMs: number;
    readonly afterMs?: number;
    readonly omitPhase?: boolean;
  }): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `item/completed/${input.id}`,
    ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
    frame: {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: input.id,
          text: input.text,
          ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
          memoryCitation: null,
        },
        threadId: RESUME_CHILD_THREAD,
        turnId: input.turnId,
        completedAtMs: input.completedAtMs,
      },
    },
  });

  const childTurnStarted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/started/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/started",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: {
          ...makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
          startedAt: turnId === RESUME_CHILD_TURN_2 ? 1782622470 : 1782622440,
        },
      },
    },
  });

  const childTurnCompleted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/completed/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/completed",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
      },
    },
  });

  const resumeSubagentTranscript = makeCodexReplayTranscript({
    scenario: RESUME_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: RESUME_NATIVE_THREAD,
        nativeTurnId: RESUME_NATIVE_TURN,
        prompt: RESUME_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/subAgentActivity-started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "call-codex-resume-spawn",
              kind: "started",
              agentThreadId: RESUME_CHILD_THREAD,
              agentPath: "/root/resume_agent",
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_1),
      childAgentMessage({
        id: "child-first-answer",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442000,
      }),
      childAgentMessage({
        id: "child-first-answer-empty",
        text: "",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442001,
        omitPhase: true,
      }),
      childAgentMessage({
        id: "child-first-answer-duplicate",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442002,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_1, 100),
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-resume",
              text: "NUDGED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622443000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/root",
        frame: {
          method: "turn/completed",
          params: {
            threadId: RESUME_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
      childAgentMessage({
        id: "child-resume-answer",
        text: "CODEX_RESUME_DONE",
        turnId: RESUME_CHILD_TURN_2,
        completedAtMs: 1782622480000,
        afterMs: 30_000,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_2),
    ],
  });

  it.effect.each([
    { name: "current Codex Sol", model: "gpt-6-sol" },
    { name: "current Codex wrong child", model: null },
    { name: "Sol", model: "gpt-5.6-sol" },
    { name: "Fable", model: "gpt-5.6-fable" },
    { name: "Astra", model: "gpt-6-astra" },
    { name: "missing", model: null },
    { name: "invalid", model: null },
    { name: "wrong child", model: null },
  ])("reads $name child metadata without using the parent model", ({ name, model }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const metadataRead = yield* Deferred.make<void>();
        const modelReported = yield* Deferred.make<void>();
        let metadataRequests = 0;
        const harness = yield* makeCodexReplayHarness(
          resumeSubagentTranscript,
          (event) =>
            event.type === "subagent.updated" && event.subagent.model === model
              ? Deferred.succeed(modelReported, undefined)
              : Effect.void,
          undefined,
          (threadId) => {
            metadataRequests++;
            assert.equal(threadId, RESUME_CHILD_THREAD);
            return Deferred.succeed(metadataRead, undefined).pipe(
              Effect.as(
                name === "invalid"
                  ? {}
                  : {
                      thread: {
                        id: name.includes("wrong child") ? "other-child" : threadId,
                        ...(name.startsWith("current Codex")
                          ? { model: "gpt-6-sol", reasoningEffort: "high" }
                          : {}),
                      },
                      model: name.startsWith("current Codex")
                        ? null
                        : name === "wrong child"
                          ? "gpt-5.6-sol"
                          : model,
                      reasoningEffort: "high",
                      serviceTier: "priority",
                    },
              ),
            );
          },
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-child-model"),
            text: RESUME_PROMPT,
          }),
        );
        yield* Deferred.await(metadataRead);
        yield* Deferred.await(modelReported);
        yield* TestClock.adjust("100 millis");
        yield* harness.firstTerminal;
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
        if (model) {
          assert.deepEqual(harness.subagentUpdates().at(-1)?.subagent.modelSelection?.options, [
            { id: "reasoningEffort", value: "high" },
            ...(name.startsWith("current Codex") ? [] : [{ id: "serviceTier", value: "priority" }]),
          ]);
        }
        assert.equal(metadataRequests, name === "current Codex Sol" ? 1 : 2);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each(["failed", "malformed", "wrong child", "blank model"] as const)(
    "resumes child metadata after a %s read",
    (readResult) =>
      Effect.scoped(
        Effect.gen(function* () {
          const modelReported = yield* Deferred.make<void>();
          const model = "gpt-6-sol";
          const metadataRequests: Array<string> = [];
          const harness = yield* makeCodexReplayHarness(
            resumeSubagentTranscript,
            (event) =>
              event.type === "subagent.updated" && event.subagent.model === model
                ? Deferred.succeed(modelReported, undefined)
                : Effect.void,
            undefined,
            (threadId, method) => {
              assert.equal(threadId, RESUME_CHILD_THREAD);
              metadataRequests.push(method);
              if (method === "thread/resume") {
                return Effect.succeed({ thread: { id: threadId }, model });
              }
              switch (readResult) {
                case "failed":
                  return Effect.fail(
                    new CodexError.CodexAppServerRequestError({
                      code: -32000,
                      errorMessage: "Child metadata unavailable",
                      method,
                    }),
                  );
                case "malformed":
                  return Effect.succeed({});
                case "wrong child":
                  return Effect.succeed({ thread: { id: "other-child", model: "gpt-6-astra" } });
                case "blank model":
                  return Effect.succeed({ thread: { id: threadId, model: " \t " } });
              }
            },
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-child-model-fallback"),
              text: RESUME_PROMPT,
            }),
          );
          yield* Deferred.await(modelReported);
          yield* TestClock.adjust("100 millis");
          yield* harness.firstTerminal;
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
          assert.deepEqual(metadataRequests, ["thread/read", "thread/resume"]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.each(["thread/settings/updated", "model/rerouted"] as const)(
    "keeps %s child metadata when an older lookup finishes later",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseMetadata = yield* Deferred.make<void>();
          const observed = yield* Deferred.make<void>();
          const model = "gpt-5.6-sol";
          const notification: CodexReplay.CodexAppServerReplayEntry = {
            type: "emit_inbound",
            frame: {
              method,
              params:
                method === "model/rerouted"
                  ? {
                      threadId: RESUME_CHILD_THREAD,
                      turnId: RESUME_CHILD_TURN_1,
                      fromModel: "gpt-6-astra",
                      toModel: model,
                      reason: "highRiskCyberActivity",
                    }
                  : {
                      threadId: RESUME_CHILD_THREAD,
                      threadSettings: {
                        model,
                        effort: "low",
                        serviceTier: "ultrafast",
                        modelProvider: "openai",
                        cwd: "/workspace",
                        approvalPolicy: "never",
                        approvalsReviewer: "auto_review",
                        collaborationMode: { mode: "default", settings: { model } },
                        sandboxPolicy: { type: "dangerFullAccess" },
                      },
                    },
            },
          };
          const initialSettings: CodexReplay.CodexAppServerReplayEntry = {
            type: "emit_inbound",
            frame: {
              method: "thread/settings/updated",
              params: {
                threadId: RESUME_CHILD_THREAD,
                threadSettings: {
                  model: "gpt-6-astra",
                  effort: "low",
                  serviceTier: "ultrafast",
                  modelProvider: "openai",
                  cwd: "/workspace",
                  approvalPolicy: "never",
                  approvalsReviewer: "auto_review",
                  collaborationMode: { mode: "default", settings: { model: "gpt-6-astra" } },
                  sandboxPolicy: { type: "dangerFullAccess" },
                },
              },
            },
          };
          const harness = yield* makeCodexReplayHarness(
            {
              ...resumeSubagentTranscript,
              entries: resumeSubagentTranscript.entries.flatMap((entry) =>
                entry.type === "emit_inbound" && entry.label === "turn/completed/root"
                  ? [entry, initialSettings, notification]
                  : [entry],
              ),
            },
            (event) =>
              event.type === "subagent.updated" && event.subagent.model === model
                ? Deferred.succeed(observed, undefined)
                : Effect.void,
            undefined,
            (threadId) =>
              Deferred.await(releaseMetadata).pipe(
                Effect.as({ thread: { id: threadId }, model: "gpt-6-astra" }),
              ),
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-child-model-update"),
              text: RESUME_PROMPT,
            }),
          );
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(observed);
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "completed");
          yield* Deferred.succeed(releaseMetadata, undefined);
          yield* TestClock.adjust("30 seconds");
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
          assert.deepEqual(harness.subagentUpdates().at(-1)?.subagent.modelSelection?.options, [
            { id: "reasoningEffort", value: "low" },
            { id: "serviceTier", value: "ultrafast" },
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("preserves a subagent result across a trailing empty final and resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(resumeSubagentTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-resume"),
            text: RESUME_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.subagentUpdates().some((event) => event.subagent.result === "CODEX_FIRST_DONE"),
          "first subagent result",
        );
        assert.lengthOf(
          harness.subagentUpdates().filter((event) => event.subagent.result === "CODEX_FIRST_DONE"),
          1,
        );
        yield* TestClock.adjust("100 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        const settledUpdates = harness.subagentUpdates();
        const firstCompletion = settledUpdates[settledUpdates.length - 1];
        assert.equal(firstCompletion?.subagent.status, "completed");
        assert.equal(firstCompletion?.subagent.result, "CODEX_FIRST_DONE");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        const settledUpdateCount = settledUpdates.length;

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(
          () => harness.subagentUpdates().length > settledUpdateCount,
          "subagent re-open",
        );
        const reopened = harness.subagentUpdates()[settledUpdateCount];
        assert.equal(reopened?.subagent.status, "running");
        assert.equal(DateTime.toEpochMillis(reopened!.subagent.startedAt!), 1782622470000);
        assert.isNull(reopened!.subagent.completedAt);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(() => {
          const updates = harness.subagentUpdates();
          const latest = updates[updates.length - 1];
          return (
            latest !== undefined &&
            latest.subagent.status === "completed" &&
            latest.subagent.result === "CODEX_RESUME_DONE"
          );
        }, "resumed subagent completion");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("rejects duplicate child starts across parent runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstDone = yield* Deferred.make<void>();
        const resumed = yield* Deferred.make<void>();
        const secondTurn = "native-parent-resume-turn";
        const secondPrompt = "Resume the child.";
        const entries = [...resumeSubagentTranscript.entries];
        const resumeIndex = entries.findIndex(
          (e) => e.type === "emit_inbound" && e.label === `turn/started/${RESUME_CHILD_TURN_2}`,
        );
        const suffix = entries.splice(resumeIndex);
        for (const entry of codexReplayPreamble({
          nativeThreadId: RESUME_NATIVE_THREAD,
          nativeTurnId: secondTurn,
          prompt: secondPrompt,
        }).slice(-3)) {
          entries.push(
            entry.type === "expect_outbound" || entry.type === "emit_inbound"
              ? {
                  ...entry,
                  frame:
                    Predicate.isObject(entry.frame) && "id" in entry.frame
                      ? { ...entry.frame, id: 4 }
                      : entry.frame,
                }
              : entry,
          );
        }
        entries.push(childTurnStarted(RESUME_CHILD_TURN_1));
        entries.push(...suffix);
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-cross-run-resume",
            entries,
          }),
          (event) =>
            event.type === "turn.terminal"
              ? Deferred.succeed(firstDone, undefined)
              : event.type === "subagent.updated" && event.subagent.runId === "run-cross-run-second"
                ? Deferred.succeed(resumed, undefined)
                : Effect.void,
        );
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("cross-run-first"),
            text: RESUME_PROMPT,
          }),
        );
        yield* TestClock.adjust("100 millis");
        yield* Deferred.await(firstDone);
        yield* harness.runtime.startTurn({
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("cross-run-second"),
            text: secondPrompt,
          }),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
        });
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(resumed);
        const row = harness
          .subagentUpdates()
          .find((e) => e.subagent.runId === "run-cross-run-second")?.subagent;
        assert.equal(row?.status, "running");
        assert.equal(row?.parentNodeId, "node-cross-run-second");
        assert.isNull(row?.completedAt);
        assert.isNotNull(row?.startedAt);
        assert.equal(DateTime.toEpochMillis(row!.startedAt!), 1782622470000);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    ["pendingInit", "pending"],
    ["running", "running"],
    ["interrupted", "interrupted"],
    ["shutdown", "cancelled"],
    ["notFound", "failed"],
    ["errored", "failed"],
    ["completed", "completed"],
    ["activity-completed", "completed"],
    ["late-activity-completed", "completed"],
    ["stale-running", "completed"],
    ["duplicate-completed", "completed"],
  ] as const)(
    "normalizes subagent %s without losing its lifecycle",
    ([nativeStatus, expectedStatus]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* Deferred.make<void>();
          const firstCompletion = yield* Deferred.make<void>();
          const stateEntry = (
            status: string,
            id: string,
          ): Extract<CodexReplay.CodexAppServerReplayEntry, { type: "emit_inbound" }> => ({
            type: "emit_inbound",
            label: id,
            frame: {
              method: "item/completed",
              params: {
                threadId: RESUME_NATIVE_THREAD,
                turnId: RESUME_NATIVE_TURN,
                item: {
                  type: "collabAgentToolCall",
                  id,
                  tool: "listAgents",
                  status: "completed",
                  senderThreadId: RESUME_NATIVE_THREAD,
                  receiverThreadIds: [RESUME_CHILD_THREAD],
                  agentsStates: { [RESUME_CHILD_THREAD]: { status, message: null } },
                },
              },
            },
          });
          const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
            ...codexReplayPreamble({
              nativeThreadId: RESUME_NATIVE_THREAD,
              nativeTurnId: RESUME_NATIVE_TURN,
              prompt: RESUME_PROMPT,
            }),
            resumeSubagentTranscript.entries.find(
              (e) =>
                e.type === "emit_inbound" && e.label === "item/completed/subAgentActivity-started",
            )!,
          ];
          if (nativeStatus === "late-activity-completed") {
            entries.push(
              resumeSubagentTranscript.entries.find(
                (e) => e.type === "emit_inbound" && e.label === "turn/completed/root",
              )!,
            );
          }
          if (nativeStatus === "activity-completed" || nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "activity-done",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "subAgentActivity",
                    id: "activity-done",
                    kind: "completed",
                    agentThreadId: RESUME_CHILD_THREAD,
                    agentPath: "/root/resume_agent",
                  },
                },
              },
            });
          } else if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            entries.push(stateEntry("completed", "child-completed"), {
              ...stateEntry(
                nativeStatus === "stale-running" ? "running" : "completed",
                "trailing-snapshot",
              ),
              afterMs: 100,
            });
          } else {
            entries.push(stateEntry(nativeStatus, "status-update"));
          }
          // A known child's turn provides a receipt even after the parent context is released.
          if (nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "late-marker",
              frame: {
                method: "turn/started",
                params: {
                  threadId: RESUME_CHILD_THREAD,
                  turn: makeCodexReplayTurn({ id: RESUME_CHILD_TURN_1, status: "inProgress" }),
                },
              },
            });
          } else {
            entries.push({
              type: "emit_inbound",
              label: "marker",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "agentMessage",
                    id: "marker",
                    text: "LIFECYCLE_MARKER",
                    phase: "final_answer",
                    memoryCitation: null,
                  },
                },
              },
            });
          }
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({ scenario: `subagent-${nativeStatus}`, entries }),
            (event) =>
              (event.type === "message.updated" && event.message.text === "LIFECYCLE_MARKER") ||
              (nativeStatus === "late-activity-completed" &&
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === RESUME_CHILD_TURN_1)
                ? Deferred.succeed(marker, undefined)
                : event.type === "subagent.updated" && event.subagent.status === "completed"
                  ? Deferred.succeed(firstCompletion, undefined)
                  : Effect.void,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`subagent-${nativeStatus}`),
              text: RESUME_PROMPT,
            }),
          );
          if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            yield* Deferred.await(firstCompletion);
            yield* TestClock.adjust("100 millis");
          }
          yield* Deferred.await(marker);
          const latest = harness.subagentUpdates().at(-1)!.subagent;
          assert.equal(latest.status, expectedStatus);
          if (nativeStatus === "duplicate-completed") {
            const first = harness.subagentUpdates().find((e) => e.subagent.status === "completed")!;
            assert.equal(
              DateTime.toEpochMillis(latest.completedAt!),
              DateTime.toEpochMillis(first.subagent.completedAt!),
            );
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  const codexReplayThreadResult = (input: {
    readonly nativeThreadId: string;
    readonly forkedFromId: string | null;
  }) => ({
    thread: {
      id: input.nativeThreadId,
      sessionId: input.nativeThreadId,
      forkedFromId: input.forkedFromId,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1782622440,
      updatedAt: 1782622440,
      status: { type: "idle" },
      path: `/tmp/${input.nativeThreadId}.jsonl`,
      cwd: "/workspace",
      cliVersion: "0.144.0",
      source: "vscode",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/workspace",
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    reasoningEffort: "medium",
  });

  const errorCauseChainText = (error: unknown): string =>
    error instanceof Error ? `${error.message} ${errorCauseChainText(error.cause)}` : String(error);

  const codexReplaySourceTurn = (input: {
    readonly id: string;
    readonly ordinal: number;
    readonly nativeId: string | null;
    readonly providerThreadId: ProviderThreadId;
    readonly now: DateTime.Utc;
  }): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(input.id),
    providerThreadId: input.providerThreadId,
    nodeId: NodeId.make(`node-${input.id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
    nativeTurnRef:
      input.nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : {
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeId: input.nativeId,
            strength: "strong",
          },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: input.now,
    completedAt: input.now,
  });

  it.effect("fails honestly when rolling back a legacy Codex thread", () =>
    Effect.gen(function* () {
      const nativeThreadId = "legacy-rollback-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "legacy-rollback-turn",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-legacy-rollback",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/read",
            frame: {
              id: 3,
              method: "thread/read",
              params: { threadId: nativeThreadId, includeTurns: false },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/read",
            frame: {
              id: 3,
              result: { thread: { id: nativeThreadId, historyMode: "legacy" } },
            },
          },
        ],
      });
      const outbound: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            outbound.push(method);
          }),
      );
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });
      const secondTurn = codexReplaySourceTurn({
        id: "provider-turn-second",
        ordinal: 2,
        nativeId: "native-turn-second",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const error = yield* Effect.flip(
        harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-legacy-rollback"),
            appRunOrdinal: 1,
            providerTurn: firstTurn,
          },
          providerThreadTurns: [firstTurn, secondTurn],
        }),
      );

      assert.instanceOf(error, ProviderAdapter.ProviderAdapterRollbackThreadError);
      assert.include(
        errorCauseChainText(error),
        "legacy",
        "legacy rollback must surface an honest unsupported-history failure",
      );
      assert.notInclude(
        outbound,
        "thread/rollback",
        "thread/rollback must not be sent to a legacy Codex thread",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect(
    "falls back to fork-local thread/revert on paginated history when the source turn lacks a native reference",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "fallback-source-thread";
        const forkThreadId = "fallback-fork-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "fallback-source-turn",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-fork-paginated-fallback",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 3,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/read",
              frame: {
                id: 4,
                method: "thread/read",
                params: { threadId: forkThreadId, includeTurns: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/read",
              frame: {
                id: 4,
                result: { thread: { id: forkThreadId, historyMode: "paginated" } },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                method: "thread/turns/list",
                params: {
                  threadId: forkThreadId,
                  cursor: null,
                  limit: 1,
                  sortDirection: "desc",
                  itemsView: "summary",
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                result: {
                  data: [{ id: "native-turn-second", items: [], status: "completed", error: null }],
                  nextCursor: null,
                },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/revert",
              frame: {
                id: 6,
                method: "thread/revert",
                params: { threadId: forkThreadId, beforeTurnId: "native-turn-second" },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/revert",
              frame: {
                id: 6,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: null,
                }),
              },
            },
          ],
        });
        const outbound: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              outbound.push(method);
            }),
        );
        const now = yield* DateTime.now;
        const firstTurn = codexReplaySourceTurn({
          id: "provider-turn-first",
          ordinal: 1,
          nativeId: null,
          providerThreadId: harness.providerThread.id,
          now,
        });
        const secondTurn = codexReplaySourceTurn({
          id: "provider-turn-second",
          ordinal: 2,
          nativeId: "native-turn-second",
          providerThreadId: harness.providerThread.id,
          now,
        });

        const forkedProviderThread = yield* harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          sourceProviderTurns: [firstTurn, secondTurn],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make("thread-fork-paginated-fallback-target"),
        });

        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, forkThreadId);
        assert.notEqual(forkedProviderThread.id, harness.providerThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, firstTurn.id);
        assert.deepEqual(outbound.slice(-2), ["thread/turns/list", "thread/revert"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect(
    "fails honestly when a legacy fork cannot honor a source turn without a native reference",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "legacy-fallback-source-thread";
        const forkThreadId = "legacy-fallback-fork-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "legacy-fallback-source-turn",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-fork-legacy-fallback",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 3,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/read",
              frame: {
                id: 4,
                method: "thread/read",
                params: { threadId: forkThreadId, includeTurns: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/read",
              frame: {
                id: 4,
                result: { thread: { id: forkThreadId, historyMode: "legacy" } },
              },
            },
          ],
        });
        const outbound: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              outbound.push(method);
            }),
        );
        const now = yield* DateTime.now;
        const firstTurn = codexReplaySourceTurn({
          id: "provider-turn-first",
          ordinal: 1,
          nativeId: null,
          providerThreadId: harness.providerThread.id,
          now,
        });
        const secondTurn = codexReplaySourceTurn({
          id: "provider-turn-second",
          ordinal: 2,
          nativeId: "native-turn-second",
          providerThreadId: harness.providerThread.id,
          now,
        });

        const error = yield* Effect.flip(
          harness.runtime.forkThread({
            sourceProviderThread: harness.providerThread,
            sourceProviderTurns: [firstTurn, secondTurn],
            providerTurnId: firstTurn.id,
            targetThreadId: ThreadId.make("thread-fork-legacy-fallback-target"),
          }),
        );

        assert.instanceOf(error, ProviderAdapter.ProviderAdapterForkThreadError);
        assert.include(
          errorCauseChainText(error),
          "legacy",
          "the missing-native-reference fallback must name the legacy limitation",
        );
        assert.notInclude(
          outbound,
          "thread/rollback",
          "thread/rollback must not be sent to a legacy Codex fork",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("propagates native thread/fork failures as typed fork errors", () =>
    Effect.gen(function* () {
      const nativeThreadId = "fork-failure-source-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "fork-failure-source-turn",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-fork-request-failure",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/fork",
            frame: {
              id: 3,
              method: "thread/fork",
              params: {
                threadId: nativeThreadId,
                lastTurnId: "native-turn-first",
                config: CodexAdapterV2.CODEX_THREAD_CONFIG,
              },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/fork",
            frame: { id: 3, error: { code: -32000, message: "fork exploded" } },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const error = yield* Effect.flip(
        harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          sourceProviderTurns: [firstTurn],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make("thread-fork-failure-target"),
        }),
      );

      assert.instanceOf(error, ProviderAdapter.ProviderAdapterForkThreadError);
      assert.include(errorCauseChainText(error), "fork exploded");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  describe("permissions", () => {
    const testLayer = Layer.mergeAll(
      IdAllocator.layer,
      McpProviderSessions.layer,
      NodeServices.layer,
    );
    const turnCompleted = (
      nativeThreadId: string,
      nativeTurnId: string,
      status: "completed" | "interrupted" = "completed",
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: nativeThreadId,
          turn: makeCodexReplayTurn({ id: nativeTurnId, status }),
        },
      },
    });
    const turnInputFor = (
      harness: {
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
      },
      attempt: string,
      text: string,
      runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = CODEX_TEST_RUNTIME_POLICY,
    ) =>
      DateTime.now.pipe(
        Effect.map((now) => ({
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(attempt),
            text,
          }),
          runtimePolicy,
        })),
      );
    const inheritPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      ...CODEX_TEST_RUNTIME_POLICY,
      permissionSource: "inherit",
    });
    const supervisedPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      ...CODEX_TEST_RUNTIME_POLICY,
      runtimeMode: "approval-required",
    });
    const approvalRequest = (
      nativeThreadId: string,
      nativeTurnId: string,
      params: Record<string, unknown>,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: "approval",
      frame: {
        id: 100,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: nativeThreadId,
          turnId: nativeTurnId,
          itemId: "item-approval",
          startedAtMs: 1,
          ...params,
        },
      },
    });
    const resolvedRequest = (nativeThreadId: string): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: "resolved",
      frame: {
        method: "serverRequest/resolved",
        params: { threadId: nativeThreadId, requestId: 100 },
      },
    });
    const providerClosedRequests = (
      events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    ) =>
      events.flatMap((event) =>
        event.type === "runtime_request.updated" && event.closedByProvider === true
          ? [[event.runtimeRequest.id, event.runtimeRequest.status]]
          : [],
      );

    it.effect("offers only the decisions Codex lists and sends the listed rule", () =>
      Effect.gen(function* () {
        const nativeThreadId = "listed-decisions";
        const nativeTurnId = "listed-decisions-turn";
        const prompt = "Run the tests.";
        const listedRule = {
          acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] },
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "listed-decisions",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            approvalRequest(nativeThreadId, nativeTurnId, {
              command: "npm test -- --run",
              proposedExecpolicyAmendment: ["npm", "test"],
              availableDecisions: ["accept", listedRule, "cancel"],
            }),
            {
              type: "expect_outbound",
              label: "approval-response",
              frame: { id: 100, result: { decision: listedRule } },
            },
            turnCompleted(nativeThreadId, nativeTurnId),
          ],
        });
        const cardShown = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
            ? Deferred.succeed(cardShown, undefined)
            : Effect.void,
        );
        yield* harness.runtime.startTurn(yield* turnInputFor(harness, "listed-decisions", prompt));
        yield* Deferred.await(cardShown);
        const [card] = approvalItems(harness.events);
        if (card?.type !== "approval_request") return yield* Effect.die("Missing approval card");
        assert.deepEqual(
          card.options?.map((option) => [option.optionId, option.decision, option.label]),
          [
            ["once:0", "accept", "Allow once"],
            ["persistent:0", "acceptAlways", "Always allow (Codex, every project)"],
            ["deny-stop:0", "cancel", "Deny and stop"],
          ],
        );
        for (const unlisted of ["acceptForSession", "decline"] as const) {
          const refused = yield* Effect.flip(
            harness.runtime.respondToRuntimeRequest({
              requestId: card.requestId,
              decision: unlisted,
            }),
          );
          assert.equal(refused._tag, "ProviderAdapterRuntimeRequestResponseError");
        }
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: card.requestId,
          optionId: "persistent:0",
        });
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect.each(["closed-first", "answered-first"] as const)(
      "settles an approval Codex resolves itself exactly once when %s",
      (race) =>
        Effect.gen(function* () {
          const nativeThreadId = `resolved-${race}`;
          const nativeTurnId = `resolved-${race}-turn`;
          const prompt = "Run a command.";
          const transcript = makeCodexReplayTranscript({
            scenario: `resolved-${race}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
              approvalRequest(nativeThreadId, nativeTurnId, {
                command: "make build",
                availableDecisions: ["accept", "decline", "cancel"],
              }),
              // Closed first, Codex no longer waits and no answer may follow.
              ...(race === "answered-first"
                ? [
                    {
                      type: "expect_outbound" as const,
                      label: "approval-response",
                      frame: { id: 100, result: { decision: "accept" } },
                    },
                  ]
                : []),
              resolvedRequest(nativeThreadId),
              turnCompleted(nativeThreadId, nativeTurnId),
              // The next frame Stark sends: a stray answer before it fails the replay.
              {
                type: "expect_outbound",
                label: "thread/unsubscribe",
                frame: {
                  id: 4,
                  method: "thread/unsubscribe",
                  params: { threadId: nativeThreadId },
                },
              },
              {
                type: "emit_inbound",
                label: "thread/unsubscribe",
                frame: { id: 4, result: { status: "unsubscribed" } },
              },
            ],
          });
          const cardShown = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(
            transcript,
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
                ? Deferred.succeed(cardShown, undefined)
                : Effect.void,
            undefined,
            undefined,
            (entry) => (entry.label === "resolved" ? Deferred.await(cardShown) : Effect.void),
          );
          yield* harness.runtime.startTurn(
            yield* turnInputFor(harness, `resolved-${race}`, prompt),
          );
          yield* Deferred.await(cardShown);
          const [card] = approvalItems(harness.events);
          if (card?.type !== "approval_request") return yield* Effect.die("Missing approval card");
          if (race === "answered-first") {
            yield* harness.runtime.respondToRuntimeRequest({
              requestId: card.requestId,
              decision: "accept",
            });
          }
          yield* harness.firstTerminal;
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          if (race === "closed-first") {
            // The orchestrator decides what a provider close means; the
            // adapter only reports it, with the request as it was.
            assert.deepEqual(providerClosedRequests(harness.events), [[card.requestId, "pending"]]);
            const late = yield* Effect.flip(
              harness.runtime.respondToRuntimeRequest({
                requestId: card.requestId,
                decision: "accept",
              }),
            );
            assert.equal(
              late._tag === "ProviderAdapterRuntimeRequestResponseError" && late.nothingWaiting,
              true,
            );
          } else {
            assert.deepEqual(providerClosedRequests(harness.events), []);
          }
          yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
        }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("reports an answer delivered only once Codex's transport took it", () =>
      Effect.gen(function* () {
        const nativeThreadId = "answer-transport";
        const nativeTurnId = "answer-transport-turn";
        const prompt = "Run a command.";
        const transcript = makeCodexReplayTranscript({
          scenario: "answer-transport",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            approvalRequest(nativeThreadId, nativeTurnId, {
              command: "make build",
              availableDecisions: ["accept", "decline"],
            }),
            {
              type: "emit_inbound",
              label: "gate",
              frame: { method: "stark/test/gate", params: {} },
            },
            { type: "runtime_exit", status: "error" },
          ],
        });
        const cardShown = yield* Deferred.make<void>();
        const answerChosen = yield* Deferred.make<void>();
        const transportEnds = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(
          transcript,
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
              ? Deferred.succeed(cardShown, undefined)
              : Effect.void,
          undefined,
          undefined,
          (entry) => (entry.label === "gate" ? Deferred.await(transportEnds) : Effect.void),
          // Hold the approval handler after it chose the answer and before
          // its result goes to the transport.
          (client) => ({
            ...client,
            handleServerRequest: (method, handler) =>
              client.handleServerRequest(method, (payload, context) =>
                handler(payload, context).pipe(
                  Effect.tap(() =>
                    Deferred.succeed(answerChosen, undefined).pipe(Effect.andThen(Effect.never)),
                  ),
                ),
              ),
          }),
        );
        yield* harness.runtime.startTurn(yield* turnInputFor(harness, "answer-transport", prompt));
        yield* Deferred.await(cardShown);
        const [card] = approvalItems(harness.events);
        if (card?.type !== "approval_request") return yield* Effect.die("Missing approval card");
        const answer = yield* harness.runtime
          .respondToRuntimeRequest({ requestId: card.requestId, optionId: "once:0" })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(answerChosen);
        // The Codex process ends before the answer was written.
        yield* Deferred.succeed(transportEnds, undefined);
        const exit = yield* Fiber.join(answer);
        assert.isTrue(Exit.isFailure(exit), "an answer that never left Stark is not delivered");
        const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
        assert.isTrue(Option.isSome(error));
        if (Option.isSome(error)) {
          assert.equal(error.value._tag, "ProviderAdapterRuntimeRequestResponseError");
          // Not proven undelivered either: the delivery is uncertain.
          assert.notEqual(
            error.value._tag === "ProviderAdapterRuntimeRequestResponseError"
              ? error.value.nothingWaiting
              : undefined,
            true,
          );
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("puts what an approval would allow on its card, not in its prompt", () =>
      Effect.gen(function* () {
        const nativeThreadId = "approval-scope";
        const nativeTurnId = "approval-scope-turn";
        const prompt = "Install the dependencies.";
        const transcript = makeCodexReplayTranscript({
          scenario: "approval-scope",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            approvalRequest(nativeThreadId, nativeTurnId, {
              command: "npm install",
              reason: "Needs the registry",
              networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
              additionalPermissions: {
                fileSystem: { read: null, write: ["/workspace/node_modules"] },
                network: { enabled: true },
              },
              availableDecisions: ["accept", "decline"],
            }),
            {
              type: "expect_outbound",
              label: "approval-response",
              frame: { id: 100, result: { decision: "decline" } },
            },
            turnCompleted(nativeThreadId, nativeTurnId),
          ],
        });
        const cardShown = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
            ? Deferred.succeed(cardShown, undefined)
            : Effect.void,
        );
        yield* harness.runtime.startTurn(yield* turnInputFor(harness, "approval-scope", prompt));
        yield* Deferred.await(cardShown);
        const [card] = approvalItems(harness.events);
        if (card?.type !== "approval_request") return yield* Effect.die("Missing approval card");
        assert.equal(card.prompt, "Needs the registry");
        assert.equal(card.command, "npm install");
        assert.deepEqual(card.network, { host: "registry.npmjs.org", protocol: "https" });
        assert.deepEqual(card.requestedPermissions, {
          writePaths: ["/workspace/node_modules"],
          network: true,
        });
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: card.requestId,
          optionId: "deny:0",
        });
        yield* harness.firstTerminal;
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("reports the settings Codex runs the session with, and answers nothing stale", () =>
      Effect.gen(function* () {
        const nativeThreadId = "active-settings";
        const nativeTurnId = "active-settings-turn";
        const prompt = "Hello.";
        const transcript = makeCodexReplayTranscript({
          scenario: "active-settings",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            turnCompleted(nativeThreadId, nativeTurnId),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* turnInputFor(harness, "active-settings", prompt));
        yield* harness.firstTerminal;
        const reported = harness.events.flatMap((event) =>
          event.type === "provider_session.updated" ? [event.providerSession] : [],
        );
        assert.equal(reported[0]?.id, harness.runtime.providerSessionId);
        const { reportedAt, ...active } = reported[0]?.activePermissions ?? {};
        assert.isString(reportedAt);
        // As the preamble's thread/start response reports them.
        assert.deepEqual(active, {
          nativeMode: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          reportedBy: "thread-start",
        });
        const stale = yield* Effect.flip(
          harness.runtime.respondToRuntimeRequest({
            requestId: RuntimeRequestId.make("runtime-request:unknown"),
            decision: "accept",
          }),
        );
        assert.equal(
          stale._tag === "ProviderAdapterRuntimeRequestResponseError" && stale.nothingWaiting,
          true,
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("applies other permissions only after Codex drops this session's grants", () =>
      Effect.gen(function* () {
        const nativeThreadId = "session-grants";
        const nativeTurnId = "session-grants-turn";
        const prompt = "Build it.";
        const requests: Array<string> = [];
        const transcript = makeCodexReplayTranscript({
          scenario: "session-grants",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            approvalRequest(nativeThreadId, nativeTurnId, {
              command: "make build",
              availableDecisions: ["accept", "acceptForSession", "decline"],
            }),
            {
              type: "expect_outbound",
              label: "approval-response",
              frame: { id: 100, result: { decision: "acceptForSession" } },
            },
            turnCompleted(nativeThreadId, nativeTurnId),
          ],
        });
        const cardShown = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(
          transcript,
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
              ? Deferred.succeed(cardShown, undefined)
              : Effect.void,
          (method) => Effect.sync(() => requests.push(method)),
        );
        yield* harness.runtime.startTurn(yield* turnInputFor(harness, "session-grants-1", prompt));
        yield* Deferred.await(cardShown);
        const [card] = approvalItems(harness.events);
        if (card?.type !== "approval_request") return yield* Effect.die("Missing approval card");
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: card.requestId,
          decision: "acceptForSession",
        });
        yield* harness.firstTerminal;
        // Narrowed to Supervised, the granted session approval would still let
        // `make build` run without asking.
        const refused = yield* Effect.flip(
          harness.runtime.startTurn(
            yield* turnInputFor(harness, "session-grants-2", "Again.", supervisedPolicy),
          ),
        );
        assert.include(String(refused.cause), "Restart the chat's Codex session");
        assert.equal(requests.filter((method) => method === "turn/start").length, 1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("refuses Codex's own settings while a Stark override is still loaded", () =>
      Effect.gen(function* () {
        const nativeThreadId = "inherit-loaded";
        const nativeTurnId = "inherit-loaded-turn";
        const prompt = "First turn under Stark's preset.";
        const requests: Array<string> = [];
        const transcript = makeCodexReplayTranscript({
          scenario: "inherit-loaded",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            turnCompleted(nativeThreadId, nativeTurnId),
          ],
        });
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) => Effect.sync(() => requests.push(method)),
        );
        yield* harness.runtime.startTurn(yield* turnInputFor(harness, "inherit-loaded-1", prompt));
        yield* harness.firstTerminal;
        const refused = yield* Effect.flip(
          harness.runtime.startTurn(
            yield* turnInputFor(
              harness,
              "inherit-loaded-2",
              "Now use Codex's settings.",
              inheritPolicy,
            ),
          ),
        );
        assert.equal(refused._tag, "ProviderAdapterTurnStartError");
        assert.include(String(refused.cause), "Restart the chat's Codex session");
        assert.equal(requests.filter((method) => method === "turn/start").length, 1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect.each(["cleared", "sticky"] as const)(
      "switches a reloaded chat to Codex's settings only when the reload shows the override gone (%s)",
      (reload) =>
        Effect.gen(function* () {
          const nativeThreadId = `inherit-reload-${reload}`;
          const nativeTurnId = `inherit-reload-${reload}-turn`;
          const prompt = "First turn under Stark's preset.";
          const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
          const reloadedSettings =
            reload === "cleared"
              ? {
                  approvalPolicy: "on-request",
                  approvalsReviewer: "user",
                  sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
                  activePermissionProfile: { id: ":workspace", extends: null },
                }
              : {
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandbox: { type: "dangerFullAccess" },
                  activePermissionProfile: null,
                };
          const transcript = makeCodexReplayTranscript({
            scenario: `inherit-reload-${reload}`,
            entries: [
              ...preamble,
              turnCompleted(nativeThreadId, nativeTurnId),
              {
                type: "expect_outbound",
                label: "thread/unsubscribe",
                frame: {
                  id: 4,
                  method: "thread/unsubscribe",
                  params: { threadId: nativeThreadId },
                },
              },
              {
                type: "emit_inbound",
                label: "thread/unsubscribe",
                frame: { id: 4, result: { status: "unsubscribed" } },
              },
              {
                type: "expect_outbound",
                label: "thread/resume",
                frame: {
                  id: 5,
                  method: "thread/resume",
                  params: {
                    threadId: nativeThreadId,
                    excludeTurns: true,
                    cwd: "/workspace",
                    config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "thread/resume",
                frame: {
                  id: 5,
                  result: {
                    thread: { id: nativeThreadId, updatedAt: 1782622460 },
                    ...reloadedSettings,
                  },
                },
              },
              {
                type: "expect_outbound",
                label: "config/read",
                frame: {
                  id: 6,
                  method: "config/read",
                  params: { includeLayers: false, cwd: "/workspace" },
                },
              },
              {
                type: "emit_inbound",
                label: "config/read",
                frame: { id: 6, result: { config: { approvals_reviewer: "user" }, origins: {} } },
              },
              ...(reload === "cleared"
                ? [
                    {
                      type: "expect_outbound" as const,
                      label: "turn/start inherited",
                      frame: {
                        id: 7,
                        method: "turn/start",
                        params: {
                          threadId: nativeThreadId,
                          input: [{ type: "text", text: "Now use Codex's settings." }],
                          cwd: "/workspace",
                          model: "gpt-5.4",
                          summary: "detailed",
                        },
                      },
                    },
                    {
                      type: "emit_inbound" as const,
                      label: "turn/start inherited",
                      frame: {
                        id: 7,
                        result: {
                          turn: makeCodexReplayTurn({ id: "inherited-turn", status: "inProgress" }),
                        },
                      },
                    },
                  ]
                : []),
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(
            yield* turnInputFor(harness, `reload-${reload}-1`, prompt),
          );
          yield* harness.firstTerminal;
          yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
          const resumed = yield* harness.runtime.resumeThread({
            providerThread: harness.providerThread,
            runtimePolicy: inheritPolicy,
          });
          const second = harness.runtime.startTurn({
            ...(yield* turnInputFor(
              harness,
              `reload-${reload}-2`,
              "Now use Codex's settings.",
              inheritPolicy,
            )),
            providerThread: resumed,
          });
          if (reload === "cleared") {
            yield* second;
          } else {
            const refused = yield* Effect.flip(second);
            assert.include(String(refused.cause), "still reports the permissions Stark set");
          }
        }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("asks with the granular policy once Codex rejects untrusted", () =>
      Effect.gen(function* () {
        const nativeThreadId = "untrusted-rejected";
        const nativeTurnId = "untrusted-rejected-turn";
        const prompt = "Look around.";
        const preamble = withSupervisedReplayPolicy(
          makeCodexReplayTranscript({
            scenario: "untrusted-rejected",
            entries: codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          }),
        ).entries;
        const supervisedTurnStart = preamble[5];
        if (
          supervisedTurnStart?.type !== "expect_outbound" ||
          !Predicate.isObject(supervisedTurnStart.frame)
        )
          return yield* Effect.die("Missing turn/start entry");
        const granularTurnStart = {
          ...supervisedTurnStart,
          frame: {
            ...supervisedTurnStart.frame,
            id: 4,
            params: {
              ...(Predicate.isObject(supervisedTurnStart.frame.params)
                ? supervisedTurnStart.frame.params
                : {}),
              approvalPolicy: {
                granular: {
                  sandbox_approval: true,
                  rules: true,
                  skill_approval: true,
                  request_permissions: true,
                  mcp_elicitations: true,
                },
              },
            },
          },
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "untrusted-rejected",
          entries: [
            ...preamble.slice(0, 6),
            {
              type: "emit_inbound",
              label: "turn/start rejected",
              frame: {
                id: 3,
                error: {
                  code: -32600,
                  message:
                    "Invalid request: unknown variant `untrusted`, expected `on-request` or `never`",
                },
              },
            },
            granularTurnStart,
            ...preamble.slice(6, 7).map((entry) => withReplayRequestId(entry, 4)),
            ...preamble.slice(7),
            turnCompleted(nativeThreadId, nativeTurnId),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          yield* turnInputFor(harness, "untrusted-rejected", prompt, supervisedPolicy),
        );
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        // The chat says so, not only the server log.
        const notices = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(notices, 1);
        assert.include(
          JSON.stringify(notices[0]),
          "Codex doesn't accept the untrusted approval policy here; running with read-only granular approvals instead.",
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("stops the running turn before a permission change applies now", () =>
      Effect.gen(function* () {
        const nativeThreadId = "apply-now";
        const nativeTurnId = "apply-now-turn";
        const prompt = "Keep working.";
        const transcript = makeCodexReplayTranscript({
          scenario: "apply-now",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            {
              type: "expect_outbound",
              label: "turn/interrupt",
              frame: {
                id: 4,
                method: "turn/interrupt",
                params: { threadId: nativeThreadId, turnId: nativeTurnId },
              },
            },
            { type: "emit_inbound", label: "turn/interrupt", frame: { id: 4, result: {} } },
            turnCompleted(nativeThreadId, nativeTurnId, "interrupted"),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* turnInputFor(harness, "apply-now", prompt));
        const seam = harness.runtime;
        if (seam.applyRuntimePolicy === undefined)
          return yield* Effect.die("Missing applyRuntimePolicy");
        assert.equal(
          yield* seam.applyRuntimePolicy({
            providerThread: harness.providerThread,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
            timing: "now",
          }),
          "unchanged",
        );
        assert.equal(
          yield* seam.applyRuntimePolicy({
            providerThread: harness.providerThread,
            runtimePolicy: supervisedPolicy,
            timing: "now",
          }),
          "stopped",
        );
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("stops a running turn before unsubscribing from its thread", () =>
      Effect.gen(function* () {
        const nativeThreadId = "unload-running";
        const nativeTurnId = "unload-running-turn";
        const prompt = "Keep working.";
        const requests: Array<string> = [];
        const transcript = makeCodexReplayTranscript({
          scenario: "unload-running",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            {
              type: "expect_outbound",
              label: "turn/interrupt",
              frame: {
                id: 4,
                method: "turn/interrupt",
                params: { threadId: nativeThreadId, turnId: nativeTurnId },
              },
            },
            { type: "emit_inbound", label: "turn/interrupt", frame: { id: 4, result: {} } },
            turnCompleted(nativeThreadId, nativeTurnId, "interrupted"),
            {
              type: "expect_outbound",
              label: "thread/unsubscribe",
              frame: { id: 5, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
            },
            {
              type: "emit_inbound",
              label: "thread/unsubscribe",
              frame: { id: 5, result: { status: "unsubscribed" } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) => Effect.sync(() => requests.push(method)),
        );
        yield* harness.runtime.startTurn(yield* turnInputFor(harness, "unload-running", prompt));
        yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
        assert.deepEqual(requests.slice(-2), ["turn/interrupt", "thread/unsubscribe"]);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("shows what Codex's own reviewer decided", () =>
      Effect.gen(function* () {
        const nativeThreadId = "auto-review";
        const nativeTurnId = "auto-review-turn";
        const prompt = "Clean up.";
        const action = {
          type: "command",
          source: "shell",
          command: "rm -rf build",
          cwd: "/workspace",
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "auto-review",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            {
              type: "emit_inbound",
              label: "review started",
              frame: {
                method: "item/autoApprovalReview/started",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1,
                  reviewId: "review-1",
                  targetItemId: "item-rm",
                  review: {
                    status: "inProgress",
                    riskLevel: null,
                    userAuthorization: null,
                    rationale: null,
                  },
                  action,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "review completed",
              frame: {
                method: "item/autoApprovalReview/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1,
                  completedAtMs: 2,
                  reviewId: "review-1",
                  targetItemId: "item-rm",
                  decisionSource: "agent",
                  review: {
                    status: "denied",
                    riskLevel: "high",
                    userAuthorization: null,
                    rationale: "Deletes build output the user did not ask to remove.",
                  },
                  action,
                },
              },
            },
            turnCompleted(nativeThreadId, nativeTurnId),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* turnInputFor(harness, "auto-review", prompt));
        yield* harness.firstTerminal;
        const notices = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [[event.turnItem.id, event.turnItem.status, event.turnItem.message] as const]
            : [],
        );
        assert.lengthOf(notices, 2);
        assert.equal(notices[0]?.[0], notices[1]?.[0]);
        assert.deepEqual(notices[1]?.slice(1), [
          "completed",
          "Codex auto-review denied rm -rf build (high risk). Deletes build output the user did not ask to remove.",
        ]);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    it.effect("ties an MCP tool approval to its own call and never to a neighbour", () =>
      Effect.gen(function* () {
        const nativeThreadId = "mcp-approval-target";
        const nativeTurnId = "mcp-approval-target-turn";
        const prompt = "File the issue.";
        const toolCall = (id: string, args: unknown, status: string) => ({
          type: "mcpToolCall",
          id,
          server: "github",
          tool: "create_issue",
          arguments: args,
          status,
        });
        const itemEvent = (method: "item/started" | "item/completed", item: unknown) =>
          ({
            type: "emit_inbound",
            label: method,
            frame: {
              method,
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                ...(method === "item/started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
                item,
              },
            },
          }) satisfies CodexReplay.CodexAppServerReplayEntry;
        const transcript = makeCodexReplayTranscript({
          scenario: "mcp-approval-target",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            {
              type: "emit_inbound",
              label: "elicitation",
              frame: {
                id: 101,
                method: "mcpServer/elicitation/request",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  serverName: "github",
                  mode: "form",
                  message: 'Allow the github MCP server to run tool "create_issue"?',
                  _meta: {
                    codex_approval_kind: "mcp_tool_call",
                    persist: ["session", "always"],
                    tool_name: "create_issue",
                    tool_title: "Create issue",
                    tool_params: { title: "Bug" },
                  },
                  requestedSchema: { type: "object", properties: {} },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "elicitation-response",
              frame: { id: 101, result: { action: "accept", content: {} } },
            },
            // A neighbouring call with other arguments starts first.
            itemEvent("item/started", toolCall("call-other", { title: "Other" }, "inProgress")),
            itemEvent("item/started", toolCall("call-approved", { title: "Bug" }, "inProgress")),
            itemEvent("item/completed", toolCall("call-approved", { title: "Bug" }, "completed")),
            itemEvent("item/completed", toolCall("call-other", { title: "Other" }, "completed")),
            turnCompleted(nativeThreadId, nativeTurnId),
          ],
        });
        const cardShown = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
            ? Deferred.succeed(cardShown, undefined)
            : Effect.void,
        );
        yield* harness.runtime.startTurn(
          yield* turnInputFor(harness, "mcp-approval-target", prompt),
        );
        yield* Deferred.await(cardShown);
        const nodes = harness.events.flatMap((event) =>
          event.type === "node.updated" ? [event.node] : [],
        );
        const approvalNode = nodes.find((node) => node.kind === "approval_request");
        const targetNode = nodes.find((node) => node.id === approvalNode?.parentNodeId);
        assert.equal(targetNode?.kind, "tool_call");
        assert.equal(targetNode?.status, "waiting");
        const targetItem = harness.events.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nodeId === targetNode?.id,
        );
        if (targetItem?.type !== "turn_item.updated" || targetItem.turnItem.type !== "dynamic_tool")
          return yield* Effect.die("Missing the approval's own tool row");
        assert.deepEqual(targetItem.turnItem.input, { title: "Bug" });
        const [card] = approvalItems(harness.events);
        if (card?.type !== "approval_request") return yield* Effect.die("Missing approval card");
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: card.requestId,
          decision: "accept",
        });
        yield* harness.firstTerminal;
        const finalTools = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
              ? [[event.turnItem.id, event.turnItem] as const]
              : [],
          ),
        );
        // The approved call took over the approval's row; the neighbour has its own.
        assert.equal(finalTools.size, 2);
        assert.deepEqual(finalTools.get(targetItem.turnItem.id)?.input, { title: "Bug" });
        assert.equal(finalTools.get(targetItem.turnItem.id)?.status, "completed");
        assert.isTrue(
          [...finalTools.values()].some(
            (item) =>
              item.id !== targetItem.turnItem.id &&
              Predicate.isObject(item.input) &&
              item.input.title === "Other",
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  });

  describe("native goals", () => {
    const nativeThreadId = "goal-thread";
    const objective = "Ship the feature";
    const codexGoal = (status: string, tokensUsed: number) => ({
      threadId: nativeThreadId,
      objective,
      status,
      tokenBudget: null,
      tokensUsed,
      timeUsedSeconds: 3,
      createdAt: 1782622440,
      updatedAt: 1782622450,
    });
    const notification = (
      label: string,
      method: string,
      params: unknown,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label,
      frame: { method, params },
    });
    const request = (id: number, method: string, params: unknown, result: unknown) =>
      [
        { type: "expect_outbound", label: method, frame: { id, method, params } },
        { type: "emit_inbound", label: method, frame: { id, result } },
      ] satisfies Array<CodexReplay.CodexAppServerReplayEntry>;
    const withReplayRequestId = (
      entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
      id: number,
    ) =>
      entries.map((entry) =>
        "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
          ? { ...entry, frame: { ...entry.frame, id } }
          : entry,
      );
    const sessionStart = codexReplayPreamble({
      nativeThreadId,
      nativeTurnId: "unused",
      prompt: "unused",
    }).slice(0, 5);
    const goalTurnInput = (
      harness: {
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
      },
      text: string,
    ) =>
      DateTime.now.pipe(
        Effect.map((now) =>
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("goal-attempt"),
            text,
          }),
        ),
      );
    const providerGoals = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      events.flatMap((event) =>
        event.type === "provider_thread.updated" ? [event.providerThread.goal?.status ?? null] : [],
      );

    it("parses /goal like the Codex TUI", () => {
      assert.deepEqual(CodexAdapterV2.parseCodexGoalCommand("/goal"), { type: "show" });
      assert.deepEqual(CodexAdapterV2.parseCodexGoalCommand(" /goal Pause "), { type: "pause" });
      assert.deepEqual(CodexAdapterV2.parseCodexGoalCommand("/goal resume"), { type: "resume" });
      assert.deepEqual(CodexAdapterV2.parseCodexGoalCommand("/goal clear"), { type: "clear" });
      assert.deepEqual(CodexAdapterV2.parseCodexGoalCommand("/goal fix the\nflaky tests"), {
        type: "set",
        objective: "fix the\nflaky tests",
      });
      assert.isNull(CodexAdapterV2.parseCodexGoalCommand("/goals"));
      assert.isNull(CodexAdapterV2.parseCodexGoalCommand("set a /goal"));
    });

    it.effect("keeps a /goal run open across the turns Codex continues on its own", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation",
          entries: [
            ...sessionStart,
            ...request(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, objective, status: "paused" },
              { goal: codexGoal("paused", 0) },
            ),
            // The first goal turn carries this run's turn configuration.
            ...withReplayRequestId(
              codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "goal-turn-1",
                prompt: objective,
              }).slice(5),
              5,
            ),
            ...request(
              6,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "active" },
              { goal: codexGoal("active", 0) },
            ),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-1",
              goal: codexGoal("active", 0),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-1", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "inProgress" }),
            }),
            notification("goal complete", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-2",
              goal: codexGoal("complete", 1200),
            }),
            notification("continuation done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "completed" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, `/goal ${objective}`));
        yield* harness.firstTerminal;

        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const providerTurnId = (nativeTurnId: string) =>
          idAllocator.derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId,
          });
        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [[providerTurnId("goal-turn-2"), "completed"]],
        );
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running"
              ? [
                  [
                    event.providerTurn.id,
                    event.providerTurn.runAttemptId,
                    event.providerTurn.ordinal,
                  ],
                ]
              : [],
          ),
          [
            [providerTurnId("goal-turn-1"), RunAttemptId.make("goal-attempt"), 1],
            [providerTurnId("goal-turn-2"), RunAttemptId.make("goal-attempt"), 2],
          ],
        );
        assert.equal(providerGoals(harness.events).at(-1), "complete");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("stops a goal turn Codex continues under superseded permissions", () =>
      Effect.gen(function* () {
        const policyChanged = yield* Deferred.make<void>();
        const interruptSent = yield* Deferred.make<void>();
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-superseded-permissions",
          entries: [
            ...sessionStart,
            ...request(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, objective, status: "paused" },
              { goal: codexGoal("paused", 0) },
            ),
            ...withReplayRequestId(
              codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "goal-turn-1",
                prompt: objective,
              }).slice(5),
              5,
            ),
            ...request(
              6,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "active" },
              { goal: codexGoal("active", 0) },
            ),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-1",
              goal: codexGoal("active", 0),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-1", status: "completed" }),
            }),
            // Codex continues with the settings of the turn before.
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "inProgress" }),
            }),
            ...request(
              7,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 600) },
            ),
            ...request(
              8,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-2" },
              {},
            ),
          ],
        });
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            method === "turn/interrupt" ? Deferred.succeed(interruptSent, undefined) : Effect.void,
          undefined,
          (entry) =>
            entry.label === "first turn done" ? Deferred.await(policyChanged) : Effect.void,
        );
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, `/goal ${objective}`));
        const seam = harness.runtime;
        if (seam.applyRuntimePolicy === undefined)
          return yield* Effect.die("Missing applyRuntimePolicy");
        // Narrowed to apply after this run stops: the running turn may finish.
        assert.equal(
          yield* seam.applyRuntimePolicy({
            providerThread: harness.providerThread,
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              ...CODEX_TEST_RUNTIME_POLICY,
              runtimeMode: "approval-required",
            }),
            timing: "after-run",
          }),
          "after-run",
        );
        yield* Deferred.succeed(policyChanged, undefined);
        yield* harness.firstTerminal;
        yield* Deferred.await(interruptSent);

        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const providerTurnId = (nativeTurnId: string) =>
          idAllocator.derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId,
          });
        // The run ends with the turn that ran under the old settings; the
        // continuation never joins it.
        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [[providerTurnId("goal-turn-1"), "completed"]],
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.id === providerTurnId("goal-turn-2"),
          ),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("settles /goal pause with a reply instead of a native turn", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-pause",
          entries: [
            ...sessionStart,
            ...request(
              3,
              "thread/goal/get",
              { threadId: nativeThreadId },
              { goal: codexGoal("active", 10) },
            ),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, "/goal pause"));
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
        const turns = harness.events.flatMap((event) =>
          event.type === "provider_turn.updated" ? [event.providerTurn] : [],
        );
        assert.isTrue(turns.every((turn) => turn.nativeTurnRef === null));
        assert.include(
          harness.events.flatMap((event) =>
            event.type === "message.updated" && event.message.role === "assistant"
              ? [event.message.text]
              : [],
          ),
          "Goal paused. Send /goal resume to continue.",
        );
        assert.equal(providerGoals(harness.events).at(-1), "paused");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("settles a run held for the next goal turn when Stop arrives in between", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-between-turns",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            // Notifications run in order, so seeing this one proves the turn settled.
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
            notification("goal paused", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("paused", 10),
            }),
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-hold-attempt"),
            text: prompt,
          }),
        );
        const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeTurnId: "goal-turn",
        });
        const turnStatuses = () =>
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.id === providerTurnId
              ? [event.providerTurn.status]
              : [],
          );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the completed turn to be held",
        );
        // The held turn keeps reading as running, so Stop still reaches the adapter.
        assert.deepEqual(turnStatuses(), ["running"]);
        assert.lengthOf(harness.terminalEvents(), 0);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });
        yield* harness.firstTerminal;

        assert.notInclude(requests, "turn/interrupt");
        assert.deepEqual(turnStatuses(), ["running", "completed"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("moves a Stop that names an earlier goal turn to the turn Codex continued with", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-after-continuation",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn-a", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              goal: codexGoal("active", 10),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-a", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "inProgress" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-b",
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(
              5,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-b" },
              {},
            ),
            notification("continuation interrupted", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-successor-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the continuation to be adopted",
        );
        // The projection may still name the first turn when Stop is dispatched.
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn-a",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("stops a held goal run's background command when Stop arrives between turns", () =>
      Effect.gen(function* () {
        const prompt = "Start the server";
        const command = "node server.js";
        const commandItem = (status: "inProgress" | "completed") => ({
          type: "commandExecution",
          id: "goal-bg-command",
          command,
          cwd: "/workspace",
          processId: "4242",
          source: "unifiedExecStartup",
          status,
          commandActions: [{ type: "unknown", command }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-held-background",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("command started", "item/started", {
              item: commandItem("inProgress"),
              threadId: nativeThreadId,
              turnId: "goal-turn",
              startedAtMs: 1782622440500,
            }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(
              5,
              "thread/backgroundTerminals/terminate",
              { threadId: nativeThreadId, processId: "4242" },
              { terminated: true },
            ),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-held-background-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the completed turn to be held",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        // The settled-turn path terminates the process (the replay expects that
        // request) before it marks the command interrupted.
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "interrupted",
            ),
          "the background command to be interrupted",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("moves Stop to a continuation Codex starts while the goal pause is in flight", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-races-continuation",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn-a", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              goal: codexGoal("active", 10),
            }),
            {
              type: "expect_outbound",
              label: "thread/goal/set",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
              },
            },
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-a", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "inProgress" }),
            }),
            {
              type: "emit_inbound",
              label: "thread/goal/set",
              frame: { id: 4, result: { goal: codexGoal("paused", 11) } },
            },
            ...request(
              5,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-b" },
              {},
            ),
            notification("continuation interrupted", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-stop-race-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.status === "active",
            ),
          "the goal to be active",
        );
        // Stop names the first turn while it still runs.
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn-a",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("stops a subagent an earlier goal turn left running when Stop settles the run", () =>
      Effect.gen(function* () {
        const prompt = "Delegate the audit";
        const childThreadId = "goal-child-thread";
        const childTurnId = "goal-child-turn";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-held-subagent",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("subagent started", "item/completed", {
              item: {
                type: "subAgentActivity",
                id: "goal-subagent-call",
                kind: "started",
                agentThreadId: childThreadId,
                agentPath: "/root/audit",
              },
              threadId: nativeThreadId,
              turnId: "goal-turn",
              completedAtMs: 1782622441000,
            }),
            notification("child turn", "turn/started", {
              threadId: childThreadId,
              turn: makeCodexReplayTurn({ id: childTurnId, status: "inProgress" }),
            }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(5, "turn/interrupt", { threadId: childThreadId, turnId: childTurnId }, {}),
            notification("child interrupted", "turn/completed", {
              threadId: childThreadId,
              turn: makeCodexReplayTurn({ id: childTurnId, status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-held-subagent-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the completed turn to be held",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === childTurnId &&
                event.providerTurn.status === "interrupted",
            ),
          "the subagent turn to be interrupted",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("stops an earlier goal turn's subagent when the run settles during the pause", () =>
      Effect.gen(function* () {
        const prompt = "Delegate the audit";
        const childThreadId = "goal-race-child-thread";
        const childTurnId = "goal-race-child-turn";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-run-settles-during-pause",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn-a", prompt }),
            notification("subagent started", "item/completed", {
              item: {
                type: "subAgentActivity",
                id: "goal-race-subagent-call",
                kind: "started",
                agentThreadId: childThreadId,
                agentPath: "/root/audit",
              },
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              completedAtMs: 1782622441000,
            }),
            notification("child turn", "turn/started", {
              threadId: childThreadId,
              turn: makeCodexReplayTurn({ id: childTurnId, status: "inProgress" }),
            }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              goal: codexGoal("active", 10),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-a", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "inProgress" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-b",
              goal: codexGoal("active", 11),
            }),
            {
              type: "expect_outbound",
              label: "thread/goal/set",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
              },
            },
            notification("goal paused", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-b",
              goal: codexGoal("paused", 11),
            }),
            notification("continuation done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "completed" }),
            }),
            {
              type: "emit_inbound",
              label: "thread/goal/set",
              frame: { id: 4, result: { goal: codexGoal("paused", 11) } },
            },
            ...request(5, "turn/interrupt", { threadId: childThreadId, turnId: childTurnId }, {}),
            notification("child interrupted", "turn/completed", {
              threadId: childThreadId,
              turn: makeCodexReplayTurn({ id: childTurnId, status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-settles-during-pause-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the continuation to be adopted",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn-b",
          }),
          requestRuntimeRestart: true,
        });
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === childTurnId &&
                event.providerTurn.status === "interrupted",
            ),
          "the subagent turn to be interrupted",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

    it.effect("pauses an active goal before Stop interrupts its turn", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
            ...request(5, "turn/interrupt", { threadId: nativeThreadId, turnId: "goal-turn" }, {}),
            notification("interrupted", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "interrupted" }),
            }),
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-stop-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () => providerGoals(harness.events).includes("active"),
          "the active goal to reach the provider thread",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn",
          }),
        });
        yield* harness.firstTerminal;

        assert.deepEqual(requests.slice(-2), ["thread/goal/set", "turn/interrupt"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );
  });
});
