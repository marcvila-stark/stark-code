import type { ResolvedSettings, Settings } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, ProviderSessionId } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makePendingClaudeProvider, readClaudeConfiguredPermissions } from "./ClaudeProvider.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

const key = {
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerSessionId: ProviderSessionId.make("provider-session-configured"),
  cwd: "/repo",
};

/** A resolved cascade, low to high precedence, with `effective` merged the way the CLI merges. */
function cascade(
  sources: ReadonlyArray<{
    readonly source: "user" | "project" | "local";
    readonly settings: Settings;
  }>,
): ResolvedSettings {
  const effective: Settings = {};
  for (const { settings } of sources) {
    Object.assign(effective, settings, {
      permissions: { ...effective.permissions, ...settings.permissions },
    });
  }
  return { effective, provenance: {}, sources: sources.map((entry) => ({ ...entry })) };
}

const read = (input: {
  readonly resolved?: ResolvedSettings;
  readonly fails?: boolean;
  readonly homePath?: string;
  readonly allowBypassPermissions?: boolean;
}) =>
  readClaudeConfiguredPermissions({
    ...key,
    settings: {
      homePath: input.homePath ?? "",
      allowBypassPermissions: input.allowBypassPermissions ?? false,
    },
    environment: {},
    serverEnvironment: {},
    resolve: (options) =>
      input.fails === true
        ? Promise.reject(new Error("unreadable"))
        : Promise.resolve(options?.cwd === key.cwd ? input.resolved! : cascade([])),
  }).pipe(Effect.provide(NodeServices.layer));

describe("Claude configured permissions", () => {
  it.effect("reports the profile's settings as configured, after Claude's trust filter", () =>
    Effect.gen(function* () {
      const configured = yield* read({
        resolved: cascade([
          {
            source: "user",
            settings: {
              disableAllHooks: true,
              permissions: {
                allow: ["Bash(npm test)"],
                deny: ["Read(.env)"],
                ask: ["Bash(git push:*)"],
              },
            },
          },
          // A repo-committed escalating default is not honoured by Claude.
          { source: "project", settings: { permissions: { defaultMode: "bypassPermissions" } } },
        ]),
      });
      assert.deepInclude(configured, {
        ...key,
        status: "configured",
        label: "configured",
        defaultMode: null,
        defaultModeSource: null,
        bypassDisabled: false,
        hooksDisabled: true,
        rules: { allow: 1, ask: 1, deny: 1 },
        additionalDirectories: [],
      });
      assert.deepEqual(configured.liveRules, {
        status: "unknown",
        reason: "Not reported by Claude SDK 0.3.276.",
      });
    }),
  );

  it.effect("names the settings file that chose the default mode", () =>
    Effect.gen(function* () {
      const configured = yield* read({
        resolved: cascade([
          { source: "user", settings: { permissions: { defaultMode: "default" } } },
          {
            source: "local",
            settings: {
              permissions: {
                defaultMode: "acceptEdits",
                disableBypassPermissionsMode: "disable",
                additionalDirectories: ["/shared"],
              },
            },
          },
        ]),
      });
      assert.deepInclude(configured, {
        status: "configured",
        defaultMode: "acceptEdits",
        defaultModeSource: "local",
        bypassDisabled: true,
        additionalDirectories: ["/shared"],
      });
    }),
  );

  it.effect.each([
    { allowBypassPermissions: true, policy: "stark-children-never-bypass" },
    { allowBypassPermissions: false, policy: "stark-bypass-opt-in" },
  ])("labels Stark's own rule (Bypass opt-in $allowBypassPermissions)", (scenario) =>
    Effect.gen(function* () {
      const configured = yield* read({
        resolved: cascade([]),
        allowBypassPermissions: scenario.allowBypassPermissions,
      });
      assert.deepEqual(
        configured.starkPolicies.map((policy) => policy.id),
        [scenario.policy],
      );
      assert.match(configured.starkPolicies[0]!.label, /^Stark policy: /);
    }),
  );

  it.effect("is unknown, never guessed, when the settings cannot be read", () =>
    Effect.gen(function* () {
      assert.deepInclude(yield* read({ fails: true }), {
        status: "unknown",
        reason: "Claude's settings could not be read.",
      });
      // An account with its own Claude folder reads settings the server cannot resolve here.
      assert.deepInclude(yield* read({ resolved: cascade([]), homePath: "/accounts/work" }), {
        status: "unknown",
        reason:
          "This Claude account keeps its settings in its own folder, which Stark cannot read.",
      });
    }),
  );
});

describe("Claude provider presentation", () => {
  it.effect("lets chats inherit the profile's own permission settings", () =>
    Effect.gen(function* () {
      const provider = yield* makePendingClaudeProvider(DEFAULT_CLAUDE_SETTINGS);
      assert.isTrue(provider.nativePermissionInherit);
    }),
  );
});
