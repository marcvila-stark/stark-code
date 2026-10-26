import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  makePermissionRuleFiles,
  codexRuleSpans,
  type PermissionRuleFileDescriptor,
} from "./PermissionRuleFiles.ts";
it("reads multiline Codex rules without interpreting strings/comments", () => {
  const input =
    '# prefix_rule(pattern=["ignored"], decision="allow")\nprefix_rule(\n pattern=["npm", "test)"], # ( ignored\n decision="allow"\n)\n';
  expect(codexRuleSpans(input).map((entry) => entry.text)).toEqual([
    'prefix_rule(\n pattern=["npm", "test)"], # ( ignored\n decision="allow"\n)',
  ]);
});
it.layer(NodeServices.layer)("permission files in isolated temp workspaces", (it) => {
  const fixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stark-rules-test-" });
    const store = yield* makePermissionRuleFiles;
    return { fs, path, root, store };
  });
  it.effect(
    "forgets exactly one Claude allow rule atomically and preserves unrelated settings",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, store } = yield* fixture;
        const file = path.join(root, "settings.local.json");
        yield* fs.writeFileString(
          file,
          '{"env":{"KEEP":"yes"},"permissions":{"allow":["Bash(npm test)","Read(src/**)"],"ask":["Bash(rm *)"]}}',
        );
        const descriptor: PermissionRuleFileDescriptor = {
          providerInstanceId: ProviderInstanceId.make("claude"),
          provider: "claudeAgent",
          scope: "project",
          root,
          path: file,
        };
        const before = yield* store.read(descriptor);
        const after = yield* store.forget(descriptor, before.rules[0]!.id);
        expect(after.rules.map((rule) => rule.text)).toEqual(["Read(src/**)"]);
        const contents = yield* fs.readFileString(file);
        expect(contents).toContain('"KEEP": "yes"');
        expect(contents).toContain('"Bash(rm *)"');
        expect(contents).not.toContain("Bash(npm test)");
        expect(
          yield* store.forget(descriptor, before.rules[1]!.id).pipe(Effect.flip),
        ).toMatchObject({ _tag: "PermissionRulesError" });
        expect((yield* fs.readDirectory(root)).sort()).toEqual(["settings.local.json"]);
      }),
  );
  it.effect("removes only the selected Codex statement and rejects stale edits", () =>
    Effect.gen(function* () {
      const { fs, path, root, store } = yield* fixture;
      const file = path.join(root, "default.rules");
      const first = 'prefix_rule(pattern=["npm", "test"], decision="allow")';
      const second = 'prefix_rule(pattern=["git", "status"], decision="prompt")';
      yield* fs.writeFileString(file, `# Keep this comment\n${first}\n${second}\n`);
      const descriptor: PermissionRuleFileDescriptor = {
        providerInstanceId: ProviderInstanceId.make("codex"),
        provider: "codex",
        scope: "user",
        root,
        path: file,
      };
      const before = yield* store.read(descriptor);
      yield* store.forget(descriptor, before.rules[0]!.id);
      expect(yield* fs.readFileString(file)).toBe(`# Keep this comment\n\n${second}\n`);
      expect(yield* store.forget(descriptor, before.rules[1]!.id).pipe(Effect.flip)).toMatchObject({
        _tag: "PermissionRulesError",
      });
    }),
  );
  it.effect("does not follow a settings link outside the selected workspace", () =>
    Effect.gen(function* () {
      const { fs, path, root, store } = yield* fixture;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "stark-rules-outside-" });
      const target = path.join(outside, "settings.json");
      yield* fs.writeFileString(target, '{"permissions":{"allow":["Bash(npm test)"]}}');
      const file = path.join(root, "settings.json");
      yield* fs.symlink(target, file);
      expect(
        yield* store
          .read({
            providerInstanceId: ProviderInstanceId.make("claude"),
            provider: "claudeAgent",
            scope: "project",
            root,
            path: file,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "PermissionRulesError" });
    }),
  );
});
