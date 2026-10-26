import { MicIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

/** The provider owns the microphone, transcription, account and voice controls. */
export function ComposerProviderVoiceControl({
  driver,
  apiBackend,
  disabled,
  onOpen,
}: {
  driver: string;
  apiBackend?: "openrouter" | undefined;
  disabled: boolean;
  onOpen: (() => void) | undefined;
}) {
  if (!onOpen || apiBackend === "openrouter" || (driver !== "codex" && driver !== "claudeAgent"))
    return null;
  const label = `Open ${driver === "codex" ? "Codex" : "Claude"} voice`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            data-composer-provider-voice
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onOpen}
          />
        }
      >
        <MicIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup {...composerFloatingLayerProps}>
        {label}. Your chat draft stays here.
      </TooltipPopup>
    </Tooltip>
  );
}
