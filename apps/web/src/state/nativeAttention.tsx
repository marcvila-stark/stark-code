import { useEffect } from "react";
import { create } from "zustand";
import {
  AuthTerminalReadScope,
  type EnvironmentId,
  type NativeAgentAttention,
} from "@starkfuture/contracts";
import { terminalEnvironment } from "./terminal";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentScope } from "./session";
import { useConnectedEnvironmentIds } from "./environments";

const EMPTY: ReadonlyArray<NativeAgentAttention> = [];
export const useNativeAttention = create<{
  readonly byEnvironment: Readonly<Record<string, ReadonlyArray<NativeAgentAttention>>>;
  readonly update: (id: EnvironmentId, rows: ReadonlyArray<NativeAgentAttention>) => void;
}>()((set) => ({
  byEnvironment: {},
  update: (id, rows) =>
    set((state) =>
      state.byEnvironment[id] === rows
        ? state
        : {
            byEnvironment: { ...state.byEnvironment, [id]: rows },
          },
    ),
}));

function NativeAttentionSubscription({ environmentId }: { environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const query = useEnvironmentQuery(
    canRead
      ? terminalEnvironment.nativeAttention({
          environmentId,
          input: null,
        })
      : null,
  );
  useEffect(() => {
    useNativeAttention
      .getState()
      .update(environmentId, query.error === null ? (query.data ?? EMPTY) : EMPTY);
  }, [environmentId, query.data, query.error]);
  useEffect(
    () => () => useNativeAttention.getState().update(environmentId, EMPTY),
    [environmentId],
  );
  return null;
}

/** One bounded snapshot subscription per connected host, including hidden native chats. */
export function NativeAttentionSubscriptions() {
  const environments = useConnectedEnvironmentIds();
  return environments.map((environmentId) => (
    <NativeAttentionSubscription key={environmentId} environmentId={environmentId} />
  ));
}
