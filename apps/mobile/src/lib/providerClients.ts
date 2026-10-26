import { isProviderDriverKind } from "@starkfuture/contracts";
import { acpRegistryClient } from "@starkfuture/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@starkfuture/provider-core/client";
import { cursorClient } from "@starkfuture/provider-cursor/client";
import { grokClient } from "@starkfuture/provider-grok/client";
import { museClient } from "@starkfuture/provider-muse/client";
import { openCodeClient } from "@starkfuture/provider-opencode/client";
import { piClient } from "@starkfuture/provider-pi/client";

/** The provider client definitions this mobile build ships. */
const providerClients = makeProviderClientRegistry([
  cursorClient,
  grokClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
]);

/** The client definition for a driver kind, or `undefined` for drivers drawn by hand. */
export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
