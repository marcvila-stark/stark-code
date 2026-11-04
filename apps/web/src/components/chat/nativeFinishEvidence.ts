import type { NativeTurnEvidence } from "@starkfuture/contracts";
import type { FinishEvidence } from "./finishEvidence";

/** Provider-reported native results, never a claim that every check or edit was observed. */
export function deriveNativeFinishEvidence(
  id: string,
  evidence: NativeTurnEvidence | undefined,
): FinishEvidence | null {
  if (!evidence) return null;
  const commands = evidence.commands.map((command) => {
    const start = command.startedAt ? Date.parse(command.startedAt) : NaN;
    const laterFiles = evidence.changes
      .filter((change) => change.completedAt !== null && Date.parse(change.completedAt) >= start)
      .map((change) => change.path);
    const uncertain =
      evidence.coverage !== "available" ||
      evidence.unconfirmedChanges > 0 ||
      !Number.isFinite(start) ||
      evidence.changes.some((change) => change.completedAt === null);
    return {
      ...command,
      command: command.label,
      laterFiles,
      freshness: laterFiles.length
        ? ("changed" as const)
        : uncertain
          ? ("unknown" as const)
          : ("no-later-reported-edits" as const),
    };
  });
  const successfulChecks = commands.filter(
    (command) =>
      command.isCheck && (command.outcome === "exit-zero" || command.outcome === "tool-completed"),
  );
  return {
    runId: id,
    runStatus: "completed",
    completedAt: null,
    commands,
    files: evidence.changes.map((change) => change.path),
    unconfirmedFileChanges: evidence.unconfirmedChanges,
    declinedFileChanges: 0,
    failedCount: commands.filter((command) => command.outcome === "failed").length,
    declinedCount: 0,
    unknownCount: commands.filter((command) => command.outcome === "unknown").length,
    zeroExitChecks: successfulChecks.filter((command) => command.outcome === "exit-zero").length,
    completedToolChecks: successfulChecks.filter((command) => command.outcome === "tool-completed")
      .length,
    staleChecks: successfulChecks.filter((command) => command.freshness === "changed").length,
    unknownTimingChecks: successfulChecks.filter((command) => command.freshness === "unknown")
      .length,
    source: "native",
    captureIncomplete: evidence.coverage !== "available",
  };
}
