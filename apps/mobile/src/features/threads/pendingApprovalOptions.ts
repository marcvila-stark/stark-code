import {
  APPROVAL_NO_CHOICES,
  approvalOffersNoChoices,
  approvalScopeRows,
  presentApprovalChoices,
  type ApprovalChoice,
  type ApprovalRequestScope,
} from "@starkfuture/client-runtime/approvals/permission-presentation";
import type { ProviderApprovalOption } from "@starkfuture/contracts";

/**
 * The approval card's choices, only from the server's list: deny and the narrowest allow first,
 * then the session and stop choices. Mobile has no settings grant and exact-rule preview flow for
 * saved (persistent) choices yet, so those are left out.
 */
export function mobileApprovalChoices(
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
): ReadonlyArray<ApprovalChoice> {
  return presentApprovalChoices(options, { canRemember: false, persistent: "omit" });
}

/** The line a card shows instead of buttons when the agent offered no choices, else null. */
export function mobileApprovalNoChoicesNote(
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
): string | null {
  return approvalOffersNoChoices(options)
    ? `${APPROVAL_NO_CHOICES.title}. ${APPROVAL_NO_CHOICES.detail}`
    : null;
}

/**
 * Muted lines under the buttons: how long each choice lasts and, where the server describes it,
 * what it grants, such as the folder a session choice adds.
 */
export function mobileApprovalChoiceDetails(
  choices: ReadonlyArray<ApprovalChoice>,
): ReadonlyArray<string> {
  return choices.flatMap((choice) =>
    choice.optionClass === "once" || choice.optionClass === "deny"
      ? []
      : [
          `${choice.label}${choice.lifetimeTag === undefined ? "" : ` (${choice.lifetimeTag})`}: ${choice.detail ?? choice.lifetimeText}`,
        ],
  );
}

/**
 * What the request reaches beyond its command or files, one line each, as the provider reported
 * it: the subagent that asked, paths, network host, grant root and the MCP server behind it.
 * Leads with the provider's advice when it recommends declining.
 */
export function mobileApprovalScopeLines(scope: ApprovalRequestScope | undefined): string[] {
  return [
    ...(scope?.defaultToNo ? ["The provider recommends declining this request."] : []),
    ...approvalScopeRows(scope).map((row) => `${row.label}: ${row.value.replaceAll("\n", ", ")}`),
  ];
}

/** Muted lines under the buttons saying what each offered choice grants, such as a session rule. */
export function mobileApprovalOptionDetails(
  options: ReadonlyArray<ProviderApprovalOption>,
): ReadonlyArray<string> {
  return options.flatMap((option) => (option.detail ? [`${option.label}: ${option.detail}`] : []));
}
