import {
  ProviderSessionReadError,
  type ProviderReadContextUsageInput,
  type ProviderContextBreakdown,
  type ProviderReadSessionCatalogInput,
  type ServerProviderSessionCatalog,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export class ProviderSessionInspector extends Context.Service<
  ProviderSessionInspector,
  {
    readonly readCatalog: (
      input: ProviderReadSessionCatalogInput,
    ) => Effect.Effect<ServerProviderSessionCatalog, ProviderSessionReadError>;
    readonly readContext: (
      input: ProviderReadContextUsageInput,
    ) => Effect.Effect<ProviderContextBreakdown, ProviderSessionReadError>;
  }
>()("stark-code/provider/ProviderSessionInspector") {}

/** Inspection never opens a provider or touches its idle deadline. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  return ProviderSessionInspector.of({
    readContext: (input) =>
      Effect.gen(function* () {
        const projection = yield* threads.getThreadRecords(input.threadId, [
          "providerThreads",
          "providerSessions",
        ]);
        const thread =
          projection.providerThreads.find(
            (candidate) => candidate.id === projection.thread.activeProviderThreadId,
          ) ?? projection.providerThreads.at(-1);
        const session = projection.providerSessions.find(
          (candidate) => candidate.id === thread?.providerSessionId,
        );
        const provider = session?.driver === "codex" ? "codex" : "claudeAgent";
        const runtime = thread?.providerSessionId
          ? Option.getOrNull(yield* sessions.peek(thread.providerSessionId))
          : null;
        if (runtime?.readContextUsage)
          return yield* runtime.readContextUsage({ detail: input.detail });
        const usage = thread?.contextUsage;
        const totalTokens = usage?.usedTokens ?? 0;
        const maxTokens = usage?.maxTokens ?? 0;
        const tokens = {
          inputTokens: usage?.inputTokens ?? 0,
          cachedInputTokens: usage?.cachedInputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          reasoningTokens: usage?.reasoningOutputTokens ?? 0,
          ...(maxTokens ? { modelContextWindow: maxTokens } : {}),
        };
        return {
          provider,
          kind: provider === "codex" && usage ? "tokens-only" : "unavailable",
          detail: input.detail,
          categories: [],
          totalTokens,
          maxTokens,
          rawMaxTokens: maxTokens,
          percentage: maxTokens ? (totalTokens / maxTokens) * 100 : 0,
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          apiUsage: null,
          ...(provider === "codex" && usage
            ? {
                lastTurn: {
                  inputTokens: usage.lastInputTokens ?? tokens.inputTokens,
                  cachedInputTokens: usage.lastCachedInputTokens ?? tokens.cachedInputTokens,
                  outputTokens: usage.lastOutputTokens ?? tokens.outputTokens,
                  reasoningTokens: usage.lastReasoningOutputTokens ?? tokens.reasoningTokens,
                  ...(maxTokens ? { modelContextWindow: maxTokens } : {}),
                },
                windowLabel: "limit" as const,
              }
            : {
                message:
                  "Send a message to start a live provider session before inspecting its context.",
              }),
        } satisfies ProviderContextBreakdown;
      }).pipe(
        Effect.mapError(
          (cause) => new ProviderSessionReadError({ threadId: input.threadId, cause }),
        ),
      ),
    readCatalog: (input) =>
      Effect.gen(function* () {
        const projection = yield* threads.getThreadRecords(input.threadId, ["providerThreads"]);
        const thread =
          projection.providerThreads.find(
            (candidate) => candidate.id === projection.thread.activeProviderThreadId,
          ) ?? projection.providerThreads.at(-1);
        if (!thread?.providerSessionId)
          return { commands: [], skills: [], mcpServers: [], live: false };
        const runtime = Option.getOrNull(yield* sessions.peek(thread.providerSessionId));
        if (!runtime?.readSessionCatalog)
          return { commands: [], skills: [], mcpServers: [], live: false };
        return {
          ...(yield* runtime.readSessionCatalog()),
          providerSessionId: thread.providerSessionId,
        };
      }).pipe(
        Effect.mapError(
          (cause) => new ProviderSessionReadError({ threadId: input.threadId, cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(ProviderSessionInspector, make);
