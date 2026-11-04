import type { ThreadLostRequest } from "@starkfuture/client-runtime/state/thread-requests";
import type { RuntimeRequestId } from "@starkfuture/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { RequestActionButton } from "./RequestActionButton";

type LostRequestIds = readonly [RuntimeRequestId, ...RuntimeRequestId[]];

export interface LostRequestCardProps {
  readonly canOperateThread: boolean;
  /** Open lost requests, oldest first; the card shows the newest. */
  readonly requests: ReadonlyArray<ThreadLostRequest>;
  readonly busy: boolean;
  readonly onAskAgain: (requestIds: LostRequestIds) => Promise<unknown>;
  readonly onDismiss: (requestIds: LostRequestIds) => Promise<unknown>;
}

/**
 * An approval or question lost to a restart, shutdown or provider exit. Ask
 * again starts a turn that asks the agent to retry the step; the "all"
 * actions only appear, and are labelled, when several decisions are open.
 */
export function LostRequestCard(props: LostRequestCardProps) {
  const shown = props.requests.at(-1);
  if (shown === undefined) return null;
  const count = props.requests.length;
  const allIds = props.requests.map((request) => request.requestId);
  const everyId: LostRequestIds = [allIds[0] ?? shown.requestId, ...allIds.slice(1)];
  const disabled = props.busy || !props.canOperateThread;
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-stark-bold text-2xs uppercase tracking-[1.1px] text-warning-foreground">
        {count > 1 ? `${count} decisions lost` : "Decision lost"}
      </Text>
      <Text className="font-stark-bold text-lg text-foreground">{shown.label}</Text>
      {shown.detail ? (
        <Text
          className="font-mono text-sm leading-normal text-foreground-secondary"
          numberOfLines={3}
        >
          {shown.detail}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        <RequestActionButton
          label="Ask again"
          disabled={disabled}
          onPress={() => {
            if (!disabled) void props.onAskAgain([shown.requestId]);
          }}
        />
        <RequestActionButton
          label="Dismiss"
          tone="secondary"
          disabled={disabled}
          onPress={() => {
            if (!disabled) void props.onDismiss([shown.requestId]);
          }}
        />
        {count > 1 ? (
          <>
            <RequestActionButton
              label={`Ask again for all ${count}`}
              tone="secondary"
              disabled={disabled}
              onPress={() => {
                if (!disabled) void props.onAskAgain(everyId);
              }}
            />
            <RequestActionButton
              label={`Dismiss all ${count}`}
              tone="secondary"
              disabled={disabled}
              onPress={() => {
                if (!disabled) void props.onDismiss(everyId);
              }}
            />
          </>
        ) : null}
      </View>
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          This connection cannot change this thread.
        </Text>
      ) : null}
    </View>
  );
}
