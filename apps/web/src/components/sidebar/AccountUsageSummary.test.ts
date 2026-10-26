import { expect, it } from "vite-plus/test";
import { accountUsageLabel } from "./AccountUsageSummary";

it("normalizes account-wide windows while preserving model-specific limits", () => {
  expect(["5 hours", "Session", "Session · all models"].map(accountUsageLabel)).toEqual([
    "Session",
    "Session",
    "Session",
  ]);
  expect(["7 days", "Weekly", "Weekly · all models"].map(accountUsageLabel)).toEqual([
    "Weekly",
    "Weekly",
    "Weekly",
  ]);
  expect(["Weekly · Fable", "Monthly", "Fable"].map(accountUsageLabel)).toEqual([
    "Weekly · Fable",
    "Monthly",
    "Fable",
  ]);
});
