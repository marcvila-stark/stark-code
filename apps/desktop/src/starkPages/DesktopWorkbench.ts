import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  STARK_WORKBENCH_RESOURCE,
  starkWorkbenchEnvironment,
  validateStarkWorkbenchRoot,
} from "@starkfuture/shared/starkWorkbench";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export const bundledRoot = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  environment.isPackaged
    ? environment.path.join(environment.resourcesPath, STARK_WORKBENCH_RESOURCE)
    : environment.path.join(
        environment.rootDir,
        "apps",
        "desktop",
        "resources",
        STARK_WORKBENCH_RESOURCE,
      );

export const backendEnvironment = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const kit = yield* validateStarkWorkbenchRoot(bundledRoot(environment)).pipe(Effect.option);
  return Option.isSome(kit)
    ? starkWorkbenchEnvironment(kit.value, process.execPath)
    : {
        STARK_WORKBENCH_ROOT: undefined,
        STARK_WORKBENCH_NODE: undefined,
        STARK_WORKBENCH_MANAGED_MIRROR: undefined,
      };
});
