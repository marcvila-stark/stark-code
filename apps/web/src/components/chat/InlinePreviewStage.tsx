import { ChevronLeftIcon, ChevronRightIcon, Maximize2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Shared presentation for generated visuals; the content keeps its own loading and permissions. */
export function InlinePreviewStage(props: {
  readonly children: ReactNode;
  readonly title: string;
  readonly index?: number;
  readonly count?: number;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onExpand?: () => void;
  readonly expandDisabled?: boolean;
}) {
  const multiple = (props.count ?? 1) > 1;
  return (
    <div className="my-3 min-w-0 rounded-xl border border-border/45 bg-muted/15 p-3 [background-image:radial-gradient(var(--border)_0.7px,transparent_0.7px)] [background-size:18px_18px] sm:p-4">
      <div className="min-w-0 overflow-hidden rounded-lg bg-background/95 shadow-xs">
        {props.children}
      </div>
      <div className="mt-3 flex min-w-0 items-center justify-center gap-2">
        <div className="flex min-w-0 items-center gap-1 rounded-full border border-border/65 bg-background/95 px-2 py-1">
          {multiple ? (
            <Button
              aria-label="Previous preview"
              size="icon-xs"
              variant="ghost-muted"
              onClick={props.onPrevious}
            >
              <ChevronLeftIcon />
            </Button>
          ) : null}
          {multiple ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {(props.index ?? 0) + 1} / {props.count}
            </span>
          ) : null}
          <span className="min-w-0 truncate px-1 text-xs text-foreground" aria-live="polite">
            {props.title}
          </span>
          {multiple ? (
            <Button
              aria-label="Next preview"
              size="icon-xs"
              variant="ghost-muted"
              onClick={props.onNext}
            >
              <ChevronRightIcon />
            </Button>
          ) : null}
        </div>
        {props.onExpand ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Open full screen"
                  size="icon-sm"
                  variant="glass"
                  onClick={props.onExpand}
                  disabled={props.expandDisabled}
                />
              }
            >
              <Maximize2Icon />
            </TooltipTrigger>
            <TooltipPopup>Open full screen</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
