import { expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ClaudeAccount,
} from "@starkfuture/contracts";
import {
  isSharedClaudeOrganizationContext,
  sharedClaudeOrganizationName,
} from "./claudeSharedLogin";
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  checkedAt: "2026-10-20T00:00:00Z",
  auth: { status: "authenticated", email: "user@example.com", workspaceId: "org-one" },
  usesSharedClaudeLogin: true,
  models: [],
  slashCommands: [],
  skills: [],
};
const account: ClaudeAccount = {
  number: 1,
  email: "user@example.com",
  organizationUuid: "org-one",
  organizationName: "Stark One",
  alias: null,
  active: true,
  disabled: false,
  usageStatus: "ok",
  usageAgeSeconds: 0,
  windows: [],
};
it("requires verified shared login metadata and never infers from a profile name", () => {
  expect(isSharedClaudeOrganizationContext(provider)).toBe(true);
  expect(isSharedClaudeOrganizationContext({ ...provider, usesSharedClaudeLogin: false })).toBe(
    false,
  );
  const { usesSharedClaudeLogin, ...unknownMetadata } = provider;
  expect(usesSharedClaudeLogin).toBe(true);
  expect(isSharedClaudeOrganizationContext(unknownMetadata)).toBe(false);

  expect(
    isSharedClaudeOrganizationContext({ ...provider, driver: ProviderDriverKind.make("codex") }),
  ).toBe(false);
});
it("checks reported email and organization ID before using an active catalog label", () => {
  expect(sharedClaudeOrganizationName(provider, account)).toBe("Stark One");
  expect(
    sharedClaudeOrganizationName(provider, { ...account, organizationUuid: "org-two" }),
  ).toBeNull();
  expect(
    sharedClaudeOrganizationName(provider, { ...account, email: "other@example.com" }),
  ).toBeNull();
  expect(sharedClaudeOrganizationName(provider, { ...account, active: false })).toBeNull();
  expect(
    sharedClaudeOrganizationName(
      { ...provider, auth: { status: "authenticated", email: account.email } },
      account,
    ),
  ).toBe("Stark One");
});
