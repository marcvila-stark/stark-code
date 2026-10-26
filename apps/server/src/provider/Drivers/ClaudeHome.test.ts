import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
  usesSharedClaudeLoginHome,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("identifies the actual host login home without credential access", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const shared = path.resolve(NodeOS.homedir(), ".claude");
        expect(yield* usesSharedClaudeLoginHome({ homePath: "" }, {})).toBe(true);
        expect(yield* usesSharedClaudeLoginHome({ homePath: "~/.claude" }, {})).toBe(true);
        expect(yield* usesSharedClaudeLoginHome({ homePath: shared }, {})).toBe(true);
        // The default instance can override homePath too; its name is no proof of identity.
        expect(yield* usesSharedClaudeLoginHome({ homePath: "~/.claude-work" }, {})).toBe(false);
        expect(
          yield* usesSharedClaudeLoginHome(
            { homePath: "" },
            { CLAUDE_CONFIG_DIR: "/tmp/other/.claude" },
          ),
        ).toBe(false);
        expect(
          yield* usesSharedClaudeLoginHome({ homePath: "" }, { CLAUDE_CONFIG_DIR: shared }),
        ).toBe(true);
        expect(
          yield* usesSharedClaudeLoginHome({ homePath: shared }, { HOME: "/tmp/other-home" }),
        ).toBe(false);
      }),
    );

    it.effect("does not advertise shared switching when credentials are overridden", () =>
      Effect.gen(function* () {
        for (const name of [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
          "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
          "CLAUDE_SECURESTORAGE_CONFIG_DIR",
          "ANTHROPIC_BASE_URL",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_VERTEX",
          "CLAUDE_CODE_USE_FOUNDRY",
        ]) {
          expect(
            yield* usesSharedClaudeLoginHome({ homePath: "~/.claude" }, { [name]: "configured" }),
            name,
          ).toBe(false);
        }
      }),
    );

    it.effect("overrides inherited helper choices without mutating the caller's environment", () =>
      Effect.gen(function* () {
        const environment = {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
          CLAUDE_CODE_SUBAGENT_MODEL: "opus",
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0",
          KEEP: "value",
        };
        const resolved = yield* makeClaudeEnvironment({ homePath: "" }, environment);
        expect(resolved).toMatchObject({
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-5-5",
          CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5-5",
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
          KEEP: "value",
        });
        expect(environment.CLAUDE_CODE_SUBAGENT_MODEL).toBe("opus");
      }),
    );

    it.effect(
      "isolates an OpenRouter config without a home instead of borrowing Claude login files",
      () =>
        Effect.gen(function* () {
          const env = yield* makeClaudeEnvironment(
            { homePath: "", apiBackend: "openrouter" },
            {
              CLAUDE_CONFIG_DIR: "/someone/claude",
              CLAUDE_CODE_OAUTH_TOKEN: "test-other-login",
              ANTHROPIC_AUTH_TOKEN: "test-router-key",
            },
          );
          expect(env.CLAUDE_CONFIG_DIR?.replaceAll("\\", "/")).toMatch(
            /stark-code\/openrouter\/default$/,
          );
          expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
          expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-router-key");
          expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
        }),
    );

    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toMatchObject(process.env);

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
