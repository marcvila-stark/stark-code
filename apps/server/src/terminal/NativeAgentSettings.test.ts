import { nativeAgentLaunch } from "./NativeAgentLaunch.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  mergeNativeSettings,
  prepareNativeClaudeSettings,
  prepareNativeCodexCaptureArgs,
} from "./NativeAgentSettings.ts";
import { parse as parseToml } from "smol-toml";

describe("native Codex capture settings", () => {
  it("preserves notify and other CLI config while combining inline Stop hooks", () => {
    const notify = 'notify=["node", "computer-use.js"]';
    const result = prepareNativeCodexCaptureArgs(
      [
        "-c",
        notify,
        "--config",
        'hooks={ Stop=[{ hooks=[{ type="command", command="existing" }] }], PreToolUse=[{ matcher="Bash", hooks=[{type="command",command="guard"}] }] }',
        "--config=hooks.Stop=[{ hooks=[{type='command',command='second'}] }]",
        "--config",
        'model_reasoning_effort="high"',
      ],
      "ELECTRON_RUN_AS_NODE=1 '/Applications/Stark Code' '/private/capture.cjs'",
    );
    expect(result.slice(0, 4)).toEqual(["-c", notify, "--config", 'model_reasoning_effort="high"']);
    const settings = parseToml(result.at(-1)!);
    expect(settings).toMatchObject({
      hooks: {
        Stop: [
          { hooks: [{ command: "existing" }] },
          { hooks: [{ command: "second" }] },
          { hooks: [{ type: "command", async: true, timeout: 5 }] },
        ],
        PreToolUse: [{ hooks: [{ command: "guard" }] }],
      },
    });
    expect(result).not.toContain("--dangerously-bypass-hook-trust");
  });

  it("recognizes quoted TOML hook keys and leaves prompt-shaped options untouched", () => {
    const prompt = ["--", "--config", "hooks.Stop=not a setting"];
    const result = prepareNativeCodexCaptureArgs(
      ["-c", '"hooks"."Stop"=[{hooks=[{type="command",command="kept"}]}]', ...prompt],
      "capture",
    );
    expect(result.slice(-3)).toEqual(prompt);
    expect(parseToml(result[1]!)).toMatchObject({
      hooks: { Stop: [{ hooks: [{ command: "kept" }] }, { hooks: [{ command: "capture" }] }] },
    });
  });

  it("refuses malformed custom hooks rather than silently replacing them", () => {
    expect(() => prepareNativeCodexCaptureArgs(["-c", "hooks=broken"], "capture")).toThrow();
  });
});

