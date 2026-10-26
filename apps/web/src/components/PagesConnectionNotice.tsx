import type { StarkPublishedPagesStatus } from "@starkfuture/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "./ui/button";

/** Saved connections restore before offering interactive browser sign-in. */
export function PagesConnectionNotice({
  status,
  busy,
  onConnect,
  onCancel,
}: {
  status: StarkPublishedPagesStatus | null;
  busy: boolean;
  onConnect: () => void;
  onCancel?: () => void;
}) {
  if (status === null || busy) {
    return (
      <p role="status" className="text-muted-foreground">
        {busy ? "Connecting to Company pages…" : "Restoring Pages connection…"}
      </p>
    );
  }

  if (status.state === "connecting") {
    return (
      <div className="space-y-3">
        <p role="status">Finish sign-in in your browser.</p>
        <p className="text-muted-foreground">Your pages will appear here automatically.</p>
        {onCancel ? (
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel sign-in
          </Button>
        ) : null}
      </div>
    );
  }

  const retry = status.state === "error";
  return (
    <div className="space-y-3">
      <h3 className="font-medium">
        {retry ? "Couldn’t connect to Company pages" : "Connect Company pages"}
      </h3>
      {status.message ? <p role="status">{status.message}</p> : null}
      {!retry ? (
        <p className="text-muted-foreground">
          Sign in through your browser. Your connection is saved on this Mac.
        </p>
      ) : null}
      <Button size="sm" variant={retry ? "outline" : "default"} onClick={onConnect}>
        {!retry ? <ExternalLinkIcon aria-hidden /> : null}
        {retry ? "Retry connection" : "Continue in browser"}
      </Button>
    </div>
  );
}
