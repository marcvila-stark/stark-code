import {
  CodexSettings,
  PermissionRulesError,
  ProviderInstanceId,
  type ForgetPermissionRuleInput,
  type ReadPermissionRulesInput,
  type ReadPermissionRulesResult,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveCodexPermissionRulesHome } from "./PermissionRulesHome.ts";
import {
  makePermissionRuleFiles,
  type PermissionRuleFileDescriptor,
} from "./PermissionRuleFiles.ts";

/** No operation accepts a path or new rule text from a client. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const files = yield* makePermissionRuleFiles;
  const descriptors = Effect.fn("PermissionRulesService.descriptors")(function* (
    input: ReadPermissionRulesInput,
  ) {
    const projection = yield* threads.getThreadRecords(input.threadId, []);
    const project = Option.getOrNull(yield* projects.get(projection.thread.projectId));
    if (!project)
      return yield* Effect.fail(
        new PermissionRulesError({ message: "The thread's project is unavailable." }),
      );
    const configured = (yield* settings.getSettings).providerInstances;
    const cwd = path.resolve(
      projection.thread.worktreePath ??
        projection.thread.localSession?.cwd ??
        project.workspaceRoot,
    );
    const entries = Object.entries(configured);
    const claude =
      entries.find(
        ([id, instance]) =>
          id === projection.thread.providerInstanceId && instance.driver === "claudeAgent",
      ) ?? entries.find(([, instance]) => instance.driver === "claudeAgent");
    const result: PermissionRuleFileDescriptor[] = claude
      ? [
          {
            providerInstanceId: ProviderInstanceId.make(claude[0]),
            provider: "claudeAgent",
            scope: projection.thread.worktreePath ? "worktree" : "project",
            path: path.join(cwd, ".claude", "settings.local.json"),
            root: cwd,
          },
        ]
      : [];
    for (const [id, instance] of entries) {
      if (instance.driver !== "codex") continue;
      const config = yield* Schema.decodeUnknownEffect(CodexSettings)(instance.config ?? {});
      const rulesHome = yield* resolveCodexPermissionRulesHome(config, instance.environment, cwd);
      result.push({
        providerInstanceId: ProviderInstanceId.make(id),
        provider: "codex",
        scope: "user",
        root: rulesHome,
        path: path.join(rulesHome, "rules", "default.rules"),
        warning:
          "Codex allow rules run matching commands outside the sandbox without prompting, across every project using this home.",
      });
    }
    return result;
  });
  const mapError = (cause: unknown) =>
    Schema.is(PermissionRulesError)(cause)
      ? cause
      : new PermissionRulesError({
          message: "Could not read or update the provider's saved rules.",
          cause,
        });
  const read = (input: ReadPermissionRulesInput) =>
    Effect.gen(function* () {
      return {
        files: yield* Effect.forEach(yield* descriptors(input), (descriptor) =>
          files.read(descriptor),
        ),
      } satisfies ReadPermissionRulesResult;
    }).pipe(Effect.mapError(mapError));
  const forget = (input: ForgetPermissionRuleInput) =>
    Effect.gen(function* () {
      const descriptor = (yield* descriptors(input)).find(
        (file) => file.providerInstanceId === input.providerInstanceId,
      );
      if (!descriptor)
        return yield* Effect.fail(
          new PermissionRulesError({
            message: "This provider is no longer configured for this thread.",
          }),
        );
      yield* files.forget(descriptor, input.ruleId);
      yield* Effect.logInfo("Saved approval rule removed from thread settings").pipe(
        Effect.annotateLogs({
          threadId: input.threadId,
          providerInstanceId: input.providerInstanceId,
          scope: descriptor.scope,
        }),
      );
      return yield* read(input);
    }).pipe(Effect.mapError(mapError));
  return { read, forget };
});
