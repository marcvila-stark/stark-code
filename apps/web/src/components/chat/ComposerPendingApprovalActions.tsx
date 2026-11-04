import {
  APPROVAL_NO_CHOICES,
  approvalChoiceResponse,
  approvalOffersNoChoices,
  presentApprovalChoices,
  type ApprovalChoice,
  type ApprovalResponseInput,
} from "@starkfuture/client-runtime/approvals/permission-presentation";
import {
  PROVIDER_APPROVAL_FEEDBACK_MAX_LENGTH,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@starkfuture/contracts";
import { memo, useEffect, useRef, useState } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  /** The settings grant a saved choice needs; without it saved choices show but stay disabled. */
  canRemember?: boolean;
  disabled?: boolean;
  /** The server's options; older servers send none and the legacy decisions apply. */
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  /** The provider recommends declining: Decline becomes the primary button. */
  defaultToNo?: boolean | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    response?: ApprovalResponseInput,
  ) => Promise<unknown>;
}

const isDeny = (choice: ApprovalChoice) =>
  choice.optionClass === "deny" || choice.optionClass === "deny-stop";

/**
 * An approval's decisions, only from the server's list. The plain deny and the narrowest allow
 * are buttons; session, turn, saved and stop choices sit in a menu that says how long each lasts
 * and what it covers. A deny that takes feedback can carry a typed reason, kept per request: the
 * host reuses this component as one pending request replaces another.
 */
