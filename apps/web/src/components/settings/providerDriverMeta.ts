import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@starkfuture/contracts";
import { acpRegistryClient } from "@starkfuture/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@starkfuture/provider-core/client";
import { cursorClient } from "@starkfuture/provider-cursor/client";
import { grokClient } from "@starkfuture/provider-grok/client";
import { museClient } from "@starkfuture/provider-muse/client";
import { openCodeClient } from "@starkfuture/provider-opencode/client";
import { piClient } from "@starkfuture/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
