import { useSyncExternalStore } from "react";
import type { ScopedThreadRef } from "@starkfuture/contracts";

const listeners = new Set<() => void>();
const keyFor = (thread: ScopedThreadRef) =>
  `stark-code:hook-activity:${thread.environmentId}:${thread.threadId}`;
function readThreadHookActivity(thread: ScopedThreadRef | null): boolean {
  if (thread === null) return false;
  try {
    return localStorage.getItem(keyFor(thread)) === "true";
  } catch {
    return false;
  }
}
function setThreadHookActivity(thread: ScopedThreadRef, value: boolean): void {
  try {
    localStorage.setItem(keyFor(thread), String(value));
  } catch {
    /* The preference can be unavailable in a restricted browser. */
  }
  for (const listener of listeners) listener();
}
export function useThreadHookActivity(thread: ScopedThreadRef | null): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      window.addEventListener("storage", listener);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", listener);
      };
    },
    () => readThreadHookActivity(thread),
    () => false,
  );
}
