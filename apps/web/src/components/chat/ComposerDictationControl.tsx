import { MicIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { useComposerDictation } from "./useComposerDictation";
import { composerFloatingLayerProps } from "./composerEventScope";

export function ComposerDictationControl({
  voice,
  disabled,
}: {
  voice: ReturnType<typeof useComposerDictation>;
  disabled: boolean;
}) {
  if (!voice.supported || voice.busy) return null;
  const label = voice.available ? "Dictate a message" : voice.unavailableReason;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-composer-dictation="true"
            aria-label={label}
            disabled={disabled || !voice.available}
            onPointerDown={(event) => event.preventDefault()}
            onClick={voice.start}
          />
        }
      >
        <MicIcon />
      </TooltipTrigger>
      <TooltipPopup {...composerFloatingLayerProps}>{label}</TooltipPopup>
    </Tooltip>
  );
}
