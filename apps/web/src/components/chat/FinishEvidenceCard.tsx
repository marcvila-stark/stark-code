import { ListIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import type { FinishCommandEvidence, FinishEvidence } from "./finishEvidence";

function commandResult(command: FinishCommandEvidence): string {
  if (command.outcome === "tool-completed") return "Tool completed · exit code not reported";
  if (command.outcome === "unfinished") return "Completion not recorded";
  if (command.outcome === "failed")
    return command.exitCode === null
      ? "Failed or interrupted"
      : `Exit ${command.exitCode} · failure reported`;
  return command.exitCode === null ? "Exit code not reported" : `Exit ${command.exitCode}`;
}

/** Recorded details only; opening this never runs a command or calls a model. */
export function FinishEvidenceCard({ evidence }: { readonly evidence: FinishEvidence | null }) {
  if (!evidence) return null;
  return (
    <div className="my-1 flex items-center">
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
    </div>
  );
}
