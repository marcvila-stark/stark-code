import type { EnvironmentId, ScheduledTask } from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import { CalendarClockIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useId } from "react";
import {
  scheduledTaskRunStateLabel,
  scheduledTaskRunTone,
} from "@starkfuture/client-runtime/scheduled-task-runs";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { relativeLabel } from "../settings/ScheduledTasksSettings";
import { SidebarNavigationButton } from "./SidebarNavigationButton";

/** Rows beyond this stay in Settings; the sidebar header must not crowd out chats. */
export const SIDEBAR_SCHEDULED_TASKS_LIMIT = 5;

/** `nowMinute` is unused by the label itself; it makes the countdown recompute each minute. */
function taskStatus(task: ScheduledTask, _nowMinute: string): string {
  if (!task.enabled) return "Paused";
  if (task.schedule.type === "webhook") return "Listening";
  return task.nextRunAt ? `Next ${relativeLabel(task.nextRunAt)}` : "Not scheduled";
}

/** Prefers the run history; `lastRunStatus` only covers dispatch, and older servers send no `latestRun`. */
function failedLabel(task: ScheduledTask): string | null {
  if (task.latestRun !== undefined) {
    return scheduledTaskRunTone(task.latestRun.state) === "error"
      ? scheduledTaskRunStateLabel(task.latestRun.state)
      : null;
  }
  return task.lastRunStatus === "failed" ? "Failed" : null;
}

export function SidebarScheduledTasks({
  environmentId,
  tasks,
  onOpenTask,
  onOpenAll,
}: {
  environmentId: EnvironmentId;
  tasks: readonly ScheduledTask[];
  onOpenTask: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  onOpenAll: () => void;
}) {
  const [expanded, setExpanded] = useLocalStorage(
    "stark-code:sidebar-scheduled-tasks-expanded",
    true,
    Schema.Boolean,
  );
  const listId = useId();
  const nowMinute = useNowMinute();
  if (tasks.length === 0) return null;
  const visible = tasks.slice(0, SIDEBAR_SCHEDULED_TASKS_LIMIT);
  const hidden = tasks.length - visible.length;
  return (
    <div>
      <div className="stark-sidebar-list-heading">
        <button
          type="button"
          className="flex h-full w-full items-center gap-1"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3" />
          )}
          <span>Scheduled tasks</span>
          <span className="tabular-nums">{tasks.length}</span>
        </button>
      </div>
      {expanded ? (
        <ul id={listId} className="max-h-40 list-none overflow-y-auto">
          {visible.map((task) => {
            const failed = failedLabel(task);
            const status = taskStatus(task, nowMinute);
            return (
              <li key={task.id}>
                <SidebarNavigationButton
                  aria-label={`${task.title}, ${status}${failed ? `, last run ${failed.toLowerCase()}` : ""}`}
                  onClick={() => onOpenTask(environmentId, task)}
                >
                  <CalendarClockIcon aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <span
                    className={cn(
                      "shrink-0 text-2xs text-sidebar-muted-foreground",
                      failed && "text-destructive",
                    )}
                  >
                    {failed ?? status}
                  </span>
                </SidebarNavigationButton>
              </li>
            );
          })}
          {hidden > 0 ? (
            <li>
              <SidebarNavigationButton onClick={onOpenAll}>
                <span className="text-sidebar-muted-foreground">{hidden} more…</span>
              </SidebarNavigationButton>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** Primary environment only; other environments' tasks stay in Settings. */
export function SidebarScheduledTasksSection({
  onNavigate,
}: {
  onNavigate?: (() => void) | undefined;
}) {
  const router = useRouter();
  const environmentId = usePrimaryEnvironmentId();
  const connected = useConnectedEnvironmentIds().some((id) => id === environmentId);
  const query = useEnvironmentQuery(
    environmentId && connected
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  if (!environmentId || !query.data) return null;
  return (
    <SidebarScheduledTasks
      environmentId={environmentId}
      tasks={query.data.tasks}
      onOpenTask={(taskEnvironmentId, task) => {
        onNavigate?.();
        void router.navigate({
          to: "/settings/scheduled-tasks",
          search: { environmentId: taskEnvironmentId, taskId: task.id },
        });
      }}
      onOpenAll={() => {
        onNavigate?.();
        void router.navigate({ to: "/settings/scheduled-tasks", search: {} });
      }}
    />
  );
}
