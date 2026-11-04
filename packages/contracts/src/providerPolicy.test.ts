import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { dispatchNeedsSettingsWrite } from "./clientRpcPermissions.ts";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2Command,
  OrchestrationV2RuntimeRequestJson,
} from "./orchestrationV2.ts";
import { newChatPermissionSourceFor } from "./providerInstance.ts";
import {
  approvalOptionClass,
  approvalOptionIdClass,
  permissionSourceOf,
  ProviderApprovalOptionId,
  withApprovalOptionIds,
} from "./providerPolicy.ts";
import { ScheduledTask } from "./scheduledTask.ts";

const decodeThreadJson = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const encodeThreadJson = Schema.encodeSync(OrchestrationV2AppThreadJson);
const decodeRequestJson = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequestJson);
const encodeRequestJson = Schema.encodeSync(OrchestrationV2RuntimeRequestJson);
const decodeScheduledTask = Schema.decodeUnknownSync(ScheduledTask);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOptionId = Schema.decodeUnknownSync(ProviderApprovalOptionId);

const legacyThread = {
  createdBy: "user",
  creationSource: "web",
  id: "thread:legacy",
  projectId: "project:legacy",
  title: "Legacy",
  providerInstanceId: "claudeAgent",
  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread:legacy" },
  forkedFrom: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
};

describe("permission source", () => {
  it("reads a record written before permission sources as override", () => {
    const thread = decodeThreadJson(legacyThread);
    expect(thread.permissionSource).toBeUndefined();
    expect(permissionSourceOf(thread)).toBe("override");
    expect(encodeThreadJson(thread)).not.toHaveProperty("permissionSource");
  });

  it("round-trips a stored source and its migration trail", () => {
    const thread = decodeThreadJson({
      ...legacyThread,
      runtimeMode: "approval-required",
      permissionSource: "override",
      permissionMigrations: [
        {
          migrationId: "perm-v1",
          from: "full-access",
          to: "approval-required",
          reason: "claude-bypass-not-allowed",
          migratedAt: "2026-10-30T00:00:00.000Z",
        },
      ],
      permissionChangePending: { requestedAt: "2026-10-30T00:00:00.000Z" },
    });
    expect(encodeThreadJson(thread)).toMatchObject({
      permissionSource: "override",
      permissionMigrations: [{ migrationId: "perm-v1", migratedAt: "2026-10-30T00:00:00.000Z" }],
      permissionChangePending: { requestedAt: "2026-10-30T00:00:00.000Z" },
    });
  });

  it("treats a scheduled task without a source as override", () => {
    const task = decodeScheduledTask({
      id: "task:1",
      title: "Nightly",
      prompt: "Run the tests",
      enabled: true,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId: "project:legacy",
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    });
    expect(permissionSourceOf(task)).toBe("override");
  });

  it("starts new Claude chats on Claude's settings and other providers on a preset", () => {
    expect(newChatPermissionSourceFor({ driver: "claudeAgent" as never })).toBe("inherit");
    expect(newChatPermissionSourceFor({ driver: "codex" as never })).toBe("override");
    expect(
      newChatPermissionSourceFor({
        driver: "claudeAgent" as never,
        newChatPermissionSource: "override",
      }),
    ).toBe("override");
  });
});

