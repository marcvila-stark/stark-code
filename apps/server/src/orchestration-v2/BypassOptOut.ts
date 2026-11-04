/**
 * Narrows chats when an account stops allowing Bypass. A Claude chat saved as
 * Bypass runs Manual once its instance no longer allows Bypass, but a provider
 * session it already started keeps running Bypass until it restarts. So when
 * an instance's opt-in flips off, explicit Bypass chats become Manual and live
 * inherited sessions restart while preserving inheritance. Both use "Stop and
 * apply now": an idle session restarts at once, a running chat's run is stopped
 * and its session restarts when it has. Turning the opt-in back on widens nothing.
 *
 * The startup freeze (PermissionFreeze) covers an opt-in turned off while the
 * server was not running.
 */
import { CommandId, type ServerSettings, ThreadId } from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { freezeCapabilities } from "./PermissionFreeze.ts";
import { DispatchPermissionRevocation } from "./DispatchPermissionRevocation.ts";

/** The provider instances whose account allows Bypass, read from settings. */
export function bypassAllowedInstanceIds(settings: ServerSettings): ReadonlySet<string> {
  const instances = deriveProviderInstanceConfigMap(settings);
  return new Set(
    Object.keys(instances).filter(
      (instanceId) =>
        freezeCapabilities(instances, instanceId).supportedRuntimeModes?.includes("full-access") ===
        true,
    ),
  );
}

/** The instances that allowed Bypass before a settings change and no longer do. */
export function bypassRevokedInstanceIds(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): ReadonlyArray<string> {
  return [...before].filter((instanceId) => !after.has(instanceId));
}

/**
 * Narrows explicit Bypass chats and restarts inherited live sessions, which
 * may run native Bypass even when their stored fallback is Manual. Inherited
 * chats keep inheriting, but their next process reads the revoked opt-in.
 * Returns affected chats; a chat it could not restart is logged.
 */
export const narrowBypassChats = Effect.fn("BypassOptOut.narrowBypassChats")(function* (
  instanceIds: ReadonlyArray<string>,
) {
  if (instanceIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* OrchestratorV2;
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread.thread_id FROM orchestration_v2_projection_threads AS thread
    WHERE thread.deleted_at IS NULL
      AND thread.provider_instance_id IN ${sql.in(instanceIds)}
      AND (
        (thread.runtime_mode = 'full-access'
          AND (thread.permission_source IS NULL OR thread.permission_source = 'override'))
        OR (thread.permission_source = 'inherit' AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_provider_sessions AS session
          WHERE session.thread_id = thread.thread_id
            AND session.provider_instance_id = thread.provider_instance_id
            AND session.status NOT IN ('stopped', 'error')
        ))
      )
    ORDER BY thread.thread_id
  `;
  const stamp = DateTime.toEpochMillis(yield* DateTime.now);
  const narrowed: Array<ThreadId> = [];
  for (const row of rows) {
    const threadId = ThreadId.make(row.thread_id);
    const result = yield* orchestrator
      .dispatch({
        type: "thread.permission.set",
        commandId: CommandId.make(`permission-bypass-off:${threadId}:${stamp}`),
        threadId,
        permissionSource: "override",
        runtimeMode: "approval-required",
        whileRunning: "stop-and-apply",
      })
      .pipe(Effect.provideService(DispatchPermissionRevocation, true), Effect.result);
    if (result._tag === "Success") {
      narrowed.push(threadId);
    } else {
      yield* Effect.logWarning("Could not narrow a Bypass chat after Bypass was turned off", {
        threadId,
        cause: result.failure,
      });
    }
  }
  if (narrowed.length > 0) {
    yield* Effect.logInfo("permissions.bypass-opt-out", {
      instanceIds,
      threadIds: narrowed,
    });
  }
  return narrowed;
});

/**
 * Watches settings for an instance whose Bypass opt-in turns off and narrows
 * its Bypass chats then. Runs for the life of the server.
 */
export const start = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsModule.ServerSettingsService;
  const changes = yield* settingsService.subscribeChanges;
  let allowed = bypassAllowedInstanceIds(yield* settingsService.getSettings.pipe(Effect.orDie));
  yield* forkParked(
    Stream.runForEach(changes, (settings) =>
      Effect.suspend(() => {
        const next = bypassAllowedInstanceIds(settings);
        const revoked = bypassRevokedInstanceIds(allowed, next);
        allowed = next;
        return narrowBypassChats(revoked).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not narrow Bypass chats after Bypass was turned off", {
              instanceIds: revoked,
              cause,
            }),
          ),
          Effect.asVoid,
        );
      }),
    ),
  );
});
