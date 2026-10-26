import { assert, describe, it } from "@effect/vitest";

import {
  STARK_CODE_ORCHESTRATION_INSTRUCTIONS,
  starkAcpPromptWithInstructions,
  starkOrchestrationPromptForFirstRun,
  starkOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Stark orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(STARK_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(STARK_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level Stark conversations");
    assert.include(STARK_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(STARK_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(STARK_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      STARK_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `stark_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(STARK_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(STARK_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(STARK_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = starkOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasStarkMcp: true,
    });

    assert.include(injected, "<stark_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      starkOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasStarkMcp: true }),
      prompt,
    );
    assert.equal(
      starkOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasStarkMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the Stark MCP server is attached", () => {
    assert.equal(starkOrchestrationSystemPrompt(false), undefined);
    assert.equal(starkOrchestrationSystemPrompt(true), STARK_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = starkAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasStarkMcp: true },
    });

    assert.include(injected, "Stark Code interaction mode: Default");
    assert.include(injected, "Stark Code collaborative browser");
    assert.include(injected, "Stark Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasStarkMcp: true } as const;

    assert.equal(
      starkAcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      starkAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Stark Code interaction mode: Plan",
    );
    const withoutMcp = starkAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasStarkMcp: false },
    });
    assert.include(withoutMcp, "Stark Code interaction mode: Default");
    assert.notInclude(withoutMcp, "Stark Code collaborative browser");
    assert.notInclude(withoutMcp, "Stark Code orchestration");
  });
});
