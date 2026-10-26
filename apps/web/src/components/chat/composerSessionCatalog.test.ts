import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderSessionCatalog } from "@starkfuture/contracts";
import {
  composerCommandInsertion,
  plainCatalogText,
  resolveComposerSessionCatalog,
} from "./composerSessionCatalog";

const catalog = (
  live: boolean,
  commands = [{ name: "remote", source: "mcp" as const, sourceName: "drive" }],
) =>
  ({
    live,
    commands,
    skills: [
      {
        name: "deploy:ship",
        path: "/plugins/deploy/skills/ship/SKILL.md",
        enabled: true,
        pluginName: "deploy",
      },
    ],
    mcpServers: [],
  }) satisfies ServerProviderSessionCatalog;
describe("composer session catalog", () => {
  it("replaces the probe only when a session is live, including an empty live catalog", () => {
    const probe = {
      probeCommands: [{ name: "probe" }],
      probeSkills: [{ name: "local", enabled: true, path: "/skills/local/SKILL.md" }],
    };
    expect(
      resolveComposerSessionCatalog({ ...probe, catalog: catalog(false) }).commands.map(
        (entry) => entry.name,
      ),
    ).toEqual(["probe"]);
    expect(
      resolveComposerSessionCatalog({ ...probe, catalog: catalog(true) }).commands.map(
        (entry) => entry.name,
      ),
    ).toEqual(["remote"]);
    expect(
      resolveComposerSessionCatalog({
        ...probe,
        catalog: { ...catalog(true), commands: [], skills: [] },
      }),
    ).toMatchObject({ commands: [], skills: [], live: true });
  });
  it("strips third-party terminal controls, caps plain text, and hides denied commands", () => {
    expect(
      plainCatalogText(
        "\x1b[31mPlugin\x1b[0m\x00\n\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
      ),
    ).toBe("Pluginlink");
    const result = resolveComposerSessionCatalog({
      catalog: {
        ...catalog(true),
        commands: [
          { name: "clear" },
          {
            name: "\x1b[31mserver:prompt\x1b[0m",
            description: "x".repeat(2000),
            source: "mcp",
            sourceName: "\x00Drive",
          },
        ],
      },
      probeCommands: [],
      probeSkills: [],
    });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ name: "server:prompt", sourceName: "Drive" });
    expect(result.commands[0]!.description).toHaveLength(1000);
    expect(result.skills[0]!.pluginName).toBe("deploy");
  });
  it("picking commands produces text for a later send, preserving canonical plugin and MCP names", () => {
    expect(
      composerCommandInsertion({ type: "slash-command", command: "model" }, "slash-command"),
    ).toBe("/model ");
    expect(
      composerCommandInsertion(
        { type: "provider-slash-command", command: { name: "drive:search" } },
        "slash-command",
      ),
    ).toBe("/drive:search ");
    expect(
      composerCommandInsertion({ type: "skill", skill: { name: "deploy:ship" } }, "slash-command"),
    ).toBe("/deploy:ship ");
    expect(
      composerCommandInsertion({ type: "skill", skill: { name: "deploy:ship" } }, "skill"),
    ).toBe("$deploy:ship ");
  });
});
