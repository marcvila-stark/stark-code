import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderContextBreakdown } from "@starkfuture/contracts";

export function unavailableContextBreakdown(
  provider: "claudeAgent" | "codex",
  detail: "summary" | "full",
): ProviderContextBreakdown {
  return {
    provider,
    kind: "unavailable",
    detail,
    categories: [],
    totalTokens: 0,
    maxTokens: 0,
    rawMaxTokens: 0,
    percentage: 0,
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    apiUsage: null,
    message: "Send a message to measure context",
  };
}

/** Keep provider kinds, never infer row semantics from translated labels. */
export function claudeContextBreakdown(
  value: SDKControlGetContextUsageResponse,
  detail: "summary" | "full",
): ProviderContextBreakdown {
  const source: unknown = Reflect.get(value, "autocompactSource");
  return {
    provider: "claudeAgent",
    kind: "breakdown",
    detail,
    categories: value.categories.map(({ name, tokens, kind, isDeferred }) => ({
      name,
      tokens,
      kind,
      ...(isDeferred === undefined ? {} : { isDeferred }),
    })),
    totalTokens: value.totalTokens,
    maxTokens: value.maxTokens,
    rawMaxTokens: value.rawMaxTokens,
    percentage: value.percentage,
    windowLabel:
      source === "auto"
        ? "limit"
        : typeof source === "string"
          ? "compaction window"
          : "context window per Claude Code",
    model: value.model,
    memoryFiles: value.memoryFiles,
    mcpTools: value.mcpTools,
    ...(value.deferredBuiltinTools === undefined
      ? {}
      : { deferredBuiltinTools: value.deferredBuiltinTools }),
    ...(value.systemTools === undefined ? {} : { systemTools: value.systemTools }),
    ...(value.systemPromptSections === undefined
      ? {}
      : { systemPromptSections: value.systemPromptSections }),
    agents: value.agents,
    ...(value.slashCommands === undefined ? {} : { slashCommands: value.slashCommands }),
    ...(value.skills === undefined ? {} : { skills: value.skills }),
    ...(value.autoCompactThreshold === undefined
      ? {}
      : { autoCompactThreshold: value.autoCompactThreshold }),
    isAutoCompactEnabled: value.isAutoCompactEnabled,
    ...(value.messageBreakdown === undefined ? {} : { messageBreakdown: value.messageBreakdown }),
    apiUsage:
      value.apiUsage === null
        ? null
        : {
            inputTokens: value.apiUsage.input_tokens,
            outputTokens: value.apiUsage.output_tokens,
            cacheCreationInputTokens: value.apiUsage.cache_creation_input_tokens,
            cacheReadInputTokens: value.apiUsage.cache_read_input_tokens,
          },
  };
}
