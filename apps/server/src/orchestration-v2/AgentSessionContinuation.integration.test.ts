import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  agentSessionImportThreadId,
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type ThreadId,
} from "@starkfuture/contracts";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@starkfuture/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@starkfuture/provider-testing/replayWorkspace";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeAgentSessionImportEvents } from "../project/AgentSessionImporter.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// The first message on a thread imported from Claude Code or Codex must resume
// that CLI session natively, without resending the imported transcript, and
// must fall back to a fresh session that receives the transcript once when the
// CLI no longer has the session.

const projectId = ProjectId.make("project:agent-session-continuation");
const claudeSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const codexSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const importedSessionId = "6f1c2f0e-3b7a-4c55-9d7e-1a2b3c4d5e6f";
const importedMarker = "The imported release marker is violet.";
const prompt = "What was the release marker?";
const settings = Schema.decodeSync(ClaudeSettings)({});

function promptText(message: SDKUserMessage): string {
  const content = message.message.content;
  return typeof content === "string"
    ? content
    : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Claude through the real adapter; only the SDK process is replaced. */
const makeClaudeSdk = Effect.gen(function* () {
  const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
  const offered: Array<SDKUserMessage> = [];
  const promptOffered = yield* Deferred.make<void>();
  const runner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape = {
    allocateSessionId: Effect.succeed("fresh-claude-session"),
    open: (input) =>
      Effect.sync(() => {
        opened.push(input);
        return {
          messages: Stream.never,
          offer: (message) =>
            Effect.sync(() => void offered.push(message)).pipe(
              Effect.andThen(Deferred.succeed(promptOffered, undefined)),
            ),
          setModel: () => Effect.void,
          setPermissionMode: () => Effect.void,
          stopTask: () => Effect.void,
          interrupt: Effect.void,
          close: Effect.void,
        };
      }),
    forkSession: () => Effect.die("unused forkSession"),
    subagentLaunchToolUseId: () => Effect.succeed(null),
    assertComplete: Effect.void,
  };
  return { runner, opened, offered, promptOffered };
});

interface CapturedCodexTurn {
  readonly text: string;
  readonly nativeThreadId: string | null;
}

/** Resumes eagerly like Codex `thread/resume`, which fails when the rollout is gone. */
const makeCodexLikeAdapter = (input: { readonly nativeHistoryExists: boolean }) =>
  Effect.gen(function* () {
    const turns: Array<CapturedCodexTurn> = [];
    const turnStarted = yield* Deferred.make<void>();
    const driver = ProviderDriverKind.make("codex");
    const fail = (detail: string) =>
      Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId: codexSelection.instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (sessionInput) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const providerSession: OrchestrationV2ProviderSession = {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId: codexSelection.instanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
            model: codexSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          };
          return {
            instanceId: codexSelection.instanceId,
            driver,
            providerSessionId: sessionInput.providerSessionId,
            providerSession,
            events: Stream.never,
            ensureThread: (threadInput) =>
              Effect.gen(function* () {
                const createdAt = yield* DateTime.now;
                return {
                  ...threadInput.existingProviderThread,
                  id:
                    threadInput.existingProviderThread?.id ??
                    ProviderThreadId.make(`provider-thread:codex:${threadInput.threadId}`),
                  driver,
                  providerInstanceId: codexSelection.instanceId,
                  providerSessionId: sessionInput.providerSessionId,
                  appThreadId: threadInput.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "fresh-codex-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: threadInput.existingProviderThread?.handoffIds ?? [],
                  forkedFrom: null,
                  createdAt,
                  updatedAt: createdAt,
                };
              }),
            resumeThread: ({ providerThread }) =>
              input.nativeHistoryExists
                ? Effect.succeed(providerThread)
                : fail("thread/resume: no rollout found for thread id"),
            startTurn: (turnInput) =>
              Effect.sync(
                () =>
                  void turns.push({
                    text: turnInput.message.text,
                    nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  }),
              ).pipe(Effect.andThen(Deferred.succeed(turnStarted, undefined))),
            steerTurn: () => Effect.void,
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => fail("unused readThreadSnapshot"),
            rollbackThread: () => fail("unused rollbackThread"),
            forkThread: () => fail("unused forkThread"),
          } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
        }),
    };
    return { adapter, turns, turnStarted };
  });

