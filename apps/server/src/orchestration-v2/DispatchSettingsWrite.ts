import * as Context from "effect/Context";

/**
 * Whether the sender of a dispatched command holds the settings-write scope.
 * A remote client without it may still answer approvals and pick the
 * narrowest preset, but may not widen a chat's permissions or answer with a
 * decision the provider persists (O12). RPC authorization rejects such
 * commands up front; the orchestrator checks again against the thread and
 * request it actually changes, inside the thread's command lock.
 *
 * Unset for the server's own commands and for local callers, which have no
 * such limit.
 */
export const DispatchSettingsWrite = Context.Reference<boolean | undefined>(
  "stark-code/orchestration-v2/DispatchSettingsWrite",
  { defaultValue: () => undefined },
);
