import { AuthTerminalReadScope, type ScopedThreadRef } from "@starkfuture/contracts";
import { terminalEnvironment } from "./terminal";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentScope } from "./session";

/** One atomic snapshot/subscription delivers completed replies, never terminal output bytes. */
export function useNativeReplies(
  threadRef: ScopedThreadRef,
  enabled: boolean,
  terminalId?: string,
) {
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope);
  return useEnvironmentQuery(
    enabled && canRead
      ? terminalEnvironment.nativeReplies({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, ...(terminalId ? { terminalId } : {}) },
        })
      : null,
  );
}
