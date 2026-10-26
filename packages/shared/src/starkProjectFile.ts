import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { StarkProjectFile, STARK_PROJECT_FILE_SCHEMA_URL } from "@starkfuture/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `stark.json` file contents (lenient JSONC string) and the
 * decoded {@link StarkProjectFile}.
 */
export const StarkProjectFileFromJson = fromLenientJson(StarkProjectFile);

const decodeStarkProjectFile = Schema.decodeExit(StarkProjectFileFromJson);

/**
 * Decode raw `stark.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseStarkProjectFile(contents: string): StarkProjectFile | null {
  const decoded = decodeStarkProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the JSON Schema document for `stark.json` (draft 2020-12).
 *
 * Identified by {@link STARK_PROJECT_FILE_SCHEMA_URL}; this build does not host
 * a public schema URL.
 */
export function buildStarkProjectFileJsonSchema(): Record<string, unknown> {
  // Closed objects, as before effect rc.113 changed the generator default;
  // editors then flag unknown keys in stark.json.
  const document = Schema.toJsonSchemaDocument(StarkProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: STARK_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
