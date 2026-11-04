import type {
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2RuntimeRequestDelivery,
  OrchestrationV2RuntimeRequestLoss,
  OrchestrationV2TurnItem,
} from "@starkfuture/contracts";
import { approvalDeliveryIssue } from "@starkfuture/client-runtime/approvals/permission-presentation";
import type {
  TurnCheck,
  TurnCheckOutcome,
  TurnChecks,
} from "@starkfuture/client-runtime/state/review-chain";
import * as DateTime from "effect/DateTime";

type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;

function isInternalPreparation(item: CommandItem): boolean {
  if (item.internalOperation === "workspace_preparation") return true;
  // Older server events predate the marker. Match the server's derived ID and
  // absent provider turn as well as its label; an agent's matching prose is not evidence.
  return (
    item.providerTurnId === null &&
    item.input === "Preparing workspace" &&
    /^turn-item:provider:[^:]+:native-item:/.test(item.id) &&
    item.id.endsWith(`:native-item:${encodeURIComponent(`workspace-preparation:${item.runId}`)}`)
  );
}

export type FinishCommandEvidence = {
  id: string;
  command: string;
  isCheck: boolean;
  /** `declined`: its approval was declined, expired or lost unanswered, so it never ran. */
  outcome: "exit-zero" | "tool-completed" | "failed" | "declined" | "unfinished" | "unknown";
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  freshness: "no-later-reported-edits" | "changed" | "unknown";
  laterFiles: readonly string[];
};

/**
 * A project check run after the turn finished. It ran in the live folder, so it reports what
 * the command returned then, never that the turn was verified. `later-work` means other work in
 * this thread ran after it started; changes made outside the thread are never tracked.
 */
export type FinishCheckEvidence = {
  runId: string;
  name: string;
  command: string;
  outcome: TurnCheckOutcome;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  completedAt: string | null;
  fullOutputPath: string | null;
  /** Null when the output was too long to load with the thread; the run still holds it. */
  output: string | null;
  freshness: "no-later-turns" | "later-work" | "unknown";
  skipReason: string | null;
  check: TurnCheck;
};

export type FinishEvidence = {
  runId: string;
  runStatus: "completed" | "failed" | "cancelled" | "interrupted";
  completedAt: string | null;
  commands: readonly FinishCommandEvidence[];
  files: readonly string[];
  unconfirmedFileChanges: number;
  /** File edits their approval never allowed; nothing was written, so they are not unconfirmed. */
  declinedFileChanges: number;
  failedCount: number;
  /** Commands their approval never allowed; they did not run, so they are not failures. */
  declinedCount: number;
  unknownCount: number;
  zeroExitChecks: number;
  staleChecks: number;
  unknownTimingChecks: number;
  source?: "native";
  captureIncomplete?: boolean;
  completedToolChecks?: number;
  /** The turn's number, which check labels name ("ran after Turn N"). */
  turnOrdinal?: number;
  /** Checks run after this turn, oldest first. */
  checks?: readonly FinishCheckEvidence[];
  /** Some later runs are outside the loaded history, so checks may be missing. */
  checksIncomplete?: boolean;
  /** Approval answers in this run that did not, or may not, reach the agent. */
  approvalDelivery?: { readonly notDelivered: number; readonly uncertain: number };
};

/** What the finish card reads of a runtime request: whether its answer arrived. */
type RuntimeRequestWithDelivery = Pick<OrchestrationV2RuntimeRequest, "id"> & {
  readonly delivery?: Pick<OrchestrationV2RuntimeRequestDelivery, "state"> | undefined;
  readonly lost?:
    | Pick<OrchestrationV2RuntimeRequestLoss, "cause" | "deliveryUncertain">
    | undefined;
};

/**
 * Counts this run's approval answers whose delivery failed or is unknown. A confirmed delivery
 * outranks loss history, the same way the timeline reads it.
 */
function approvalDeliveryIssues(
  runItems: readonly OrchestrationV2TurnItem[],
  runtimeRequests: ReadonlyArray<RuntimeRequestWithDelivery> | undefined,
): FinishEvidence["approvalDelivery"] {
  if (!runtimeRequests?.length) return undefined;
  const byId = new Map(runtimeRequests.map((request) => [request.id, request]));
  let notDelivered = 0;
  let uncertain = 0;
  for (const item of runItems) {
    if (item.type !== "approval_request") continue;
    const request = byId.get(item.requestId);
    if (request === undefined) continue;
    const issue = approvalDeliveryIssue(request);
    if (issue === "uncertain") uncertain += 1;
    else if (issue === "not_delivered") notDelivered += 1;
  }
  return notDelivered + uncertain === 0 ? undefined : { notDelivered, uncertain };
}

