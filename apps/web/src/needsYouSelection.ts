import { create } from "zustand";
import type {
  NativeAgentAttention,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@starkfuture/contracts";

export const useNeedsYouSelection = create<{
  readonly target:
    | (ScopedThreadRef & {
        requestId: RuntimeRequestId | null;
        terminalId?: string;
        nativeProvider?: NativeAgentAttention["provider"];
        sequence: number;
      })
    | null;
  readonly open: (threadRef: ScopedThreadRef, requestId: RuntimeRequestId) => void;
  readonly openNative: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    provider: NativeAgentAttention["provider"],
  ) => void;
}>()((set) => ({
  target: null,
  open: (threadRef, requestId) =>
    set((state) => ({
      target: { ...threadRef, requestId, sequence: (state.target?.sequence ?? 0) + 1 },
    })),
  openNative: (threadRef, terminalId, provider) =>
    set((state) => ({
      target: {
        ...threadRef,
        requestId: null,
        terminalId,
        nativeProvider: provider,
        sequence: (state.target?.sequence ?? 0) + 1,
      },
    })),
}));
