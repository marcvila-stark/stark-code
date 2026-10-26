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
export type ComposerModeOption = Omit<RuntimeModeOption, "mode"> & { mode: ComposerMode };

export function runtimeModeOptionsForProvider(driver: string): RuntimeModeOption[] {
  const modes =
    driver === "claudeAgent" || !BRAND.requireApprovalsByDefault
      ? (Object.keys(runtimeModeConfig) as RuntimeMode[])
      : (["approval-required"] as RuntimeMode[]);
  return modes.map((mode) => {
    const option = { mode, ...runtimeModeConfig[mode] };
    if (driver === "codex" && mode === "approval-required")
      return { ...option, label: "Ask before changes" };
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

export function composerModeOptions(
  options: ReadonlyArray<RuntimeModeOption>,
  includePlan: boolean,
): ReadonlyArray<ComposerModeOption> {
  if (!includePlan) return options;
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
