import { InfoIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Source-folder context stays visible because imported chats share one sidebar workspace. */
export function LocalHistoryNotice({
  imported,
  cwd,
  truncated,
}: {
  readonly imported: boolean;
  readonly cwd: string;
  readonly truncated: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
      <span className="shrink-0">{imported ? "Local CLI history" : "CLI working folder"}</span>
      <span aria-hidden>·</span>
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate" tabIndex={0} />}>
          {cwd}
        </TooltipTrigger>
        <TooltipPopup>{cwd}</TooltipPopup>
      </Tooltip>
      {imported && truncated ? (
        <span className="shrink-0 text-warning-foreground">History is incomplete</span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={imported ? "About imported history" : "About this working folder"}
            />
          }
        >
          <InfoIcon />
        </TooltipTrigger>
        <TooltipPopup>
          {imported ? (
            <>
              Continue here when the CLI session is idle. The Shell button starts a separate
              session. Imported history contains message text; some tool outputs and attachments are
              unavailable.
            </>
          ) : (
            <>This chat uses the original CLI working folder. It has its own agent session.</>
          )}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
