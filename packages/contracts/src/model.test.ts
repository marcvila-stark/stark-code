import { expect, it } from "vite-plus/test";
import { DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

it("uses Sonnet for Claude auxiliary text generation", () => {
  expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")]).toBe(
    "claude-sonnet-5-5",
  );
});
