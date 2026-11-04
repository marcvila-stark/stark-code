/**
 * PLAN-002 §6.4: changing where new chats take their permissions from must
 * not change what a native terminal launches with. The terminal keeps its own
 * launch-argument policy (C8) for both providers.
 */
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceConfig } from "@starkfuture/contracts";
import * as Schema from "effect/Schema";

import { nativeAgentLaunch } from "./NativeAgentLaunch.ts";

const decodeInstance = Schema.decodeUnknownSync(ProviderInstanceConfig);

const launchArgs = (instance: ProviderInstanceConfig) =>
  nativeAgentLaunch({
    driver: instance.driver,
    config: instance.config ?? {},
    home: "/tmp/native-permissions",
    platform: "linux",
    nodeExecutable: "node",
  }).args;

const CASES = [
  ["claudeAgent", {}],
  ["claudeAgent", { launchArgs: "--permission-mode acceptEdits" }],
  ["claudeAgent", { allowBypassPermissions: true }],
  ["codex", {}],
  ["codex", { launchArgs: "-c model_reasoning_effort=high" }],
] as const;

describe("native terminals ignore the new-chat permission source", () => {
  it.each(CASES)("%s %j launches the same whatever new chats default to", (driver, config) => {
    const unset = launchArgs(decodeInstance({ driver, config }));
    for (const newChatPermissionSource of ["inherit", "override"] as const) {
      expect(launchArgs(decodeInstance({ driver, config, newChatPermissionSource }))).toEqual(
        unset,
      );
    }
  });

  it("keeps Codex terminals Supervised when new Codex chats inherit Codex's settings", () => {
    const args = launchArgs(
      decodeInstance({ driver: "codex", config: {}, newChatPermissionSource: "inherit" }),
    );
    expect(args).toEqual(expect.arrayContaining(["--ask-for-approval", "--sandbox", "read-only"]));
    expect(args).not.toContain("never");
    expect(args).not.toContain("danger-full-access");
  });

  it("keeps Claude terminals on their own mode when new Claude chats inherit", () => {
    const args = launchArgs(
      decodeInstance({ driver: "claudeAgent", config: {}, newChatPermissionSource: "inherit" }),
    );
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
    expect(args).not.toContain("bypassPermissions");
  });
});
