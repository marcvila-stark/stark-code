import { ListIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import {
  finishApprovalDeliveryNotes,
  finishApprovalDeliverySummary,
  type FinishCheckEvidence,
  type FinishCommandEvidence,
  type FinishEvidence,
} from "./finishEvidence";
import { checkRanAfterLabel, turnCheckNeedsFix, turnCheckResultLabel } from "./turnChecks";

function commandResult(command: FinishCommandEvidence): string {
  if (command.outcome === "declined") return "Declined: did not run";
  if (command.outcome === "tool-completed") return "Tool completed · exit code not reported";
  if (command.outcome === "unfinished") return "Completion not recorded";
  if (command.outcome === "failed")
    return command.exitCode === null
      ? "Failed or interrupted"
      : `Exit ${command.exitCode} · failure reported`;
  return command.exitCode === null ? "Exit code not reported" : `Exit ${command.exitCode}`;
}

function checkNeedsAttention(check: FinishCheckEvidence): boolean {
  return (
    turnCheckNeedsFix(check.check) ||
    check.outcome === "unknown" ||
    check.outcome === "stopped" ||
    check.outcome === "skipped" ||
    check.freshness === "later-work"
  );
}

/** Recorded details only; opening this never runs a command or calls a model. */
export function FinishEvidenceCard({
  evidence,
  onOpenCheckOutput,
  onAskForFix,
}: {
  readonly evidence: FinishEvidence | null;
  /** Opens a check's saved full-output log. */
  readonly onOpenCheckOutput?: (path: string) => void;
  /** Drafts a correction request for a failed check into the composer. */
  readonly onAskForFix?: (check: FinishCheckEvidence) => void;
}) {
  if (!evidence) return null;
  const turnLabel =
    evidence.turnOrdinal === undefined ? "this turn" : `Turn ${evidence.turnOrdinal}`;
  const deliverySummary = finishApprovalDeliverySummary(evidence);
  const declinedSummary = [
    evidence.declinedCount
      ? `${evidence.declinedCount} ${evidence.declinedCount === 1 ? "command" : "commands"} declined`
      : null,
    evidence.declinedFileChanges
      ? `${evidence.declinedFileChanges} ${evidence.declinedFileChanges === 1 ? "file change" : "file changes"} declined`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <div className="my-1 flex flex-wrap items-center gap-2">
      <Popover key={evidence.runId}>
        <PopoverTrigger
          aria-label="Reply details"
          render={<Button variant="ghost-muted" size="xs" />}
        >
          <ListIcon aria-hidden />
          Details
        </PopoverTrigger>
        <PopoverPopup width="lg" variant="review" padding="none" align="start" sideOffset={6}>
          <div className="flex max-h-[min(28rem,calc(var(--available-height)-2px))] min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
              <PopoverTitle>Reply details</PopoverTitle>
              <PopoverClose
                aria-label="Close reply details"
                render={<Button variant="ghost-muted" size="icon-xs" />}
              >
                <XIcon aria-hidden />
              </PopoverClose>
            </div>
            <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3 text-xs">
              <p className="text-muted-foreground">
                {evidence.commands.length} {evidence.commands.length === 1 ? "command" : "commands"}{" "}
                · {evidence.files.length} reported {evidence.files.length === 1 ? "file" : "files"}
              </p>
              <p className="text-muted-foreground">
                {evidence.source === "native"
                  ? "Recorded tool activity for this reply. Arguments and outputs are hidden. This may not include shell edits or child agents. A completed tool does not mean tests passed."
                  : "Commands and file changes recorded for this reply. These records do not verify the whole project or work outside this chat."}
              </p>
              {evidence.captureIncomplete ? (
                <p className="text-muted-foreground">
                  Some activity could not be captured. Missing results are unknown.
                </p>
              ) : null}
              {declinedSummary ? <p className="text-muted-foreground">{declinedSummary}</p> : null}
              {finishApprovalDeliveryNotes(evidence).map((note) => (
                <p key={note} className="text-warning-foreground">
                  {note}
                </p>
              ))}
              {evidence.declinedFileChanges ? (
                <p className="text-muted-foreground">
                  {evidence.declinedFileChanges === 1
                    ? "1 declined file change was not written."
                    : `${evidence.declinedFileChanges} declined file changes were not written.`}
                </p>
              ) : null}
              {evidence.runStatus !== "completed" ? <p>Reply {evidence.runStatus}.</p> : null}
              {evidence.staleChecks ? (
                <p className="text-warning-foreground">
                  Files changed after {evidence.staleChecks} completed{" "}
                  {evidence.staleChecks === 1 ? "check began" : "checks began"}. Those results may
                  not cover the final edits.
                </p>
              ) : null}
              {evidence.unknownCount ? (
                <p className="text-muted-foreground">
                  {evidence.unknownCount === 1
                    ? "One command has"
                    : `${evidence.unknownCount} commands have`}{" "}
                  no recorded final result.
                </p>
              ) : null}
              {evidence.unconfirmedFileChanges ? (
                <p className="text-muted-foreground">
                  {evidence.unconfirmedFileChanges}{" "}
                  {evidence.unconfirmedFileChanges === 1 ? "file change has" : "file changes have"}{" "}
                  no recorded completion.
                </p>
              ) : null}
              <ol className="divide-y divide-border/60">
                {evidence.commands.map((command) => (
                  <li key={command.id} className="py-2 first:pt-0 last:pb-0">
                    <details className="group/command">
                      <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                        <span className="line-clamp-2 whitespace-pre-wrap break-all font-mono group-open/command:line-clamp-none">
                          {command.command}
                        </span>
                        <span
                          className={`mt-1 block pl-4 ${command.outcome === "failed" ? "text-warning-foreground" : "text-muted-foreground"}`}
                        >
                          {commandResult(command)}
                        </span>
                      </summary>
                      <div className="mt-2 space-y-1 pl-4 text-muted-foreground">
                        {command.startedAt ? (
                          <p>
                            Started{" "}
                            <time dateTime={command.startedAt}>
                              {new Date(command.startedAt).toLocaleTimeString()}
                            </time>
                          </p>
                        ) : (
                          <p>Start time not recorded</p>
                        )}
                        {command.completedAt ? (
                          <p>
                            Finished{" "}
                            <time dateTime={command.completedAt}>
                              {new Date(command.completedAt).toLocaleTimeString()}
                            </time>
                          </p>
                        ) : null}
                      </div>
                    </details>
                    {command.isCheck &&
                    (command.outcome === "exit-zero" || command.outcome === "tool-completed") &&
                    command.freshness === "changed" ? (
                      <p className="mt-1 break-all text-warning-foreground">
                        Files edited later: {command.laterFiles.join(", ")}
                      </p>
                    ) : null}
                    {command.isCheck && command.freshness === "unknown" ? (
                      <p className="mt-1 text-muted-foreground">
                        Unknown whether this check covers the recorded edits.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
              {evidence.checks?.length || evidence.checksIncomplete ? (
                <section aria-label={`Checks after ${turnLabel}`} className="space-y-2">
                  <p className="font-medium">Checks after {turnLabel}</p>
                  <p className="text-muted-foreground">
                    Each command {checkRanAfterLabel(turnLabel)}. It shows what the command returned
                    then, not whether {turnLabel}'s own changes are correct. Changes made outside
                    this thread are not tracked.
                  </p>
                  {evidence.checksIncomplete ? (
                    <p className="text-muted-foreground">
                      Older history is not loaded, so some checks may be missing.
                    </p>
                  ) : null}
                  <ol className="divide-y divide-border/60">
                    {(evidence.checks ?? []).map((check) => (
                      <li key={check.runId} className="space-y-1 py-2 first:pt-0 last:pb-0">
                        <p className="line-clamp-2 whitespace-pre-wrap break-all font-mono">
                          {check.command}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                          <span
                            className={checkNeedsAttention(check) ? "text-warning-foreground" : ""}
                          >
                            {check.name}: {turnCheckResultLabel(check.check)}
                          </span>
                          {check.completedAt ? (
                            <span>
                              Finished{" "}
                              <time dateTime={check.completedAt}>
                                {new Date(check.completedAt).toLocaleTimeString()}
                              </time>
                            </span>
                          ) : null}
                          {check.fullOutputPath && onOpenCheckOutput ? (
                            <Button
                              size="micro"
                              variant="link"
                              onClick={() => onOpenCheckOutput(check.fullOutputPath!)}
                            >
                              Full output
                            </Button>
                          ) : null}
                          {turnCheckNeedsFix(check.check) && onAskForFix ? (
                            <Button
                              size="micro"
                              variant="outline"
                              onClick={() => onAskForFix(check)}
                            >
                              Ask for a fix
                            </Button>
                          ) : null}
                        </div>
                        {check.skipReason ? (
                          <p className="text-muted-foreground">{check.skipReason}</p>
                        ) : check.freshness === "later-work" ? (
                          <p className="text-warning-foreground">
                            Later work ran in this folder, so this result may be out of date.
                          </p>
                        ) : check.freshness === "unknown" ? (
                          <p className="text-muted-foreground">
                            Cannot tell whether later work ran in this folder.
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
              {evidence.files.length ? (
                <details>
                  <summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
                    Reported files ({evidence.files.length})
                  </summary>
                  <ul className="mt-2 space-y-1 break-all font-mono">
                    {evidence.files.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      {deliverySummary ? (
        <span className="text-xs text-warning-foreground">{deliverySummary}</span>
      ) : null}
    </div>
  );
}
