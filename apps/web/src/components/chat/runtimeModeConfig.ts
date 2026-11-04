import { runtimeModeDisabledReason } from "@starkfuture/client-runtime/approvals/permission-presentation";
import { BRAND } from "@starkfuture/shared/branding";
import type { RuntimeMode, ProviderInteractionMode } from "@starkfuture/contracts";
import {
  type LucideIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SparklesIcon,
  PencilRulerIcon,
} from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export type RuntimeModeOption = { mode: RuntimeMode } & (typeof runtimeModeConfig)[RuntimeMode];
export type ComposerMode = RuntimeMode | "plan";
export type ComposerModeOption = Omit<RuntimeModeOption, "mode"> & {
  mode: ComposerMode;
  /** Shown but not selectable, with the reason: a widening this client has no grant for. */
  disabledReason?: string;
};

export function runtimeModeOptionsForProvider(driver: string): RuntimeModeOption[] {
  const modes =
    driver === "claudeAgent" || !BRAND.requireApprovalsByDefault
      ? (Object.keys(runtimeModeConfig) as RuntimeMode[])
      : (["approval-required"] as RuntimeMode[]);
  return modes.map((mode) => {
    const option = { mode, ...runtimeModeConfig[mode] };
    if (driver === "codex" && mode === "approval-required")
      return {
        ...option,
        label: "Ask before actions",
        description:
          "Codex asks before file changes and commands, including some read-only commands.",
      };
    if (driver !== "claudeAgent") return option;
    if (mode === "approval-required") return { ...option, label: "Manual" };
    if (mode === "auto")
      return { ...option, description: "Claude reviews actions and asks when needed." };
    if (mode === "auto-accept-edits") return { ...option, label: "Accept edits" };
    if (mode === "full-access")
      return {
        ...option,
        label: "Bypass permissions",
        description: "Skip Claude's permission checks.",
      };
    return option;
  });
}

/**
 * The composer's mode choices. Without the settings-write grant, modes above the narrowest stay
 * listed but disabled with "Needs settings permission", as in the scheduled-task editor: the
 * server refuses to widen a chat from such a client (O12). Plan only reads, so it stays enabled.
 */
export function composerModeOptions(
  runtimeOptions: ReadonlyArray<RuntimeModeOption>,
  input: { readonly includePlan: boolean; readonly canWriteSettings: boolean },
): ReadonlyArray<ComposerModeOption> {
  const options = runtimeOptions.map((option): ComposerModeOption => {
    const disabledReason = runtimeModeDisabledReason(option.mode, input.canWriteSettings);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
  if (!input.includePlan) return options;
  const plan: ComposerModeOption = {
    mode: "plan",
    label: "Plan",
    description: "Explore and plan before changing code.",
    icon: PencilRulerIcon,
  };
  const bypassIndex = options.findIndex((option) => option.mode === "full-access");
  const index = bypassIndex < 0 ? options.length : bypassIndex;
  return [...options.slice(0, index), plan, ...options.slice(index)];
}

/** Plan preserves the build permission mode; selecting a build mode leaves planning. */
export function resolveComposerModeSelection(
  mode: ComposerMode,
  runtimeMode: RuntimeMode,
): {
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
} {
  return mode === "plan"
    ? { runtimeMode, interactionMode: "plan" }
    : { runtimeMode: mode, interactionMode: "default" };
}

export interface RuntimeModeDisplay {
  /** The mode the picker selects: the saved one, or what the provider runs it as. */
  readonly mode: RuntimeMode;
  /** Set when the saved mode is not offered, so the chat runs as `mode` instead. */
  readonly saved?: { readonly mode: RuntimeMode; readonly label: string; readonly note: string };
}

/**
 * A chat saved with a mode its provider no longer offers (Claude Bypass after the account opt-in
 * is turned off, a Codex chat saved as Full access) runs as the provider's first offered mode.
 * The picker shows that mode and says what was saved, instead of hiding the difference. Current
 * servers narrow such a chat themselves (the startup freeze, and turning the Bypass opt-in off),
 * so the note and "Save as …" only appear against older servers.
 */
export function resolveRuntimeModeDisplay(
  options: ReadonlyArray<RuntimeModeOption>,
  savedMode: RuntimeMode,
  driver: string,
): RuntimeModeDisplay {
  if (options.length === 0 || options.some((option) => option.mode === savedMode))
    return { mode: savedMode };
  const runsAs = options[0]!;
  const savedLabel =
    runtimeModeOptionsForProvider(driver).find((option) => option.mode === savedMode)?.label ??
    runtimeModeConfig[savedMode].label;
  return {
    mode: runsAs.mode,
    saved: {
      mode: savedMode,
      label: savedLabel,
      note: `Saved as ${savedLabel}, which isn't available here, so this chat runs as ${runsAs.label}.`,
    },
  };
}
