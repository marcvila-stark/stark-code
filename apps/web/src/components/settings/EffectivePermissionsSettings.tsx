import type { ServerProvider, ServerSettings } from "@starkfuture/contracts";

import { Badge } from "../ui/badge";
import {
  permissionProviderName,
  providerPermissionDefaultRows,
  starkPermissionPolicies,
} from "../chat/permissionsPresentation.logic";

/**
 * Settings → Permissions: per provider, where new chats take their permissions from, what
 * inheriting means, that the native terminal is separate, and the boundaries Stark keeps.
 */
export function EffectivePermissionsSettings({
  providers,
  settings,
}: {
  providers: ReadonlyArray<ServerProvider>;
  settings: Pick<ServerSettings, "providerInstances" | "defaultRuntimeMode">;
}) {
  const rows = providerPermissionDefaultRows(
    providers.map((provider) => {
      const source = Object.hasOwn(settings.providerInstances, provider.instanceId)
        ? settings.providerInstances[provider.instanceId]?.newChatPermissionSource
        : undefined;
      const inherit = provider.nativePermissionInherit;
      return {
        instanceId: provider.instanceId,
        driver: provider.driver,
        ...(provider.displayName ? { displayName: provider.displayName } : {}),
        ...(inherit === undefined ? {} : { nativePermissionInherit: inherit }),
        ...(source === undefined ? {} : { newChatPermissionSource: source }),
      };
    }),
    settings.defaultRuntimeMode,
  );
  const drivers = [...new Set(providers.map((provider) => provider.driver))];
  return (
    <div className="space-y-4">
      <section aria-label="New chats" className="space-y-3 rounded-xl border p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">New chats</h3>
          <p className="text-xs text-muted-foreground">
            A chat either inherits its provider's own permission settings or overrides them with a
            Stark preset you pick in the composer. Inheriting means Stark sends no permission
            settings, so the provider's own settings files and any policy your organization manages
            decide. Existing chats keep the permissions they were saved with.
          </p>
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No providers are set up.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.providerInstanceId} className="space-y-1 rounded-lg bg-muted/40 p-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium wrap-anywhere">{row.name}</span>
                  <span className="text-sm wrap-anywhere">{row.newChats}</span>
                </div>
                <p className="text-xs text-muted-foreground wrap-anywhere">{row.newChatsDetail}</p>
                <p className="text-xs text-muted-foreground wrap-anywhere">{row.terminal}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {drivers.length > 0 ? (
        <section aria-label="Stark policies" className="space-y-3 rounded-xl border p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Stark policies</h3>
            <p className="text-xs text-muted-foreground">
              Boundaries Stark keeps whatever a provider's settings allow.
            </p>
          </div>
          {drivers.map((driver) => (
            <div key={driver} className="space-y-1.5">
              <p className="text-xs font-medium">
                {permissionProviderName(
                  driver,
                  providers.find((provider) => provider.driver === driver)?.displayName,
                )}
              </p>
              <ul className="space-y-1.5">
                {starkPermissionPolicies(driver).map((policy) => (
                  <li
                    key={policy.id}
                    className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
                  >
                    <span className="min-w-0 wrap-anywhere">{policy.text}</span>
                    <Badge variant="secondary" size="sm">
                      Stark policy
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
