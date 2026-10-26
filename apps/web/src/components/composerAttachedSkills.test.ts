import { expect, it } from "vite-plus/test";
import { attachSkillAtStart, splitAttachedSkills } from "./composerAttachedSkills";
const skills = [
  { name: "plain-english", path: "/skills/plain/SKILL.md", enabled: true },
  { name: "review", path: "/skills/review/SKILL.md", enabled: true },
];
it("keeps provider invocation intact while separating writing from attached skills", () => {
  const value = "$plain-english /review Explain this.";
  const result = splitAttachedSkills(value, skills);
  expect(result.attached.map(({ skill }) => skill.name)).toEqual(["plain-english", "review"]);
  expect(result.body).toBe("Explain this.");
  expect(result.prefix + result.body).toBe(value);
});
it("preserves unknown names, unfinished typing, literal code and in-sentence references", () => {
  for (const value of [
    "$unavailable explain",
    "$plain-english",
    "`$plain-english` ",
    "Use $review here",
  ]) {
    expect(splitAttachedSkills(value, skills).body).toBe(value);
  }
});
it("adds a picked skill ahead of the draft without losing text around the picker", () => {
  expect(
    attachSkillAtStart({
      value: "Explain $pl this",
      start: 8,
      end: 11,
      reference: "$plain-english ",
    }),
  ).toEqual({ value: "$plain-english Explain  this", cursor: 23 });
});
