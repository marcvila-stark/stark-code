import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { claudeContextBreakdown, unavailableContextBreakdown } from "./ClaudeContextUsage.ts";

describe("Claude context breakdown", () => {
  it("uses provider category kinds, excludes presentation colors/grid, and keeps deferred rows", () => {
    const input: SDKControlGetContextUsageResponse = {
      categories: [
        { name: "Translated label", tokens: 5, color: "malicious", kind: "used" },
        { name: "Messages", tokens: 9000, color: "red", kind: "deferred", isDeferred: true },
      ],
      totalTokens: 5,
      maxTokens: 100,
      rawMaxTokens: 120,
      percentage: 5,
      gridRows: [],
      model: "claude-test",
      memoryFiles: [{ path: "/work/CLAUDE.md", type: "project", tokens: 2 }],
      mcpTools: [{ name: "read", serverName: "stark", tokens: 3, isLoaded: true }],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      },
    };
    const output = claudeContextBreakdown(input, "summary");
    assert.equal(output.detail, "summary");
    assert.equal(output.totalTokens, 5);
    assert.equal(output.categories[1]?.kind, "deferred");
    assert.equal(output.windowLabel, "context window per Claude Code");
    assert.notProperty(output, "gridRows");
    assert.notProperty(output.categories[0], "color");
    assert.deepEqual(output.apiUsage, {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
    });
  });
  it("does not fabricate live measurements", () => {
    assert.equal(unavailableContextBreakdown("claudeAgent", "summary").kind, "unavailable");
  });
});
