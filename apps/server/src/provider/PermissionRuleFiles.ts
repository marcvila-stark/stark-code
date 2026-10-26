import { PermissionRulesError, type SavedPermissionRuleFile } from "@starkfuture/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { fromJsonStringPretty } from "@starkfuture/shared/schemaJson";

export type PermissionRuleFileDescriptor = Omit<SavedPermissionRuleFile, "rules" | "exists"> & {
  readonly root: string;
};
const fail = (message: string) => new PermissionRulesError({ message });

/** Finds literal top-level prefix_rule statements without interpreting Starlark. */
export function codexRuleSpans(
  contents: string,
): Array<{ start: number; end: number; text: string }> {
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const pattern = /^[ \t]*prefix_rule\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contents)) !== null) {
    const start = match.index;
    let depth = 1;
    let quote = "";
    let escaped = false;
    let comment = false;
    let end = pattern.lastIndex;
    for (; end < contents.length; end++) {
      const char = contents[end]!;
      if (comment) {
        if (char === "\n") comment = false;
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "#") {
        comment = true;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "(") depth++;
      if (char === ")" && --depth === 0) {
        end++;
        break;
      }
    }
    if (depth !== 0 || quote)
      throw fail(
        "The Codex rules file contains an incomplete rule. Open the file to repair it before forgetting a rule.",
      );
    spans.push({ start, end, text: contents.slice(start, end).trim() });
    pattern.lastIndex = end;
  }
  return spans;
}

export const makePermissionRuleFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const digest = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  const read = Effect.fn("PermissionRuleFiles.read")(function* (
    descriptor: PermissionRuleFileDescriptor,
  ) {
    const { root, ...metadata } = descriptor;
    if (!(yield* fs.exists(descriptor.path)))
      return {
        file: { ...metadata, exists: false, rules: [] } satisfies SavedPermissionRuleFile,
        contents: "",
        spans: [] as Array<{ start: number; end: number; text: string }>,
        json: null as Record<string, unknown> | null,
      };
    const canonicalRoot = yield* fs.realPath(root);
    const canonicalFile = yield* fs.realPath(descriptor.path);
    const relative = path.relative(canonicalRoot, canonicalFile);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      canonicalFile !== path.resolve(canonicalRoot, path.relative(root, descriptor.path))
    )
      return yield* Effect.fail(
        fail(
          "Permission rule paths must stay inside their configured home or workspace; linked files are read-only.",
        ),
      );
    const stat = yield* fs.stat(canonicalFile);
    if (stat.type !== "File" || Number(stat.size) > 1_048_576)
      return yield* Effect.fail(
        fail("Permission rules must be a regular file smaller than 1 MiB."),
      );
    const contents = yield* fs.readFileString(canonicalFile);
    if (new TextEncoder().encode(contents).length > 1_048_576)
      return yield* Effect.fail(fail("Permission rules exceeded the 1 MiB read limit."));
    const version = yield* digest(contents);
    let json: Record<string, unknown> | null = null;
    let spans: Array<{ start: number; end: number; text: string }>;
    if (descriptor.provider === "claudeAgent") {
      const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        contents,
      ).pipe(
        Effect.mapError(() =>
          fail("The Claude local settings file is not valid JSON. Open it to repair it first."),
        ),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return yield* Effect.fail(fail("Claude local settings must be a JSON object."));
      json = parsed as Record<string, unknown>;
      const permissions = json.permissions;
      const allow =
        permissions && typeof permissions === "object"
          ? Reflect.get(permissions, "allow")
          : undefined;
      if (
        allow !== undefined &&
        (!Array.isArray(allow) || !allow.every((rule) => typeof rule === "string"))
      )
        return yield* Effect.fail(fail("Claude permissions.allow must contain strings."));
      spans = ((allow ?? []) as string[]).map((text, start) => ({ start, end: start + 1, text }));
    } else
      spans = yield* Effect.try({
        try: () => codexRuleSpans(contents),
        catch: (cause) =>
          Schema.is(PermissionRulesError)(cause) ? cause : fail("Could not read Codex rules."),
      });
    const rules = spans
      .filter((span) => span.text.trim())
      .map((span) => ({ id: `${version}:${span.start}`, text: span.text }));
    return {
      file: { ...metadata, exists: true, rules } satisfies SavedPermissionRuleFile,
      contents,
      spans,
      json,
    };
  });
  const forget = (descriptor: PermissionRuleFileDescriptor, ruleId: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        const loaded = yield* read(descriptor);
        const rule = loaded.file.rules.find((candidate) => candidate.id === ruleId);
        if (!rule)
          return yield* Effect.fail(
            fail("This rule changed or was removed. Refresh the list before trying again."),
          );
        const start = Number(ruleId.slice(ruleId.lastIndexOf(":") + 1));
        let contents: string;
        if (descriptor.provider === "claudeAgent") {
          const json = loaded.json!;
          const permissions = json.permissions as { allow: string[] };
          contents = `${yield* Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown))({ ...json, permissions: { ...permissions, allow: permissions.allow.filter((_, index) => index !== start) } })}\n`;
        } else {
          const span = loaded.spans.find((candidate) => candidate.start === start)!;
          contents = loaded.contents.slice(0, span.start) + loaded.contents.slice(span.end);
        }
        // The opaque id includes the full file revision, so a stale UI cannot remove another rule.
        if ((yield* fs.readFileString(descriptor.path)) !== loaded.contents)
          return yield* Effect.fail(
            fail("The rules file changed. Refresh before forgetting a rule."),
          );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs.makeTempDirectoryScoped({
              directory: path.dirname(descriptor.path),
              prefix: ".stark-permission-rule-",
            });
            const temp = path.join(directory, "contents.tmp");
            const stat = yield* fs.stat(descriptor.path);
            yield* fs.writeFileString(temp, contents, { mode: stat.mode & 0o777 });
            yield* fs.chmod(temp, stat.mode & 0o777);
            if ((yield* fs.readFileString(descriptor.path)) !== loaded.contents)
              return yield* Effect.fail(
                fail("The rules file changed during the update. Refresh before trying again."),
              );
            if (
              (yield* fs.realPath(path.dirname(descriptor.path))) !==
              path.dirname(yield* fs.realPath(descriptor.path))
            )
              return yield* Effect.fail(fail("The rule file location changed during the update."));
            yield* fs.rename(temp, descriptor.path);
          }),
        );
        yield* Effect.logInfo("Provider approval rule forgotten").pipe(
          Effect.annotateLogs({
            provider: descriptor.provider,
            providerInstanceId: descriptor.providerInstanceId,
            scope: descriptor.scope,
            path: descriptor.path,
            rule: rule.text,
          }),
        );
        return (yield* read(descriptor)).file;
      }),
    );
  return {
    read: (descriptor: PermissionRuleFileDescriptor) =>
      read(descriptor).pipe(Effect.map((loaded) => loaded.file)),
    forget,
  };
});
