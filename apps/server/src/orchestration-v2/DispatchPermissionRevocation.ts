import * as Context from "effect/Context";

/**
 * A server-side account revocation must replace the live provider session even
 * when the chat still inherits the same settings. The old process captured the
 * previous Bypass opt-in. This is dispatch context, never a client command flag;
 * the orchestrator preserves the chat's current source under its command lock.
 */
export const DispatchPermissionRevocation = Context.Reference<boolean>(
  "stark-code/orchestration-v2/DispatchPermissionRevocation",
  { defaultValue: () => false },
);
