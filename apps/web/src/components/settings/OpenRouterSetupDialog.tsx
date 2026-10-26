import { useRef, useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { ensureLocalApi } from "../../localApi";
import {
  AuthProvidersManageScope,
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@starkfuture/contracts";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SecretInput } from "./SecretInput";

const CONNECTION_VARIABLES = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
]);

export function isOpenRouterInstance(instance: ProviderInstanceConfig): boolean {
  return (
    instance.driver === "claudeAgent" &&
    instance.config !== null &&
    typeof instance.config === "object" &&
    "apiBackend" in instance.config &&
    instance.config.apiBackend === "openrouter"
  );
}

function availableId(instances: Readonly<Record<string, ProviderInstanceConfig>>) {
  let id = "openrouter";
  let suffix = 2;
  while (Object.hasOwn(instances, id)) id = `openrouter_${suffix++}`;
  return ProviderInstanceId.make(id);
}

function savedKey(instance: ProviderInstanceConfig | undefined) {
  return instance?.environment?.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN");
}

/** A blank replacement retains the server's write-only secret marker. */
export function openRouterInstanceWithKey(
  instanceId: ProviderInstanceId,
  key: string,
  existing?: ProviderInstanceConfig,
): ProviderInstanceConfig {
  const token = key.trim()
    ? { name: "ANTHROPIC_AUTH_TOKEN", value: key.trim(), sensitive: true }
    : savedKey(existing);
  if (!token || (!token.valueRedacted && !token.value.trim())) {
    throw new Error("Enter your OpenRouter API key.");
  }
  return {
    ...existing,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: existing?.displayName ?? "OpenRouter",
    enabled: existing?.enabled ?? true,
    config: {
      homePath: `~/.stark-code/openrouter/${instanceId}`,
      customModels: [],
      ...(existing?.config !== null && typeof existing?.config === "object" ? existing.config : {}),
      apiBackend: "openrouter",
    },
    environment: [
      ...(existing?.environment ?? []).filter((entry) => !CONNECTION_VARIABLES.has(entry.name)),
      { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      token,
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
    ],
  };
}

export function OpenRouterSetupDialog({
  environmentId,
  environmentLabel,
  instanceId,
  onOpenChange,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved?: (instanceId: ProviderInstanceId) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const persist = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const existing = instanceId ? settings.providerInstances?.[instanceId] : undefined;
  const configured = Boolean(savedKey(existing)?.valueRedacted || savedKey(existing)?.value);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const save = async () => {
    if (pending.current || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    if (instanceId && (!existing || !isOpenRouterInstance(existing))) {
      setError("This OpenRouter connection is no longer available. Close and reopen its settings.");
      return;
    }
    if (!configured && !key.trim()) {
      setError("Enter your OpenRouter API key.");
      return;
    }
    const id = instanceId ?? availableId(settings.providerInstances ?? {});
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await persist({
        operation: "upsert",
        instanceId: id,
        instance: openRouterInstanceWithKey(id, key, existing),
      });
      if (result._tag !== "Success") {
        setError("Could not save the API key. Check your connection and try again.");
        return;
      }
      setKey("");
      onSaved?.(id);
      onOpenChange(false);
    } catch {
      setError("Could not save the API key. Check your connection and try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!pending.current) onOpenChange(open);
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{instanceId ? "OpenRouter API key" : "Connect OpenRouter"}</DialogTitle>
            <DialogDescription>
              Choose OpenRouter models in chat using your own API key. OpenRouter bills these
              requests separately from your Claude or ChatGPT subscription.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-3">
              <div className="grid gap-2">
                <label htmlFor="openrouter-api-key" className="text-sm font-medium">
                  API key
                </label>
                <SecretInput
                  id="openrouter-api-key"
                  value={key}
                  configured={configured}
                  maxLength={4096}
                  disabled={busy || !canManage}
                  onChange={(event) => setKey(event.target.value)}
                  aria-describedby="openrouter-key-help"
                />
                <p id="openrouter-key-help" className="text-xs text-muted-foreground">
                  {configured ? "Leave blank to keep your saved key. " : ""}Stored securely on{" "}
                  {environmentLabel}. Your key is never included in a chat message.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Uses the installed Claude Code runtime with its own separate connection.
              </p>
              <p className="text-xs text-muted-foreground">
                Anthropic models work best with this runtime. Tool support varies for other models.
              </p>
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void ensureLocalApi()
                      .shell.openExternal("https://openrouter.ai/settings/keys")
                      .catch(() =>
                        setError(
                          "Could not open your browser. Visit openrouter.ai/settings/keys to create a key.",
                        ),
                      );
                  }}
                >
                  <ExternalLinkIcon aria-hidden />
                  Get an API key
                </Button>
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {!canManage ? (
                <p role="status" className="text-sm text-muted-foreground">
                  You don’t have permission to change connections on this device.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !canManage} aria-busy={busy}>
              {busy ? "Saving…" : instanceId ? "Save key" : "Connect OpenRouter"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
