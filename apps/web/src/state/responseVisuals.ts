import { createResponseVisualsEnvironmentAtoms } from "@starkfuture/client-runtime/state/response-visuals";
import { connectionAtomRuntime } from "../connection/runtime";

export const responseVisualsEnvironment =
  createResponseVisualsEnvironmentAtoms(connectionAtomRuntime);
