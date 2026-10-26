// @effect-diagnostics nodeBuiltinImport:off -- bounded Git argv runner; no shell or repository scripts
import * as NodeChildProcess from "node:child_process";
import {
  ChangesetCheckError,
  type ChangesetCheckInput,
  type ChangesetCheckResult,
} from "@starkfuture/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { parseDocument } from "yaml";

export class ChangesetCheck extends Context.Service<
  ChangesetCheck,
  {
    readonly check: (
      input: ChangesetCheckInput,
    ) => Effect.Effect<ChangesetCheckResult, ChangesetCheckError>;
  }
>()("stark-code/git/ChangesetCheck") {}

const git = (cwd: string, args: readonly string[]) =>
  Effect.callback<string, ChangesetCheckError>((resume) => {
    const child = NodeChildProcess.execFile(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1_048_576,
        windowsHide: true,
      },
      (cause, stdout) =>
        resume(
          cause
            ? Effect.fail(new ChangesetCheckError({ reason: "git", cause }))
            : Effect.succeed(stdout),
        ),
    );
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
  });
const isCheckError = Schema.is(ChangesetCheckError);
const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optional(Schema.Unknown),
      private: Schema.optional(Schema.Unknown),
    }),
  ),
);
const paths = (value: string) => value.split("\0").filter(Boolean);
const packageDir = (file: string) => /^packages\/[^/]+(?=\/)/u.exec(file)?.[0];

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const check = Effect.fn("ChangesetCheck.check")(function* (input: ChangesetCheckInput) {
    const root = (yield* git(input.cwd, ["rev-parse", "--show-toplevel"])).trim();
    const canonicalRoot = yield* fs
      .realPath(root)
      .pipe(Effect.mapError((cause) => new ChangesetCheckError({ reason: "files", cause })));
    const safeRead = (relative: string) =>
      Effect.gen(function* () {
        const full = path.join(root, relative);
        if (!(yield* fs.exists(full))) return null;
        const real = yield* fs.realPath(full);
        const rel = path.relative(canonicalRoot, real);
        if (rel.startsWith("..") || path.isAbsolute(rel))
          return yield* new ChangesetCheckError({ reason: "files" });
        const stat = yield* fs.stat(real);
        if (stat.size > 128_000n) return yield* new ChangesetCheckError({ reason: "limit" });
        return yield* fs.readFileString(real);
      }).pipe(
        Effect.mapError((cause) =>
          isCheckError(cause) ? cause : new ChangesetCheckError({ reason: "files", cause }),
        ),
      );
    let base = "HEAD";
    if (input.baseRef) {
      const ref = (yield* git(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.baseRef}^{commit}`,
      ])).trim();
      base = (yield* git(root, ["merge-base", "HEAD", ref])).trim();
    }
    const changed = new Set(
      paths(
        yield* git(root, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--name-only",
          "-z",
          base,
          "--",
        ]),
      ),
    );
    for (const file of paths(
      yield* git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ))
      changed.add(file);
    if (changed.size > 5000) return yield* new ChangesetCheckError({ reason: "limit" });
    const staged = paths(
      yield* git(root, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        "--",
      ]),
    );
    if ([...changed].filter((file) => file.startsWith(".changeset/")).length > 200)
      return yield* new ChangesetCheckError({ reason: "limit" });
    const allPaths = new Set([...changed, ...staged]);
    if (
      allPaths.size > 5000 ||
      [...allPaths].filter((file) => file.startsWith(".changeset/")).length > 200
    )
      return yield* new ChangesetCheckError({ reason: "limit" });
    const directories = [
      ...new Set([...changed, ...staged].flatMap((file) => packageDir(file) ?? [])),
    ];
    if (directories.length > 200) return yield* new ChangesetCheckError({ reason: "limit" });
    const warnings: string[] = [];
    const notes = new Map<string, string[]>();
    const stagedNotes = new Set<string>();
    const parseNote = (file: string, raw: string | null, stagedOnly: boolean) => {
      if (raw === null) return;
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
      if (!match || !raw.slice(match[0].length).trim()) {
        warnings.push(`${file}: missing release frontmatter`);
        return;
      }
      try {
        const doc = parseDocument(match[1]!, { uniqueKeys: true });
        if (doc.errors.length) throw new Error("Invalid frontmatter");
        const data: unknown = doc.toJS({ maxAliasCount: 0 });
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error("Invalid frontmatter");
        for (const [name, bump] of Object.entries(data)) {
          if (!["patch", "minor", "major"].includes(String(bump))) {
            warnings.push(`${file}: unsupported bump for ${name}`);
            continue;
          }
          if (stagedOnly) stagedNotes.add(name);
          else notes.set(name, [...(notes.get(name) ?? []), file]);
        }
      } catch {
        warnings.push(`${file}: invalid release frontmatter`);
      }
    };
    // Only notes included in this change count; old pending release notes cannot mask a new omission.
    for (const file of changed) {
      if (/^\.changeset\/[^/]+\.md$/u.test(file) && file !== ".changeset/README.md")
        parseNote(file, yield* safeRead(file), false);
    }
    for (const file of staged) {
      if (/^\.changeset\/[^/]+\.md$/u.test(file) && file !== ".changeset/README.md") {
        const raw = yield* git(root, ["show", `:${file}`]).pipe(Effect.orElseSucceed(() => null));
        parseNote(file, raw, true);
      }
    }
    const packages: ChangesetCheckResult["packages"][number][] = [];
    for (const directory of directories) {
      const isStaged = staged.some((file) => file.startsWith(`${directory}/`));
      const raw = yield* safeRead(`${directory}/package.json`);
      const baselineRaw = yield* git(root, ["show", `${base}:${directory}/package.json`]).pipe(
        Effect.orElseSucceed(() => null),
      );
      const stagedRaw = isStaged
        ? yield* git(root, ["show", `:${directory}/package.json`]).pipe(
            Effect.orElseSucceed(() => null),
          )
        : null;
      for (const source of new Set([raw, stagedRaw, baselineRaw])) {
        if (source === null) continue;
        const decoded = yield* decodeManifest(source).pipe(Effect.option);
        if (Option.isNone(decoded)) {
          warnings.push(`${directory}: package.json could not be parsed`);
          continue;
        }
        const manifest = decoded.value;
        if (manifest.private === true) continue;
        if (
          typeof manifest.name !== "string" ||
          !manifest.name.trim() ||
          manifest.name.length > 214
        ) {
          warnings.push(`${directory}: publishable package has no name`);
          continue;
        }
        if (packages.some((p) => p.directory === directory && p.name === manifest.name)) continue;
        packages.push({
          name: manifest.name,
          directory,
          changesets: notes.get(manifest.name) ?? [],
          staged: isStaged,
          stagedCovered: stagedNotes.has(manifest.name),
        });
      }
    }
    return {
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      base: input.baseRef ? `${input.baseRef} (merge base)` : "Uncommitted changes",
      packages,
      warnings: [...new Set(warnings)],
    };
  });
  return ChangesetCheck.of({
    check: (input) =>
      check(input).pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(new ChangesetCheckError({ reason: "limit" })),
        ),
      ),
  });
});
export const layer = Layer.effect(ChangesetCheck, make);
