import {
  claudeModelEnvironment,
  permittedClaudeModel,
} from "@starkfuture/shared/claudeModelPolicy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { expandHomePath } from "@starkfuture/provider-core/server/pathExpansion";
import { parse as parseToml, type TomlValue } from "smol-toml";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeUnknownEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);
class NativeAgentSettingsInvalidError extends Schema.TaggedError<NativeAgentSettingsInvalidError>()(
  "NativeAgentSettingsInvalidError",
  {},
) {
  override get message() {
    return "Custom Claude settings must contain a JSON object.";
  }
}

export function mergeNativeSettings(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return mergeSettingsObjects(base, next, []);
}

function inlineToml(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(", ")}]`;
  if (value instanceof Date) throw new Error("Dates are not supported in hook settings.");
  return `{ ${Object.entries(value)
    .map(([key, entry]) => `${JSON.stringify(key)} = ${inlineToml(entry)}`)
    .join(", ")} }`;
}

/** Session hook layers add to config-file hooks; never use or replace `notify`. */
export function prepareNativeCodexCaptureArgs(args: readonly string[], command: string): string[] {
  const kept: string[] = [];
  let configured: Record<string, unknown> = {};
  let prompt: readonly string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      prompt = args.slice(index);
      break;
    }
    const separate = arg === "-c" || arg === "--config";
    const attached = arg.startsWith("--config=")
      ? arg.slice(9)
      : arg.startsWith("-c") && arg.length > 2
        ? arg.slice(2).replace(/^=/, "")
        : null;
    const value = separate ? args[++index] : attached;
    if (value === undefined) throw new Error("Codex config requires a value.");
    if (value !== null) {
      const key = value
        .slice(0, value.indexOf("="))
        .trim()
        .split(".")
        .map((part) => part.trim().replaceAll('"', "").replaceAll("'", ""))
        .join(".");
      if (key === "hooks" || key.startsWith("hooks.")) {
        const decoded = parseToml(value);
        if (!isObject(decoded.hooks)) throw new Error("Codex hooks must contain a TOML table.");
        if (decoded.hooks.Stop !== undefined && !Array.isArray(decoded.hooks.Stop))
          throw new Error("Codex Stop hooks must contain an array of matcher groups.");
        configured = mergeNativeSettings(configured, { hooks: decoded.hooks });
        continue;
      }
    }
    kept.push(arg);
    if (separate) kept.push(value!);
  }
  configured = mergeNativeSettings(configured, {
    hooks: { Stop: [{ hooks: [{ type: "command", command, async: true, timeout: 5 }] }] },
  });
  return [...kept, "-c", `hooks=${inlineToml(configured.hooks as TomlValue)}`, ...prompt];
}

function mergeSettingsObjects(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  path: ReadonlyArray<string>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const previous = Object.hasOwn(result, key) ? result[key] : undefined;
    // Each event has independent matchers. The session guard must coexist with
    // custom publishing hooks, while ordinary settings arrays still override.
    const merged =
      path.length === 1 && path[0] === "hooks" && Array.isArray(previous) && Array.isArray(value)
        ? [...previous, ...value]
        : isObject(previous) && isObject(value)
          ? mergeSettingsObjects(previous, value, [...path, key])
          : value;
    Object.defineProperty(result, key, {
      value: merged,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/** Preserve custom settings files while adding the per-session supervision policy. */
export const prepareNativeClaudeSettings = Effect.fn("terminal.prepareNativeClaudeSettings")(
  function* (input: {
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly home: string;
    readonly stateDir: string;
    readonly lifetime: Scope.Scope;
  }) {
    const sources: string[] = [];
    const args: string[] = [];
    let promptArgs: ReadonlyArray<string> = [];
    for (let index = 0; index < input.args.length; index++) {
      const arg = input.args[index]!;
      if (arg === "--") {
        promptArgs = input.args.slice(index);
        break;
      }
      if (arg === "--settings") {
        const source = input.args[++index];
        if (source === undefined || source === "--") {
          return yield* new NativeAgentSettingsInvalidError({});
        }
        sources.push(source);
      } else if (arg.startsWith("--settings=")) sources.push(arg.slice("--settings=".length));
      else args.push(arg);
    }
    if (sources.length < 2) return [...input.args];
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let merged: Record<string, unknown> = {};
    for (const source of sources) {
      const text = source.trim().startsWith("{")
        ? source
        : yield* fs.readFileString(path.resolve(input.cwd, expandHomePath(source, input.home)));
      const value = yield* decodeSettings(text).pipe(
        Effect.mapError(() => new NativeAgentSettingsInvalidError({})),
      );
      merged = mergeNativeSettings(merged, value);
    }
    // Normalize only the temporary session copy, leaving personal settings and history untouched.
    if (typeof merged.model === "string") merged.model = permittedClaudeModel(merged.model);
    if (typeof merged.advisorModel === "string")
      merged.advisorModel = permittedClaudeModel(merged.advisorModel);
    const environment = isObject(merged.env) ? merged.env : {};
    merged.env = claudeModelEnvironment(
      Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    );
    const cache = path.join(input.stateDir, "cache", "native-agent-settings");
    yield* fs.makeDirectory(cache, { recursive: true, mode: 0o700 });
    const directory = yield* fs.makeTempDirectory({ directory: cache, prefix: "session-" });
    const filename = path.join(directory, "settings.json");
    const serialized = yield* encodeSettings(merged).pipe(
      Effect.mapError(() => new NativeAgentSettingsInvalidError({})),
    );
    yield* fs.writeFileString(filename, serialized, { mode: 0o600 });
    yield* Scope.addFinalizer(
      input.lifetime,
      fs.remove(directory, { recursive: true }).pipe(Effect.ignore),
    );
    return [...args, "--settings", filename, ...promptArgs];
  },
);
