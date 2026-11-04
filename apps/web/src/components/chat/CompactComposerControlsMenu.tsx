import { ProviderInteractionMode, RuntimeMode } from "@starkfuture/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import {
  composerModeOptions,
  type RuntimeModeOption,
  type ComposerMode,
} from "./runtimeModeConfig";
import { applyComposerModeSelection, type ConfirmRuntimeModeChange } from "./composerModeSelection";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  combinePlanMode: boolean;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  size?: "sm" | "xs";
  /**
   * The resting strip keeps this menu mounted out of flow while every block
   * fits inline. Its portaled popup would outlive that transition, so an
   * open menu closes when its trigger hides.
   */
  hidden?: boolean;
  /** Without the settings-write grant, modes above the narrowest are disabled. */
  canWriteSettings: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: ConfirmRuntimeModeChange;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);

  const options = composerModeOptions(props.runtimeModeOptions, {
    includePlan: props.combinePlanMode && props.showInteractionModeToggle,
    canWriteSettings: props.canWriteSettings,
  });
  const selectedMode =
    props.combinePlanMode && props.showInteractionModeToggle && props.interactionMode === "plan"
      ? "plan"
      : props.runtimeMode;

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0"
            aria-label="More composer controls"
            data-composer-shortcut={
              props.traitsMenuContent ? "composer.mode composer.effort" : "composer.mode"
            }
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle && !props.combinePlanMode ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
          {props.combinePlanMode ? "Mode" : "Access"}
        </div>
        <MenuRadioGroup
          value={selectedMode}
          onValueChange={(value) => {
            if (!value || value === selectedMode) return;
            if (options.find((option) => option.mode === value)?.disabledReason) return;
            void applyComposerModeSelection(value as ComposerMode, {
              ...props,
              combinePlanMode: props.combinePlanMode && props.showInteractionModeToggle,
            });
          }}
        >
          {options.map((option) => (
            <MenuRadioItem
              key={option.mode}
              value={option.mode}
              disabled={option.disabledReason !== undefined}
            >
              {option.disabledReason ? (
                <span className="flex min-w-0 flex-col">
                  <span>{option.label}</span>
                  <span className="text-muted-foreground text-xs">{option.disabledReason}</span>
                </span>
              ) : (
                option.label
              )}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
