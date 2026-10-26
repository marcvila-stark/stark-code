import { describe, expect, it } from "vite-plus/test";
import { projectNativeTurnEvidence } from "./NativeTurnEvidence.ts";

const at = (n: number) => `2026-10-20T12:00:${String(n).padStart(2, "0")}.000Z`;
const base = {
  sessionId: "session",
  turnId: "turn",
  cwd: "/workspace",
  replyText: "Finished.",
  truncated: false,
} as const;
const codexItem = (item: Record<string, unknown>, start = 10, end = 20, turn = "turn") => ({
  type: "event_msg",
  timestamp: at(end),
  payload: {
    type: "item_completed",
    thread_id: "session",
    turn_id: turn,
    item,
    started_at_ms: Date.parse(at(start)),
    completed_at_ms: Date.parse(at(end)),
  },
});
const command = (values: Record<string, unknown> = {}) => ({
  type: "CommandExecution",
  id: "check",
  command: "npm test --token secret-value",
  status: "completed",
  exit_code: 0,
  aggregated_output: "private tool output",
  ...values,
});
const claude = (
  uuid: string,
  parentUuid: string | null,
  type: string,
  content: unknown,
  extra: Record<string, unknown> = {},
) => ({
  sessionId: "session",
  uuid,
  parentUuid,
  type,
  isSidechain: false,
  timestamp: at(10),
  message: { content },
  ...extra,
});
const prompt = claude("prompt", null, "user", "Please test.");
const use = claude("use", "prompt", "assistant", [
  {
    type: "tool_use",
    id: "bash",
    name: "Bash",
    input: { command: "SECRET=secret-value npm test" },
  },
]);
const completed = claude(
  "result",
  "use",
  "user",
  [{ type: "tool_result", tool_use_id: "bash", content: "Never persist me" }],
  { timestamp: at(20), toolUseResult: { stdout: "secret-value", stderr: "", interrupted: false } },
);
const reply = claude("reply", "result", "assistant", [{ type: "text", text: "Finished." }], {
  timestamp: at(30),
});

