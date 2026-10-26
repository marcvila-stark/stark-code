import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@starkfuture/contracts";
import { memo } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  canRemember?: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  canRemember = false,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const primaryOptions = options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = options.filter(
    (option) =>
      option.decision !== "decline" &&
      option.decision !== "accept" &&
      (option.decision !== "acceptAlways" ||
        (canRemember && (option.rulePreview?.length ?? 0) > 0)),
  );

  return (
    <>
      {primaryOptions.map((option) => {
        const button = (
          <Button
            key={option.decision}
            size="xs"
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={disabled || isResponding || !canRespond}
            aria-description={option.warning}
            onClick={() => {
              if (!disabled && !isResponding && canRespond) {
                void onRespondToApproval(requestId, option.decision);
              }
            }}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-40 truncate">{option.label}</span>
          </Button>
        );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={disabled || isResponding || !canRespond}
            render={<Button size="icon-xs" variant="outline" aria-label="More approval options" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={disabled || isResponding || !canRespond}
                  aria-description={option.warning}
                  onClick={() => {
                    if (
                      !disabled &&
                      !isResponding &&
                      canRespond &&
                      (option.decision !== "acceptAlways" || canRemember)
                    )
                      void onRespondToApproval(requestId, option.decision);
                  }}
                  variant="ghost"
                  className="mb-1 last:mb-0"
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="flex min-w-0 flex-col gap-1 whitespace-normal wrap-break-word">
                    <span>{option.label}</span>
                    {option.rulePreview?.map((rule) => (
                      <code key={rule} className="max-w-96 whitespace-pre-wrap text-xs">
                        {rule}
                      </code>
                    ))}
                    {option.warning ? (
                      <span className="max-w-96 text-xs text-muted-foreground">
                        {option.warning}
                      </span>
                    ) : null}
                  </span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});
