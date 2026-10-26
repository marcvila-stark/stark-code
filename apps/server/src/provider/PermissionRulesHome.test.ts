import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { CodexSettings, type ProviderInstanceEnvironment } from "@starkfuture/contracts";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveCodexPermissionRulesHome } from "./PermissionRulesHome.ts";

const settings = Schema.decodeSync(CodexSettings);
const resolve = (
  config: Parameters<typeof settings>[0],
  environment?: ProviderInstanceEnvironment,
  inheritedHome?: string,
) =>
  resolveCodexPermissionRulesHome(settings(config), environment, "/project/worktree").pipe(
    Effect.provideService(HostProcess.HomeDirectory, "/test-user"),
    Effect.provideService(HostProcess.Environment, {
      CODEX_HOME: inheritedHome,
      UNRELATED_SECRET: "must-not-be-used",
    }),
  );
const variable = (value: string) => ({ name: "CODEX_HOME", value, sensitive: false });

it.layer(NodeServices.layer)("Codex saved-rule home", (it) => {
  it.effect("uses the inherited home for existing CLI instances without a configured home", () =>
    Effect.gen(function* () {
      expect(yield* resolve({ setupMode: "existing" }, undefined, "/ambient/codex")).toBe(
        "/ambient/codex",
      );
      expect(yield* resolve({}, undefined, "/ambient/legacy")).toBe("/ambient/legacy");
    }),
  );

  it.effect("uses the last provider CODEX_HOME override and the runtime's tilde expansion", () =>
    Effect.gen(function* () {
      expect(
        yield* resolve(
          {},
          [
            variable("/earlier"),
            { name: "UNRELATED_SECRET", value: "ignored", sensitive: true },
            variable("~/.codex-work"),
          ],
          "/ambient/codex",
        ),
      ).toBe("/test-user/.codex-work");
    }),
  );

  it.effect("resolves relative and literal inherited paths from the thread worktree", () =>
    Effect.gen(function* () {
      expect(yield* resolve({}, undefined, "codex-relative")).toBe(
        "/project/worktree/codex-relative",
      );
      expect(yield* resolve({}, undefined, "~/.codex-literal")).toBe(
        "/project/worktree/~/.codex-literal",
      );
    }),
  );

  it.effect("keeps configured, shadow, and managed shared-home precedence", () =>
    Effect.gen(function* () {
      const environment = [variable("/provider/codex")];
      expect(yield* resolve({ homePath: "~/configured" }, environment, "/ambient/codex")).toBe(
        "/test-user/configured",
      );
      expect(yield* resolve({ shadowHomePath: "/shadow" }, environment, "/ambient/codex")).toBe(
        "/test-user/.codex",
      );
      expect(yield* resolve({ setupMode: "managed" }, environment, "/ambient/codex")).toBe(
        "/test-user/.codex",
      );
    }),
  );

  it.effect("uses the default home when absent or cleared by the provider", () =>
    Effect.gen(function* () {
      expect(yield* resolve({})).toBe("/test-user/.codex");
      expect(yield* resolve({}, [variable("")], "/ambient/codex")).toBe("/test-user/.codex");
    }),
  );
});