describe("native Claude settings", () => {
  it("keeps a user's Stop and publishing hooks alongside asynchronous reply capture", () => {
    const launch = nativeAgentLaunch({
      driver: "claudeAgent",
      config: {},
      home: "/tmp",
      replyCaptureCommand: "capture",
    });
    const app = JSON.parse(launch.args.at(-1)!);
    const merged = mergeNativeSettings(
      {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "existing-stop" }] }],
          PreToolUse: [
            { matcher: "pages_upload", hooks: [{ type: "command", command: "publish-guard" }] },
          ],
        },
      },
      app,
    );
    expect(merged.hooks).toMatchObject({
      Stop: [
        { hooks: [{ command: "existing-stop" }] },
        { hooks: [{ command: "capture", async: true }] },
      ],
      PreToolUse: [{ matcher: "pages_upload" }, { matcher: "*" }],
    });
    expect(app.permissions.disableBypassPermissionsMode).toBe("disable");
  });
  it("keeps configured hooks and permission rules while locking bypass mode", () => {
    const hooks = {
      PreToolUse: [
        { matcher: "pages_upload", hooks: [{ type: "command", command: "publish-guard" }] },
      ],
    };
    const merged = mergeNativeSettings(
      { hooks, permissions: { allow: ["Read"] }, language: "english" },
      { disableAutoMode: "disable", permissions: { disableBypassPermissionsMode: "disable" } },
    );
    expect(merged.hooks).toEqual(hooks);
    expect(merged.permissions).toEqual({
      allow: ["Read"],
      disableBypassPermissionsMode: "disable",
    });
    expect(merged.disableAutoMode).toBe("disable");
    expect(merged.language).toBe("english");
  });
  it("keeps plugin hooks and user environment while overriding reporting settings", () => {
    const launch = nativeAgentLaunch({ driver: "claudeAgent", config: {}, home: "/tmp" });
    const policy = JSON.parse(launch.args.at(-1)!);
    const merged = mergeNativeSettings(
      {
        env: {
          KEEP_PLUGIN_CONFIG: "yes",
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_TRACES_EXPORTER: "otlp",
        },
        hooks: { PreToolUse: [{ matcher: "pages_upload" }] },
      },
      policy,
    );
    expect(merged.env).toMatchObject({
      KEEP_PLUGIN_CONFIG: "yes",
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      OTEL_TRACES_EXPORTER: "none",
    });
    expect(merged.hooks).toEqual({
      PreToolUse: [{ matcher: "pages_upload" }, ...policy.hooks.PreToolUse],
    });
  });
  it("does not change an object's prototype when settings contain an own __proto__ key", () => {
    const merged = mergeNativeSettings({}, JSON.parse('{"__proto__":{"unsafe":true}}'));
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(({} as { unsafe?: boolean }).unsafe).toBeUndefined();
  });
  it("preserves both publish and child-agent guards without merging ordinary arrays", () => {
    const publish = {
      matcher: "pages_upload",
      hooks: [{ type: "command", command: "publish-guard" }],
    };
    const child = { matcher: "Agent|Task", hooks: [{ type: "command", command: "child-guard" }] };
    const base = {
      hooks: {
        PreToolUse: [publish],
        Stop: [{ hooks: [{ type: "command", command: "on-stop" }] }],
      },
      permissions: { allow: ["Read"] },
      nested: { hooks: { PreToolUse: ["ordinary"] } },
    };
    const merged = mergeNativeSettings(base, {
      hooks: { PreToolUse: [child] },
      permissions: { allow: ["Glob"] },
      nested: { hooks: { PreToolUse: ["replacement"] } },
    });
    expect(merged.hooks).toEqual({ ...base.hooks, PreToolUse: [publish, child] });
    expect(merged.permissions).toEqual({ allow: ["Glob"] });
    expect(merged.nested).toEqual({ hooks: { PreToolUse: ["replacement"] } });
    expect(base.hooks.PreToolUse).toEqual([publish]);
  });
  it("keeps prototype-like keys as own data even inside hooks", () => {
    const merged = mergeNativeSettings(
      JSON.parse('{"hooks":{"__proto__":[{"command":"custom"}]}}'),
      JSON.parse(
        '{"hooks":{"__proto__":[{"command":"mandatory"}]},"constructor":{"prototype":{"unsafe":true}}}',
      ),
    );
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    const hooks = merged.hooks as Record<string, unknown>;
    expect(Object.getPrototypeOf(hooks)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(hooks, "__proto__")?.value).toEqual([
      { command: "custom" },
      { command: "mandatory" },
    ]);
    expect(({} as { unsafe?: boolean }).unsafe).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("native Claude settings preparation", (it) => {
  it.effect(
    "merges file and inline guards before the delimiter while preserving a settings-shaped prompt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "stark-native-settings-" });
        const lifetime = yield* Effect.scope;
        const publish = {
          matcher: "pages_upload",
          hooks: [{ type: "command", command: "publish-guard" }],
        };
        const child = {
          matcher: "Agent|Task",
          hooks: [{ type: "command", command: "child-guard" }],
        };
        yield* fs.writeFileString(
          path.join(cwd, "custom.json"),
          JSON.stringify({
            model: "haiku",
            availableModels: ["sonnet"],
            env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "haiku", KEEP_PLUGIN: "value" },
            hooks: { PreToolUse: [publish] },
            permissions: { allow: ["Read"] },
          }),
        );
        const prompt = [
          "--",
          "--settings",
          "/this-is-prompt-not-a-file.json",
          "--settings={literal prompt}",
        ];
        const args = yield* prepareNativeClaudeSettings({
          args: [
            "--model",
            "sonnet",
            "--settings=custom.json",
            "--settings",
            JSON.stringify({ hooks: { PreToolUse: [child] }, disableAllHooks: false }),
            ...prompt,
          ],
          cwd,
          home: cwd,
          stateDir: cwd,
          lifetime,
        });
        expect(args.slice(0, 3)).toEqual(["--model", "sonnet", "--settings"]);
        expect(args.slice(4)).toEqual(prompt);
        expect(args.filter((arg) => arg === "--settings")).toHaveLength(2);
        const saved = JSON.parse(yield* fs.readFileString(args[3]!));
        expect(saved).toMatchObject({
          model: "claude-sonnet-5-5",
          availableModels: ["sonnet"],
          env: {
            ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5",
            CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5-5",
            CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
            KEEP_PLUGIN: "value",
          },
          hooks: { PreToolUse: [publish, child] },
          permissions: { allow: ["Read"] },
          disableAllHooks: false,
        });
        expect(JSON.parse(yield* fs.readFileString(path.join(cwd, "custom.json"))).model).toBe(
          "haiku",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("does not parse prompt settings when only one real settings argument exists", () =>
    Effect.gen(function* () {
      const lifetime = yield* Effect.scope;
      const args = [
        "--settings",
        '{"disableAllHooks":false}',
        "--",
        "--settings",
        "/not-a-file",
        "--settings=also-not-a-file",
      ];
      expect(
        yield* prepareNativeClaudeSettings({
          args,
          cwd: "/missing",
          home: "/missing",
          stateDir: "/missing",
          lifetime,
        }),
      ).toEqual(args);
    }).pipe(Effect.scoped),
  );

  it.effect("does not consume the delimiter as a missing settings value", () =>
    Effect.gen(function* () {
      const lifetime = yield* Effect.scope;
      const error = yield* prepareNativeClaudeSettings({
        args: ["--settings", "--", "literal prompt"],
        cwd: "/missing",
        home: "/missing",
        stateDir: "/missing",
        lifetime,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("NativeAgentSettingsInvalidError");
    }).pipe(Effect.scoped),
  );
});
