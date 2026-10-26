import { WS_METHODS } from "@starkfuture/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@starkfuture/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Read-only discovery; importing never creates a separate project for every source folder. */
export const agentSessionScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:scan",
  tag: WS_METHODS.agentSessionsScan,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const agentSessionImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});

export const agentSessionSyncStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:sync-status",
  tag: WS_METHODS.agentSessionsSyncStatus,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

export const agentSessionSyncConfigure = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:sync-configure",
  tag: WS_METHODS.agentSessionsSyncConfigure,
});
