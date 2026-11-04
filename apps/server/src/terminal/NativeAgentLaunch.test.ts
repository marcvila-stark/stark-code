import { CODEX_PRIVACY_ARGS, PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import { STARK_PAGES_ENV } from "@starkfuture/shared/starkPages";
import { describe, expect, it } from "@effect/vitest";
import { nativeAgentLaunch } from "./NativeAgentLaunch.ts";
// @effect-diagnostics nodeBuiltinImport:off -- exercise the generated native CLI hook command.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderInstanceConfig } from "@starkfuture/contracts";

const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);

const defaultCodexPolicy = [
  "--ask-for-approval",
  "on-request",
  "--sandbox",
  "read-only",
  "-c",
  'approvals_reviewer="user"',
  "-c",
  "sandbox_workspace_write.network_access=false",
  "--no-daemon",
];

describe("native agent shell launch", () => {
  it("recognizes existing environment-only OpenRouter native connections", () => {
    const launch = nativeAgentLaunch({
      driver: "claudeAgent",
      config: { launchArgs: "--model claude-sonnet-5-5" },
      home: "/tmp",
      environment: { ANTHROPIC_BASE_URL: "https://openrouter.ai/api" },
    });
    expect(launch.args.slice(0, 2)).toEqual(["--model", "anthropic/claude-sonnet-5.5"]);
  });
  it("uses gateway model IDs in native OpenRouter launches without embedding the API key", () => {
    const launch = nativeAgentLaunch({
      driver: "claudeAgent",
      config: { apiBackend: "openrouter", launchArgs: "--model opus" },
      home: "/tmp",
      environment: { ANTHROPIC_AUTH_TOKEN: "test-router-key" },
    });
    expect(launch.args.slice(0, 2)).toEqual(["--model", "anthropic/claude-opus-5.5"]);
    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    expect(settings.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("anthropic/claude-sonnet-5.5");
    expect(JSON.stringify(launch)).not.toContain("test-router-key");
  });

  it.each(["inherit", "override"] as const)(
    "keeps a Claude terminal's own permission flags when new chats default to %s",
    (source) => {
      // The terminal manager launches with the instance's `config` only; the instance's
      // new-chat permission source sits beside it and never reaches the terminal.
      const instance = (config: Record<string, unknown>, newChatPermissionSource?: typeof source) =>
        decodeProviderInstanceConfig({
          driver: "claudeAgent",
          config,
          ...(newChatPermissionSource === undefined ? {} : { newChatPermissionSource }),
        });
      const launch = (config: ProviderInstanceConfig) =>
        nativeAgentLaunch({
          driver: config.driver,
          config: config.config ?? {},
          home: "/tmp",
          platform: "linux",
          nodeExecutable: "node",
        }).args;
      expect(launch(instance({}, source))).toEqual(launch(instance({})));
      expect(launch(instance({}, source))).toEqual(
        expect.arrayContaining(["--permission-mode", "default"]),
      );
      const acceptEdits = { launchArgs: "--permission-mode acceptEdits" };
      expect(launch(instance(acceptEdits, source))).toEqual(launch(instance(acceptEdits)));
      expect(launch(instance(acceptEdits, source))).not.toContain("default");
    },
  );
  it.each([
    "--model haiku",
    "--model=claude-haiku-5-5",
    "--fallback-model haiku",
    "--advisor=claude-haiku-4-5",
  ])("refuses an explicit Haiku launch: %s", (launchArgs) => {
    expect(() =>
      nativeAgentLaunch({ driver: "claudeAgent", config: { launchArgs }, home: "/tmp" }),
    ).toThrow("Haiku is disabled");
  });
  it("pins helpers to Sonnet while preserving the main model and literal prompt", () => {
    const { args } = nativeAgentLaunch({
      driver: "claudeAgent",
      config: {
        launchArgs: "--model opus -- --model haiku",
        customModels: ["haiku", "custom-sonnet"],
      },
      home: "/tmp",
    });
    expect(args.slice(0, 2)).toEqual(["--model", "opus"]);
    expect(args.slice(-3)).toEqual(["--", "--model", "haiku"]);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings).not.toHaveProperty("availableModels");
    expect(settings.env).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-5-5",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5-5",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    });
  });
  it("adds the bundled kit before the prompt while preserving user plugins, hooks and permission policy", () => {
    const launch = nativeAgentLaunch({
      driver: "claudeAgent",
      config: { launchArgs: '--plugin-dir "/custom kit" --permission-mode plan -- literal prompt' },
      home: "/home/test",
      workbenchRoot: "/Applications/Stark Code/Resources/stark-workbench",
      nodeExecutable: "/Applications/Stark Code/MacOS/Stark Code",
    });
    expect(launch.args.slice(0, 6)).toEqual([
      "--plugin-dir",
      "/custom kit",
      "--permission-mode",
      "plan",
      "--plugin-dir",
      "/Applications/Stark Code/Resources/stark-workbench",
    ]);
    expect(launch.args.slice(-3)).toEqual(["--", "literal", "prompt"]);
    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    expect(settings.env).toMatchObject({
      STARK_WORKBENCH_NODE: "/Applications/Stark Code/MacOS/Stark Code",
      STARK_WORKBENCH_MANAGED_MIRROR: "1",
    });
    expect(settings.hooks.PreToolUse[0].matcher).toBe("*");
    expect(settings.permissions.disableBypassPermissionsMode).toBe("disable");
    const again = nativeAgentLaunch({
      driver: "claudeAgent",
      config: { launchArgs: "--plugin-dir /kit" },
      home: "/home/test",
      workbenchRoot: "/kit",
    });
    expect(again.args.filter((arg) => arg === "/kit")).toHaveLength(1);
  });
  it("runs Codex interactively rather than starting its app server", () => {
    expect(nativeAgentLaunch({ driver: "codex", config: {}, home: "/Users/test" })).toEqual({
      shell: "codex",
      args: [...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS],
    });
  });
  it("keeps Claude plugin arguments and executable paths as distinct argv values", () => {
    const launch = nativeAgentLaunch({
      driver: "claudeAgent",
      config: {
        binaryPath: "~/Tools/Claude Code/claude",
        launchArgs: '--plugin-dir "/Users/test/My plugins"',
      },
      home: "/Users/test",
    });
    expect(launch.shell).toBe("/Users/test/Tools/Claude Code/claude");
    expect(launch.args.slice(0, 5)).toEqual([
      "--plugin-dir",
      "/Users/test/My plugins",
      "--permission-mode",
      "default",
      "--settings",
    ]);
    expect(JSON.parse(launch.args[5]!)).toMatchObject({
      disableAllHooks: false,
      permissions: { disableBypassPermissionsMode: "disable" },
      env: { ...PROVIDER_PRIVACY_ENV, ...STARK_PAGES_ENV },
    });
  });
  it.each(["manual", "auto", "acceptEdits", "plan", "dontAsk"])(
    "preserves Claude's explicit %s mode while keeping Bypass locked",
    (mode) => {
      const { args } = nativeAgentLaunch({
        driver: "claudeAgent",
        home: "/tmp",
        config: { launchArgs: `--permission-mode ${mode}` },
      });
      expect(args.slice(0, 2)).toEqual(["--permission-mode", mode]);
      expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toMatchObject({
        permissions: { disableBypassPermissionsMode: "disable" },
        env: { ...PROVIDER_PRIVACY_ENV, ...STARK_PAGES_ENV },
      });
    },
  );
  it.each([
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode bypassPermissions",
    "--permission-mode=bypassPermissions",
  ])("requires account opt-in for %s", (launchArgs) => {
    expect(() =>
      nativeAgentLaunch({ driver: "claudeAgent", home: "/tmp", config: { launchArgs } }),
    ).toThrow("Enable Allow Bypass");
    const launch = nativeAgentLaunch({
      driver: "claudeAgent",
      home: "/tmp",
      config: { launchArgs, allowBypassPermissions: true },
    });
    expect(JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!)).not.toHaveProperty(
      "permissions.disableBypassPermissionsMode",
    );
  });
  it("does not treat prompt text after -- as unsafe flags", () => {
    const launch = nativeAgentLaunch({
      driver: "claudeAgent",
      home: "/tmp",
      config: { launchArgs: '-- "--dangerously-skip-permissions"' },
    });
    expect(launch.args.slice(-2)).toEqual(["--", "--dangerously-skip-permissions"]);
  });
  it.effect("runs the native child guard and denies inherited Bypass", (ctx) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return ctx.skip("POSIX hook command");
      const launch = nativeAgentLaunch({
        driver: "claudeAgent",
        home: "/tmp",
        config: { allowBypassPermissions: true },
      });
      const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
      expect(settings.hooks.PreToolUse[0].matcher).toBe("*");
      const command = settings.hooks.PreToolUse[0].hooks[0].command;
      for (const mode of ["bypassPermissions", undefined]) {
        const result = NodeChildProcess.execFileSync("/bin/sh", ["-c", command], {
          input: JSON.stringify({ tool_name: "Agent", permission_mode: mode }),
          encoding: "utf8",
        });
        expect(JSON.parse(result).hookSpecificOutput.permissionDecision).toBe("deny");
      }
      expect(
        NodeChildProcess.execFileSync("/bin/sh", ["-c", command], {
          input: JSON.stringify({ tool_name: "Agent", permission_mode: "auto" }),
          encoding: "utf8",
        }),
      ).toBe("");
      for (const toolName of ["Bash", "Write"]) {
        const result = NodeChildProcess.execFileSync("/bin/sh", ["-c", command], {
          input: JSON.stringify({
            tool_name: toolName,
            permission_mode: "bypassPermissions",
            agent_id: "custom-agent",
          }),
          encoding: "utf8",
        });
        expect(JSON.parse(result).hookSpecificOutput.permissionDecision).toBe("deny");
      }
      for (const hook of [
        { tool_name: "Bash", permission_mode: "bypassPermissions" },
        { tool_name: "Write", permission_mode: "acceptEdits", agent_id: "custom-agent" },
      ]) {
        expect(
          NodeChildProcess.execFileSync("/bin/sh", ["-c", command], {
            input: JSON.stringify(hook),
            encoding: "utf8",
          }),
        ).toBe("");
      }
      expect(
        JSON.parse(
          NodeChildProcess.execFileSync("/bin/sh", ["-c", command], {
            input: "not-json",
            encoding: "utf8",
          }),
        ).hookSpecificOutput.permissionDecision,
      ).toBe("deny");
      const refused = nativeAgentLaunch({
        driver: "claudeAgent",
        home: "/tmp",
        config: {},
        nodeExecutable: "/nonexistent/stark-node",
      });
      const refusalCommand = JSON.parse(refused.args.at(-1)!).hooks.PreToolUse[0].hooks[0].command;
      expect(
        NodeChildProcess.spawnSync("/bin/sh", ["-c", refusalCommand], { input: "{}" }).status,
      ).toBe(2);
    }),
  );
  it.effect(
    "runs Windows Claude safety hooks with Bash syntax and the supplied node executable",
    (ctx) =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32")
          return ctx.skip("Bash command execution on POSIX host");
        const launch = nativeAgentLaunch({
          driver: "claudeAgent",
          config: {},
          home: "/tmp",
          platform: "win32",
          nodeExecutable: process.execPath,
          replyCaptureCommand: "ELECTRON_RUN_AS_NODE=1 '/capture node' '/capture script'",
        });
        const hooks = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!).hooks;
        expect(hooks.PreToolUse[0].hooks[0].shell).toBe("bash");
        expect(hooks.PreToolUse[0].hooks[0].onFailure).toBe("block");
        expect(hooks.Stop[0].hooks[0].shell).toBe("bash");
        expect(hooks.Notification[0].matcher).toBe("permission_prompt|elicitation_dialog");
        expect(hooks.Notification[0].hooks[0]).toMatchObject({
          shell: "bash",
          command: "ELECTRON_RUN_AS_NODE=1 '/capture node' '/capture script'",
        });
        expect(hooks.Stop[0].hooks[0]).toMatchObject({
          async: false,
          command: `${hooks.UserPromptSubmit[0].hooks[0].command} --attention-only`,
        });
        expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe(hooks.Stop[0].hooks[1].command);
        const result = NodeChildProcess.execFileSync(
          "/bin/bash",
          ["-c", hooks.PreToolUse[0].hooks[0].command],
          {
            env: { PATH: "/usr/bin:/bin" },
            input: JSON.stringify({ tool_name: "Agent", permission_mode: "bypassPermissions" }),
            encoding: "utf8",
          },
        );
        expect(JSON.parse(result).hookSpecificOutput.permissionDecision).toBe("deny");
      }),
  );

  it("does not interpret shell substitutions in configuration", () => {
    const result = nativeAgentLaunch({
      driver: "codex",
      config: {
        binaryPath: "/tmp/codex; touch /tmp/unwanted",
        launchArgs: '--config "name=$(whoami)"',
      },
      home: "/Users/test",
    });
    expect(result.shell).toBe("/tmp/codex; touch /tmp/unwanted");
    expect(result.args).toEqual([
      "--config",
      "name=$(whoami)",
      ...defaultCodexPolicy,
      ...CODEX_PRIVACY_ARGS,
    ]);
  });
  it("keeps explicitly configured permission policies", () => {
    expect(
      nativeAgentLaunch({ driver: "codex", home: "/tmp", config: { launchArgs: "-a untrusted" } })
        .args,
    ).toEqual([...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS]);
    expect(
      nativeAgentLaunch({
        driver: "claudeAgent",
        home: "/tmp",
        config: { launchArgs: "--permission-mode plan" },
      }).args.slice(0, 2),
    ).toEqual(["--permission-mode", "plan"]);
  });
  it("overrides configured Codex reporting while preserving the selected profile and other settings", () => {
    const { args } = nativeAgentLaunch({
      driver: "codex",
      home: "/tmp",
      config: {
        launchArgs:
          '--profile "company profile" --config analytics.enabled=true -c otel.metrics_exporter="statsig" --config model="configured-model"',
      },
    });
    expect(args.slice(0, 8)).toEqual([
      "--profile",
      "company profile",
      "--config",
      "analytics.enabled=true",
      "-c",
      "otel.metrics_exporter=statsig",
      "--config",
      "model=configured-model",
    ]);
    expect(args.slice(-10)).toEqual([
      "-c",
      "analytics.enabled=false",
      "-c",
      'otel.exporter="none"',
      "-c",
      'otel.trace_exporter="none"',
      "-c",
      'otel.metrics_exporter="none"',
      "-c",
      "otel.log_user_prompt=false",
    ]);
  });
  it("retains the Codex launch restrictions", () => {
    for (const [driver, launchArgs] of [
      ["codex", "--yolo"],
      ["codex", "-a never"],
      ["codex", "-anever"],
      ["codex", "-a=never"],
      ["codex", "--ask-for-approval=never"],
      ["codex", "-s danger-full-access"],
      ["codex", "-sdanger-full-access"],
      ["codex", "-s=danger-full-access"],
      ["codex", "--sandbox danger-full-access"],
      ["codex", "--sandbox=danger-full-access"],
      ["codex", "--approve-for-me"],
      ["codex", "--not-so-yolo"],
      ["codex", "--dangerously-bypass-hook-trust"],
      ["codex", "--remote ws://localhost:1234"],
      ["codex", "-c 'approval_policy=\"never\"'"],
      ["codex", '-capproval_policy="never"'],
      ["codex", '--config=approval_policy="never"'],
      ["codex", '--config \'"approval_policy"="never"\''],
      ["codex", "-c 'sandbox_mode=\"danger-full-access\"'"],
      ["codex", "-c 'sandbox_mode=\"danger-full-access\"' -s workspace-write"],
      ["codex", "-c 'approvals_reviewer=\"auto_review\"'"],
      ["codex", "-c 'approval_policy={ sandbox_approval=false }'"],
    ] as const) {
      expect(() => nativeAgentLaunch({ driver, config: { launchArgs }, home: "/tmp" })).toThrow(
        "requires supervised",
      );
    }
  });
  it("retains safe sandbox flags and their stricter config overrides", () => {
    for (const launchArgs of [
      "-s read-only",
      "-sread-only",
      "-s=read-only",
      "--sandbox=read-only",
    ]) {
      const { args } = nativeAgentLaunch({ driver: "codex", config: { launchArgs }, home: "/tmp" });
      expect(args).toEqual([...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS]);
      expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual([
        "--sandbox",
        "read-only",
      ]);
    }
  });
  it("applies safe launch policy after personal profile configuration", () => {
    const { args } = nativeAgentLaunch({
      driver: "codex",
      home: "/tmp",
      config: { launchArgs: "--profile company --model company-model -c 'plugins.enabled=true'" },
    });
    expect(args.slice(0, 6)).toEqual([
      "--profile",
      "company",
      "--model",
      "company-model",
      "-c",
      "plugins.enabled=true",
    ]);
    expect(args.slice(6)).toEqual([...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS]);
  });
  it("refuses prompts after an options delimiter", () => {
    expect(() =>
      nativeAgentLaunch({
        driver: "codex",
        home: "/tmp",
        config: { launchArgs: '--profile company -- "explain these flags"' },
      }),
    ).toThrow("Remove --");
  });
  it("normalises repeated safe policy flags without duplicate CLI options", () => {
    const { args } = nativeAgentLaunch({
      driver: "codex",
      home: "/tmp",
      config: {
        launchArgs:
          "-s workspace-write --sandbox read-only -a on-request --ask-for-approval untrusted",
      },
    });
    expect(args.filter((arg) => arg === "--sandbox")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--ask-for-approval")).toHaveLength(1);
    expect(args).toEqual([...defaultCodexPolicy, ...CODEX_PRIVACY_ARGS]);
  });
  it("rejects unsupported providers instead of launching a different agent", () => {
    expect(() => nativeAgentLaunch({ driver: "unknown", config: {}, home: "/Users/test" })).toThrow(
      "supports Claude and Codex",
    );
  });
});
