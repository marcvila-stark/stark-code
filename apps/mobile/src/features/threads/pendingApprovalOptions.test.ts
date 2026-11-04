import { expect, it } from "vite-plus/test";
import type { ProviderApprovalOption } from "@starkfuture/contracts";
import {
  mobileApprovalChoiceDetails,
  mobileApprovalChoices,
  mobileApprovalNoChoicesNote,
  mobileApprovalScopeLines,
} from "./pendingApprovalOptions";

it("puts Decline and Allow once first and excludes persistent approval even with a rule preview", () => {
  const options = [
    { decision: "accept", label: "Allow once" },
    { decision: "acceptForSession", label: "Allow for this session" },
    { decision: "acceptAlways", label: "Always allow", rulePreview: ["Bash(npm test)"] },
    { decision: "decline", label: "Decline" },
  ] satisfies ProviderApprovalOption[];
  expect(mobileApprovalChoices(options).map((choice) => choice.decision)).toEqual([
    "decline",
    "accept",
    "acceptForSession",
  ]);
  expect(options).toHaveLength(4);
});

it("says what the offered session choice grants and how long it lasts, but not the hidden persistent one", () => {
  const choices = mobileApprovalChoices([
    { decision: "decline", label: "Decline" },
    { decision: "accept", label: "Allow once" },
    {
      optionId: "session:2",
      decision: "acceptForSession",
      label: "Allow for this session",
      detail: "Adds /tmp/out to the allowed folders for this session",
    },
    { decision: "cancel", label: "Decline and stop" },
    { decision: "acceptAlways", label: "Always allow", detail: "Saves Bash(npm test)" },
  ]);
  expect(choices.find((choice) => choice.decision === "acceptForSession")?.optionId).toBe(
    "session:2",
  );
  expect(mobileApprovalChoiceDetails(choices)).toEqual([
    "Allow for this session: Adds /tmp/out to the allowed folders for this session",
    "Decline and stop: The agent is told no and the run stops.",
  ]);
});

it("falls back to the legacy decisions, including Decline and stop, when the server sends none", () => {
  expect(mobileApprovalChoices(undefined).map((choice) => choice.label)).toEqual([
    "Decline",
    "Allow once",
    "Allow for this session",
    "Decline and stop",
  ]);
});

it("offers Codex's turn and session grants with the access they cover, and no saved rule", () => {
  // A Codex permissions request (CodexApprovalOptions.codexPermissionsApprovalChoices).
  const choices = mobileApprovalChoices([
    { optionId: "deny:0", decision: "decline", label: "Deny", effect: "deny" },
    {
      optionId: "turn:0",
      decision: "accept",
      label: "Grant for this turn",
      detail: "Write: /repo/out",
      scope: "turn",
      effect: "allow",
    },
    {
      optionId: "session:0",
      decision: "acceptForSession",
      label: "Grant for this session",
      detail: "Write: /repo/out",
      scope: "session",
      effect: "allow",
    },
    {
      optionId: "persistent:0",
      decision: "acceptAlways",
      label: "Always allow example.com",
      rulePreview: ['network_policy_amendment(host="example.com", action="allow")'],
      scope: "persistent",
      effect: "allow",
    },
  ]);
  expect(choices.map((choice) => [choice.optionId, choice.placement])).toEqual([
    ["deny:0", "primary"],
    ["turn:0", "primary"],
    ["session:0", "more"],
  ]);
  expect(mobileApprovalChoiceDetails(choices)).toEqual([
    "Grant for this turn: Write: /repo/out",
    "Grant for this session: Write: /repo/out",
  ]);
});

it("names the lifetime in brackets only when the label doesn't already say it", () => {
  expect(
    mobileApprovalChoiceDetails(
      mobileApprovalChoices([
        { decision: "decline", label: "No" },
        { decision: "accept", label: "Yes" },
        { decision: "acceptForSession", label: "Yes, and don't ask again" },
        { decision: "cancel", label: "Cancel" },
      ]),
    ),
  ).toEqual([
    "Yes, and don't ask again (This session): Applies until this provider session ends; nothing is saved.",
    "Cancel (Deny and stop): The agent is told no and the run stops.",
  ]);
});

it("lists who asked and what the request reaches, after the provider's advice to decline", () => {
  expect(
    mobileApprovalScopeLines({
      defaultToNo: true,
      agentId: "explorer-1",
      network: { host: "example.com", protocol: "https" },
      requestedPermissions: { readPaths: ["/a", "/b"] },
    }),
  ).toEqual([
    "The provider recommends declining this request.",
    "Asked by subagent: explorer-1",
    "Network host: https://example.com",
    "Read access: /a, /b",
  ]);
  expect(mobileApprovalScopeLines(undefined)).toEqual([]);
});

it("says when the agent offered no choices", () => {
  expect(mobileApprovalNoChoicesNote([])).toBe(
    "No choices offered. The agent offered no choices for this request, so it can't be answered. It closes when the agent stops waiting.",
  );
  expect(mobileApprovalNoChoicesNote(undefined)).toBeNull();
});
