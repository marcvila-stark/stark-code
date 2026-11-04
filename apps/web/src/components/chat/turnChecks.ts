import {
  ChatAttachmentId,
  type CommandId,
  type MessageId,
  type OrchestrationV2Command,
  type ProjectScript,
  type RunId,
  type ThreadId,
} from "@starkfuture/contracts";
import type { TurnCheck } from "@starkfuture/client-runtime/state/review-chain";
import type { UserShellCheckSubjectValidation } from "@starkfuture/shared/userShellChecks";

import type { ChatFileAttachment } from "../../types";
import { buildUserShellCommandDispatch } from "./userShellComposer";

/** Project actions marked with the test or lint icon, in their configured order. */
export function checkScripts(scripts: ReadonlyArray<ProjectScript>): ReadonlyArray<ProjectScript> {
  return scripts.filter((script) => script.icon === "test" || script.icon === "lint");
}

export type TurnCheckAvailability =
  /** The server cannot record checks, so the Changes panel does not offer them. */
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "available" };

/**
 * Whether the latest turn can be checked from the Changes panel. A check is a human shell
 * command, so it keeps that path's permission boundary: thread and terminal operation, the
 * environment's shell-command switch, and a Codex or Claude thread.
 */
export function turnCheckAvailability(input: {
  readonly capability: boolean;
  readonly allowed: boolean;
  readonly canOperateThread: boolean;
  readonly canOperateTerminal: boolean;
  /** The driver of the thread's saved model selection, not the composer's picker. */
  readonly driver: string | null;
  readonly nativeAgentRunning: boolean;
  /** A subagent the provider started owns its conversation, so it takes no shell commands. */
  readonly providerSubagent: boolean;
  readonly subject: UserShellCheckSubjectValidation | null;
}): TurnCheckAvailability {
  if (!input.capability) return { kind: "hidden" };
  if (input.providerSubagent) {
    return {
      kind: "unavailable",
      reason: "This thread belongs to an agent the provider started, so it cannot run checks.",
    };
  }
  if (!input.allowed) {
    return { kind: "unavailable", reason: "Shell commands are turned off for this environment." };
  }
  if (!input.canOperateThread || !input.canOperateTerminal) {
    return {
      kind: "unavailable",
      reason: "Running checks needs permission to operate threads and terminals here.",
    };
  }
  if (input.driver !== "codex" && input.driver !== "claudeAgent") {
    return {
      kind: "unavailable",
      reason:
        "Recorded checks need a Codex or Claude thread. Run the script from Project actions instead.",
    };
  }
  if (input.nativeAgentRunning) {
    return {
      kind: "unavailable",
      reason: "The native agent is still running in this thread's terminal.",
    };
  }
  if (input.subject === null) {
    return { kind: "unavailable", reason: "No finished turn to check yet." };
  }
  if (!input.subject.ok) {
    return {
      kind: "unavailable",
      reason:
        input.subject.reason === "unfinished"
          ? "Checks run after the turn finishes."
          : input.subject.reason === "superseded"
            ? "Checks run after queued messages have run."
            : "The latest turn cannot be checked.",
    };
  }
  return { kind: "available" };
}

/** The recorded, non-responding shell command that runs `script` after the subject turn. */
export function buildTurnCheckDispatch(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly script: Pick<ProjectScript, "id" | "name" | "command">;
  readonly subjectRunId: RunId;
  readonly running: boolean;
  readonly nativeAgentRunning: boolean;
}): Extract<OrchestrationV2Command, { readonly type: "thread.shell-command.dispatch" }> {
  return {
    ...buildUserShellCommandDispatch({
      commandId: input.commandId,
      threadId: input.threadId,
      messageId: input.messageId,
      command: input.script.command,
      respond: false,
      running: input.running,
      nativeAgentRunning: input.nativeAgentRunning,
    }),
    check: {
      subjectRunId: input.subjectRunId,
      scriptId: input.script.id,
      scriptName: input.script.name,
    },
  };
}

const CHECK_OUTPUT_TAIL_LINES = 40;
const CHECK_OUTPUT_TAIL_CHARS = 4_000;

/** The end of a check's output, where test runners and linters report what failed. */
export function checkOutputTail(output: string): string {
  return output
    .trimEnd()
    .split("\n")
    .slice(-CHECK_OUTPUT_TAIL_LINES)
    .join("\n")
    .slice(-CHECK_OUTPUT_TAIL_CHARS);
}

/** A correction request for a failed check. It is drafted into the composer; the user sends it. */
export function checkFixPrompt(input: {
  /** How the turn is named in the UI, such as "Turn 5". */
  readonly turnLabel: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string | null;
}): string {
  const result = input.timedOut
    ? "timed out"
    : input.exitCode === null
      ? "failed"
      : `exited ${input.exitCode}`;
  const lines = [
    `\`${input.command}\` ${result} when run after ${input.turnLabel}.`,
    input.output === null
      ? "Fix the failures it reported. Its output is recorded in this thread."
      : "Fix the failures it reported.",
  ];
  const tail = checkOutputTail(input.output ?? "");
  if (tail.trim().length > 0) {
    const fence = "`".repeat(
      Math.max(3, ...Array.from(tail.matchAll(/`+/g), (m) => m[0].length + 1)),
    );
    lines.push("", `${fence}text`, tail, fence);
  }
  return lines.join("\n");
}

/**
 * Where and when a check ran. A check runs in the thread's live folder after its turn, so this
 * names that, never that the turn was verified.
 */
export function checkRanAfterLabel(turnLabel: string): string {
  return `ran after ${turnLabel} in the live folder`;
}

/** The short result of a check, such as `exit 1 · 12.4s`. It never says "passed". */
export function turnCheckResultLabel(check: Pick<TurnCheck, "outcome" | "item">): string {
  const duration =
    check.item?.durationMs === undefined ? "" : ` · ${(check.item.durationMs / 1000).toFixed(1)}s`;
  switch (check.outcome) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "exit-zero":
    case "failed":
      return check.item?.exitCode === undefined
        ? `failed to start${duration}`
        : `exit ${check.item.exitCode}${duration}`;
    case "timed-out":
      return `timed out${duration}`;
    case "stopped":
      return `stopped${duration}`;
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "unknown":
      return "result not recorded";
  }
}

/** Whether a check ended in a way the agent can be asked to fix. */
export function turnCheckNeedsFix(check: Pick<TurnCheck, "outcome">): boolean {
  return check.outcome === "failed" || check.outcome === "timed-out";
}

/** A saved full-output log, as the attachment viewer opens it. Null for anything else. */
export function shellOutputAttachment(path: string): ChatFileAttachment | null {
  const basename = path.split(/[\\/]/).at(-1) ?? "";
  if (!basename.endsWith(".log")) return null;
  return {
    type: "file",
    id: ChatAttachmentId.make(basename.slice(0, -4)),
    name: "shell-output.log",
    mimeType: "text/plain",
    sizeBytes: 0,
  };
}
