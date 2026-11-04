import {
  parseAgentSessionImportThreadId,
  type OrchestrationV2ProviderThread,
  type ThreadId,
} from "@starkfuture/contracts";

/**
 * Whether a provider thread is still the native CLI session its app thread was
 * imported from (Claude Code or Codex). That native session already holds the
 * imported transcript, so a turn on it resumes the session and must not be
 * sent the transcript again as context. A fresh native session that replaced
 * it after a failed resume is not the imported one.
 */
export function continuesImportedAgentSession(input: {
  readonly threadId: ThreadId;
  readonly providerThread: Pick<OrchestrationV2ProviderThread, "nativeThreadRef"> | undefined;
}): boolean {
  const imported = parseAgentSessionImportThreadId(input.threadId);
  const nativeThreadRef = input.providerThread?.nativeThreadRef;
  return (
    imported !== null &&
    nativeThreadRef?.strength === "strong" &&
    nativeThreadRef.nativeId === imported.providerSessionId
  );
}
