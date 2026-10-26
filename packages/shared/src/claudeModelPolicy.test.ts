import { describe, expect, it } from "vite-plus/test";
import {
  CLAUDE_HELPER_MODEL,
  claudeModelEnvironment,
  isClaudeHaikuModel,
  permittedClaudeModel,
} from "./claudeModelPolicy.ts";

describe("Claude model policy", () => {
  it.each([
    "haiku",
    "HAIKU",
    "haiku-5.5",
    "claude-haiku-4-5-20251001",
    "anthropic/claude-haiku-5-5",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "claude-3-5-haiku-20241022",
    "claude-haiku-5-5[1m]",
  ])("recognizes blocked model %s", (model) => {
    expect(isClaudeHaikuModel(model)).toBe(true);
    expect(permittedClaudeModel(model)).toBe(CLAUDE_HELPER_MODEL);
  });
  it.each(["claude-sonnet-5-5", "opus", "fable", "my-haiku-proxy", "gpt-6-astra"])(
    "preserves opaque or permitted ID %s",
    (model) => {
      expect(isClaudeHaikuModel(model)).toBe(false);
      expect(permittedClaudeModel(model)).toBe(model);
    },
  );
  it("repairs inherited Haiku aliases without changing an allowed main model", () => {
    const source = {
      ANTHROPIC_MODEL: "opus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "haiku",
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0",
    };
    expect(claudeModelEnvironment(source)).toMatchObject({
      ANTHROPIC_MODEL: "opus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5-5",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    });
    expect(source.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("haiku");
  });
});

describe("OpenRouter model and credential isolation", () => {
  it("keeps routed IDs and replaces only native aliases and blocked helpers", () => {
    const source = {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "router-key",
      ANTHROPIC_API_KEY: "unrelated-key",
      CLAUDE_CODE_OAUTH_TOKEN: "unrelated-login",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_MODEL: "openai/gpt-example",
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
    };
    const env = claudeModelEnvironment(source);
    expect(env.ANTHROPIC_MODEL).toBe("openai/gpt-example");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("router-key");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("anthropic/claude-sonnet-5.5");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("anthropic/claude-sonnet-5.5");
    expect(source.CLAUDE_CODE_OAUTH_TOKEN).toBe("unrelated-login");
  });
  it("maps native aliases only for the exact OpenRouter endpoint", () => {
    expect(
      claudeModelEnvironment({
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api/",
        ANTHROPIC_MODEL: "sonnet",
      }).ANTHROPIC_MODEL,
    ).toBe("anthropic/claude-sonnet-5.5");
    expect(
      claudeModelEnvironment({
        ANTHROPIC_BASE_URL: "https://openrouter.ai.example/api",
        ANTHROPIC_MODEL: "sonnet",
      }).ANTHROPIC_MODEL,
    ).toBe("sonnet");
  });
});
