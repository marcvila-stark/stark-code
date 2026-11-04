import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  permissionSourceOf,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@starkfuture/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as PermissionContainment from "../orchestration-v2/PermissionContainment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

/** Decider string rejections are public; wrapped storage and hydration causes are not. */
export const dispatchFailure = (
  error: OrchestratorV2Error | ThreadManagement.ThreadManagementProviderInstanceDisabledError,
) =>
  error._tag === "ThreadManagementProviderInstanceDisabledError"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : (error._tag === "OrchestratorDispatchError" ||
          error._tag === "OrchestratorCommandRejectedError") &&
        typeof error.cause === "string" &&
        error.cause.length > 0
      ? new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: Array.from(error.cause).slice(0, 1000).join(""),
        })
      : unavailable();

/**
 * The most a caller may hand to the threads it targets, and whether it may
 * change the environment itself. A thread caller is capped by the preset its
 * provider really runs, not the one stored on the thread; an OAuth client by
 * the ceiling chosen when it was approved.
 */
export type CallerLimits = PermissionContainment.StarkLimits;

export interface Caller {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  /** The calling thread, absent for a client signed in from outside Stark. */
  readonly caller: OrchestrationV2ThreadShell | undefined;
}

export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  return yield* loadCaller();
});

/**
 * The caller, whichever tools its credential grants. Tools check their own
 * capability; `McpToolAccess` uses this for every tool.
 */
export const loadCaller = Effect.fn("mcp.loadCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (scope.thread === undefined) {
    return { scope, threads, caller: undefined } satisfies Caller;
  }
  const caller = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return { scope, threads, caller } satisfies Caller;
});

/**
 * The caller's limits. A thread caller's come from the provider its MCP
 * credential belongs to, since the brand runs every non-Claude session
 * Supervised whatever the thread stored; nothing is read for a thread that
 * stored Supervised or inherits, which grants Supervised either way.
 */
export const loadLimits = Effect.fn("mcp.loadLimits")(function* ({
  scope,
  threads,
  caller,
}: Caller) {
  if (caller === undefined) {
    return PermissionContainment.clientLimits(
      McpInvocationContext.clientRuntimeModeCeiling(scope.client),
    );
  }
  if (caller.runtimeMode === "approval-required" || permissionSourceOf(caller) === "inherit") {
    return PermissionContainment.threadLimits(caller, undefined);
  }
  const records = yield* threads
    .getThreadRecords(caller.id, ["providerSessions", "providerThreads"])
    .pipe(Effect.mapError(unavailable));
  return PermissionContainment.threadLimits(
    caller,
    PermissionContainment.providerFactsFromRecords({
      providerInstanceId: caller.providerInstanceId,
      providerSessionId: scope.thread?.providerSessionId,
      providerSessions: records.providerSessions,
      providerThreads: records.providerThreads,
    }),
  );
});

/**
 * A caller may change another thread only if that thread runs within the
 * caller's own modes. Its own thread is always within them. A target that
 * follows its provider's own settings counts as the broadest preset.
 */
export const assertTargetWithinLimits = (
  limits: CallerLimits,
  target: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
) => {
  const exceeded = PermissionContainment.exceededLimit(limits, target);
  return exceeded === undefined
    ? Effect.void
    : Effect.fail(
        exceeded === "runtime"
          ? new OrchestratorMcpFailure({
              code: "runtime_mode_escalation_denied",
              message: `Thread runtime mode ${PermissionContainment.targetPreset(target)} is broader than this caller's ${limits.runtimeMode}.`,
            })
          : new OrchestratorMcpFailure({
              code: "interaction_mode_escalation_denied",
              message: `Thread interaction mode ${target.interactionMode} is broader than this caller's ${limits.interactionMode}.`,
            }),
      );
};

/**
 * A thread caller acts only while it owns a live run of a thread that is not
 * archived, so a provider token that outlived its session cannot act. An
 * OAuth client has no run; its session and ceiling are its authority.
 */
export function assertLiveCaller({ caller, scope }: Caller) {
  if (caller === undefined) return Effect.void;
  return caller.archivedAt !== null ||
    caller.activeRunId === null ||
    caller.providerInstanceId !== scope.thread?.providerInstanceId
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      )
    : Effect.void;
}

/**
 * Actions that change the environment itself (projects, preferences) need
 * Stark's environment authority: a thread whose provider really runs Bypass
 * outside Plan, or a client approved with a full-access ceiling. A clamped
 * thread that only stored full-access does not hold it.
 */
export const assertFullAccess = (context: Caller, message: string) =>
  loadLimits(context).pipe(
    Effect.flatMap((limits) =>
      limits.authority === "environment"
        ? Effect.void
        : Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message })),
    ),
  );

/** A target project: the one passed, else the calling thread's. */
export const resolveProjectId = (context: Caller, projectId: ProjectId | undefined) =>
  projectId !== undefined
    ? Effect.succeed(projectId)
    : context.caller !== undefined
      ? Effect.succeed(context.caller.projectId)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass projectId: this MCP client is not running inside a Stark thread.",
          }),
        );

/** A target thread: the one passed, else the calling thread. */
const resolveThreadId = (context: Caller, threadId: ThreadId | undefined) =>
  threadId !== undefined
    ? Effect.succeed(threadId)
    : context.caller !== undefined
      ? Effect.succeed(context.caller.id)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId: this MCP client is not running inside a Stark thread.",
          }),
        );

/** Load a target thread anywhere in the environment; an omitted id means the calling thread. */
export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readCaller();
  const targetId = yield* resolveThreadId(context, threadId);
  const shell = yield* context.threads.getThreadShell(targetId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The thread was not found.",
    });
  }
  const projection = yield* context.threads
    .getProjectThreadRecords({ projectId: shell.projectId, threadId: targetId }, fields, {
      turnItemTypes: ["user_input_request"],
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "ThreadManagementThreadNotFoundError"
          ? new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The thread was not found.",
            })
          : unavailable(),
      ),
    );
  return { ...context, projection };
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(`mcp:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`);
});
