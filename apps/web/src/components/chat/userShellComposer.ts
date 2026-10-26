import type { ComposerThreadDraftState } from "../../composerDraftStore";
import type { ComposerPromptHistoryMessage } from "./composerPromptHistory";
import type {
  OrchestrationV2Command,
  CommandId,
  MessageId,
  ThreadId,
} from "@starkfuture/contracts";

export function buildUserShellCommandDispatch(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly command: string;
  readonly respond: boolean;
  readonly running: boolean;
  readonly nativeAgentRunning: boolean;
}): Extract<OrchestrationV2Command, { readonly type: "thread.shell-command.dispatch" }> {
  if (input.nativeAgentRunning)
    throw new Error(
      "The native agent is still running. Exit it in Shell mode before sending a shell command.",
    );
  const command = input.command.trim();
  if (command.length === 0 || command.length > 10_000)
    throw new Error("Enter a shell command between 1 and 10,000 characters.");
  return {
    type: "thread.shell-command.dispatch",
    commandId: input.commandId,
    threadId: input.threadId,
    messageId: input.messageId,
    command,
    respond: input.respond,
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: input.running ? "queue_after_active" : "start_immediately" },
  };
}

export function composerHasShellBlockingContent(draft: ComposerThreadDraftState): boolean {
  return (
    draft.images.length +
      draft.files.length +
      draft.persistedAttachments.length +
      draft.terminalContexts.length +
      draft.previewAnnotations.length +
      draft.reviewComments.length +
      draft.threadContexts.length >
    0
  );
}

/** Called only from a physical key or clipboard event, never a restored prompt. */
export function enterUserShellFromHumanInput(input: {
  readonly available: boolean;
  readonly shellMode: boolean;
  readonly draft: ComposerThreadDraftState;
  readonly text: string;
}): string | null {
  return input.available &&
    !input.shellMode &&
    input.draft.prompt.length === 0 &&
    !composerHasShellBlockingContent(input.draft) &&
    input.text.startsWith("!")
    ? input.text.slice(1)
    : null;
}

export function userShellCommandAvailability(input: {
  readonly canOperateTerminal: boolean;
  readonly canOperateThread: boolean;
  readonly capability: boolean;
  readonly allowed: boolean;
  readonly provider: string | null;
  readonly multipleModels: boolean;
}): boolean {
  return (
    input.canOperateTerminal &&
    input.canOperateThread &&
    input.capability &&
    input.allowed &&
    !input.multipleModels &&
    (input.provider === "codex" || input.provider === "claudeAgent")
  );
}

type ShellHistoryMessage = ComposerPromptHistoryMessage & { readonly createdAt: string };
const HISTORY_PREFIX = "stark-code:user-shell-history:";
const historyCache = new Map<string, ShellHistoryMessage[]>();

export function readProjectShellHistory(projectKey: string): ShellHistoryMessage[] {
  const cached = historyCache.get(projectKey);
  if (cached) return cached;
  let entries: ShellHistoryMessage[] = [];
  try {
    const raw =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(HISTORY_PREFIX + projectKey);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed))
      entries = parsed.filter(
        (entry): entry is ShellHistoryMessage =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          typeof entry.text === "string" &&
          typeof entry.createdAt === "string" &&
          entry.role === "user" &&
          typeof entry.userShell?.command === "string" &&
          typeof entry.userShell?.respond === "boolean",
      );
  } catch {
    /* unavailable browser storage leaves session history usable */
  }
  historyCache.set(projectKey, entries);
  return entries;
}

export function rememberProjectShellCommand(
  projectKey: string,
  message: ShellHistoryMessage,
): void {
  const entries = [
    ...readProjectShellHistory(projectKey).filter((entry) => entry.id !== message.id),
    message,
  ].slice(-500);
  historyCache.set(projectKey, entries);
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(HISTORY_PREFIX + projectKey, JSON.stringify(entries));
  } catch {
    /* keep the in-memory history */
  }
}
