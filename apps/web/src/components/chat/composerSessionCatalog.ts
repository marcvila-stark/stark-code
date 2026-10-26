import type {
  ServerProviderSessionCatalog,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@starkfuture/contracts";

/** Third-party catalog fields are display text, never terminal output or markup. */
export function plainCatalogText(value: string | undefined, limit = 200): string {
  return (value ?? "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, limit);
}

const DENIED_COMMANDS = new Set(["clear", "resume", "rewind", "exit", "login", "logout"]);

export function resolveComposerSessionCatalog(input: {
  catalog: ServerProviderSessionCatalog | null;
  probeCommands: ReadonlyArray<ServerProviderSlashCommand>;
  probeSkills: ReadonlyArray<ServerProviderSkill>;
}) {
  const live = input.catalog?.live === true;
  const commands = (live ? input.catalog!.commands : input.probeCommands).flatMap((command) => {
    const name = plainCatalogText(command.name);
    if (!name || DENIED_COMMANDS.has(name.toLowerCase())) return [];
    const description = plainCatalogText(command.description, 1000);
    const sourceName = plainCatalogText(command.sourceName);
    return [
      {
        ...command,
        name,
        ...(description ? { description } : { description: undefined }),
        ...(sourceName ? { sourceName } : { sourceName: undefined }),
        aliases: command.aliases?.map((alias) => plainCatalogText(alias)).filter(Boolean),
        ...(command.input
          ? { input: { ...command.input, hint: plainCatalogText(command.input.hint, 1000) } }
          : {}),
      },
    ];
  });
  const skills = (live ? input.catalog!.skills : input.probeSkills).flatMap((skill) => {
    const name = plainCatalogText(skill.name);
    if (!name) return [];
    return [
      {
        ...skill,
        name,
        displayName: plainCatalogText(skill.displayName) || undefined,
        description: plainCatalogText(skill.description, 1000) || undefined,
        shortDescription: plainCatalogText(skill.shortDescription, 1000) || undefined,
        pluginName: plainCatalogText(skill.pluginName) || undefined,
      },
    ];
  });
  return { commands, skills, live };
}

export function composerCommandInsertion(
  item:
    | { type: "slash-command"; command: string }
    | { type: "provider-slash-command"; command: { name: string } }
    | { type: "skill"; skill: { name: string } },
  triggerKind: "slash-command" | "skill",
) {
  const name =
    item.type === "skill"
      ? item.skill.name
      : typeof item.command === "string"
        ? item.command
        : item.command.name;
  return `${item.type === "skill" && triggerKind === "skill" ? "$" : "/"}${name} `;
}
