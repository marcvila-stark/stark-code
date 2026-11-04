import type {
  EnvironmentId,
  McpServersListInput,
  McpServersListResult,
} from "@starkfuture/contracts";

import { formatElapsedDurationLabel } from "../../timestampFormat";

/** One MCP inspection result and when it arrived (epoch ms). */
export interface McpStatusSnapshot {
  readonly result: McpServersListResult;
  readonly receivedAt: number;
}

/** A shown result older than this carries its age, so old state never reads as current. */
const MCP_STATUS_AGE_LABEL_AFTER_MS = 3 * 60_000;

/**
 * A current result this recent when a view opens counts as fresh, so reopening
 * a panel right after a poll does not flash "Refreshing…". Matches the query's
 * stale time.
 */
export const MCP_STATUS_FRESH_ON_OPEN_MS = 30_000;

/**
 * One key per environment and inspection target: a chat thread, or a folder
 * plus agent. The poller, the panel and the memory below share it.
 */
export function mcpStatusTargetKey(
  environmentId: EnvironmentId,
  target: McpServersListInput,
): string {
  return JSON.stringify([
    environmentId,
    target.threadId,
    target.providerInstanceId,
    target.projectId,
  ]);
}

/**
 * Last inspection result per target for this app session. The query atom drops
 * its value a few minutes after the last panel closes; this keeps it so the
 * next open can show what was known while a new inspection runs. The least
 * recently updated targets are dropped past `limit`.
 */
export function createMcpStatusMemory(limit = 50) {
  const snapshots = new Map<string, McpStatusSnapshot>();
  return {
    remember(key: string, snapshot: McpStatusSnapshot): void {
      const current = snapshots.get(key);
      if (current !== undefined && current.receivedAt >= snapshot.receivedAt) return;
      snapshots.delete(key);
      snapshots.set(key, snapshot);
      for (const oldest of snapshots.keys()) {
        if (snapshots.size <= limit) break;
        snapshots.delete(oldest);
      }
    },
    recall(key: string): McpStatusSnapshot | null {
      return snapshots.get(key) ?? null;
    },
  };
}

/** Shared by every Connected tools surface in this window. */
export const mcpStatusMemory = createMcpStatusMemory();

export type McpStatusView =
  /** Nothing is known for this target yet and an inspection is running. */
  | { readonly kind: "checking" }
  /** Nothing is known and the inspection failed; the error message explains it. */
  | { readonly kind: "unknown" }
  | {
      readonly kind: "known";
      readonly result: McpServersListResult;
      /** The shown result predates this view and a newer inspection is running. */
      readonly refreshing: boolean;
      /** The shown result came from memory, not from the current query. */
      readonly remembered: boolean;
      /** Short age such as "12m" once the result is older than a few minutes. */
      readonly age: string | null;
    };

/**
 * Decide what a Connected tools surface shows. The current query result wins;
 * without one, the remembered result stands in, marked as refreshing, until
 * the inspection answers. `freshSince` is when the view opened or the user
 * last asked for a check: a current result older than that also counts as
 * refreshing while a check is outstanding, so background polls stay quiet.
 */
export function resolveMcpStatusView(input: {
  readonly current: McpServersListResult | null;
  readonly currentReceivedAt: number;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly remembered: McpStatusSnapshot | null;
  readonly freshSince: number;
  readonly now: number;
}): McpStatusView {
  const remembered = input.current === null;
  const snapshot =
    input.current === null
      ? input.remembered
      : { result: input.current, receivedAt: input.currentReceivedAt };
  if (snapshot === null) return input.failed ? { kind: "unknown" } : { kind: "checking" };
  const ageMs = input.now - snapshot.receivedAt;
  return {
    kind: "known",
    result: snapshot.result,
    remembered,
    refreshing:
      !input.failed && (remembered || (input.pending && snapshot.receivedAt < input.freshSince)),
    age:
      ageMs >= MCP_STATUS_AGE_LABEL_AFTER_MS
        ? formatElapsedDurationLabel(new Date(snapshot.receivedAt).toISOString(), input.now)
        : null,
  };
}

/**
 * The one-line note above a known result: whether a check is running, whether
 * the rows are the last known state, and how old they are. `slow` is set once
 * a refresh has run for a while without an answer.
 */
export function describeMcpStatusFreshness(view: McpStatusView, slow: boolean): string | null {
  if (view.kind !== "known") return null;
  const checked = view.age ? ` Last checked ${view.age} ago.` : "";
  if (view.refreshing) {
    return slow ? `Refresh is taking longer than expected.${checked}` : `Refreshing…${checked}`;
  }
  if (view.remembered) {
    return view.age
      ? `Showing the last known status from ${view.age} ago.`
      : "Showing the last known status.";
  }
  return view.age ? `Last checked ${view.age} ago.` : null;
}
