import { runtimeRequestDeliveryCaption } from "@starkfuture/client-runtime/approvals/permission-presentation";
import type { OrchestrationV2RuntimeRequestDelivery } from "@starkfuture/contracts";
import {
  runtimeRequestResponseCaption,
  type RuntimeRequestResponseState,
} from "@starkfuture/client-runtime/state/runtime-request-response";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/**
 * Why an approval or question cannot take an answer right now, beside its actions. An answer
 * that could not be confirmed offers Retry, which sends the same answer again. Once the server
 * reports delivery, a given answer says whether it reached the agent; a failed
 * or uncertain delivery is never shown as done.
 */
export const RuntimeRequestResponseNotice = memo(function RuntimeRequestResponseNotice({
  state,
  onRetry,
  delivery,
  providerName,
}: {
  state: RuntimeRequestResponseState;
  onRetry?: (() => void) | undefined;
  delivery?: Pick<OrchestrationV2RuntimeRequestDelivery, "state"> | undefined;
  providerName?: string | undefined;
}) {
  const caption = runtimeRequestResponseCaption(state);
  const deliveryCaption =
    caption === null ? runtimeRequestDeliveryCaption(delivery, providerName) : null;
  if (caption === null && deliveryCaption === null) return null;
  return (
    <span
      role="status"
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        deliveryCaption?.tone === "error"
          ? "text-destructive"
          : deliveryCaption?.tone === "warning"
            ? "text-warning"
            : "text-muted-foreground",
      )}
      data-runtime-request-response={state}
      data-runtime-request-delivery={deliveryCaption ? delivery?.state : undefined}
    >
      <span className="min-w-0">{caption ?? deliveryCaption?.text}</span>
      {state === "unconfirmed" && onRetry ? (
        <Button size="xs" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </span>
  );
});
