import type {
  ClaudeSettings,
  ServerProviderSessionCatalog,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderMcpSource,
} from "@starkfuture/contracts";
import type { ProviderAdapterV2Error } from "@starkfuture/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeUtil from "node:util";
import { resolveStarkWorkbenchRoot } from "@starkfuture/shared/starkWorkbench";
import {
  applyClaudeSkillOverrides,
  discoverClaudeSkills,
  parseSkillFrontmatter,
} from "./ClaudeSkills.ts";

type Command = {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
};
type Plugin = { name: string; path: string };
const MAX_FILE_BYTES = 256 * 1024;
export const CLAUDE_PLUGIN_PERMISSION_WARNING =
  "This skill or plugin can pre-approve tools. Some tool calls may run without a Stark approval prompt.";
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const DENIED = new Set(["clear", "resume", "rewind", "exit", "login", "logout"]);
const SOURCES = new Set<string>([
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
]);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
const values = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value.slice(0, 2048) : [];

/** All provider metadata is third-party text; it stays plain text in the UI. */
export function catalogText(value: unknown, limit = 128): string {
  return typeof value === "string"
    ? NodeUtil.stripVTControlCharacters(value)
        .replace(/[\p{Cc}\p{Cf}]/gu, "")
        .trim()
        .slice(0, limit)
    : "";
}
function commandName(value: unknown): string {
  return catalogText(value).replace(/^\//, "").replace(/\s+/g, " ");
}
function parseCommands(value: unknown): Command[] {
  return values(value).flatMap((raw) => {
    const item = record(raw);
    const name = commandName(item?.name ?? raw);
    return name
      ? [
          {
            name,
            description: catalogText(item?.description, 500),
            argumentHint: catalogText(item?.argumentHint),
            aliases: values(item?.aliases).map(commandName).filter(Boolean).slice(0, 20),
          },
        ]
      : [];
  });
}
const parsePlugins = (value: unknown): Plugin[] =>
  values(value).flatMap((raw) => {
    const plugin = record(raw);
    const name = catalogText(plugin?.name);
    return name && typeof plugin?.path === "string" ? [{ name, path: plugin.path }] : [];
  });
const parseMcpServers = (value: unknown): ServerProviderSessionCatalog["mcpServers"] =>
  values(value).flatMap((raw) => {
    const server = record(raw);
    const name = catalogText(server?.name);
    const status = catalogText(server?.status);
    const source = server?.source;
    return name && status
      ? [
          {
            name,
            status,
            ...(typeof source === "string" && SOURCES.has(source)
              ? { source: source as ServerProviderMcpSource }
              : {}),
          },
        ]
      : [];
  });

/** Reads bounded descriptions under live CLI roots or the validated app-owned bundle. */
const scanPluginSkills = Effect.fn("ClaudeSessionCatalog.scanPluginSkills")(function* (
  plugins: readonly Plugin[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const result: ServerProviderSkill[] = [];
  for (const plugin of plugins.slice(0, 128)) {
    const root = yield* fs.realPath(plugin.path).pipe(Effect.orElseSucceed(() => undefined));
    if (!root) continue;
    const inside = (candidate: string) => {
      const relative = path.relative(root, candidate);
      return (
        !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      );
    };
    const read = Effect.fn(function* (candidate: string) {
      const real = yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => undefined));
      if (!real || !inside(real)) return undefined;
      const info = yield* fs.stat(real).pipe(Effect.orElseSucceed(() => undefined));
      if (!info || info.type !== "File" || info.size > BigInt(MAX_FILE_BYTES)) return undefined;
      return yield* fs.readFileString(real).pipe(Effect.orElseSucceed(() => undefined));
    });
    const manifestText = yield* read(path.join(root, ".claude-plugin", "plugin.json"));
    const manifest = manifestText
      ? record(yield* decodeManifest(manifestText).pipe(Effect.orElseSucceed(() => undefined)))
      : undefined;
    const pluginName = catalogText(manifest?.name) || plugin.name;
    const candidates = new Set<string>([path.join(root, "SKILL.md")]);
    const scanDirectory = Effect.fn(function* (directory: string) {
      const real = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined));
      if (!real || !inside(real)) return;
      candidates.add(path.join(real, "SKILL.md"));
      const children = yield* fs.readDirectory(real).pipe(Effect.orElseSucceed(() => []));
      for (const child of children.slice(0, 512))
        candidates.add(path.join(real, child, "SKILL.md"));
    });
    yield* scanDirectory(path.join(root, "skills"));
    const extra =
      typeof manifest?.skills === "string" ? [manifest.skills] : values(manifest?.skills);
    for (const raw of extra.slice(0, 64)) {
      if (typeof raw !== "string" || path.isAbsolute(raw)) continue;
      const candidate = path.resolve(root, raw);
      if (!inside(candidate)) continue;
      if (path.basename(candidate) === "SKILL.md") candidates.add(candidate);
      else yield* scanDirectory(candidate);
    }
    for (const candidate of [...candidates].slice(0, 1024)) {
      const contents = yield* read(candidate);
      if (contents === undefined) continue;
      const frontmatter = parseSkillFrontmatter(contents);
      const directory = path.dirname(candidate);
      const shortName = directory === root ? pluginName : catalogText(path.basename(directory));
      result.push({
        name: `${pluginName}:${shortName}`,
        pluginName,
        path: candidate,
        scope: "plugin",
        // Remember an invalid known file so it cannot reappear as a virtual,
        // description-less bundled skill just because init also named it.
        enabled: frontmatter.kind !== "malformed",
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: catalogText(frontmatter.description, 500) }
          : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocationOnly
          ? { userInvocationOnly: true }
          : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {}),
      });
    }
  }
  return result;
});

