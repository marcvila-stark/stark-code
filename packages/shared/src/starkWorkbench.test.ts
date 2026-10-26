import { describe, expect, it } from "@effect/vitest";
import { claudePluginArguments, resolveStarkWorkbenchRoot } from "./starkWorkbench.ts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

describe("Workbench provider configuration", () => {
  it("preserves repeated and variadic user plugins without treating literal prompt text as flags", () => {
    expect(
      claudePluginArguments(
        '--plugin-dir "/one plugin" /two --permission-mode plan --plugin-dir=/three --plugin-dir /two -- --plugin-dir /prompt',
      ),
    ).toEqual({
      paths: ["/one plugin", "/two", "/three"],
      args: ["--permission-mode", "plan"],
    });
  });
  it.effect(
    "permits standalone servers without a bundled desktop kit and rejects invalid configured paths",
    () =>
      Effect.gen(function* () {
        expect(yield* resolveStarkWorkbenchRoot({})).toBeUndefined();
        const failure = yield* resolveStarkWorkbenchRoot({
          STARK_WORKBENCH_ROOT: "relative/path",
        }).pipe(Effect.flip);
        expect(failure.message).toContain("missing or invalid");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
