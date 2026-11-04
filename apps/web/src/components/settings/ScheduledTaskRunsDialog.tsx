import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ScheduledTask, ScheduledTaskRun } from "@starkfuture/contracts";
import {
  isScheduledTaskRunActive,
  scheduledTaskRunDurationLabel,
  scheduledTaskRunStateLabel,
  scheduledTaskRunTone,
  scheduledTaskRunTriggerLabel,
  type ScheduledTaskRunTone,
} from "@starkfuture/client-runtime/scheduled-task-runs";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TONE_BADGE_VARIANTS = {
  success: "success",
  error: "error",
  active: "info",
  muted: "outline",
} as const satisfies Record<ScheduledTaskRunTone, string>;

/** Badge variant for a run state, shared by the run list and a task's latest-run badge. */
export function scheduledTaskRunBadgeVariant(run: ScheduledTaskRun) {
  return TONE_BADGE_VARIANTS[scheduledTaskRunTone(run.state)];
}

function runTimeSummary(run: ScheduledTaskRun, nowMs: number): string {
  const duration = scheduledTaskRunDurationLabel(run, nowMs);
  if (run.startedAt === null) {
    // Never started: a webhook request still waiting, or a slot that was skipped.
    const at = formatRelativeTimeLabel(run.createdAt);
    return run.trigger === "webhook" ? `Received ${at}` : `Due ${at}`;
  }
  const started = `Started ${formatRelativeTimeLabel(run.startedAt)}`;
  if (duration === null) return started;
  return isScheduledTaskRunActive(run.state)
    ? `${started} · ${duration} so far`
    : `${started} · took ${duration}`;
}

/** Exact start and end times, behind the relative summary. */
function runTimeLines(run: ScheduledTaskRun): ReadonlyArray<string> {
  const started = `Started ${new Date(run.startedAt ?? run.createdAt).toLocaleString()}`;
  return run.endedAt === null
    ? [started]
    : [started, `Ended ${new Date(run.endedAt).toLocaleString()}`];
}

/**
 * The newest runs of one scheduled task, each with its state, trigger, timing
 * and a link to the thread it ran in. Updates as runs change.
 */
export function ScheduledTaskRunsDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const runsQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskRuns({ environmentId, input: { id: task.id } }),
  );
  const runs = runsQuery.data?.runs ?? null;
  const hasActiveRun = runs?.some((run) => isScheduledTaskRunActive(run.state)) ?? false;
  const [nowMs, setNowMs] = useState(Date.now);
  // Only an active run's elapsed time moves; finished runs need no clock.
  useEffect(() => {
    if (!hasActiveRun) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasActiveRun]);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Runs · {task.title}</DialogTitle>
          <DialogDescription>
            The newest runs of this task. A run follows the agent's turn until it ends.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {runsQuery.error ? <p className="text-sm text-destructive">{runsQuery.error}</p> : null}
          {runs === null ? (
            runsQuery.error ? null : (
              <p className="text-sm text-muted-foreground" role="status">
                Loading runs…
              </p>
            )
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm"
                >
                  <Badge variant={scheduledTaskRunBadgeVariant(run)}>
                    {scheduledTaskRunStateLabel(run.state)}
                  </Badge>
                  <span>{scheduledTaskRunTriggerLabel(run.trigger)}</span>
                  <Tooltip>
                    <TooltipTrigger render={<span className="text-muted-foreground" />}>
                      {runTimeSummary(run, nowMs)}
                    </TooltipTrigger>
                    <TooltipPopup>
                      {runTimeLines(run).map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </TooltipPopup>
                  </Tooltip>
                  {run.threadId !== null ? (
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: run.threadId }}
                      className="ms-auto underline underline-offset-2"
                      onClick={onClose}
                    >
                      Open thread
                    </Link>
                  ) : null}
                  {run.error !== null ? (
                    <p className="w-full text-destructive">{run.error}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={runsQuery.isPending}
            onClick={runsQuery.refresh}
          >
            Refresh
          </Button>
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
