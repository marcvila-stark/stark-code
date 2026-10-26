/** Stark-owned Claude work uses Sonnet for helpers; history retains its reported model. */
export const CLAUDE_HELPER_MODEL = "claude-sonnet-5-5";

/** Official CLI controls; FORCE requires Claude Code 2.1.257+, Sonnet 5.5 requires 2.1.284+. */
export const CLAUDE_HELPER_MODEL_ENV = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_HELPER_MODEL,
  // Retain the deprecated control for older helper code paths.
  ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_HELPER_MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL: CLAUDE_HELPER_MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
} as const;

/** Match aliases and provider-qualified/versioned Haiku IDs, not arbitrary prose. */
export function isClaudeHaikuModel(model: string): boolean {
  return /(?:^|[/:.])(?:claude-)?haiku(?:$|[-.\d]|\[)|(?:^|[/:.])claude-\d[\w.-]*-haiku(?:$|[-.])/i.test(
    model.trim(),
  );
}

/** Apply only to a new dispatch, never to usage or persisted transcript metadata. */
export function permittedClaudeModel(model: string): string {
  return isClaudeHaikuModel(model) ? CLAUDE_HELPER_MODEL : model;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

/** Match the actual gateway, not an arbitrary URL containing its name. */
export function isOpenRouterEnvironment(environment: Record<string, string | undefined>): boolean {
  return environment.ANTHROPIC_BASE_URL?.replace(/\/+$/, "") === OPENROUTER_BASE_URL;
}

/** Native aliases are local to Claude; gateway IDs must retain their provider prefix. */
export function openRouterModelId(model: string): string {
  if (isClaudeHaikuModel(model)) return OPENROUTER_DEFAULT_MODEL;
  if (model.includes("/")) return model;
  if (/^(?:claude-)?opus(?:$|[-.\d])/i.test(model)) return "anthropic/claude-opus-5.5";
  if (/^(?:claude-)?fable(?:$|[-.\d])/i.test(model)) return "anthropic/claude-fable-5.1";
  if (/^(?:claude-)?sonnet(?:$|[-.\d])/i.test(model) || model === "default")
    return OPENROUTER_DEFAULT_MODEL;
  return model;
}

/** Only non-secret runtime policy belongs in --settings; never copy API keys there. */
export function claudeHelperModelEnvironment(environment: Record<string, string | undefined>) {
  if (!isOpenRouterEnvironment(environment)) return CLAUDE_HELPER_MODEL_ENV;
  return {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: OPENROUTER_DEFAULT_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: OPENROUTER_DEFAULT_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: OPENROUTER_DEFAULT_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    ANTHROPIC_DEFAULT_SONNET_MODEL: OPENROUTER_DEFAULT_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-5.5",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "anthropic/claude-fable-5.1",
  };
}

/** Apply after user/profile env so a saved Haiku alias cannot undo the helper policy. */
export function claudeModelEnvironment(environment: Record<string, string | undefined>) {
  const gateway = isOpenRouterEnvironment(environment);
  const result: Record<string, string | undefined> = {
    ...environment,
    ...claudeHelperModelEnvironment(environment),
  };
  if (gateway) {
    // The API key variable must be explicitly empty for Claude's gateway auth.
    result.ANTHROPIC_API_KEY = "";
    for (const key of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    ])
      delete result[key];
  }
  for (const key of [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
  ]) {
    const model = result[key];
    if (model !== undefined)
      result[key] = gateway ? openRouterModelId(model) : permittedClaudeModel(model);
  }
  return result;
}
