import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";

import {
  claudeConfiguredPermissionRows,
  readClaudeConfiguredPermissions,
} from "./ClaudeEffectivePermissions.ts";
import { CLAUDE_BYPASS_OPT_IN_POLICY } from "../orchestration-v2/Adapters/ApprovalRulePolicy.ts";
import type { ClaudeConfiguredPermissions } from "./ClaudeProvider.ts";

const key = {
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerSessionId: ProviderSessionId.make("provider-session-effective"),
  cwd: "/repo",
  starkPolicies: [CLAUDE_BYPASS_OPT_IN_POLICY],
  liveRules: { status: "unknown", reason: "Not reported by Claude SDK 0.3.276." },
} as const;

const configured = (
  fields: Partial<Extract<ClaudeConfiguredPermissions, { status: "configured" }>>,
): ClaudeConfiguredPermissions => ({
  ...key,
  status: "configured",
  label: "configured",
  defaultMode: null,
  defaultModeSource: null,
  bypassDisabled: false,
  bypassDisabledSource: null,
  hooksDisabled: false,
  hooksDisabledSource: null,
  rules: { allow: 0, ask: 0, deny: 0 },
  ruleSources: [],
  additionalDirectories: [],
  additionalDirectoriesSource: null,
  ...fields,
});

const rowsById = (input: ClaudeConfiguredPermissions) =>
  Object.fromEntries(claudeConfiguredPermissionRows(input).rows.map((row) => [row.id, row]));

describe("Claude effective permission rows", () => {
  it("shows the configured mode with the settings file that set it, never as running", () => {
    const result = claudeConfiguredPermissionRows(
      configured({
        defaultMode: "acceptEdits",
        defaultModeSource: "local",
        hooksDisabled: true,
        hooksDisabledSource: "managed",
        rules: { allow: 2, ask: 1, deny: 0 },
        ruleSources: [
          { source: "user", allow: 1, ask: 1, deny: 0 },
          { source: "project", allow: 1, ask: 0, deny: 0 },
        ],
      }),
    );
    assert.deepEqual(result.configured, {
      permissionSource: "inherit",
      nativeMode: "acceptEdits",
      interactionMode: "default",
    });
    const rows = Object.fromEntries(result.rows.map((row) => [row.id, row]));
    assert.deepInclude(rows.configured, {
      kind: "configured",
      value: "Accept edits",
      nativeValue: "acceptEdits",
      origin: "local",
    });
    assert.deepInclude(rows["configured-hooks"], { origin: "managed" });
    assert.deepInclude(rows["configured-rules-user"], { value: "1 allow, 1 ask, 0 deny" });
    assert.deepInclude(rows["configured-rules-project"], { origin: "project" });
    // Live session rules stay unknown, and Stark's own rule is labelled as Stark's.
    assert.deepInclude(rows["active-rules"], { kind: "active", origin: "unknown" });
    assert.deepInclude(rows["stark-bypass-opt-in"], {
      kind: "stark-policy",
      origin: "stark-policy",
    });
  });

  it("says when no settings file chooses a mode", () => {
    assert.deepInclude(rowsById(configured({})).configured, {
      value: "Not set: Claude starts in Manual",
      nativeValue: "default",
    });
    assert.notProperty(
      claudeConfiguredPermissionRows(configured({})).configured ?? {},
      "nativeMode",
    );
  });

  it("reports unknown instead of guessing", () => {
    const result = claudeConfiguredPermissionRows({
      ...key,
      status: "unknown",
      reason: "Claude's settings could not be read.",
    });
    assert.isNull(result.configured);
    assert.deepInclude(result.rows[0], {
      id: "configured",
      value: "Unknown: Claude's settings could not be read",
      origin: "unknown",
    });
  });

  it.effect("reads nothing for a chat without a folder or a usable account", () =>
    Effect.gen(function* () {
      const base = {
        providerInstanceId: key.providerInstanceId,
        providerSessionId: null,
      };
      const noFolder = yield* readClaudeConfiguredPermissions({
        ...base,
        cwd: null,
        instance: { driver: "claudeAgent" as never },
      });
      assert.isNull(noFolder.configured);
      assert.equal(noFolder.rows[0]?.origin, "unknown");
      const removed = yield* readClaudeConfiguredPermissions({
        ...base,
        cwd: "/repo",
        instance: undefined,
      });
      assert.isNull(removed.configured);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
