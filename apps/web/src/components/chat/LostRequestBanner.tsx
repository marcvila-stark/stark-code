import type { ThreadLostRequest } from "@starkfuture/client-runtime/state/thread-requests";
import type { RuntimeRequestId } from "@starkfuture/contracts";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type LostRequestIds = readonly [RuntimeRequestId, ...RuntimeRequestId[]];

type LostRequestBannerProps = {
  /** Open lost requests, oldest first; the banner shows the newest. */
  readonly requests: ReadonlyArray<ThreadLostRequest>;
  readonly canOperateThread: boolean;
  /** Rejects with the server's reason when the command is refused. */
  readonly onAskAgain: (requestIds: LostRequestIds) => Promise<void>;
  readonly onDismiss: (requestIds: LostRequestIds) => Promise<void>;
};

/**
 * The chat notice for approvals and questions lost to a restart, shutdown or
 * provider exit. Ask again and Dismiss act on the request shown; with several
 * open, separate "for all" actions name every one of them.
 */
export function lostRequestBannerItem(
  props: LostRequestBannerProps,
): ComposerBannerStackItem | null {
  const shown = props.requests.at(-1);
  if (shown === undefined) return null;
  const count = props.requests.length;
  return {
    id: `lost-request:${shown.requestId}`,
    variant: "warning",
    priority: "urgent",
    icon: <RotateCcwIcon />,
    title: (
      // Needs you focuses this element when the user picks the lost entry.
      <span data-runtime-request-id={shown.requestId} tabIndex={-1}>
        {shown.label}
        {count > 1 ? ` · ${count} decisions` : null}
      </span>
    ),
    description: shown.detail ? <code>{shown.detail}</code> : undefined,
    actions: <LostRequestActions key={shown.requestId} {...props} shown={shown} />,
  };
}

function LostRequestActions({
  requests,
  shown,
  canOperateThread,
  onAskAgain,
  onDismiss,
}: LostRequestBannerProps & { readonly shown: ThreadLostRequest }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allIds = requests.map((request) => request.requestId);
  const everyId: LostRequestIds = [allIds[0] ?? shown.requestId, ...allIds.slice(1)];
  const run = async (action: () => Promise<void>, failure: string) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    }
    setPending(false);
  };
  const disabled = pending || !canOperateThread;
  const noun = shown.requestKind === "user_input" ? "question" : "approval";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled}
        onClick={() => void run(() => onAskAgain([shown.requestId]), "Could not ask again.")}
      >
        Ask again
      </Button>
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Dismiss lost ${noun}`}
        disabled={disabled}
        onClick={() => void run(() => onDismiss([shown.requestId]), "Could not dismiss.")}
      >
        Dismiss
      </Button>
      {requests.length > 1 ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => void run(() => onAskAgain(everyId), "Could not ask again.")}
          >
            Ask again for all {requests.length}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => void run(() => onDismiss(everyId), "Could not dismiss.")}
          >
            Dismiss all {requests.length}
          </Button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
