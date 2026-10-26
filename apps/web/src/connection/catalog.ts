import { createEnvironmentCatalogAtoms } from "@starkfuture/client-runtime/state/connections";

import { connectionAtomRuntime } from "./runtime";

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);