describe("approval option ids", () => {
  it("classes options by lifetime and effect", () => {
    expect(approvalOptionClass({ decision: "accept" })).toBe("once");
    expect(approvalOptionClass({ decision: "acceptForSession" })).toBe("session");
    expect(approvalOptionClass({ decision: "accept", scope: "turn" })).toBe("turn");
    expect(approvalOptionClass({ decision: "acceptAlways" })).toBe("persistent");
    // A persisted deny (a Codex network rule) is still a persistent change.
    expect(approvalOptionClass({ decision: "decline", scope: "persistent", effect: "deny" })).toBe(
      "persistent",
    );
    expect(approvalOptionClass({ decision: "decline" })).toBe("deny");
    expect(approvalOptionClass({ decision: "cancel" })).toBe("deny-stop");
  });

  it("numbers options per class and never keeps an id that claims a narrower class", () => {
    const options = withApprovalOptionIds([
      { decision: "accept", label: "Allow once" },
      { decision: "acceptAlways", label: "Always allow", optionId: "once:7" },
      { decision: "accept", label: "Allow for this turn", scope: "turn" },
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Deny and stop" },
    ]);
    expect(options.map((option) => option.optionId)).toEqual([
      "once:0",
      "persistent:0",
      "turn:0",
      "deny:0",
      "deny-stop:0",
    ]);
  });

  it("rejects malformed ids", () => {
    expect(approvalOptionIdClass("persistent:0")).toBe("persistent");
    expect(approvalOptionIdClass("always:0")).toBeUndefined();
    expect(() => decodeOptionId("session:01")).toThrow();
  });

  it("accepts option id and feedback on respond, and keeps old decision-only answers", () => {
    const decode = decodeCommand;
    expect(
      decode({
        type: "runtime-request.respond",
        commandId: "command:1",
        threadId: "thread:1",
        requestId: "request:1",
        optionId: "deny:0",
        feedback: "Use the test database instead.",
      }),
    ).toMatchObject({ optionId: "deny:0", feedback: "Use the test database instead." });
    expect(() =>
      decode({
        type: "runtime-request.respond",
        commandId: "command:1",
        threadId: "thread:1",
        requestId: "request:1",
        optionId: "deny:0",
        feedback: "x".repeat(2_001),
      }),
    ).toThrow();
  });
});

describe("delivery state", () => {
  it("leaves requests answered before delivery tracking without a delivery", () => {
    const request = decodeRequestJson({
      id: "request:1",
      nodeId: "node:1",
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "resolved",
      responseCapability: { type: "message" },
      createdAt: "2026-10-01T00:00:00.000Z",
      resolvedAt: "2026-10-01T00:00:01.000Z",
      decision: "accept",
    });
    expect(request.delivery).toBeUndefined();
  });

  it("round-trips delivery, the chosen option and a delivery-failed loss", () => {
    const encoded = {
      id: "request:1",
      nodeId: "node:1",
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "resolved",
      responseCapability: { type: "message" },
      createdAt: "2026-10-01T00:00:00.000Z",
      resolvedAt: "2026-10-01T00:00:01.000Z",
      decision: "acceptForSession",
      chosen: {
        optionId: "session:0",
        decision: "acceptForSession",
        scope: "session",
        effect: "allow",
        nativePayload: [{ type: "addDirectories", directories: ["/tmp"], destination: "session" }],
      },
      delivery: { state: "uncertain", attempts: 5, updatedAt: "2026-10-01T00:00:02.000Z" },
      lost: { cause: "delivery_failed", lostAt: "2026-10-01T00:00:02.000Z" },
    };
    const decoded = decodeRequestJson(encoded);
    expect(encodeRequestJson(decoded)).toEqual(encoded);
  });
});

describe("settings-write for permission changes", () => {
  it("needs settings-write for persistent answers and anything above the narrowest preset", () => {
    expect(
      dispatchNeedsSettingsWrite({ type: "runtime-request.respond", optionId: "persistent:0" }),
    ).toBe(true);
    expect(
      dispatchNeedsSettingsWrite({ type: "runtime-request.respond", optionId: "session:0" }),
    ).toBe(false);
    expect(
      dispatchNeedsSettingsWrite({ type: "runtime-request.respond", decision: "acceptAlways" }),
    ).toBe(true);
    expect(
      dispatchNeedsSettingsWrite({
        type: "thread.permission.set",
        permissionSource: "override",
        runtimeMode: "approval-required",
      }),
    ).toBe(false);
    expect(
      dispatchNeedsSettingsWrite({
        type: "thread.permission.set",
        permissionSource: "inherit",
        runtimeMode: "approval-required",
      }),
    ).toBe(true);
    expect(
      dispatchNeedsSettingsWrite({
        type: "thread.permission.set",
        permissionSource: "override",
        runtimeMode: "auto",
      }),
    ).toBe(true);
    expect(
      dispatchNeedsSettingsWrite({ type: "thread.runtime-mode.set", runtimeMode: "full-access" }),
    ).toBe(true);
    expect(
      dispatchNeedsSettingsWrite({
        type: "thread.runtime-mode.set",
        runtimeMode: "approval-required",
      }),
    ).toBe(false);
  });
});
