import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { catalogText, makeClaudeSessionCatalog } from "./ClaudeSessionCatalog.ts";
import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";
const decodeRecordedJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("ClaudeSessionCatalog", (it) => {
  const setup = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stark-live-catalog-" });
    const home = path.join(root, "home");
    const cwd = path.join(root, "workspace");
    const write = Effect.fn(function* (file: string, text: string) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, text);
    });
    return { fs, path, root, home, cwd, write };
  });

  it.effect(
    "resolves bundled skill chips on the first send without running a query or injecting instructions",
    () =>
      Effect.gen(function* () {
        const { path, root, home, cwd, write } = yield* setup;
        const bundle = path.join(root, "bundle");
        for (const [file, contents] of [
          [".claude-plugin/plugin.json", '{"name":"stark-workbench"}'],
          ["packages/spage/bin/spage.js", "throw new Error('Do not execute')"],
          ["hooks/hooks.json", "{}"],
          ["node_modules/markdown-it/package.json", "{}"],
          [".stark-bundle.json", "{}"],
          [
            "skills/stark-pages/SKILL.md",
            "---\ndescription: Write pages\n---\nPRIVATE INSTRUCTIONS",
          ],
          ["skills/private/SKILL.md", "---\nuser-invocable: false\n---\n"],
          ["skills/disabled/SKILL.md", "---\ndescription: Disabled\n---\n"],
        ])
          yield* write(path.join(bundle, file!), contents!);
        yield* write(
          path.join(home, "settings.json"),
          '{"skillOverrides":{"stark-workbench:disabled":"off"}}',
        );
        let supportedCalls = 0;
        const catalog = yield* makeClaudeSessionCatalog({
          config: { homePath: home },
          cwd,
          environment: { STARK_WORKBENCH_ROOT: bundle },
          supportedCommands: () =>
            Effect.sync(() => {
              supportedCalls++;
              return [];
            }),
        });
        const names = yield* catalog.userInvocableSkillNames;
        assert.deepEqual([...names], ["stark-workbench:stark-pages"]);
        assert.deepEqual(
          planClaudeSkillDispatch("Please $stark-workbench:stark-pages explain this", names),
          {
            skillName: "stark-workbench:stark-pages",
            leadingText: "Please",
            commandText: "/stark-workbench:stark-pages explain this",
          },
        );
        assert.equal(supportedCalls, 0);
        assert.isFalse((yield* catalog.read).live);
        // Once the CLI has initialized, it alone decides which names are active.
        yield* catalog.onMessage({
          type: "system",
          subtype: "init",
          slash_commands: [],
          skills: [],
          plugins: [],
        });
        assert.deepEqual([...(yield* catalog.userInvocableSkillNames)], []);
        assert.isUndefined(
          planClaudeSkillDispatch(
            "$stark-workbench:stark-pages",
            yield* catalog.userInvocableSkillNames,
          ),
        );

        const invalid = yield* makeClaudeSessionCatalog({
          config: { homePath: home },
          environment: { STARK_WORKBENCH_ROOT: home },
          supportedCommands: () => Effect.die("No query should start"),
        });
        assert.deepEqual([...(yield* invalid.userInvocableSkillNames)], []);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "classifies live built-ins, bundled/personal/project skills, plugins, and both MCP forms",
    () =>
      Effect.gen(function* () {
        const { path, root, home, cwd, write } = yield* setup;
        yield* write(
          path.join(home, "skills", "personal", "SKILL.md"),
          "---\ndescription: Personal description\n---\n",
        );
        yield* write(
          path.join(cwd, ".claude", "skills", "project", "SKILL.md"),
          "---\ndescription: Project description\n---\n",
        );
        const pluginPath = path.join(root, "plugin");
        yield* write(path.join(pluginPath, ".claude-plugin", "plugin.json"), '{"name":"tools"}');
        yield* write(
          path.join(pluginPath, "skills", "deploy", "SKILL.md"),
          "---\ndescription: Deploy\n---\n",
        );
        const names = [
          "compact",
          "debug",
          "personal",
          "project",
          "tools:deploy",
          "mcp__claude_ai_Google_Drive__find",
          "plugin:tools:database:query",
          "uidotsh:search",
        ] as const;
        let calls = 0;
        const catalog = yield* makeClaudeSessionCatalog({
          config: { homePath: home },
          cwd,
          supportedCommands: () =>
            Effect.sync(() => {
              calls++;
              return names.map((name) => ({
                name,
                description: `${name} description`,
                argumentHint: "value",
              }));
            }),
        });
        const init = {
          type: "system",
          subtype: "init",
          slash_commands: names,
          skills: ["debug", "personal", "project", "tools:deploy"],
          plugins: [{ name: "tools", path: pluginPath }],
          mcp_servers: [
            { name: "claude.ai Google Drive", status: "needs-auth", source: "claudeai" },
            { name: "plugin:tools:database", status: "connected", source: "plugin" },
            { name: "uidotsh", status: "connected" },
          ],
        };
        yield* catalog.onMessage(init);
        yield* catalog.onMessage({ ...init, slash_commands: names.toReversed() });
        assert.equal(calls, 1);
        const read = yield* catalog.read;
        assert.isTrue(read.live);
        assert.deepEqual(
          read.commands.map(({ name, source, sourceName }) => ({
            name,
            source,
            ...(sourceName ? { sourceName } : {}),
          })),
          [
            { name: "compact", source: "builtin" },
            { name: "debug", source: "builtin" },
            { name: "personal", source: "personal" },
            { name: "project", source: "project" },
            { name: "tools:deploy", source: "plugin", sourceName: "tools" },
            { name: names[5], source: "mcp", sourceName: "claude.ai Google Drive" },
            { name: names[6], source: "mcp", sourceName: "plugin:tools:database" },
            { name: names[7], source: "mcp", sourceName: "uidotsh" },
          ],
        );
        assert.deepEqual(
          [...(yield* catalog.userInvocableSkillNames)],
          ["debug", "personal", "project", "tools:deploy"],
        );
      }),
  );

  it.effect(
    "replaces changed commands, strips controls, filters terminal/denied commands and aliases",
    () =>
      Effect.gen(function* () {
        const { home } = yield* setup;
        const catalog = yield* makeClaudeSessionCatalog({
          config: { homePath: home },
          supportedCommands: () => Effect.succeed([]),
        });
        assert.isFalse((yield* catalog.read).live);
        yield* catalog.onMessage({
          type: "system",
          subtype: "init",
          slash_commands: [
            "old",
            "debug",
            "clear",
            "resume",
            "rewind",
            "exit",
            "login",
            "logout",
            "terminal",
          ],
          skills: ["debug"],
          terminal_slash_commands: ["terminal"],
        });
        assert.deepEqual(
          (yield* catalog.read).commands.map((entry) => entry.name),
          ["old", "debug"],
        );
        yield* catalog.onMessage({
          type: "system",
          subtype: "commands_changed",
          commands: [
            {
              name: "\u001b[31mnew\u001b[0m",
              description: "ok\u0000\u202e",
              aliases: ["logout", "good"],
            },
            { name: "NEW" },
          ],
        });
        const read = yield* catalog.read;
        assert.deepEqual(read.commands, [
          { name: "new", source: "builtin", description: "ok", aliases: ["good"] },
        ]);
        assert.deepEqual(read.skills, []);
        assert.equal(catalogText("x".repeat(1000)), "x".repeat(128));
      }),
  );

  it.effect("handles every MCP source and older source-less servers", () =>
    Effect.gen(function* () {
      const { home } = yield* setup;
      const catalog = yield* makeClaudeSessionCatalog({
        config: { homePath: home },
        supportedCommands: () => Effect.succeed([]),
      });
      const sources = [
        "sdk",
        "plugin",
        "user",
        "project",
        "local",
        "dynamic",
        "managed",
        "enterprise",
        "claudeai",
        "agent",
      ];
      const servers = sources.map((source) => ({ name: source, status: "connected", source }));
      yield* catalog.onMessage({
        type: "system",
        subtype: "init",
        slash_commands: servers.map((server) => `${server.name}:prompt`),
        mcp_servers: [
          ...servers,
          { name: "old", status: "pending" },
          { name: "future", status: "pending", source: "future" },
        ],
      });
      assert.deepEqual(
        (yield* catalog.read).mcpServers.map((server) => server.source),
        [...sources, undefined, undefined],
      );
      assert.isTrue((yield* catalog.read).commands.every((command) => command.source === "mcp"));
    }),
  );

  it.effect(
    "scans loaded manifest/root skills read-only, refuses escaping symlinks and malformed/private skills",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, home, write } = yield* setup;
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        for (const directory of [first, second])
          yield* write(
            path.join(directory, ".claude-plugin", "plugin.json"),
            '{"name":"duplicate","skills":["extra"]}',
          );
        yield* write(path.join(first, "SKILL.md"), "---\ndescription: Root skill\n---\n");
        yield* write(
          path.join(first, "skills", "one", "SKILL.md"),
          "---\ndescription: One\n---\n!`never-run-this-command`\n",
        );
        yield* write(path.join(second, "extra", "two", "SKILL.md"), "---\ndescription: Two\n---\n");
        yield* write(
          path.join(first, "skills", "private", "SKILL.md"),
          "---\nuser-invocable: false\n---\n",
        );
        yield* write(
          path.join(first, "skills", "bad", "SKILL.md"),
          "---\ndescription: [broken\n---\n",
        );
        const outside = path.join(root, "outside");
        yield* write(path.join(outside, "SKILL.md"), "---\ndescription: Escape\n---\n");
        yield* fs.symlink(outside, path.join(first, "skills", "escape"));
        yield* write(path.join(first, "skills", "large", "SKILL.md"), "x".repeat(300_000));
        const names = [
          "duplicate:duplicate",
          "duplicate:one",
          "duplicate:two",
          "duplicate:private",
          "duplicate:bad",
          "duplicate:escape",
          "duplicate:large",
          "duplicate:no-file",
        ];
        const catalog = yield* makeClaudeSessionCatalog({
          config: { homePath: home },
          supportedCommands: () => Effect.succeed([]),
        });
        yield* catalog.onMessage({
          type: "system",
          subtype: "init",
          slash_commands: names,
          skills: names,
          plugins: [
            { name: "duplicate", path: first },
            { name: "duplicate", path: second },
          ],
        });
        const skills = (yield* catalog.read).skills;
        assert.deepEqual(
          skills
            .filter((skill) => !skill.path.startsWith("claude-skill:"))
            .map((skill) => skill.name),
          ["duplicate:duplicate", "duplicate:one", "duplicate:two"],
        );
        assert.isFalse(skills.some((skill) => skill.name === "duplicate:private"));
        assert.isFalse(skills.some((skill) => skill.name === "duplicate:bad"));
        assert.isTrue(skills.some((skill) => skill.name === "duplicate:no-file"));
        assert.isTrue(skills.every((skill) => skill.pluginName === "duplicate"));
      }),
  );

  it.effect(
    "reads the recorded native init fixture without changing its plugin or server identity",
    () =>
      Effect.gen(function* () {
        const { fs, home } = yield* setup;
        const text = yield* fs.readFileString(
          new URL(
            "../../orchestration-v2/testkit/fixtures/thread_fork_native_fork_local_rollback/claude_transcript.ndjson",
            import.meta.url,
          ).pathname,
        );
        const decoded = yield* Effect.forEach(text.split("\n").filter(Boolean), (line) =>
          decodeRecordedJson(line),
        );
        const lines = decoded.map((line) =>
          typeof line === "object" && line !== null && "frame" in line ? line.frame : line,
        );
        const init = lines.find(
          (line) =>
            typeof line === "object" &&
            line !== null &&
            "subtype" in line &&
            line.subtype === "init",
        );
        assert.isDefined(init);
        const catalog = yield* makeClaudeSessionCatalog({
          config: { homePath: home },
          supportedCommands: () => Effect.succeed([]),
        });
        yield* catalog.onMessage(init);
        const read = yield* catalog.read;
        assert.isTrue(read.live);
        assert.isTrue(
          read.commands.some(
            (command) => command.name === "coderabbit:review" && command.source === "plugin",
          ),
        );
        assert.isTrue(read.mcpServers.some((server) => server.name === "claude.ai Google Drive"));
      }),
  );
});
