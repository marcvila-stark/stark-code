import {
  ClaudeSettings,
  type EffectivePermissionOrigin,
  type EffectivePermissionRow,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderPermissionSettings,
  type ProviderSessionId,
} from "@starkfuture/contracts";
import type { PermissionMode, ResolvedSettingSource } from "@anthropic-ai/claude-agent-sdk";
import { mergeProviderInstanceEnvironment } from "@starkfuture/provider-core/server/instanceEnvironment";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  type ClaudeConfiguredPermissions,
  readClaudeConfiguredPermissions as readClaudeProfilePermissions,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/** Stark's names for Claude's permission modes, as the mode picker shows them. */
const CLAUDE_MODE_LABELS: Record<PermissionMode, string> = {
  default: "Manual",
  acceptEdits: "Accept edits",
  auto: "Auto",
  plan: "Plan",
  bypassPermissions: "Bypass",
  dontAsk: "Don't ask",
};

/** Stark's name for a Claude permission mode; an unknown mode stays in Claude's word. */
export const claudeModeLabel = (mode: string) =>
  Object.hasOwn(CLAUDE_MODE_LABELS, mode) ? CLAUDE_MODE_LABELS[mode as PermissionMode] : mode;

/** Where a Claude settings value came from, in the inspector's words. */
function originOf(source: ResolvedSettingSource | null): EffectivePermissionOrigin {
  switch (source) {
    case "managed":
      return "managed";
    case "user":
      return "user";
    case "project":
      return "project";
    case "local":
      return "local";
    // The --settings tier: launch arguments the account itself passes.
    case "flag":
      return "user";
    default:
      return "unknown";
  }
}

const SOURCE_NAMES: Record<ResolvedSettingSource, string> = {
  managed: "managed settings",
  user: "user settings",
  project: "project settings",
  local: "local project settings",
  flag: "the account's launch settings",
};

const NOT_PROOF =
  "What the next Claude launch starts from; a running chat may have changed it since.";

const unknownRow = (reason: string): EffectivePermissionRow => ({
  id: "configured",
  kind: "configured",
  label: "Configured for next launch",
  value: `Unknown: ${reason.replace(/\.$/, "")}`,
  origin: "unknown",
});

/** The inspector rows and settings for one Claude profile's configured permissions. */
export function claudeConfiguredPermissionRows(configured: ClaudeConfiguredPermissions): {
  readonly configured: ProviderPermissionSettings | null;
  readonly rows: ReadonlyArray<EffectivePermissionRow>;
} {
  const starkRows = configured.starkPolicies
    // The inspector always lists "child agents never Bypass" itself.
    .filter((policy) => policy.id !== "stark-children-never-bypass")
    // Like the inspector's own Stark rows, the label names the rule and the value says what it
    // means here; clients already mark every stark-policy row as a Stark policy.
    .map((policy): EffectivePermissionRow => ({
      id: policy.id,
      kind: "stark-policy",
      label: policy.label.replace(/^Stark policy: /, ""),
      value: policy.detail,
      origin: "stark-policy",
    }));
  const liveRules: EffectivePermissionRow = {
    id: "active-rules",
    kind: "active",
    label: "Session rules",
    value: `Unknown: ${configured.liveRules.reason.replace(/\.$/, "")}`,
    origin: "unknown",
  };
  if (configured.status === "unknown") {
    return { configured: null, rows: [unknownRow(configured.reason), liveRules, ...starkRows] };
  }
  const rows: Array<EffectivePermissionRow> = [
    configured.defaultMode === null
      ? {
          id: "configured",
          kind: "configured",
          label: "Configured mode",
          value: "Not set: Claude starts in Manual",
          nativeValue: "default",
          origin: "unknown",
          detail: `No settings file sets permissions.defaultMode. ${NOT_PROOF}`,
        }
      : {
          id: "configured",
          kind: "configured",
          label: "Configured mode",
          value: claudeModeLabel(configured.defaultMode),
          nativeValue: configured.defaultMode,
          origin: originOf(configured.defaultModeSource),
          detail: `${
            configured.defaultModeSource === null
              ? "Set in Claude's settings"
              : `Set in ${SOURCE_NAMES[configured.defaultModeSource]}`
          }. ${NOT_PROOF}`,
        },
  ];
  if (configured.bypassDisabled) {
    rows.push({
      id: "configured-bypass",
      kind: "configured",
      label: "Bypass",
      value: "Turned off in Claude's settings",
      nativeValue: "disableBypassPermissionsMode: disable",
      origin: originOf(configured.bypassDisabledSource),
    });
  }
  if (configured.hooksDisabled) {
    rows.push({
      id: "configured-hooks",
      kind: "configured",
      label: "Hooks",
      value: "Turned off in Claude's settings",
      nativeValue: "disableAllHooks: true",
      origin: originOf(configured.hooksDisabledSource),
      detail: "Stark Code's own checks still run.",
    });
  }
  for (const entry of configured.ruleSources) {
    rows.push({
      id: `configured-rules-${entry.source}`,
      kind: "configured",
      label: `Rules in ${SOURCE_NAMES[entry.source]}`,
      value: `${entry.allow} allow, ${entry.ask} ask, ${entry.deny} deny`,
      origin: originOf(entry.source),
    });
  }
  if (configured.additionalDirectories.length > 0) {
    rows.push({
      id: "configured-directories",
      kind: "configured",
      label: "Extra folders",
      value: configured.additionalDirectories.join(", "),
      origin: originOf(configured.additionalDirectoriesSource),
    });
  }
  return {
    configured: {
      permissionSource: "inherit",
      ...(configured.defaultMode === null ? {} : { nativeMode: configured.defaultMode }),
      interactionMode: configured.defaultMode === "plan" ? "plan" : "default",
    },
    rows: [...rows, liveRules, ...starkRows],
  };
}

/**
 * What Claude's configuration resolves to for the next launch in `cwd`: the
 * SDK's `resolveSettings()` after `filterEscalatingDefaultMode()`, which is
 * raw configuration and never proof of a running session. Read for the chat's
 * own provider instance, so a profile with its own settings folder answers
 * "unknown" instead of another profile's settings.
 */
export const readClaudeConfiguredPermissions = Effect.fn("readClaudeEffectivePermissions")(
  function* (input: {
    readonly cwd: string | null;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerSessionId: ProviderSessionId | null;
    /** The chat's provider instance as configured; undefined when it no longer exists. */
    readonly instance: ProviderInstanceConfig | undefined;
  }): Effect.fn.Return<
    {
      readonly configured: ProviderPermissionSettings | null;
      readonly rows: ReadonlyArray<EffectivePermissionRow>;
    },
    never,
    Path.Path
  > {
    if (input.cwd === null) {
      return { configured: null, rows: [unknownRow("this chat has no folder")] };
    }
    const settings =
      input.instance === undefined
        ? Option.none()
        : decodeClaudeSettings(input.instance.config ?? {});
    if (Option.isNone(settings)) {
      return { configured: null, rows: [unknownRow("this Claude account's settings are invalid")] };
    }
    const environment = yield* mergeProviderInstanceEnvironment(input.instance?.environment);
    const configured = yield* readClaudeProfilePermissions({
      providerInstanceId: input.providerInstanceId,
      providerSessionId: input.providerSessionId,
      cwd: input.cwd,
      settings: settings.value,
      environment,
    });
    return claudeConfiguredPermissionRows(configured);
  },
);
