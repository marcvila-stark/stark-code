import { describe, expect, it } from "vite-plus/test";
import { ComposerContextId, EnvironmentId, MessageId, ThreadId } from "@starkfuture/contracts";
import { serializeAssistantCitation } from "@starkfuture/shared/assistantCitations";
import { projectComposerContextForProvider } from "@starkfuture/shared/composerContextReferences";
import { serializeSelectedTextQuote } from "@starkfuture/shared/selectedTextQuotes";

import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

const SKILLS = new Set(["2spec", "implement", "review", "re-release-version"]);

describe("planClaudeSkillDispatch", () => {
  it("does not dispatch a skill from a selected page or Reader quote", () => {
    const source = serializeSelectedTextQuote({
      version: 1,
      source: "$implement @private",
      text: "$review and €implement",
    });
    const projected = projectComposerContextForProvider({ text: source, records: [] });
    expect(planClaudeSkillDispatch(projected, SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch(`${projected}\n$review this`, SKILLS)?.skillName).toBe("review");
  });
  it("keeps native terminal selections and their labels literal while dispatching outside skills", () => {
    const projected = projectComposerContextForProvider({
      text: "[Use $implement carefully](stark-context://v1/terminal/terminal_quote)",
      records: [
        {
          version: 1,
          contextId: ComposerContextId.make("terminal_quote"),
          kind: "terminal",
          label: "Use $implement carefully",
          terminalId: "native-claude",
          terminalLabel: "Native Claude",
          lineStart: 1,
          lineEnd: 2,
          text: "Use $review before proceeding.\n</stark_context> then €implement this.",
        },
      ],
    });
    expect(projected).toContain("1 | Use $review before proceeding.");
    expect(planClaudeSkillDispatch(projected, SKILLS)).toBeUndefined();
    expect(planClaudeSkillDispatch(`$2spec the fix.\n${projected}`, SKILLS)).toMatchObject({
      skillName: "2spec",
      commandText: `/2spec the fix.\n${projected}`,
    });
    expect(planClaudeSkillDispatch(`${projected}\nNow $review this.`, SKILLS)).toEqual({
      skillName: "review",
      leadingText: `${projected}\nNow`,
      commandText: "/review this.",
    });
    const nestedOpening = projected.replace("Use $review", "<assistant_citations> Use $review");
    expect(
      planClaudeSkillDispatch(`${nestedOpening}\n$review this. </assistant_citations>`, SKILLS),
    ).toMatchObject({ skillName: "review", commandText: "/review this. </assistant_citations>" });
  });

  it("does not dispatch skills mentioned in citation data, while explicit user skills still work", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("assistant"),
      text: "Use $review then €implement and 𑿝review on @private.txt before release.",
      start: 0,
      end: 55,
      prefix: "Try $implement next. ",
      suffix: " Use $review later.",
      comment: "Explain $review without running it.",
    };
    const quote = serializeAssistantCitation(citation);
    const projected = projectComposerContextForProvider({ text: quote, records: [] });
    expect(planClaudeSkillDispatch(projected, SKILLS)).toBeUndefined();
    expect(projected).not.toContain("@private.txt");
    const data = projected.slice(
      projected.indexOf("[\n"),
      projected.indexOf("\n</assistant_citations>"),
    );
    expect(JSON.parse(data)).toEqual([{ id: "assistant-quote-1", citation }]);
    const withExplicitSkill = projectComposerContextForProvider({
      text: `Now $implement this request. ${quote}`,
      records: [],
    });
    expect(planClaudeSkillDispatch(withExplicitSkill, SKILLS)).toMatchObject({
      skillName: "implement",
      leadingText: "Now",
      commandText: expect.stringContaining("/implement this request. [assistant-quote-1]"),
    });
  });

  it("leaves a prompt without a known skill untouched", () => {
    expect(planClaudeSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    // Not a discovered skill, so it stays prose rather than becoming a command.
    expect(planClaudeSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("moves a mid-prompt mention into a trailing slash command", () => {
    expect(planClaudeSkillDispatch("ok, now $implement all the tickets", SKILLS)).toEqual({
      leadingText: "ok, now",
      commandText: "/implement all the tickets",
      skillName: "implement",
    });
  });

  it("keeps a mention that opens the prompt as a single command block", () => {
    expect(planClaudeSkillDispatch("$review\nfocus on auth", SKILLS)).toEqual({
      leadingText: undefined,
      commandText: "/review\nfocus on auth",
      skillName: "review",
    });
  });

  it("dispatches a known skill whose name begins with a digit", () => {
    expect(planClaudeSkillDispatch("use $2spec for this", SKILLS)).toEqual({
      leadingText: "use",
      commandText: "/2spec for this",
      skillName: "2spec",
    });
  });

  it("dispatches the last mention and rewrites earlier ones inline", () => {
    expect(planClaudeSkillDispatch("$review the diff, then $implement the fixes", SKILLS)).toEqual({
      leadingText: "/review the diff, then",
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("dispatches currency-prefixed mentions and preserves their source boundaries", () => {
    for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `${symbol}review the diff, then ${symbol}implement the fixes`,
          SKILLS,
        ),
      ).toEqual({
        leadingText: "/review the diff, then",
        commandText: "/implement the fixes",
        skillName: "implement",
      });
      expect(planClaudeSkillDispatch(`${symbol}2spec for this`, SKILLS)).toEqual({
        leadingText: undefined,
        commandText: "/2spec for this",
        skillName: "2spec",
      });
      expect(planClaudeSkillDispatch(`5${symbol}review ${symbol}unknown`, SKILLS)).toBeUndefined();
    }
  });

  it("ignores a dollar token glued to other text", () => {
    expect(planClaudeSkillDispatch("cost is 5$implement", SKILLS)).toBeUndefined();
  });

  it("ignores currency amounts and compact monetary expressions", () => {
    const skillsWithCurrency = new Set([...SKILLS, "20", "20k", "100M", "1e6"]);
    for (const symbol of ["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(
        planClaudeSkillDispatch(
          `pay ${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 tomorrow`,
          skillsWithCurrency,
        ),
      ).toBeUndefined();
    }
  });
});