export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  canRemember = false,
  disabled = false,
  options,
  defaultToNo = false,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const [reasonOpenFor, setReasonOpenFor] = useState<RuntimeRequestId | null>(null);
  // Kept after sending, so a response the server refuses can be sent again; request ids are
  // never reused.
  const [reasonDrafts, setReasonDrafts] = useState<Readonly<Record<string, string>>>({});
  const reasonOpen = reasonOpenFor === requestId;
  const reason = reasonDrafts[requestId] ?? "";
  const setReason = (text: string) =>
    setReasonDrafts((drafts) => ({ ...drafts, [requestId]: text }));
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  // Keyboard focus follows the switch between the buttons and the reason editor: the editor's
  // textarea takes it on mount (so the closing menu must not pull it back to a trigger that is
  // gone), and Back returns it to the menu trigger.
  const closingIntoReason = useRef(false);
  const returningFromReason = useRef(false);
  useEffect(() => {
    if (reasonOpen) {
      closingIntoReason.current = false;
      return;
    }
    if (!returningFromReason.current) return;
    returningFromReason.current = false;
    menuTriggerRef.current?.focus();
  }, [reasonOpen]);
  const choices = presentApprovalChoices(options, { canRemember, persistent: "offer" });
  const blocked = disabled || isResponding || !canRespond;
  const respond = (choice: ApprovalChoice, feedback?: string) => {
    if (blocked || choice.disabledReason !== undefined) return;
    void onRespondToApproval(requestId, choice.decision, approvalChoiceResponse(choice, feedback));
  };
  const primary = choices.filter((choice) => choice.placement === "primary");
  const more = choices.filter((choice) => choice.placement === "more");
  const feedbackChoices = choices.filter((choice) => isDeny(choice) && choice.acceptsFeedback);

  if (approvalOffersNoChoices(options)) {
    return (
      <span role="note" className="max-w-72 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{APPROVAL_NO_CHOICES.title}.</span>{" "}
        {APPROVAL_NO_CHOICES.detail}
      </span>
    );
  }

  if (reasonOpen && feedbackChoices.length > 0) {
    return (
      // A set width: sized by its text, the field widened the actions column and squeezed the
      // request beside it into a narrow strip.
      <div className="flex w-72 min-w-0 max-w-full basis-full flex-col gap-1.5">
        <Textarea
          size="sm"
          aria-label="Reason for declining (optional)"
          placeholder="Tell the agent why (optional)"
          maxLength={PROVIDER_APPROVAL_FEEDBACK_MAX_LENGTH}
          value={reason}
          // Mounts only when the user opens the editor, so focus moves with them.
          autoFocus
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              returningFromReason.current = true;
              setReasonOpenFor(null);
            }}
          >
            Back
          </Button>
          {feedbackChoices.map((choice) => (
            <Button
              key={choice.key}
              size="xs"
              variant="outline"
              disabled={blocked}
              aria-description={choice.lifetimeText}
              onClick={() => respond(choice, reason)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      {primary.map((choice) => {
        const leads = defaultToNo ? isDeny(choice) : !isDeny(choice);
        const button = (
          <Button
            key={choice.key}
            size="xs"
            variant={leads ? "default" : "outline"}
            disabled={blocked}
            aria-description={[...new Set([choice.lifetimeText, choice.warning])]
              .filter(Boolean)
              .join(" ")}
            data-default-choice={leads || undefined}
            onClick={() => respond(choice)}
          >
            {choice.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-40 truncate">{choice.label}</span>
          </Button>
        );
        return choice.warning ? (
          <Tooltip key={choice.key}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{choice.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {more.length > 0 || feedbackChoices.length > 0 ? (
        <Menu>
          <MenuTrigger
            ref={menuTriggerRef}
            disabled={blocked}
            render={<Button size="icon-xs" variant="outline" aria-label="More approval options" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup
            {...composerFloatingLayerProps}
            side="top"
            align="end"
            finalFocus={() => !closingIntoReason.current}
          >
            {more.map((choice) => (
              <MenuItem
                key={choice.key}
                disabled={blocked || choice.disabledReason !== undefined}
                aria-description={choice.warning}
                onClick={() => respond(choice)}
                variant="ghost"
                // Block-level and start-aligned: as inline boxes the rows sat side by side when
                // the menu measured its width, so it opened far wider than its centred rows.
                className="mb-1 flex justify-start last:mb-0"
              >
                {/* One label, at most one tag, one lifetime or location line. */}
                <span className="flex min-w-0 max-w-96 flex-col gap-1 whitespace-normal wrap-break-word">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>{choice.label}</span>
                    {choice.lifetimeTag ? (
                      <Badge
                        variant={choice.optionClass === "persistent" ? "warning" : "outline"}
                        size="sm"
                      >
                        {choice.lifetimeTag}
                      </Badge>
                    ) : null}
                  </span>
                  {choice.detail ? (
                    <span className="text-xs text-foreground">{choice.detail}</span>
                  ) : null}
                  {choice.rulePreview.map((rule) => (
                    <code key={rule} className="whitespace-pre-wrap text-xs wrap-anywhere">
                      {rule}
                    </code>
                  ))}
                  <ApprovalChoiceNote warn={choice.warning === choice.lifetimeText}>
                    {choice.lifetimeText}
                  </ApprovalChoiceNote>
                  {choice.warning && choice.warning !== choice.lifetimeText ? (
                    <ApprovalChoiceNote warn>{choice.warning}</ApprovalChoiceNote>
                  ) : null}
                  {choice.disabledReason ? (
                    <span className="text-xs text-muted-foreground">{choice.disabledReason}</span>
                  ) : null}
                </span>
              </MenuItem>
            ))}
            {feedbackChoices.length > 0 ? (
              <MenuItem
                disabled={blocked}
                onClick={() => {
                  if (blocked) return;
                  closingIntoReason.current = true;
                  setReasonOpenFor(requestId);
                }}
                variant="ghost"
                className="flex justify-start"
              >
                Decline with a reason…
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});

/**
 * A muted line under a menu choice. A warning carries its mark at the start of its own line, so
 * it neither indents the row nor floats beside another line.
 */
function ApprovalChoiceNote({ warn, children }: { warn: boolean; children: string }) {
  return (
    <span className="text-xs text-muted-foreground">
      {warn ? (
        // Wrapped: the menu item's own svg margin would otherwise pull the text onto the mark.
        <span aria-hidden className="me-1.5 inline-flex -translate-y-px align-middle">
          <TriangleAlertIcon className="size-3 text-warning" />
        </span>
      ) : null}
      {children}
    </span>
  );
}
