import type { ProviderInteractionMode, RuntimeMode } from "@starkfuture/contracts";
import { resolveComposerModeSelection, type ComposerMode } from "./runtimeModeConfig";

export type ConfirmRuntimeModeChange = (mode: RuntimeMode) => boolean | Promise<boolean>;

/** Leave Plan only after the requested permission change has been accepted. */
export async function applyComposerModeSelection(
  mode: ComposerMode,
  input: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly combinePlanMode: boolean;
    readonly onRuntimeModeChange: ConfirmRuntimeModeChange;
    readonly onToggleInteractionMode: () => void;
  },
): Promise<boolean> {
  const next = resolveComposerModeSelection(mode, input.runtimeMode);
  const changeInteraction = input.combinePlanMode && next.interactionMode !== input.interactionMode;
  // Plan remembers the previous build permission mode. Returning to a remembered
  // Bypass session still needs the same explicit confirmation as entering it.
  if (next.runtimeMode !== input.runtimeMode || (mode === "full-access" && changeInteraction)) {
    if (!(await input.onRuntimeModeChange(next.runtimeMode))) return false;
  }
  if (changeInteraction) input.onToggleInteractionMode();
  return true;
}
