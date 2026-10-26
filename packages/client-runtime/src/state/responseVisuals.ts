import { WS_METHODS } from "@starkfuture/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createResponseVisualsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    format: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:response-visuals:format",
      tag: WS_METHODS.responseVisualsFormat,
    }),
  };
}
