import {
  STARK_PAGES_UNCERTAIN_NOTE,
  approvalPromptParts,
  approvalScopeRows,
  type ApprovalRequestScope,
} from "@starkfuture/client-runtime/approvals/permission-presentation";
import { summarizeProposedChanges } from "@starkfuture/client-runtime/approvals/proposed-file-changes";
import { resolveStarkMcpToolId } from "@starkfuture/shared/starkMcpToolPresentation";
import { memo, useMemo, useState } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";
import {
  APPROVAL_EXPLANATION_LIMIT,
  READ_ONLY_APPROVAL_LIMIT,
  explainApprovalCommand,
} from "./approvalExplanation";
import { ApprovalProposedChanges } from "./ApprovalProposedChanges";
import { ToolApprovalDetails } from "./ToolApprovalDetails";
import type { ToolApprovalInputState } from "./useToolApprovalInput";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const stepPrefix = (step: { readonly caution: boolean; readonly unknown: boolean }) =>
  step.caution ? "Caution: " : step.unknown ? "Not explained: " : "";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  /** The chat's folder; file-change previews show paths relative to it. */
  cwd?: string | undefined;
  /** A tool approval's whole call, when the host loaded it (see useToolApprovalInput). */
  toolCallInput?: ToolApprovalInputState | null | undefined;
  /** Who asked and what the request reaches beyond its command or files, as the provider sent it. */
  scope?: ApprovalRequestScope | undefined;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  cwd,
  toolCallInput,
  scope,
  className,
}: ComposerPendingApprovalPanelProps) {
  const scopeRows = useMemo(() => approvalScopeRows(scope), [scope]);
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const detailsOpen = expandedRequestId === approval.requestId;
  // Providers file every non-shell tool under "command", and Codex asks about an
  // MCP tool call as an app elicitation; a linked tool call that is not a shell
  // command gets the tool card, not a shell explanation or the app's prose.
  const toolCall =
    (approval.requestKind === "command" || approval.requestKind === "mcp-elicitation") &&
    approval.command === undefined &&
    approval.responseCapability === "live"
      ? approval.toolCall
      : undefined;
  const explanation = useMemo(
    () =>
      approval.requestKind === "command" &&
      approval.responseCapability === "live" &&
      toolCall === undefined
        ? explainApprovalCommand(approval.command)
        : null,
    [approval.command, approval.requestKind, approval.responseCapability, toolCall],
  );
  const proposedChanges = useMemo(
    () =>
      approval.requestKind === "file-change" && approval.responseCapability === "live"
        ? summarizeProposedChanges(approval.proposedChanges, approval.proposedChangesOmitted, cwd)
        : null,
    [
      approval.proposedChanges,
      approval.proposedChangesOmitted,
      approval.requestKind,
      approval.responseCapability,
      cwd,
    ],
  );
  const mainStep =
    explanation?.steps.find((step) => step.caution) ??
    explanation?.steps.find((step) => step.unknown) ??
    explanation?.steps[0];
  const readOnly = explanation?.readOnly;
  // Codex sends `/bin/zsh -lc '…'` as both detail and command. The headline shows
  // the script that runs; the exact wrapped command stays under the details.
  const wrapper =
    explanation?.wrapper && approval.command === approval.detail ? explanation.wrapper : undefined;
  // Claude sends its own summary ("Create build directory and write timestamp") beside the
  // command. It is prose about the command, so it reads as text under the title, not as a
  // second command with a focus stop of its own.
  // A hook's forced ask and Stark's "may publish to Stark Pages" reason arrive in the prompt;
  // they show as notes of their own, and only the rest is the agent's description.
  const promptParts = useMemo(() => approvalPromptParts(approval.detail), [approval.detail]);
  const description =
    approval.command && approval.detail && approval.detail !== approval.command
      ? promptParts.text
      : undefined;
  // An established effect leads the card; an unexplained command shows first.
  const explanationLeads = Boolean(readOnly) || (mainStep !== undefined && !mainStep.unknown);
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : toolCall
        ? resolveStarkMcpToolId(toolCall.toolName) === null
          ? "Tool approval"
          : "Stark Code tool approval"
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

  const explanationLine = (
    <span
      aria-label="Command explanation"
      className={cn(
        "w-full text-xs leading-relaxed",
        mainStep?.caution && !readOnly ? "text-warning" : "text-muted-foreground",
      )}
    >
      {readOnly
        ? readOnly.summary
        : `${mainStep ? stepPrefix(mainStep) : ""}${mainStep?.explanation ?? ""}`}
    </span>
  );

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
      data-runtime-request-id={approval.requestId}
      tabIndex={-1}
    >
      <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-muted-foreground">{fallbackLabel}</span>
        {readOnly ? (
          <Badge variant="secondary" size="sm">
            Read-only command
          </Badge>
        ) : null}
        {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      {promptParts.pagesUncertain ? (
        <span aria-label="Stark Pages" className="w-full text-xs leading-relaxed text-warning">
          {STARK_PAGES_UNCERTAIN_NOTE}
        </span>
      ) : null}
      {promptParts.askedByHook ? (
        <span aria-label="Asked by a hook" className="text-2xs text-muted-foreground">
          Asked by a hook
        </span>
      ) : null}
      {description !== undefined && approval.responseCapability === "live" ? (
        <span
          aria-label="Description"
          className="w-full text-xs leading-relaxed text-foreground wrap-break-word"
        >
          {description}
        </span>
      ) : null}
      {explanation && explanationLeads ? explanationLine : null}
      {scope?.defaultToNo ? (
        <span className="text-xs leading-relaxed text-warning">
          The provider recommends declining this request.
        </span>
      ) : null}
      {scopeRows.length > 0 ? (
        <dl
          aria-label="What this request reaches"
          className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs leading-relaxed"
        >
          {scopeRows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd
                className={cn(
                  "min-w-0 whitespace-pre-wrap text-foreground",
                  row.code ? "font-mono wrap-anywhere" : "wrap-break-word",
                )}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {toolCall ? (
        <ToolApprovalDetails
          key={approval.requestId}
          toolCall={toolCall}
          prompt={approval.detail}
          inputState={toolCallInput}
        />
      ) : proposedChanges ? (
        <ApprovalProposedChanges
          key={approval.requestId}
          summary={proposedChanges}
          detail={approval.detail}
        />
      ) : approval.command &&
        approval.detail !== approval.command &&
        approval.responseCapability === "live" ? null : (
        <Detail
          aria-label={detailAriaLabel}
          className={cn(
            "block max-h-24 w-full min-w-0 overflow-auto whitespace-pre-wrap text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
            // Long commands wrap so a narrow card never hides their end off to the side.
            approval.requestKind === "mcp-elicitation"
              ? "font-sans wrap-break-word"
              : "font-mono wrap-anywhere",
          )}
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.responseCapability === "not_resumable"
            ? "Provider process is gone — interrupt or restart the run to respond."
            : (wrapper?.script ?? (approval.detail || fallbackLabel))}
        </Detail>
      )}
      {approval.requestKind === "file-change" &&
      approval.responseCapability === "live" &&
      proposedChanges === null ? (
        <span className="w-full text-xs text-warning">
          The provider did not name the files or supply a diff. Inspect the request before allowing
          it.
        </span>
      ) : null}
      {approval.command && approval.command !== approval.detail ? (
        <code
          aria-label="Exact command"
          className="block max-h-24 w-full min-w-0 overflow-auto whitespace-pre-wrap text-xs wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          tabIndex={0}
        >
          {approval.command}
        </code>
      ) : null}
      {explanation ? (
        <span className="flex w-full flex-col gap-1 text-xs leading-relaxed">
          {explanationLeads ? null : explanationLine}
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
                {wrapper ? "Exact command, details and limits" : "Details and limits"}
                {explanation.steps.length > 1 ? ` · ${explanation.steps.length} command parts` : ""}
              </Button>
              {detailsOpen ? (
                <span className="flex max-h-48 w-full flex-col gap-1 overflow-auto py-1">
                  {wrapper ? (
                    <code
                      aria-label="Exact command"
                      // shrink-0: in the capped details list a scrolling flex item shrank below
                      // one line and cut the command in half.
                      className="block w-full min-w-0 shrink-0 overflow-auto whitespace-pre-wrap text-foreground wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                      tabIndex={0}
                    >
                      {approval.command}
                    </code>
                  ) : null}
                  {explanation.steps.length > 1 ? (
                    <span className="whitespace-pre-line">
                      {explanation.steps
                        .map(
                          (step, index) => `${index + 1}. ${stepPrefix(step)}${step.explanation}`,
                        )
                        .join("\n")}
                    </span>
                  ) : null}
                  {[...explanation.notes.slice(1), ...explanation.context].map((note) => (
                    <span key={note}>{note}</span>
                  ))}
                  <span>{readOnly ? READ_ONLY_APPROVAL_LIMIT : APPROVAL_EXPLANATION_LIMIT}</span>
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
});
