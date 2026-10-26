import { expect, it } from "vite-plus/test";
import type { ProviderApprovalOption } from "@starkfuture/contracts";
import { mobileApprovalOptions } from "./pendingApprovalOptions";
it("keeps once/session/refusal choices and excludes persistent approval even with a rule preview", () => {
  const options = [
    { decision: "accept", label: "Approve once" },
    { decision: "acceptForSession", label: "Allow for this session" },
    { decision: "acceptAlways", label: "Always allow", rulePreview: ["Bash(npm test)"] },
    { decision: "decline", label: "Decline" },
  ] as const satisfies ReadonlyArray<ProviderApprovalOption>;
  expect(mobileApprovalOptions(options).map((option) => option.decision)).toEqual([
    "accept",
    "acceptForSession",
    "decline",
  ]);
  expect(options).toHaveLength(4);
});
