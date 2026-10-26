import { MoreHorizontalIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function ThreadToolsPopover({
  tools,
  actions,
}: {
  readonly tools?: ReactNode;
  readonly actions?: (closeTools: () => void) => ReactNode;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const closeTools = useCallback(() => setToolsOpen(false), []);
  return (
    <div className="shrink-0 [-webkit-app-region:no-drag]">
      <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
        <PopoverTrigger
          render={
            <Button size="icon-sm" variant="ghost" aria-label="Thread tools">
              <MoreHorizontalIcon className="size-4" />
            </Button>
          }
        />
        <PopoverPopup side="bottom" align="end" padding="compact" width="sm">
          <div className="flex flex-wrap items-center gap-1" aria-label="Thread tools actions">
            {/* Nested tools such as MCP keep their parent open while in use. */}
            {tools}
            {actions?.(closeTools)}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