/** The summary's word for an approval answer that failed or may have failed to arrive. */
export function finishApprovalDeliverySummary(evidence: FinishEvidence): string | null {
  if (evidence.approvalDelivery?.notDelivered) return "Answer not delivered";
  if (evidence.approvalDelivery?.uncertain) return "Delivery uncertain";
  return null;
}

/** One line per delivery problem; the action it answered did not run, or may not have. */
export function finishApprovalDeliveryNotes(evidence: FinishEvidence): string[] {
  const { notDelivered = 0, uncertain = 0 } = evidence.approvalDelivery ?? {};
  return [
    notDelivered === 1
      ? "1 approval answer was not delivered: nothing ran."
      : notDelivered > 1
        ? `${notDelivered} approval answers were not delivered: nothing ran.`
        : null,
    uncertain === 1
      ? "Delivery of 1 approval answer is uncertain: check whether it ran."
      : uncertain > 1
        ? `Delivery of ${uncertain} approval answers is uncertain: check whether they ran.`
        : null,
  ].filter((note) => note !== null);
}

function checkEvidence(check: TurnCheck, incomplete: boolean): FinishCheckEvidence {
  const item = check.item;
  return {
    runId: check.runId,
    name: check.scriptName ?? check.command,
    command: check.command,
    outcome: check.outcome,
    exitCode: item?.exitCode ?? null,
    timedOut: item?.timedOut === true,
    durationMs: item?.durationMs ?? null,
    completedAt: item?.completedAt ? DateTime.formatIso(item.completedAt) : null,
    fullOutputPath: item?.fullOutputPath ?? null,
    output: item?.outputOmitted ? null : (item?.output ?? ""),
    freshness: check.laterWork ? "later-work" : incomplete ? "unknown" : "no-later-turns",
    skipReason: check.skipReason,
    check,
  };
}

