import { runtimeRequestDeliveryCaption } from "@starkfuture/client-runtime/approvals/permission-presentation";
import type { OrchestrationV2RuntimeRequestDelivery } from "@starkfuture/contracts";
import {
  runtimeRequestResponseCaption,
  type RuntimeRequestResponseState,
} from "@starkfuture/client-runtime/state/runtime-request-response";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Why an approval or question cannot take an answer right now. An answer that could not be
 * confirmed offers Retry, which sends the same answer again. Once the server reports delivery
 * a given answer says whether it reached the agent.
 */
export function RuntimeRequestResponseCaption(props: {
  readonly state: RuntimeRequestResponseState;
  readonly onRetry?: (() => void) | undefined;
  readonly delivery?: Pick<OrchestrationV2RuntimeRequestDelivery, "state"> | undefined;
  readonly providerName?: string | undefined;
}) {
  const caption = runtimeRequestResponseCaption(props.state);
  const deliveryCaption =
    caption === null ? runtimeRequestDeliveryCaption(props.delivery, props.providerName) : null;
  if (caption === null && deliveryCaption === null) return null;
  return (
    <View accessibilityLiveRegion="polite" className="flex-row flex-wrap items-center gap-2.5">
      <Text
        className={
          deliveryCaption?.tone === "error"
            ? "font-sans text-xs leading-normal text-danger-foreground"
            : deliveryCaption?.tone === "warning"
              ? "font-sans text-xs leading-normal text-warning-foreground"
              : "font-sans text-xs leading-normal text-foreground-muted"
        }
      >
        {caption ?? deliveryCaption?.text}
      </Text>
      {props.state === "unconfirmed" && props.onRetry ? (
        <RequestActionButton label="Retry" tone="secondary" onPress={props.onRetry} />
      ) : null}
    </View>
  );
}
