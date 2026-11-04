import { isToolInputSummarized } from "@starkfuture/client-runtime/approvals/tool-approval";
import type { EnvironmentId } from "@starkfuture/contracts";

import type { PendingApproval } from "../../session-logic";
import { useTurnItemDetail } from "../../state/queries";

export interface ToolApprovalInputState {
  /** The tool call's arguments: whole once loaded, otherwise what the timeline carried. */
  readonly input: unknown;
  readonly pending: boolean;
  readonly error: string | null;
  /** The detail read answered; arguments still cut after it were too large to send. */
  readonly loaded: boolean;
}

/**
 * Arguments for a tool approval card. A large call reaches the timeline as a
 * one-line summary, so the card loads the whole call from its tool item.
 */
export function useToolApprovalInput(
  approval: PendingApproval | null,
  environmentId: EnvironmentId | undefined,
): ToolApprovalInputState | null {
  const toolCall = approval?.toolCall;
  const detail = useTurnItemDetail(
    toolCall !== undefined && environmentId !== undefined && isToolInputSummarized(toolCall.input)
      ? {
          environmentId,
          threadId: toolCall.threadId,
          itemId: toolCall.itemId,
          revision: toolCall.revision,
        }
      : null,
  );
  if (toolCall === undefined) return null;
  const fetched = detail.data?.item;
  return {
    input: fetched?.type === "dynamic_tool" ? fetched.input : toolCall.input,
    pending: detail.isPending,
    error: detail.error,
    loaded: fetched?.type === "dynamic_tool",
  };
}