/** A Claude config dir that does or does not still hold the imported transcript. */
const makeClaudeHome = (input: { readonly transcriptExists: boolean }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "stark-claude-home-" });
    const projectFolder = path.join(home, "projects", "-workspace-project");
    yield* fileSystem.makeDirectory(projectFolder, { recursive: true });
    if (input.transcriptExists) {
      yield* fileSystem.writeFileString(
        path.join(projectFolder, `${importedSessionId}.jsonl`),
        "{}\n",
      );
    }
    return home;
  });

const makeClaudeAdapter = (input: {
  readonly runner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape;
  readonly claudeHome: string;
  readonly attachmentsDir: string;
}) =>
  Effect.gen(function* () {
    return yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: claudeSelection.instanceId,
      settings,
      environment: { CLAUDE_CONFIG_DIR: input.claudeHome },
      attachmentsDir: input.attachmentsDir,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: input.runner,
    });
  });

/** Writes the events the CLI importer writes for one session. */
const seedImportedThread = (source: "claudeAgent" | "codex") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const providerInstanceId = ProviderInstanceId.make(source);
    yield* sink.write({
      events: makeAgentSessionImportEvents({
        projectId,
        thread: {
          source,
          providerInstanceId,
          providerSessionId: importedSessionId,
          title: "Imported session",
          model: source === "codex" ? codexSelection.model : claudeSelection.model,
          createdAt: "2026-10-20T10:00:00.000Z",
          updatedAt: "2026-10-20T10:05:00.000Z",
          messages: [
            {
              role: "user",
              text: "Remember the release marker.",
              createdAt: "2026-10-20T10:00:00.000Z",
            },
            { role: "assistant", text: importedMarker, createdAt: "2026-10-20T10:05:00.000Z" },
          ],
        },
        providerThreadId: idAllocator.derive.providerThread({
          driver: ProviderDriverKind.make(source),
          nativeThreadId: importedSessionId,
        }),
      }),
    });
    return agentSessionImportThreadId({ providerInstanceId, providerSessionId: importedSessionId });
  });

const sendFirstMessage = (threadId: ThreadId, modelSelection?: ModelSelection) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("continue-imported-session"),
      threadId,
      messageId: MessageId.make("continue-imported-session"),
      text: prompt,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      ...(modelSelection === undefined ? {} : { modelSelection }),
    });
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  });

const runWith = <A, E>(
  name: string,
  adapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>,
  cwd: string,
  body: Effect.Effect<
    A,
    E,
    | Orchestrator.OrchestratorV2
    | EffectWorker.OrchestrationEffectWorkerV2
    | EventSink.EventSinkV2
    | IdAllocator.IdAllocatorV2
  >,
) =>
  body.pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name, runtimePolicyOverride: { cwd } },
        ProviderAdapterRegistry.layerFromAdapters(adapters),
        { runEffectWorker: false },
      ),
    ),
  );

const testServices = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

