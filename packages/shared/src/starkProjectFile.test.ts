import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildStarkProjectFileJsonSchema,
  parseStarkProjectFile,
  StarkProjectFileFromJson,
} from "./starkProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(StarkProjectFileFromJson);

describe("buildStarkProjectFileJsonSchema", () => {
  it("emits a draft 2020-12 schema with the local $id", () => {
    const schema = buildStarkProjectFileJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("urn:stark-code:project-config");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("documents every supported field", () => {
    const schema = buildStarkProjectFileJsonSchema() as {
      properties: Record<
        string,
        {
          description?: string;
          items?: { properties: Record<string, unknown>; required: ReadonlyArray<string> };
        }
      >;
      required?: ReadonlyArray<string>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      "$schema",
      "defaultThreadEnvMode",
      "iconPath",
      "scripts",
      "worktreeSubmodules",
    ]);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.iconPath?.description).toContain("Workspace-relative path");
    expect(schema.properties.defaultThreadEnvMode?.description).toContain("new threads start");

    const script = schema.properties.scripts?.items;
    expect(script?.required).toEqual(["name", "command"]);
    expect(Object.keys(script?.properties ?? {}).sort()).toEqual([
      "async",
      "autoOpenPreview",
      "command",
      "icon",
      "name",
      "previewUrl",
      "runOnSettle",
      "runOnWorktreeCreate",
    ]);
  });

  it("stays JSON-serializable", () => {
    const schema = buildStarkProjectFileJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe("StarkProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});

describe("parseStarkProjectFile", () => {
  it("returns the decoded file for valid contents", () => {
    expect(parseStarkProjectFile('{ "defaultThreadEnvMode": "worktree" }')).toEqual({
      defaultThreadEnvMode: "worktree",
    });
  });

  it("returns null for malformed or invalid contents", () => {
    expect(parseStarkProjectFile("{ not json")).toBeNull();
    expect(parseStarkProjectFile('{ "defaultThreadEnvMode": "spaceship" }')).toBeNull();
  });
});
