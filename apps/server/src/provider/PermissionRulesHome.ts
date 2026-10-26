import type { CodexSettings, ProviderInstanceEnvironment } from "@starkfuture/contracts";
import { mergeProviderInstanceEnvironment } from "@starkfuture/provider-core/server/instanceEnvironment";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

/** Resolve the rules source without reading or retaining unrelated environment values. */
export const resolveCodexPermissionRulesHome = Effect.fn("resolveCodexPermissionRulesHome")(
  function* (
    config: CodexSettings,
    environment: ProviderInstanceEnvironment | undefined,
    cwd: string,
  ) {
    const layout = yield* resolveCodexHomeLayout(config);
    // Managed/shadow homes link their rules to the configured shared home. An explicit
    // existing-CLI home also overrides the inherited environment at process launch.
    if (
      config.setupMode === "managed" ||
      config.homePath.trim().length > 0 ||
      config.shadowHomePath.trim().length > 0
    ) {
      return layout.sharedHomePath;
    }

    const hostEnvironment = yield* HostProcess.Environment;
    const resolved = yield* mergeProviderInstanceEnvironment(
      environment?.filter((variable) => variable.name === "CODEX_HOME"),
      { CODEX_HOME: hostEnvironment.CODEX_HOME },
    );
    const codexHome = resolved.CODEX_HOME;
    if (!codexHome) return layout.sharedHomePath;
    const path = yield* Path.Path;
    // Inherited process values are literal; only provider settings apply ~ expansion.
    // Relative values are interpreted from the same project/worktree as the CLI.
    return path.resolve(cwd, codexHome);
  },
);
