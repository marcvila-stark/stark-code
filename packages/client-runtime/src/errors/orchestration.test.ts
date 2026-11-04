import { OrchestrationDispatchCommandError } from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  commandFailureMessage,
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "./orchestration.ts";

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

describe("wasBootstrapThreadNotCreated", () => {
  it("accepts only a confirmed never-created bootstrap thread", () => {
    const notCreated = new OrchestrationDispatchCommandError({
      message: "A separate worktree requires a base commit.",
      bootstrapThreadDisposition: "not-created",
    });
    expect(wasBootstrapThreadNotCreated(notCreated)).toBe(true);
    expect(wasBootstrapThreadDeleted(notCreated)).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
        }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadNotCreated(new Error("connection lost"))).toBe(false);
  });
});

describe("commandFailureMessage", () => {
  it("shows a refusal's own words, never the error's type name", () => {
    class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
      "ScheduledTaskError",
      { message: Schema.String },
    ) {}
    const widening =
      "Widening this scheduled task's permissions needs permission to change settings.";
    expect(commandFailureMessage(new ScheduledTaskError({ message: widening }))).toBe(widening);
    expect(
      commandFailureMessage(
        new OrchestrationDispatchCommandError({
          message:
            "Starting a chat with broader permissions than new chats get needs permission to change settings.",
        }),
      ),
    ).toBe(
      "Starting a chat with broader permissions than new chats get needs permission to change settings.",
    );
    expect(commandFailureMessage({ message: "  " })).toBe("Something went wrong.");
    expect(commandFailureMessage("plain text")).toBe("plain text");
  });
});
