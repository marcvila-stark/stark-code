import { ProposedFileChangesPreview } from "./ProposedFileChangesPreview";
import { RequestActionButton } from "./RequestActionButton";
import {
  mobileApprovalChoiceDetails,
  mobileApprovalChoices,
  mobileApprovalNoChoicesNote,
  mobileApprovalScopeLines,
} from "./pendingApprovalOptions";
import {
  STARK_PAGES_UNCERTAIN_NOTE,
  approvalChoiceResponse,
  approvalKindTitle,
  approvalPromptParts,
  type ApprovalResponseInput,
} from "@starkfuture/client-runtime/approvals/permission-presentation";
import { summarizeProposedChanges } from "@starkfuture/client-runtime/approvals/proposed-file-changes";
import type { ProviderApprovalDecision, RuntimeRequestId } from "@starkfuture/contracts";
import { classifyReadOnlyShellCommand } from "@starkfuture/shared/readOnlyShellCommand";
import {
  canAnswerRuntimeRequest,
  isSendingRuntimeResponse,
  type RuntimeRequestResponseState,
} from "@starkfuture/client-runtime/state/runtime-request-response";
import { useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";
import { RuntimeRequestResponseCaption } from "./RuntimeRequestResponseCaption";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  /** The chat's folder; file-change previews show paths relative to it. */
  readonly cwd?: string | null;
  readonly respondingApprovalId: RuntimeRequestId | null;
  /** Whether the approval can take an answer now; without it only the provider gates it. */
  readonly responseState?: RuntimeRequestResponseState | null;
  /** `response` carries the chosen option's server id and any reason typed for the agent. */
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    response?: ApprovalResponseInput,
  ) => Promise<unknown>;
  /** Sends an answer that could not be confirmed again under its original command. */
  readonly onRetry?: ((requestId: RuntimeRequestId) => void) | undefined;
  /** The provider's name in delivery captions, such as "Closed by Codex before…". */
  readonly providerName?: string | undefined;
}

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  // Persistent choices need a settings grant and an exact-rule preview UI.
  // Until mobile supports both, only the desktop approval card offers them.
  const choices = mobileApprovalChoices(props.approval.options);
  const warning = choices.find((choice) => choice.warning)?.warning;
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  const canRespond = props.approval.responseCapability === "live";
  // Same classifier as the desktop card; the exact command stays visible below it.
  const readOnly = useMemo(
    () =>
      props.approval.requestKind === "command" && canRespond
        ? classifyReadOnlyShellCommand(props.approval.command)
        : undefined,
    [canRespond, props.approval.command, props.approval.requestKind],
  );
  const proposedChanges = useMemo(
    () =>
      props.approval.requestKind === "file-change" && canRespond
        ? summarizeProposedChanges(
            props.approval.proposedChanges,
            props.approval.proposedChangesOmitted,
            props.cwd,
          )
        : null,
    [
      canRespond,
      props.approval.proposedChanges,
      props.approval.proposedChangesOmitted,
      props.approval.requestKind,
      props.cwd,
    ],
  );
  // A hook's forced ask and Stark's Pages reason arrive in the prompt; they show on their own.
  const promptParts = approvalPromptParts(props.approval.detail);
  const responseState = props.responseState ?? null;
  const sending =
    props.respondingApprovalId === props.approval.requestId ||
    (responseState !== null && isSendingRuntimeResponse(responseState));
  // Offline or still syncing: the approval stays visible but takes no answer.
  const answerable = responseState === null || canAnswerRuntimeRequest(responseState);
  const disabled = !canRespond || sending || !answerable;
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-stark-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Approval needed
      </Text>
      <Text className="font-stark-bold text-lg text-foreground">
        {proposedChanges?.headline ??
          props.approval.appName ??
          approvalKindTitle(props.approval.requestKind)}
      </Text>
      {readOnly?.readOnly ? (
        <Text className="font-sans text-sm leading-normal text-foreground">{readOnly.summary}</Text>
      ) : null}
      {proposedChanges ? (
        <ProposedFileChangesPreview
          key={props.approval.requestId}
          summary={proposedChanges}
          detail={props.approval.detail}
        />
      ) : promptParts.text ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {promptParts.text}
        </Text>
      ) : null}
      {props.approval.requestKind === "file-change" && canRespond && proposedChanges === null ? (
        <Text className="font-sans text-sm text-warning-foreground">
          The provider did not name the files or supply a diff. Inspect the request before allowing
          it.
        </Text>
      ) : null}
      {promptParts.pagesUncertain ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">
          {STARK_PAGES_UNCERTAIN_NOTE}
        </Text>
      ) : null}
      {promptParts.askedByHook ? (
        <Text className="font-sans text-xs text-foreground-muted">Asked by a hook</Text>
      ) : null}
      {props.approval.command && props.approval.command !== props.approval.detail ? (
        <Text
          accessibilityLabel="Exact command"
          selectable
          className="font-mono text-xs leading-normal text-foreground"
        >
          {props.approval.command}
        </Text>
      ) : null}
      {mobileApprovalScopeLines(props.approval.scope).map((line) => (
        <Text
          key={line}
          selectable
          className="font-sans text-xs leading-normal text-foreground-secondary"
        >
          {line}
        </Text>
      ))}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      {responseState ? (
        <RuntimeRequestResponseCaption
          state={responseState}
          onRetry={props.onRetry ? () => props.onRetry?.(props.approval.requestId) : undefined}
          delivery={props.approval.delivery}
          providerName={props.providerName}
        />
      ) : null}
      {mobileApprovalNoChoicesNote(props.approval.options) !== null ? (
        <Text className="font-sans text-xs leading-normal text-foreground-muted">
          {mobileApprovalNoChoicesNote(props.approval.options)}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {choices.map((choice) => (
          <RequestActionButton
            key={choice.key}
            label={choice.label}
            tone={
              choice.placement === "primary"
                ? choice.optionClass === "deny"
                  ? "danger"
                  : "primary"
                : "secondary"
            }
            disabled={disabled || !props.canOperateThread}
            onPress={() => {
              if (!disabled && props.canOperateThread)
                void props.onRespond(
                  props.approval.requestId,
                  choice.decision,
                  approvalChoiceResponse(choice),
                );
            }}
          />
        ))}
      </View>
      {mobileApprovalChoiceDetails(choices).map((detail) => (
        <Text key={detail} className="font-sans text-xs leading-normal text-foreground-muted">
          {detail}
        </Text>
      ))}
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </View>
  );
}
