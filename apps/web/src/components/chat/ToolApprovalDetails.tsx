import {
  isToolInputSummarized,
  presentToolApproval,
  toolApprovalNote,
} from "@starkfuture/client-runtime/approvals/tool-approval";
import { useMemo, useState } from "react";

import type { PendingApproval } from "../../session-logic";
import { Button } from "../ui/button";
import type { ToolApprovalInputState } from "./useToolApprovalInput";

type ToolCall = NonNullable<PendingApproval["toolCall"]>;

const KIB = 1024;
const sizeLabel = (value: string) => {
  const bytes = new TextEncoder().encode(value).length;
  return bytes < KIB ? null : `${(bytes / KIB).toFixed(1)} KB`;
};

/**
 * What a non-shell tool call awaiting approval does and every argument it
 * carries. A large call loads its full arguments from the tool item; the page
 * it names is never rendered and its files are never read before the decision.
 */
export function ToolApprovalDetails({
  toolCall,
  prompt,
  inputState,
}: {
  toolCall: ToolCall;
  prompt: string | undefined;
  /** The whole call, loaded by the host; without it the timeline's copy is shown. */
  inputState: ToolApprovalInputState | null | undefined;
}) {
  const input = inputState?.input ?? toolCall.input;
  const presentation = useMemo(
    () => presentToolApproval({ toolName: toolCall.toolName, input }),
    [toolCall.toolName, input],
  );
  const note = toolApprovalNote(prompt, toolCall.toolName);
  const [argumentsOpen, setArgumentsOpen] = useState(false);
  const argumentStatus = !presentation.argumentsIncomplete
    ? null
    : inputState?.pending
      ? "Loading the full arguments…"
      : inputState?.error
        ? `Couldn't load the full arguments: ${inputState.error}`
        : inputState?.loaded
          ? "These arguments are too large to show in full here."
          : "The full arguments are unavailable.";
  // An incomplete call still shows what arrived, labelled as partial.
  const partialText = !presentation.argumentsIncomplete
    ? null
    : typeof input === "string"
      ? input
      : isToolInputSummarized(input)
        ? input.summary
        : null;
  // The button names only a count: a list of argument names cannot wrap inside it and pushed
  // narrow cards sideways. The names and sizes show once the arguments are open.
  const argumentCount = presentation.argumentLines?.length ?? 0;

  return (
    <span className="flex w-full min-w-0 flex-col gap-1.5 text-xs leading-relaxed">
      <span aria-label="Tool effect" className="font-medium text-foreground wrap-anywhere">
        {presentation.headline}
      </span>
      {note ? (
        <span className="whitespace-pre-wrap text-muted-foreground wrap-anywhere">{note}</span>
      ) : null}
      <ul aria-label="What this call does" className="flex flex-col gap-1 text-muted-foreground">
        {presentation.scope.map((entry) => (
          <li key={entry.text} className="wrap-anywhere">
            {entry.text}
            {entry.files ? (
              <ul
                aria-label="Local files it reads"
                className="mt-0.5 flex flex-col font-mono text-2xs text-foreground wrap-anywhere"
              >
                {entry.files.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {argumentStatus ? (
        <span role="status" className="text-muted-foreground">
          {argumentStatus}
        </span>
      ) : null}
      <span className="flex w-full min-w-0 flex-col items-start">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={argumentsOpen}
          onClick={() => setArgumentsOpen((open) => !open)}
        >
          {argumentsOpen ? "Hide arguments" : "Show all arguments"}
          {argumentCount > 0 ? ` · ${argumentCount}` : ""}
        </Button>
        {argumentsOpen ? (
          <span
            aria-label="Tool arguments"
            tabIndex={0}
            className="block max-h-[min(16rem,30dvh)] w-full min-w-0 overflow-auto rounded-md border border-border/60 p-2 font-mono text-2xs [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="block break-all text-muted-foreground">{toolCall.toolName}</span>
            {presentation.argumentLines?.map(([key, value]) => (
              <span key={key} className="mt-1.5 block">
                <span className="block text-muted-foreground wrap-anywhere">
                  {[key, sizeLabel(value)].filter(Boolean).join(" · ")}
                </span>
                <span className="block whitespace-pre-wrap text-foreground wrap-anywhere">
                  {value}
                </span>
              </span>
            ))}
            {presentation.argumentText ? (
              <span className="mt-1.5 block whitespace-pre-wrap text-foreground wrap-anywhere">
                {presentation.argumentText}
              </span>
            ) : null}
            {partialText ? (
              <span className="mt-1.5 block">
                <span className="block text-muted-foreground">Partial arguments</span>
                <span className="block whitespace-pre-wrap text-foreground wrap-anywhere">
                  {partialText}
                </span>
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </span>
  );
}
