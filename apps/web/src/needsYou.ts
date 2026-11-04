import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@starkfuture/client-runtime/state/models";
import { providerKindDisplayName } from "@starkfuture/client-runtime/state/provider-instance-display";
import {
  ThreadId,
  type NativeAgentAttention,
  type EnvironmentId,
  type RuntimeRequestId,
  type ScopedThreadRef,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";

export interface NeedsYouEntry {
  readonly key: string;
  readonly threadRef: ScopedThreadRef;
  readonly requestId: RuntimeRequestId | null;
  readonly terminalId?: string;
  readonly nativeProvider?: NativeAgentAttention["provider"];
  readonly title: string;
  readonly folder: string;
  readonly provider: string;
  readonly kind: "approval" | "question" | "sign-in" | "input" | "lost";
  readonly requestedAt: number;
}

function threadProviderLabel(thread: EnvironmentThreadShell): string {
  return providerKindDisplayName(thread.runtime?.providerName ?? thread.providerInstanceId);
}

/** Shell summaries already stream across all folders; no per-chat inspection or polling. */
export function collectNeedsYou(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  native: ReadonlyArray<NativeAgentAttention & { environmentId: EnvironmentId }> = [],
): NeedsYouEntry[] {
  const folders = new Map(
    projects.map((project) => [JSON.stringify([project.environmentId, project.id]), project.title]),
  );
  const seen = new Set<string>();
  const chats = threads.flatMap((thread): NeedsYouEntry[] => {
    const request = thread.source.pendingRuntimeRequest;
    if (!request || thread.deletedAt !== null) return [];
    const key = JSON.stringify([thread.environmentId, thread.id, request.id]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        key,
        threadRef: { environmentId: thread.environmentId, threadId: thread.id },
        requestId: request.id,
        title: thread.title || "Untitled chat",
        folder: folders.get(JSON.stringify([thread.environmentId, thread.projectId])) ?? "Folder",
        provider: threadProviderLabel(thread),
        kind:
          request.kind === "user_input"
            ? "question"
            : request.kind === "auth_refresh"
              ? "sign-in"
              : "approval",
        requestedAt: DateTime.toEpochMillis(request.createdAt),
      },
    ];
  });
  // A decision lost to a restart stays here until the user asks again or dismisses it.
  const lost = threads.flatMap((thread): NeedsYouEntry[] => {
    const request = thread.source.lostRuntimeRequest;
    if (!request || thread.deletedAt !== null) return [];
    const key = JSON.stringify([thread.environmentId, thread.id, request.id, "lost"]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        key,
        threadRef: { environmentId: thread.environmentId, threadId: thread.id },
        requestId: request.id,
        title: thread.title || "Untitled chat",
        folder: folders.get(JSON.stringify([thread.environmentId, thread.projectId])) ?? "Folder",
        provider: threadProviderLabel(thread),
        kind: "lost",
        requestedAt: DateTime.toEpochMillis(request.lostAt),
      },
    ];
  });
  const shells = native.flatMap((attention): NeedsYouEntry[] => {
    const thread = threads.find(
      (row) => row.environmentId === attention.environmentId && row.id === attention.threadId,
    );
    if (!thread || thread.deletedAt !== null) return [];
    const key = JSON.stringify([
      attention.environmentId,
      attention.threadId,
      attention.terminalId,
      "native",
    ]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        key,
        threadRef: {
          environmentId: attention.environmentId,
          threadId: ThreadId.make(attention.threadId),
        },
        requestId: null,
        terminalId: attention.terminalId,
        nativeProvider: attention.provider,
        title: thread.title || "Untitled chat",
        folder: folders.get(JSON.stringify([thread.environmentId, thread.projectId])) ?? "Folder",
        provider: `${attention.provider === "codex" ? "Codex" : "Claude"} · terminal`,
        kind:
          attention.kind === "permission"
            ? "approval"
            : attention.kind === "auth"
              ? "sign-in"
              : attention.kind,
        requestedAt: Date.parse(attention.requestedAt) || 0,
      },
    ];
  });
  return [...chats, ...lost, ...shells].sort(
    (left, right) => left.requestedAt - right.requestedAt || left.key.localeCompare(right.key),
  );
}

export function prioritizePendingRequest<T extends { readonly requestId: RuntimeRequestId }>(
  requests: T[],
  requestId: RuntimeRequestId | null,
): T[] {
  if (requestId === null) return requests;
  const index = requests.findIndex((request) => request.requestId === requestId);
  return index <= 0
    ? requests
    : [requests[index]!, ...requests.slice(0, index), ...requests.slice(index + 1)];
}
