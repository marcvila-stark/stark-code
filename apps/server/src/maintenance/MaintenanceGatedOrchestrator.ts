import type { OrchestrationV2ServerCommand } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MaintenanceGate from "./MaintenanceGate.ts";

/**
 * `work` starts or extends agent work, a turn, a shell command or a workspace
 * change. `control` stops, answers or settles work already admitted. `state`
 * edits records without starting anything.
 */
export type MaintenanceCommandClass = "work" | "control" | "state";

/** Exhaustive: a new command type fails typecheck here until it is classified. */
export const classifyMaintenanceCommand = (
  command: OrchestrationV2ServerCommand,
): MaintenanceCommandClass => {
  switch (command.type) {
    case "message.dispatch":
    case "thread.shell-command.dispatch":
    case "delegated_task.request":
    case "prepared-run.release":
    case "prepared-run.retry":
    case "queue.resume":
    case "runtime-request.ask-again":
    case "checkpoint.rollback":
    case "thread.merge_back":
    case "provider.switch":
      return "work";
    case "thread.pull-request-watch.sync":
      return command.wake === undefined ? "state" : "work";
    case "run.interrupt":
    case "subagent.stop":
    case "thread.stop":
    case "runtime-request.respond":
    case "runtime-request.delivery.update":
    case "runtime-request.provider-closed":
    case "thread.user-input.dismiss":
    case "runtime-request.lost.dismiss":
    case "queued-run.cancel":
    case "queued-run.reorder":
    case "queued-run.edit":
    case "queued-message.promote-to-steer":
    case "provider-session.detach":
    case "prepared-run.fail":
    case "prepared-run.progress":
    case "notification.delivery.accept":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "thread.created.record":
    case "checkpoint.rollback.fail":
    case "thread.background-work.settle":
    case "secret_request.record":
    case "thread.title.regeneration.complete":
      return "control";
    case "thread.create":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.delete":
    case "thread.settle":
    case "thread.auto-settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.auto-settle.set":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.active.reorder":
    case "thread.visit":
    case "thread.mark-unread":
    case "thread.metadata.update":
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync":
    case "thread.pull-request.watch":
    case "thread.pull-request.sync":
    case "thread.runtime-mode.set":
    case "thread.permission.set":
    case "thread.permission.migrate":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "thread.fork":
      return "state";
    default: {
      const unclassified: never = command;
      return unclassified;
    }
  }
};

/**
 * Work that continues something already admitted rather than starting a new
 * root: restart and usage-limit continuations, wakes and delegated results,
 * and scheduled runs, whose reservation already passed the gate.
 */
const continuesAdmittedWork = (command: OrchestrationV2ServerCommand) =>
  command.type === "message.dispatch" &&
  (command.restartContinuationOfRunId !== undefined ||
    command.usageLimitContinuationOfRunId !== undefined ||
    command.delegatedCompletion !== undefined ||
    command.notification !== undefined ||
    command.scheduledTaskId !== undefined);

/** Threads whose work in flight makes this command part of it (child work). */
const originThreadIds = (command: OrchestrationV2ServerCommand): ReadonlyArray<string> => {
  switch (command.type) {
    case "message.dispatch":
      return command.senderThreadId === undefined
        ? [command.threadId]
        : [command.senderThreadId, command.threadId];
    case "delegated_task.request":
      return [command.parentThreadId];
    default:
      return "threadId" in command ? [command.threadId] : [];
  }
};

/**
 * Decorates `OrchestratorV2.dispatch` with the maintenance gate. Every
 * consumer of the orchestrator in the runtime layer receives the decorated
 * service, so no dispatch path starts new work during an update.
 *
 * Control and state commands always pass. Work passes while the gate is open
 * (tracked while it commits, so a gate closing meanwhile waits for it), or as
 * part of work already in flight: a continuation, a wake, a scheduled run, or
 * a command from a thread that is still working. Anything else is rejected
 * before commit and can be sent again.
 */
export const layer = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const inner = yield* Orchestrator.OrchestratorV2;
    const gate = yield* MaintenanceGate.MaintenanceGate;
    return Orchestrator.OrchestratorV2.of({
      ...inner,
      dispatch: (command) =>
        Effect.gen(function* () {
          if (classifyMaintenanceCommand(command) !== "work") return yield* inner.dispatch(command);
          const admitted = yield* gate.guard("command", inner.dispatch(command));
          if (Option.isSome(admitted)) return admitted.value;
          if (
            continuesAdmittedWork(command) ||
            (yield* gate.hasActiveWork(originThreadIds(command)))
          ) {
            return yield* inner.dispatch(command);
          }
          return yield* new Orchestrator.OrchestratorCommandRejectedError({
            commandId: command.commandId,
            commandType: command.type,
            cause: new MaintenanceGate.MaintenanceInProgressError({
              source: "command",
              reason: "update",
            }),
          });
        }),
    });
  }),
);
