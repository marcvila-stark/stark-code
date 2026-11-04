import { scopedThreadKey, scopeThreadRef } from "@starkfuture/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@starkfuture/client-runtime/state/models";
import {
  composerDraftHasUserContent,
  DraftId,
  type ComposerThreadDraftState,
  type DraftThreadState,
} from "../composerDraftStore";
import { groupSidebarSideChats, sortScopedProjectsForSidebar } from "./Sidebar.logic";

export type HomeConversation =
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly thread: EnvironmentThreadShell;
      readonly project: EnvironmentProject | undefined;
      readonly sideChats: readonly EnvironmentThreadShell[];
      readonly hasDraft: boolean;
      readonly updatedAt: string;
    }
  | {
      readonly kind: "draft";
      readonly key: string;
      readonly draftId: DraftId;
      readonly session: DraftThreadState;
      readonly composer: ComposerThreadDraftState;
      readonly project: EnvironmentProject | undefined;
      readonly updatedAt: string;
    };

const projectKey = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;
const threadKey = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;

/** Home reads the saved roster. Merely visiting it never creates a draft. */
export function selectHomeContent(input: {
  readonly projects: readonly EnvironmentProject[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly draftSessions: Readonly<Record<string, DraftThreadState>>;
  readonly composers: Readonly<Record<string, ComposerThreadDraftState>>;
}) {
  const projectsByKey = new Map(
    input.projects.map((project) => [projectKey(project.environmentId, project.id), project]),
  );
  const visible = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.relationshipToParent !== "subagent",
  );
  const { roots, sideChatsByParentKey } = groupSidebarSideChats(visible);
  const conversations: HomeConversation[] = roots.map((thread) => {
    const sideChats = sideChatsByParentKey.get(threadKey(thread)) ?? [];
    return {
      kind: "thread",
      key: threadKey(thread),
      thread,
      project: projectsByKey.get(projectKey(thread.environmentId, thread.projectId)),
      sideChats,
      hasDraft: composerDraftHasUserContent(
        input.composers[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      ),
      updatedAt: sideChats.reduce(
        (latest, child) => (child.updatedAt > latest ? child.updatedAt : latest),
        thread.updatedAt,
      ),
    };
  });
  for (const [key, session] of Object.entries(input.draftSessions)) {
    const composer = input.composers[key];
    if (session.promotedTo != null || !composer || !composerDraftHasUserContent(composer)) continue;
    conversations.push({
      kind: "draft",
      key,
      draftId: DraftId.make(key),
      session,
      composer,
      project: projectsByKey.get(projectKey(session.environmentId, session.projectId)),
      updatedAt: session.createdAt,
    });
  }
  conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const folders = sortScopedProjectsForSidebar(
    input.projects.filter((project) => !project.isScratch),
    visible,
    "updated_at",
  ).map((project) => ({
    project,
    latestConversation: conversations.find((conversation) =>
      conversation.kind === "thread"
        ? conversation.thread.environmentId === project.environmentId &&
          conversation.thread.projectId === project.id
        : conversation.session.environmentId === project.environmentId &&
          conversation.session.projectId === project.id,
    ),
  }));
  return { folders, conversations };
}
