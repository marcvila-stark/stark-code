import { OrchestrationDispatchCommandError } from "@starkfuture/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "not-created"
  );
}

/**
 * A failed command's reason as the user reads it: the server's message (a refusal such as
 * "Widening this scheduled task's permissions needs permission to change settings."), never the
 * error's type name in front of it, as `String(error)` gives.
 */
export function commandFailureMessage(error: unknown): string {
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "";
  return message.trim() || "Something went wrong.";
}
