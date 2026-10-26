import { memo, useMemo, useState } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";
import { APPROVAL_EXPLANATION_LIMIT, explainApprovalCommand } from "./approvalExplanation";
import { Button } from "../ui/button";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const detailsOpen = expandedRequestId === approval.requestId;
  const explanation = useMemo(
    () =>
      approval.requestKind === "command" && approval.responseCapability === "live"
        ? explainApprovalCommand(approval.command)
        : null,
    [approval.command, approval.requestKind, approval.responseCapability],
  );
  const mainStep =
    explanation?.steps.find((step) => step.caution) ??
    explanation?.steps.find((step) => step.unknown) ??
    explanation?.steps[0];
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : approval.requestKind === "permission"
            ? "App permission approval"
            : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : approval.requestKind === "permission"
            ? "Permission request"
            : "File change";

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
      data-runtime-request-id={approval.requestId}
      tabIndex={-1}
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
        {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      <Detail
        aria-label={detailAriaLabel}
        className={cn(
          "block max-h-20 w-full min-w-0 overflow-auto text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
          approval.requestKind === "mcp-elicitation"
            ? "whitespace-pre-wrap font-sans wrap-break-word"
            : "whitespace-pre font-mono",
        )}
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.responseCapability === "not_resumable"
          ? "Provider process is gone — interrupt or restart the run to respond."
          : approval.detail || fallbackLabel}
      </Detail>
      {approval.command && approval.command !== approval.detail ? (
        <code
          aria-label="Exact command"
          className="block max-h-24 w-full overflow-auto whitespace-pre text-xs [scrollbar-width:thin]"
          tabIndex={0}
        >
          {approval.command}
        </code>
      ) : null}
      {explanation ? (
        <span
          aria-label="Command explanation"
          className="flex w-full flex-col gap-1 text-xs leading-relaxed"
        >
          <span className={mainStep?.caution ? "text-warning" : "text-muted-foreground"}>
            {mainStep?.caution ? "Caution: " : mainStep?.unknown ? "Unknown: " : ""}
            {mainStep?.explanation}
          </span>
          {explanation.notes.length > 0 ? (
            <span className="text-warning">{explanation.notes[0]}</span>
          ) : null}
          {approval.command ? (
            <span className="flex w-full flex-col items-start text-muted-foreground">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-expanded={detailsOpen}
                onClick={() => setExpandedRequestId(detailsOpen ? null : approval.requestId)}
              >
                Details and limits
                {explanation.steps.length > 1 ? ` · ${explanation.steps.length} command parts` : ""}
              </Button>
              {detailsOpen ? (
                <span className="flex max-h-48 flex-col gap-1 overflow-auto py-1">
                  {explanation.steps.length > 1 ? (
                    <span className="whitespace-pre-line">
                      {explanation.steps
                        .map(
                          (step, index) =>
                            `${index + 1}. ${step.caution ? "Caution: " : step.unknown ? "Unknown: " : ""}${step.explanation}`,
                        )
                        .join("\n")}
                    </span>
                  ) : null}
                  {explanation.notes.slice(1).map((note) => (
                    <span key={note}>{note}</span>
                  ))}
                  <span>{APPROVAL_EXPLANATION_LIMIT}</span>
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
});
