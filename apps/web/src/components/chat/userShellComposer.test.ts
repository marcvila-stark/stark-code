import { describe, expect, it, vi } from "vite-plus/test";
import { CommandId, MessageId, ThreadId } from "@starkfuture/contracts";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import {
  buildUserShellCommandDispatch,
  enterUserShellFromHumanInput,
  userShellCommandAvailability,
  readProjectShellHistory,
  rememberProjectShellCommand,
} from "./userShellComposer";

const empty = (): ComposerThreadDraftState => ({
  prompt: "",
  images: [],
  files: [],
  persistedAttachments: [],
  nonPersistedImageIds: [],
  terminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
  threadContexts: [],
  modelSelectionByProvider: {},
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});
const entry = (text: string, draft = empty(), available = true) =>
  enterUserShellFromHumanInput({ text, draft, available, shellMode: false });

describe("human ! entry", () => {
  it("consumes the first typed ! and keeps pasted command text without sending", () => {
    expect(entry("!")).toBe("");
    expect(entry("!ls -la")).toBe("ls -la");
    expect(entry("!echo first\necho second")).toBe("echo first\necho second");
    expect(entry("!pwd", { ...empty(), prompt: "earlier text" })).toBeNull();
    expect(entry("!pwd", empty(), false)).toBeNull();
    expect(entry("ordinary ! text")).toBeNull();
  });
  it.each([
    "images",
    "files",
    "persistedAttachments",
    "terminalContexts",
    "previewAnnotations",
    "reviewComments",
    "threadContexts",
  ] as const)("keeps ! as text when %s context is present", (key) => {
    expect(entry("!pwd", { ...empty(), [key]: [{}] } as ComposerThreadDraftState)).toBeNull();
  });
  it("requires every capability, scope, supported provider and a single model", () => {
    const base = {
      canOperateTerminal: true,
      canOperateThread: true,
      capability: true,
      allowed: true,
      provider: "codex",
      multipleModels: false,
    };
    expect(userShellCommandAvailability(base)).toBe(true);
    expect(userShellCommandAvailability({ ...base, provider: "claudeAgent" })).toBe(true);
    for (const key of ["canOperateTerminal", "canOperateThread", "capability", "allowed"] as const)
      expect(userShellCommandAvailability({ ...base, [key]: false })).toBe(false);
    expect(userShellCommandAvailability({ ...base, provider: "cursor" })).toBe(false);
    expect(userShellCommandAvailability({ ...base, multipleModels: true })).toBe(false);
  });
});

describe("user shell send dispatch", () => {
  const base = {
    commandId: CommandId.make("shell-command"),
    messageId: MessageId.make("shell-message"),
    threadId: ThreadId.make("shell-thread"),
    command: "  pwd  ",
    respond: true,
    nativeAgentRunning: false,
  };
  it("starts idle commands, queues running commands and keeps native refusal first", () => {
    expect(buildUserShellCommandDispatch({ ...base, running: false })).toMatchObject({
      type: "thread.shell-command.dispatch",
      command: "pwd",
      createdBy: "user",
      dispatchMode: { type: "start_immediately" },
    });
    expect(buildUserShellCommandDispatch({ ...base, running: true })).toMatchObject({
      dispatchMode: { type: "queue_after_active" },
    });
    expect(() =>
      buildUserShellCommandDispatch({
        ...base,
        running: false,
        nativeAgentRunning: true,
        command: "",
      }),
    ).toThrow("native agent");
    expect(() => buildUserShellCommandDispatch({ ...base, running: false, command: " " })).toThrow(
      "10,000",
    );
    expect(() =>
      buildUserShellCommandDispatch({ ...base, running: false, command: "x".repeat(10_001) }),
    ).toThrow("10,000");
  });
  it("carries the explicit next-send reply choice without steer or restart", () => {
    expect(buildUserShellCommandDispatch({ ...base, running: true, respond: false })).toMatchObject(
      { respond: false, dispatchMode: { type: "queue_after_active" } },
    );
  });
});

it("retains shell-only history across threads in the same project", () => {
  const project = `project-shell-${Date.now()}`;
  rememberProjectShellCommand(project, {
    id: "thread-a-message",
    role: "user",
    text: "pwd",
    userShell: { command: "pwd", respond: false },
    createdAt: "2026-01-01T00:00:00Z",
  });
  rememberProjectShellCommand(project, {
    id: "thread-b-message",
    role: "user",
    text: "ls",
    userShell: { command: "ls", respond: true },
    createdAt: "2026-01-02T00:00:00Z",
  });
  expect(readProjectShellHistory(project).map((message) => message.id)).toEqual([
    "thread-a-message",
    "thread-b-message",
  ]);
  expect(readProjectShellHistory(project + "other")).toEqual([]);
  vi.restoreAllMocks();
});
