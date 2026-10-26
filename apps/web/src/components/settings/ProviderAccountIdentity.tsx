import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@starkfuture/contracts";
import { useEffect, useState } from "react";
import { isSharedClaudeOrganizationContext } from "../../claudeSharedLogin";
import { claudeAccountsEnvironment } from "../../state/claudeAccounts";
import { useAtomCommand } from "../../state/use-atom-command";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

/** Only the verified shared Claude login can use the machine's organization catalog. */
export function ProviderAccountIdentity({
  environmentId,
  provider,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
}) {
  const canRead = useAtomValue(claudeAccountsEnvironment.snapshot.permissionAtom(environmentId));
  const readSnapshot = useAtomCommand(claudeAccountsEnvironment.snapshot, { reportFailure: false });
  const [organization, setOrganization] = useState<string | null>(null);
  const sharedClaude = isSharedClaudeOrganizationContext(provider);
  useEffect(() => {
    if (!sharedClaude || !canRead) return;
    let active = true;
    void readSnapshot({ environmentId, input: undefined }).then((result) => {
      if (!active || result._tag !== "Success") return;
      const account = result.value.accounts.find((entry) => entry.active);
      setOrganization(account?.organizationName || account?.alias || null);
    });
    return () => {
      active = false;
    };
  }, [canRead, environmentId, readSnapshot, sharedClaude]);
  if (sharedClaude && organization) return <>{organization} · selected organization</>;
  if (provider.auth.email) {
    return (
      <>
        Signed in as{" "}
        <RedactedSensitiveText
          value={provider.auth.email}
          ariaLabel="Show account email"
          revealTooltip="Click to reveal email"
          hideTooltip="Click to hide email"
        />
      </>
    );
  }
  return <>{provider.auth.label ?? "Connected account"}</>;
}
