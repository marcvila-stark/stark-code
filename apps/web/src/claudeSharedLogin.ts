import type { ClaudeAccount, ServerProvider } from "@starkfuture/contracts";

/** Unknown/older servers cannot establish that cswap would change this instance's login. */
export function isSharedClaudeOrganizationContext(
  provider: Pick<ServerProvider, "driver" | "usesSharedClaudeLogin"> | null | undefined,
): boolean {
  return provider?.driver === "claudeAgent" && provider.usesSharedClaudeLogin === true;
}

/** Missing email is normal for some CLI probes; explicit shared-home proof still identifies the login. */
export function sharedClaudeOrganizationName(
  provider: Pick<ServerProvider, "driver" | "usesSharedClaudeLogin" | "auth">,
  account:
    | Pick<ClaudeAccount, "active" | "email" | "organizationUuid" | "organizationName" | "alias">
    | undefined,
): string | null {
  if (!isSharedClaudeOrganizationContext(provider) || !account?.active) return null;
  if (
    provider.auth.email &&
    provider.auth.email.trim().toLowerCase() !== account.email.trim().toLowerCase()
  )
    return null;
  if (provider.auth.workspaceId && provider.auth.workspaceId !== account.organizationUuid)
    return null;
  return account.organizationName || account.alias || null;
}
