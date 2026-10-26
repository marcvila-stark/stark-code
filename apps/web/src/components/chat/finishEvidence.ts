import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;

export type FinishCommandEvidence = {
  id: string;
  command: string;
  isCheck: boolean;
  outcome: "exit-zero" | "tool-completed" | "failed" | "unfinished" | "unknown";
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  freshness: "no-later-reported-edits" | "changed" | "unknown";
  laterFiles: readonly string[];
};

export type FinishEvidence = {
  runId: string;
  runStatus: "completed" | "failed" | "cancelled" | "interrupted";
  completedAt: string | null;
  commands: readonly FinishCommandEvidence[];
  files: readonly string[];
  unconfirmedFileChanges: number;
  failedCount: number;
  unknownCount: number;
  zeroExitChecks: number;
  staleChecks: number;
  unknownTimingChecks: number;
  source?: "native";
  captureIncomplete?: boolean;
  completedToolChecks?: number;
};

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

/** Evidence is limited to structured events already loaded for this run. Never reads assistant prose. */
export function deriveFinishEvidence(
  run: Pick<OrchestrationV2Run, "id" | "threadId" | "status" | "completedAt"> | null | undefined,
  items: readonly OrchestrationV2TurnItem[],
): FinishEvidence | null {
  if (!run || !["completed", "failed", "cancelled", "interrupted"].includes(run.status))
    return null;
  const runItems = items.filter((item) => item.runId === run.id && item.threadId === run.threadId);
  const files = new Map<string, number | null>();
  let unconfirmedFileChanges = 0;
  for (const item of runItems) {
    if (item.type !== "file_change") continue;
    if (item.status !== "completed") {
      unconfirmedFileChanges += 1;
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
        outcome: commandOutcome(item),
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
  if (commands.length === 0 && files.size === 0 && unconfirmedFileChanges === 0) return null;
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
    failedCount: commands.filter((command) => command.outcome === "failed").length,
    unknownCount: commands.filter(
      (command) => command.outcome === "unfinished" || command.outcome === "unknown",
    ).length,
    zeroExitChecks: successfulChecks.length,
    staleChecks: successfulChecks.filter((command) => command.freshness === "changed").length,
    unknownTimingChecks: successfulChecks.filter((command) => command.freshness === "unknown")
      .length,
  };
}