describe("native turn evidence projection", () => {
  it("recognizes installed Codex shell argv without persisting arguments or output", () => {
    const evidence = projectNativeTurnEvidence({
      ...base,
      provider: "codex",
      records: [
        codexItem(command({ command: ["/bin/zsh", "-lc", "node --test check.test.cjs"] })),
        codexItem(command({ id: "direct", command: ["npm", "test", "--token", "secret-value"] })),
        codexItem(
          command({ id: "compound", command: ["/bin/bash", "-c", "npm test; echo hidden"] }),
        ),
        codexItem(command({ id: "one-arg", command: ["npm", "test something"] })),
        codexItem(command({ id: "unsupported-wrapper", command: ["/bin/zsh", "-ic", "npm test"] })),
        codexItem(
          {
            type: "FileChange",
            id: "edit",
            status: "completed",
            changes: { "/workspace/evidence.txt": { type: "add", content: "private source" } },
          },
          21,
          25,
        ),
      ],
    });
    expect(evidence.commands.map((row) => [row.label, row.isCheck, row.exitCode])).toEqual([
      ["node --test …", true, 0],
      ["npm test …", true, 0],
      ["Shell command (arguments hidden)", false, 0],
      ["npm …", false, 0],
      ["zsh …", false, 0],
    ]);
    expect(evidence.changes).toEqual([{ path: "evidence.txt", completedAt: at(25) }]);
    expect(JSON.stringify(evidence)).not.toMatch(/secret-value|check.test.cjs|private|hidden"/);
  });

  it("uses typed Codex exit results and edits only from the requested session and turn", () => {
    const evidence = projectNativeTurnEvidence({
      ...base,
      provider: "codex",
      records: [
        codexItem(command()),
        codexItem(command({ id: "failed", exit_code: 2 })),
        codexItem(command({ id: "incomplete", exit_code: null })),
        codexItem(command({ id: "other" }), 10, 20, "other-turn"),
        codexItem(
          {
            type: "FileChange",
            id: "edit",
            status: "completed",
            changes: {
              "/workspace/src/app.ts": {
                type: "update",
                unified_diff: "private source",
                move_path: null,
              },
            },
          },
          21,
          25,
        ),
      ],
    });
    expect(evidence.commands.map((row) => [row.label, row.outcome, row.exitCode])).toEqual([
      ["npm test …", "exit-zero", 0],
      ["npm test …", "failed", 2],
      ["npm test …", "unknown", null],
    ]);
    expect(evidence.changes).toEqual([{ path: "src/app.ts", completedAt: at(25) }]);
    expect(JSON.stringify(evidence)).not.toMatch(/secret-value|private/);
  });
  it("preserves unknown statuses and deduplicates native item replay", () => {
    const evidence = projectNativeTurnEvidence({
      ...base,
      provider: "codex",
      records: [
        codexItem(command({ status: "in_progress", exit_code: 0 })),
        codexItem(command({ status: "completed", exit_code: 0 })),
        codexItem({ type: "FileChange", status: "failed", changes: { "/workspace/x": {} } }),
      ],
    });
    expect(evidence.commands).toHaveLength(1);
    expect(evidence.unconfirmedChanges).toBe(1);
    expect(
      projectNativeTurnEvidence({ ...base, provider: "codex", turnId: null, records: [] }).coverage,
    ).toBe("unavailable");
  });
  it("keeps Claude tool success distinct from exit zero and follows the reply's ancestry", () => {
    const evidence = projectNativeTurnEvidence({
      ...base,
      provider: "claude",
      records: [
        prompt,
        use,
        completed,
        reply,
        claude("next", "reply", "user", "Next task"),
        claude("next-use", "next", "assistant", [
          { type: "tool_use", id: "secret", name: "Bash", input: { command: "rm secret-value" } },
        ]),
      ],
    });
    expect(evidence.coverage).toBe("available");
    expect(evidence.commands).toEqual([
      {
        id: "bash",
        label: "npm test",
        isCheck: true,
        outcome: "tool-completed",
        exitCode: null,
        startedAt: at(10),
        completedAt: at(20),
      },
    ]);
    expect(JSON.stringify(evidence)).not.toMatch(/secret-value|Never persist/);
  });
  it("does not infer completion from missing, backgrounded or interrupted Claude results", () => {
    for (const [response, outcome] of [
      [{ stdout: "", interrupted: false, backgroundTaskId: "task" }, "unknown"],
      [{ stdout: "", interrupted: true }, "failed"],
      [{}, "unknown"],
    ] as const) {
      const evidence = projectNativeTurnEvidence({
        ...base,
        provider: "claude",
        records: [prompt, use, { ...completed, toolUseResult: response }, reply],
      });
      expect(evidence.commands[0]?.outcome).toBe(outcome);
      expect(evidence.commands[0]?.exitCode).toBeNull();
    }
  });
  it("records Claude edits but rejects paths outside the workspace and ignores child records", () => {
    const evidence = projectNativeTurnEvidence({
      ...base,
      provider: "claude",
      records: [
        prompt,
        use,
        {
          ...completed,
          toolUseResult: {
            stdout: "",
            interrupted: false,
            bashEditDiff: {
              files: [
                { filePath: "/workspace/app.ts", hunks: ["private"] },
                { filePath: "/outside/secret" },
              ],
            },
          },
        },
        { ...reply, isSidechain: true, uuid: "child" },
        reply,
      ],
    });
    expect(evidence.changes).toEqual([{ path: "app.ts", completedAt: at(20) }]);
    expect(evidence.coverage).toBe("partial");
    expect(JSON.stringify(evidence)).not.toContain("secret");
  });
  it("marks missing ancestry, truncated captures and unmatched replies conservatively", () => {
    expect(
      projectNativeTurnEvidence({ ...base, provider: "claude", records: [use, completed, reply] })
        .coverage,
    ).toBe("partial");
    expect(
      projectNativeTurnEvidence({
        ...base,
        provider: "claude",
        replyText: "Different",
        records: [prompt, use, completed, reply],
      }).coverage,
    ).toBe("unavailable");
    expect(
      projectNativeTurnEvidence({
        ...base,
        provider: "codex",
        truncated: true,
        records: [codexItem(command())],
      }).coverage,
    ).toBe("partial");
  });

  it("refuses ambiguous identical Claude replies after an async Stop delay", () => {
    const later = claude("later", "reply", "assistant", [{ type: "text", text: "Finished." }]);
    const evidence = projectNativeTurnEvidence({
      ...base,
      provider: "claude",
      records: [prompt, use, completed, reply, later],
    });
    expect(evidence.coverage).toBe("unavailable");
    expect(evidence.commands).toHaveLength(0);
  });

  it("does not count help, listing or dry-run output as a test run", () => {
    for (const input of [
      "npm test --help",
      "tsc --version",
      "pytest --collect-only",
      "vitest list",
      "go test -list=.",
      "jest --listTests",
      "cargo test -- --list",
    ]) {
      const evidence = projectNativeTurnEvidence({
        ...base,
        provider: "codex",
        records: [codexItem(command({ command: input }))],
      });
      expect(evidence.commands[0]?.isCheck, input).toBe(false);
      expect(evidence.commands[0]?.outcome).toBe("exit-zero");
    }
  });
  it("caps collected records and never classifies compound scripts as a successful check", () => {
    const evidence = projectNativeTurnEvidence({
      ...base,
      provider: "codex",
      records: [
        codexItem(command({ id: "compound", command: "npm test; echo secret-value" })),
        ...Array.from({ length: 101 }, (_, i) => codexItem(command({ id: String(i) }))),
      ],
    });
    expect(evidence.commands).toHaveLength(100);
    expect(evidence.coverage).toBe("partial");
    expect(evidence.commands[0]?.isCheck).toBe(false);
    expect(evidence.commands[0]?.label).toBe("Shell command (arguments hidden)");
  });
});