// This is a label for simple recorded commands, not a shell parser or an assertion
// that a repository's script really ran tests. Compound scripts remain ordinary
// commands, and the card always shows their exact exit result separately.
function isCheckCommand(input: string): boolean {
  if (/[\n\r;&|<>`$]/.test(input)) return false;
  const command = input.trim().replace(/^(?:[A-Za-z_][\w]*=[^\s]+\s+)*/, "");
  const words = command.split(/\s+/);
  if (
    words.some((word) =>
      /^(?:-h|-V|--help|--version|--list(?:Tests|-tests|-tests-only|FilesOnly)?|--collect-?only|--show-?config|--showConfig|--print-config|--dry-?run|-list)(?:=|$)/i.test(
        word,
      ),
    )
  )
    return false;
  const executable = words
    .shift()
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/\.exe$/, "");
  if (!executable) return false;
  if (words[0] === "list") return false;
  if (executable === "node" && words[0] === "--test") return true;
  if (["npm", "pnpm", "yarn", "bun", "vp", "npx", "bunx"].includes(executable)) {
    if (["run", "exec", "x"].includes(words[0] ?? "")) words.shift();
    return (
      /^(?:test|lint|typecheck|check)(?::[\w-]+)?$/.test(words[0] ?? "") ||
      ["vitest", "jest", "pytest", "tsc", "tsc-rs", "eslint", "oxlint"].includes(words[0] ?? "")
    );
  }
  if (["vitest", "jest", "pytest", "tsc", "tsc-rs", "eslint", "oxlint"].includes(executable))
    return true;
  if (["python", "python3"].includes(executable))
    return words[0] === "-m" && ["pytest", "unittest"].includes(words[1] ?? "");
  return (
    (
      {
        cargo: ["test", "check", "clippy"],
        go: ["test", "vet"],
        dotnet: ["test"],
        swift: ["test"],
        make: ["test", "check", "lint"],
        mvn: ["test", "verify"],
      } as Record<string, readonly string[]>
    )[executable]?.includes(words[0] ?? "") ?? false
  );
}

function commandOutcome(item: CommandItem): FinishCommandEvidence["outcome"] {
  if (
    item.timedOut ||
    item.interrupted ||
    item.outputIndicatesFailure ||
    ["failed", "interrupted", "cancelled"].includes(item.status) ||
    (item.exitCode !== undefined && item.exitCode !== 0)
  )
    return "failed";
  if (["running", "pending", "waiting", "idle"].includes(item.status)) return "unfinished";
  return item.status === "completed" && item.exitCode === 0 ? "exit-zero" : "unknown";
}

/**
 * Evidence is limited to structured events already loaded for this run. Never reads assistant
 * prose. `declinedItemIds` are the commands and file edits whose approval never allowed them
 * (`deriveDeclinedApprovalItemIds`).
 */
export function deriveFinishEvidence(
  run: Pick<OrchestrationV2Run, "id" | "threadId" | "status" | "completedAt"> | null | undefined,
  items: readonly OrchestrationV2TurnItem[],
  recordedChecks?: { readonly turnOrdinal: number; readonly checks: TurnChecks },
  runtimeRequests?: ReadonlyArray<RuntimeRequestWithDelivery>,
  declinedItemIds?: ReadonlySet<string>,
): FinishEvidence | null {
  if (!run || !["completed", "failed", "cancelled", "interrupted"].includes(run.status))
    return null;
  const runItems = items.filter((item) => item.runId === run.id && item.threadId === run.threadId);
  const files = new Map<string, number | null>();
  let unconfirmedFileChanges = 0;
  let declinedFileChanges = 0;
  for (const item of runItems) {
    if (item.type !== "file_change") continue;
    if (item.status !== "completed") {
      // A declined edit is a decided outcome: nothing was written.
      if (declinedItemIds?.has(item.id)) declinedFileChanges += 1;
      else unconfirmedFileChanges += 1;
      continue;
    }
    const paths = item.agentWrittenPaths?.length
      ? item.agentWrittenPaths
      : item.changes?.length
        ? item.changes.flatMap((change) =>
            change.oldPath ? [change.oldPath, change.path] : [change.path],
          )
        : [item.fileName];
    // updatedAt is evidence arrival, and can be later than the actual write. A
    // false stale warning is preferable to claiming a later edit was checked.
    const time = DateTime.toEpochMillis(item.completedAt ?? item.updatedAt);
    for (const path of paths) {
      const previous = files.get(path);
      files.set(
        path,
        previous === null || !Number.isFinite(time) ? null : Math.max(previous ?? 0, time),
      );
    }
  }
  const commands: FinishCommandEvidence[] = runItems.flatMap((item) => {
    if (item.type !== "command_execution") return [];
    // Only explicit server bookkeeping can be omitted; never guess from command text.
    if (isInternalPreparation(item) && commandOutcome(item) === "exit-zero") return [];
    const start = item.startedAt ? DateTime.toEpochMillis(item.startedAt) : null;
    const laterFiles = [...files]
      .filter(([, time]) => start !== null && time !== null && time >= start)
      .map(([path]) => path)
      .sort();
    const uncertain =
      unconfirmedFileChanges > 0 ||
      (files.size > 0 && (start === null || [...files.values()].some((time) => time === null)));
    return [
      {
        id: item.id,
        command: item.input,
        isCheck: isCheckCommand(item.input),
        outcome: declinedItemIds?.has(item.id) ? "declined" : commandOutcome(item),
        exitCode: item.exitCode ?? null,
        startedAt: item.startedAt ? DateTime.formatIso(item.startedAt) : null,
        completedAt: item.completedAt ? DateTime.formatIso(item.completedAt) : null,
        freshness: laterFiles.length
          ? "changed"
          : uncertain
            ? "unknown"
            : "no-later-reported-edits",
        laterFiles,
      },
    ];
  });
  const checks =
    recordedChecks?.checks.checks.map((check) =>
      checkEvidence(check, recordedChecks.checks.incomplete),
    ) ?? [];
  const approvalDelivery = approvalDeliveryIssues(runItems, runtimeRequests);
  if (
    commands.length === 0 &&
    files.size === 0 &&
    unconfirmedFileChanges === 0 &&
    declinedFileChanges === 0 &&
    checks.length === 0 &&
    approvalDelivery === undefined
  )
    return null;
  const successfulChecks = commands.filter(
    (command) => command.isCheck && command.outcome === "exit-zero",
  );
  return {
    runId: run.id,
    runStatus: run.status as FinishEvidence["runStatus"],
    completedAt: run.completedAt ? DateTime.formatIso(run.completedAt) : null,
    commands,
    files: [...files.keys()].sort(),
    unconfirmedFileChanges,
    declinedFileChanges,
    failedCount: commands.filter((command) => command.outcome === "failed").length,
    declinedCount: commands.filter((command) => command.outcome === "declined").length,
    unknownCount: commands.filter(
      (command) => command.outcome === "unfinished" || command.outcome === "unknown",
    ).length,
    zeroExitChecks: successfulChecks.length,
    staleChecks: successfulChecks.filter((command) => command.freshness === "changed").length,
    unknownTimingChecks: successfulChecks.filter((command) => command.freshness === "unknown")
      .length,
    ...(recordedChecks === undefined
      ? {}
      : {
          turnOrdinal: recordedChecks.turnOrdinal,
          checks,
          checksIncomplete: recordedChecks.checks.incomplete,
        }),
    ...(approvalDelivery === undefined ? {} : { approvalDelivery }),
  };
}
