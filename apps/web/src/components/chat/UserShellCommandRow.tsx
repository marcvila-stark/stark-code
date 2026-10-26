import { useState } from "react";
import type { OrchestrationV2TurnItem } from "@starkfuture/contracts";
import { Button } from "../ui/button";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";

export type UserShellCommandItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "command_execution" }
>;

export function userShellStatus(item: UserShellCommandItem | null, runStatus?: string): string {
  if (
    item?.interrupted ||
    item?.status === "interrupted" ||
    item?.status === "cancelled" ||
    runStatus === "interrupted"
  )
    return "stopped";
  if (item?.timedOut) return "timed out";
  if (item?.exitCode !== undefined && item.status !== "running") return `exit ${item.exitCode}`;
  if (item?.status === "failed" || runStatus === "failed") return "failed to start";
  return item?.status === "running" || item?.status === "pending" || runStatus === "running"
    ? "Running"
    : "Queued";
}

export function UserShellCommandRow(props: {
  readonly command: string;
  readonly respond: boolean;
  readonly item: UserShellCommandItem | null;
  readonly runStatus?: string;
  readonly onOpenFullOutput: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const output = props.item?.output ?? "";
  const lines = output.split("\n");
  const collapsed = lines.length > 20 && !expanded;
  const status = userShellStatus(props.item, props.runStatus);
  const destructive =
    status === "timed out" || status === "failed to start" || (props.item?.exitCode ?? 0) !== 0;
  return (
    <section aria-label="User shell command" className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono">!</span>
        <span className={destructive ? "text-destructive" : "text-muted-foreground"}>
          {status}
          {props.item?.durationMs !== undefined
            ? ` · ${(props.item.durationMs / 1000).toFixed(1)}s`
            : ""}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void writeTextToClipboard(`${props.command}\n${output}`)}
        >
          Copy
        </Button>
      </div>
      <div className="whitespace-pre-wrap font-mono">
        <ShellCommandBlock command={props.command} />
      </div>
      {output.length > 0 ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
          {collapsed ? lines.slice(0, 20).join("\n") : output}
        </pre>
      ) : null}
      {lines.length > 20 ? (
        <Button variant="ghost" size="xs" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show all"}
        </Button>
      ) : null}
      {props.item?.fullOutputPath ? (
        <Button
          variant="link"
          size="xs"
          onClick={() => props.onOpenFullOutput(props.item!.fullOutputPath!)}
        >
          Full output saved
        </Button>
      ) : null}
      {!props.respond ? (
        <p className="text-xs text-muted-foreground">
          Recorded in the conversation. The agent will see it with your next message.
        </p>
      ) : null}
    </section>
  );
}