describe("continuing an imported Claude Code session", () => {
  it.effect("resumes the CLI session without resending its transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("agent-session-claude-resume");
        const sdk = yield* makeClaudeSdk;
        const claude = yield* makeClaudeAdapter({
          runner: sdk.runner,
          claudeHome: yield* makeClaudeHome({ transcriptExists: true }),
          attachmentsDir: cwd,
        });
        yield* runWith(
          "agent-session-claude-resume",
          [claude],
          cwd,
          Effect.gen(function* () {
            const threadId = yield* seedImportedThread("claudeAgent");
            yield* sendFirstMessage(threadId);
            yield* Deferred.await(sdk.promptOffered);

            assert.equal(sdk.opened.length, 1);
            assert.equal(sdk.opened[0]?.options.resume, importedSessionId);
            assert.isUndefined(sdk.opened[0]?.options.sessionId);
            assert.equal(promptText(sdk.offered[0]!), prompt);
            const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
              threadId,
            );
            assert.deepEqual(projection.contextHandoffs, []);
          }),
        );
      }).pipe(Effect.provide(testServices)),
    ),
  );

  it.effect("starts a fresh session with the transcript once when Claude lost the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("agent-session-claude-missing");
        const sdk = yield* makeClaudeSdk;
        const claude = yield* makeClaudeAdapter({
          runner: sdk.runner,
          claudeHome: yield* makeClaudeHome({ transcriptExists: false }),
          attachmentsDir: cwd,
        });
        yield* runWith(
          "agent-session-claude-missing",
          [claude],
          cwd,
          Effect.gen(function* () {
            const threadId = yield* seedImportedThread("claudeAgent");
            yield* sendFirstMessage(threadId);
            yield* Deferred.await(sdk.promptOffered);

            assert.equal(sdk.opened.length, 1);
            assert.equal(sdk.opened[0]?.options.sessionId, "fresh-claude-session");
            assert.isUndefined(sdk.opened[0]?.options.resume);
            const text = promptText(sdk.offered[0]!);
            assert.equal(occurrences(text, importedMarker), 1);
            assert.isTrue(text.endsWith(prompt));
          }),
        );
      }).pipe(Effect.provide(testServices)),
    ),
  );

  it.effect("gives another provider the transcript once on a switch before the first turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("agent-session-claude-switch");
        const sdk = yield* makeClaudeSdk;
        const claude = yield* makeClaudeAdapter({
          runner: sdk.runner,
          claudeHome: yield* makeClaudeHome({ transcriptExists: true }),
          attachmentsDir: cwd,
        });
        const codex = yield* makeCodexLikeAdapter({ nativeHistoryExists: true });
        yield* runWith(
          "agent-session-claude-switch",
          [claude, codex.adapter],
          cwd,
          Effect.gen(function* () {
            const threadId = yield* seedImportedThread("claudeAgent");
            yield* sendFirstMessage(threadId, codexSelection);
            yield* Deferred.await(codex.turnStarted);

            assert.equal(sdk.opened.length, 0);
            assert.equal(codex.turns.length, 1);
            assert.equal(occurrences(codex.turns[0]!.text, importedMarker), 1);
            assert.isTrue(codex.turns[0]!.text.endsWith(prompt));
          }),
        );
      }).pipe(Effect.provide(testServices)),
    ),
  );
});

describe("continuing an imported Codex session", () => {
  it.effect.each([
    { nativeHistoryExists: true, nativeThreadId: importedSessionId, markerCount: 0 },
    { nativeHistoryExists: false, nativeThreadId: "fresh-codex-thread", markerCount: 1 },
  ])(
    "sends the transcript $markerCount times when the native history exists: $nativeHistoryExists",
    ({ nativeHistoryExists, nativeThreadId, markerCount }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("agent-session-codex");
          const codex = yield* makeCodexLikeAdapter({ nativeHistoryExists });
          yield* runWith(
            "agent-session-codex",
            [codex.adapter],
            cwd,
            Effect.gen(function* () {
              const threadId = yield* seedImportedThread("codex");
              yield* sendFirstMessage(threadId);
              yield* Deferred.await(codex.turnStarted);

              assert.equal(codex.turns.length, 1);
              assert.equal(codex.turns[0]!.nativeThreadId, nativeThreadId);
              assert.equal(occurrences(codex.turns[0]!.text, importedMarker), markerCount);
              assert.isTrue(codex.turns[0]!.text.endsWith(prompt));
            }),
          );
        }).pipe(Effect.provide(testServices)),
      ),
  );
});