/** Metadata only; discovering a name does not authorize loading or executing its skill. */
export const discoverClaudeBundledSkills = Effect.fn("discoverClaudeBundledSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const root = yield* resolveStarkWorkbenchRoot(environment).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (!root) return [];
  const skills = yield* scanPluginSkills([{ name: "stark-workbench", path: root }]);
  return (yield* applyClaudeSkillOverrides(skills, config, cwd, environment))
    .filter((skill) => skill.enabled && skill.userInvocable !== false)
    .map((skill) => ({ ...skill, permissionWarning: CLAUDE_PLUGIN_PERMISSION_WARNING }));
});

/** A per-query memory cache. Reading it never starts a query or calls the SDK. */
export const makeClaudeSessionCatalog = Effect.fn("makeClaudeSessionCatalog")(function* (input: {
  readonly config: Pick<ClaudeSettings, "homePath">;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly supportedCommands: () => Effect.Effect<readonly Command[], ProviderAdapterV2Error>;
}) {
  // Capture services once; runtime callbacks and menu reads have no FS requirements.
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  let commands: Command[] = [];
  let nameSetKey: string | undefined;
  let plugins: Plugin[] = [];
  let liveSkills: string[] = [];
  let describedSkills: readonly ServerProviderSkill[] = [];
  let terminal = new Set<string>();
  let mcpServers: ServerProviderSessionCatalog["mcpServers"] = [];
  let live = false;

  const denied = (name: string) =>
    DENIED.has(name.toLowerCase()) || terminal.has(name.toLowerCase());
  const catalog = (): ServerProviderSessionCatalog => {
    const byName = new Map<string, ServerProviderSkill>();
    for (const skill of describedSkills)
      if (!byName.has(skill.name.toLowerCase())) byName.set(skill.name.toLowerCase(), skill);
    const skillNames = new Set(liveSkills.map((name) => name.toLowerCase()));
    const knownNames = new Set(commands.map((command) => command.name.toLowerCase()));
    const skills = [...new Set(liveSkills)]
      .filter((name) => knownNames.has(name.toLowerCase()) && !denied(name))
      .flatMap((name): ServerProviderSkill[] => {
        const known = byName.get(name.toLowerCase());
        if (known?.userInvocable === false || known?.enabled === false) return [];
        const plugin = plugins.find((item) => name.startsWith(`${item.name}:`));
        return [
          {
            ...(known ?? {
              name,
              path: `claude-skill:${name}`,
              enabled: true,
              scope: "builtin",
              ...(plugin ? { pluginName: plugin.name } : {}),
            }),
            name,
          },
        ];
      });
    // command-change can introduce a filesystem skill without a new init.
    for (const skill of describedSkills) {
      if (
        knownNames.has(skill.name.toLowerCase()) &&
        !skills.some((entry) => entry.name.toLowerCase() === skill.name.toLowerCase()) &&
        skill.enabled &&
        skill.userInvocable !== false &&
        !denied(skill.name)
      )
        skills.push(skill);
    }
    const classified: ServerProviderSlashCommand[] = [];
    for (const command of commands) {
      if (denied(command.name)) continue;
      const name = command.name;
      const lower = name.toLowerCase();
      const mcp = [...mcpServers]
        .sort((a, b) => b.name.length - a.name.length)
        .find(
          (server) =>
            lower.startsWith(
              `mcp__${server.name.replace(/[^A-Za-z0-9_-]/g, "_")}__`.toLowerCase(),
            ) || lower.startsWith(`${server.name}:`.toLowerCase()),
        );
      const plugin = plugins.find((entry) => lower.startsWith(`${entry.name}:`.toLowerCase()));
      const skill = byName.get(lower);
      const isSkill = skillNames.has(lower) || skill !== undefined;
      if (skill?.userInvocable === false || skill?.enabled === false) continue;
      const source = mcp
        ? "mcp"
        : plugin || skill?.pluginName
          ? "plugin"
          : isSkill && skill?.scope === "user"
            ? "personal"
            : isSkill && skill?.scope === "project"
              ? "project"
              : "builtin";
      const sourceName = mcp?.name ?? skill?.pluginName ?? plugin?.name;
      const aliases = command.aliases?.filter((alias) => !denied(alias));
      classified.push({
        name,
        source,
        ...(sourceName ? { sourceName } : {}),
        ...(command.description || skill?.description
          ? { description: command.description || skill?.description }
          : {}),
        ...(command.argumentHint ? { input: { hint: command.argumentHint } } : {}),
        ...(aliases?.length ? { aliases } : {}),
      });
    }
    const rank = { app: 6, mcp: 5, plugin: 4, personal: 3, project: 2, builtin: 1 };
    const deduped = new Map<string, ServerProviderSlashCommand>();
    for (const command of classified) {
      const key = command.name.toLowerCase();
      const old = deduped.get(key);
      if (!old || rank[command.source ?? "builtin"] > rank[old.source ?? "builtin"])
        deduped.set(key, command);
    }
    return {
      commands: [...deduped.values()].map((command) =>
        command.source === "plugin" ||
        skillNames.has(command.name.toLowerCase()) ||
        byName.has(command.name.toLowerCase())
          ? { ...command, permissionWarning: CLAUDE_PLUGIN_PERMISSION_WARNING }
          : command,
      ),
      skills: skills.map((skill) => ({
        ...skill,
        permissionWarning: CLAUDE_PLUGIN_PERMISSION_WARNING,
      })),
      mcpServers,
      live,
    };
  };
  const refreshDescriptions = Effect.gen(function* () {
    describedSkills = [
      ...(yield* discoverClaudeSkills(input.config, input.cwd, input.environment)),
      ...(yield* scanPluginSkills(plugins)),
    ];
  }).pipe(Effect.provideContext(services));
  const onMessage = (message: unknown): Effect.Effect<void> =>
    Effect.gen(function* () {
      const item = record(message);
      if (item?.type !== "system") return;
      if (item.subtype === "commands_changed") {
        commands = parseCommands(item.commands);
        nameSetKey = [...new Set(commands.map((command) => command.name.toLowerCase()))]
          .sort()
          .join("\n");
        yield* refreshDescriptions;
        return;
      }
      if (item.subtype !== "init") return;
      live = true;
      plugins = parsePlugins(item.plugins);
      liveSkills = values(item.skills).map(commandName).filter(Boolean);
      terminal = new Set(
        values(item.terminal_slash_commands)
          .map(commandName)
          .map((name) => name.toLowerCase()),
      );
      mcpServers = parseMcpServers(item.mcp_servers);
      const names = parseCommands(item.slash_commands);
      const key = [...new Set(names.map((command) => command.name.toLowerCase()))]
        .sort()
        .join("\n");
      if (key !== nameSetKey) {
        nameSetKey = key;
        const detailed = yield* input.supportedCommands().pipe(Effect.orElseSucceed(() => []));
        commands = detailed.length ? parseCommands(detailed) : names;
      }
      yield* refreshDescriptions;
    });
  return {
    onMessage,
    /** A successful native reload replaces metadata without resetting terminal-only commands. */
    onReload: (reloaded: {
      readonly commands: readonly unknown[];
      readonly plugins: readonly unknown[];
      readonly mcpServers: readonly unknown[];
    }) =>
      Effect.gen(function* () {
        live = true;
        commands = parseCommands(reloaded.commands);
        nameSetKey = [...new Set(commands.map((command) => command.name.toLowerCase()))]
          .sort()
          .join("\n");
        plugins = parsePlugins(reloaded.plugins);
        mcpServers = parseMcpServers(reloaded.mcpServers);
        const names = new Set(commands.map((command) => command.name.toLowerCase()));
        liveSkills = liveSkills.filter((name) => names.has(name.toLowerCase()));
        yield* refreshDescriptions;
      }),
    read: Effect.sync(catalog),
    userInvocableSkillNames: Effect.gen(function* () {
      // The first message is assembled before SDK init. Recognize shipped skill
      // chips so they become native slash commands, never injected skill text.
      // Claude still decides whether that command is trusted/enabled; after init,
      // only names reported by the live CLI can be dispatched.
      const skills = live
        ? catalog().skills
        : yield* discoverClaudeBundledSkills(input.config, input.cwd, input.environment);
      return new Set(skills.map((skill) => skill.name));
    }).pipe(Effect.provideContext(services)),
  };
});
