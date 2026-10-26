import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BROWSER_IMPORT_MAX_DOMAINS, BrowserImportInput } from "./browserImport.ts";

const decodeInput = Schema.decodeUnknownSync(BrowserImportInput);

const input = {
  sourceId: "chrome",
  sourceProfileDirectory: "Default",
  targetProfileId: "personal-imported",
  consent: true,
};
const domains = Array.from(
  { length: BROWSER_IMPORT_MAX_DOMAINS },
  (_, index) => `site-${index}.example`,
);

it("accepts a complete bounded inventory over IPC", () => {
  expect(decodeInput({ ...input, selectedDomains: domains })).toEqual({
    ...input,
    selectedDomains: domains,
  });
});

it("rejects oversized or empty selections and missing consent over IPC", () => {
  for (const selectedDomains of [[], [...domains, "extra.example"]]) {
    expect(() => decodeInput({ ...input, selectedDomains })).toThrow();
  }
  expect(() =>
    decodeInput({
      ...input,
      selectedDomains: domains,
      consent: false,
    }),
  ).toThrow();
});
