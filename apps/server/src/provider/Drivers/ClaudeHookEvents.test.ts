import { assert, describe, it } from "@effect/vitest";
import { cleanHookText, makeClaudeHookEventMapper } from "./ClaudeHookEvents.ts";
import { codexHookRunDisplay } from "./CodexHookEvents.ts";

const response = (fields: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "hook_response",
  hook_id: "hook-1",
  hook_event: "PreToolUse",
  hook_name: "guard",
  stdout: "",
  stderr: "",
  output: "",
  exit_code: 0,
  outcome: "success",
  ...fields,
});

describe("hook display mapping", () => {
  it("keeps empty success activity informational for the verbose fold", () => {
    const mapper = makeClaudeHookEventMapper();
    assert.deepEqual(mapper.map({ ...response(), subtype: "hook_started" }, 100), []);
    const [run] = mapper.map(response(), 150);
    assert.equal(run?.outcome, "ran");
    assert.equal(run?.level, "info");
    assert.equal(run?.detail, "");
    assert.equal(run?.durationMs, 50);
  });
  it("detects exit-2 blocks and preserves a plain stderr detail", () => {
    const [run] = makeClaudeHookEventMapper().map(
      response({ exit_code: 2, stderr: "rm commands are not allowed" }),
      1,
    );
    assert.equal(run?.outcome, "blocked");
    assert.include(run!.summary, "Blocked by PreToolUse hook");
    assert.equal(run?.detail, "rm commands are not allowed");
  });
  it("detects JSON deny at exit zero and top-level block decisions", () => {
    for (const stdout of [
      '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"publish guard"}}',
      '{"decision":"block","reason":"stop feedback"}',
    ]) {
      const [run] = makeClaudeHookEventMapper().map(response({ stdout }), 1);
      assert.equal(run?.outcome, "blocked");
    }
  });
  it("maps non-blocking failures and informational levels", () => {
    assert.equal(
      makeClaudeHookEventMapper().map(
        response({ exit_code: 1, hook_event: "PostToolUse", stderr: "failed" }),
        1,
      )[0]?.outcome,
      "failed",
    );
    const mapper = makeClaudeHookEventMapper();
    assert.equal(
      mapper.map(
        {
          type: "system",
          subtype: "informational",
          level: "warning",
          content: "hello",
          uuid: "notice",
        },
        1,
      )[0]?.level,
      "warning",
    );
    assert.equal(
      mapper.map(
        { type: "system", subtype: "informational", level: "info", content: "hello", uuid: "info" },
        1,
      )[0]?.level,
      "info",
    );
    assert.equal(
      mapper.map(
        {
          type: "system",
          subtype: "informational",
          prevent_continuation: true,
          level: "notice",
          content: "stop",
          uuid: "stop",
        },
        1,
      )[0]?.eventName,
      "Stop",
    );
  });
  it("cleans ANSI, links control payloads, NUL and caps details", () => {
    assert.equal(
      cleanHookText(
        "\u001b[31mred\u001b[0m\u0000\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007",
      ),
      "redlink",
    );
    assert.equal(cleanHookText("x".repeat(20_000)).length, 8192);
  });
  it("maps Codex stop entries as blocked and context-only runs as verbose", () => {
    assert.equal(
      codexHookRunDisplay({ id: "stopped", eventName: "stop", status: "stopped", entries: [] })
        ?.outcome,
      "notice",
    );
    assert.equal(
      codexHookRunDisplay({ id: "one", eventName: "PreToolUse", status: "completed", entries: [] })
        ?.level,
      "info",
    );
    assert.equal(
      codexHookRunDisplay({
        id: "two",
        eventName: "PreToolUse",
        status: "completed",
        entries: [{ kind: "stop", text: "guard" }],
      })?.outcome,
      "blocked",
    );
    assert.equal(
      codexHookRunDisplay({
        id: "three",
        eventName: "SessionStart",
        status: "completed",
        entries: [{ kind: "context", text: "secret context" }],
      })?.level,
      "info",
    );
  });
});
