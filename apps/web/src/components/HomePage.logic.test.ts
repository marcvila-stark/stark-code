import type { EnvironmentProject } from "@starkfuture/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@starkfuture/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ComposerThreadDraftState, DraftThreadState } from "../composerDraftStore";
import { makeThreadFixture } from "../test-fixtures";
import { selectHomeContent } from "./HomePage.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("work");
const time = (day: number) => `2026-10-${day}T10:00:00.000Z`;
function project(environmentId = local): EnvironmentProject {
  return {
    id: projectId,
    environmentId,
    title: "work",
    workspaceRoot: "/work",
    defaultModelSelection: null,
    scripts: [],
    createdAt: time(20),
    updatedAt: time(20),
  };
}
function thread(id: string, day: number, environmentId = local) {
  return makeThreadFixture({
    id: ThreadId.make(id),
    projectId,
    environmentId,
    title: id,
    updatedAt: time(day),
    visibleItemCount: 2,
  });
}
function session(day = 25): DraftThreadState {
  return {
    environmentId: local,
    projectId,
    threadId: ThreadId.make("draft-thread"),
    logicalProjectKey: "work",
    createdAt: time(day),
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
  };
}
function composer(prompt = ""): ComposerThreadDraftState {
  return {
    prompt,
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
  };
}

describe("Home saved work", () => {
  it("groups side chats under the live parent and sorts by their latest activity", () => {
    const parent = thread("parent", 20);
    const child = {
      ...thread("child", 26),
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        relationshipToParent: "side_chat" as const,
      },
    };
    const result = selectHomeContent({
      projects: [project()],
      threads: [parent, child, thread("other", 24)],
      draftSessions: {},
      composers: {},
    });
    expect(result.conversations.map((row) => row.kind === "thread" && row.thread.id)).toEqual([
      "parent",
      "other",
    ]);
    expect(result.conversations[0]).toMatchObject({ sideChats: [child], updatedAt: time(26) });
  });

  it("retains an orphan side chat but excludes archived, deleted and subagent chats", () => {
    const archived = { ...thread("archived-parent", 23), archivedAt: time(24) };
    const orphan = {
      ...thread("orphan", 25),
      lineage: {
        rootThreadId: archived.id,
        parentThreadId: archived.id,
        relationshipToParent: "side_chat" as const,
      },
    };
    const subagent = {
      ...thread("subagent", 26),
      lineage: {
        rootThreadId: orphan.id,
        parentThreadId: orphan.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const result = selectHomeContent({
      projects: [project()],
      threads: [archived, orphan, subagent, { ...thread("deleted", 27), deletedAt: time(27) }],
      draftSessions: {},
      composers: {},
    });
    expect(result.conversations.map((row) => row.kind === "thread" && row.thread.id)).toEqual([
      "orphan",
    ]);
  });

  it("does not merge matching IDs from different machines", () => {
    const localParent = thread("parent", 23);
    const remoteChild = {
      ...thread("child", 26, remote),
      lineage: {
        rootThreadId: localParent.id,
        parentThreadId: localParent.id,
        relationshipToParent: "side_chat" as const,
      },
    };
    const result = selectHomeContent({
      projects: [project(), project(remote)],
      threads: [localParent, remoteChild],
      draftSessions: {},
      composers: {},
    });
    expect(result.conversations).toHaveLength(2);
    expect(result.folders[0]?.project.environmentId).toBe(remote);
    expect(result.folders[1]?.latestConversation).toMatchObject({ thread: localParent });
  });

  it("mixes invested drafts with chats without promoting or changing their contents", () => {
    const prompt = "$plain-english Explain this\nKeep the exact draft";
    const saved = Object.freeze(composer(prompt));
    const sent = thread("sent", 24);
    const result = selectHomeContent({
      projects: [project()],
      threads: [sent],
      draftSessions: {
        saved: session(25),
        empty: session(27),
        promoted: {
          ...session(26),
          promotedTo: scopeThreadRef(local, sent.id),
        },
      },
      composers: { saved, empty: composer(), promoted: composer("already sent") },
    });
    expect(result.conversations.map((row) => row.kind)).toEqual(["draft", "thread"]);
    expect(result.conversations[0]).toMatchObject({ draftId: "saved", composer: saved });
    expect(saved.prompt).toBe(prompt);
  });

  it("labels an unsent follow-up once on its saved chat and hides scratch folders", () => {
    const sent = thread("sent", 24);
    const key = scopedThreadKey(scopeThreadRef(local, sent.id));
    const result = selectHomeContent({
      projects: [{ ...project(), isScratch: true }],
      threads: [sent],
      draftSessions: {},
      composers: { [key]: composer("unsent follow-up") },
    });
    expect(result.folders).toEqual([]);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]).toMatchObject({ kind: "thread", hasDraft: true });
  });
});
