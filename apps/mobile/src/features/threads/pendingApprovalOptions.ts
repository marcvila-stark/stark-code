import type { ProviderApprovalOption } from "@starkfuture/contracts";
/** Mobile has no settings grant + exact-rule preview flow for persistent approvals yet. */
export function mobileApprovalOptions(
  options: ReadonlyArray<ProviderApprovalOption>,
): ReadonlyArray<ProviderApprovalOption> {
  return options.filter((option) => option.decision !== "acceptAlways");
}
