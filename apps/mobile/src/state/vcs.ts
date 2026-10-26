import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@starkfuture/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
