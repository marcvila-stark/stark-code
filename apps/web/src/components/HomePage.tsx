import { scopeProjectRef, scopeThreadRef } from "@starkfuture/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { FolderIcon, MessageSquareIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useOpenFolder } from "../hooks/useOpenFolder";
import { useScratchProject } from "../hooks/useScratchProject";
import { openThreadWithSideChat } from "../lib/sideChatNavigation";
import {
  readThreadShells,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { resolveChatDisplayTitle, resolveComposerDraftTitle } from "./composerDraftTitle";
import { type HomeConversation, selectHomeContent } from "./HomePage.logic";
import styles from "./HomePage.module.css";
import { OpenFolderDialog } from "./sidebar/OpenFolderDialog";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function HomePage() {
  const router = useRouter();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const draftSessions = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  const composers = useComposerDraftStore((state) => state.draftsByThreadKey);
  const { folders, conversations } = useMemo(
    () => selectHomeContent({ projects, threads, draftSessions, composers }),
    [projects, threads, draftSessions, composers],
  );
  const { handleNewThread, selectedProjectRef } = useHandleNewThread();
  const openFolder = useOpenFolder();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  function displayTitle(conversation: HomeConversation) {
    const environmentId =
      conversation.kind === "thread"
        ? conversation.thread.environmentId
        : conversation.session.environmentId;
    const providers = serverConfigs.get(environmentId)?.providers ?? [];
    if (conversation.kind === "draft") {
      return resolveComposerDraftTitle({
        composer: conversation.composer,
        environmentId,
        providers,
        cwd: conversation.session.worktreePath ?? conversation.project?.workspaceRoot,
      });
    }
    return resolveChatDisplayTitle({
      title: conversation.thread.title,
      environmentId,
      providerInstanceId: conversation.thread.providerInstanceId,
      providers,
      cwd: conversation.thread.worktreePath ?? conversation.project?.workspaceRoot,
    });
  }

  async function startChat() {
    if (starting) return;
    setStarting(true);
    try {
      const recent = folders[0]?.project;
      const projectRef =
        selectedProjectRef ?? (recent ? scopeProjectRef(recent.environmentId, recent.id) : null);
      if (projectRef) {
        await handleNewThread(projectRef);
      } else {
        const scratchId = scratchEnvironmentId(primaryEnvironmentId);
        if (scratchId) await startScratchThread(scratchId);
        else setFolderDialogOpen(true);
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start chat",
          description: error instanceof Error ? error.message : "Try opening the folder again.",
        }),
      );
    } finally {
      setStarting(false);
    }
  }

  async function resume(conversation: HomeConversation) {
    try {
      if (conversation.kind === "draft") {
        await router.navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(conversation.draftId),
        });
        return;
      }
      const { thread } = conversation;
      // Resolve the parent at click time so an archived or detached side chat
      // remains reachable even if its lineage changed while Home was open.
      await openThreadWithSideChat({
        threadRef: scopeThreadRef(thread.environmentId, thread.id),
        getThread: (id) =>
          readThreadShells().find(
            (candidate) => candidate.environmentId === thread.environmentId && candidate.id === id,
          ),
        navigate: (threadRef) =>
          router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          }),
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open chat",
          description: error instanceof Error ? error.message : "Try opening the chat again.",
        }),
      );
    }
  }

  return (
    <>
      {folderDialogOpen ? <OpenFolderDialog onClose={() => setFolderDialogOpen(false)} /> : null}
      <SidebarInset className="min-h-0 flex-1 overflow-hidden">
        <section className={styles.page} aria-label="Home">
          <div className={styles.content}>
            <header className={styles.heading}>
              <div>
                <h1 className={styles.title}>
                  {conversations.length > 0
                    ? "Pick up where you left off."
                    : "What should we work on?"}
                </h1>
                <p className={styles.subtitle}>
                  {conversations.length > 0
                    ? "Your chats, drafts and folders are right here."
                    : "Open a folder, or start a new chat."}
                </p>
              </div>
              <Button
                onClick={() => void startChat()}
                disabled={!bootstrapped || starting}
                variant="outline"
              >
                <PlusIcon />
                {starting ? "Opening…" : "New chat"}
              </Button>
            </header>
            {!bootstrapped ? (
              <p className={styles.loading} role="status">
                Loading your chats…
              </p>
            ) : (
              <>
                <section className={styles.section} aria-labelledby="home-folders-heading">
                  <h2 className={styles.sectionHeading} id="home-folders-heading">
                    Recent folders
                  </h2>
                  {folders.length > 0 ? (
                    <div className={styles.folderGrid}>
                      {folders.slice(0, 4).map(({ project, latestConversation }) => (
                        <Tooltip key={`${project.environmentId}:${project.id}`}>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                className={styles.folder}
                                onClick={() =>
                                  void openFolder(
                                    scopeProjectRef(project.environmentId, project.id),
                                  )
                                }
                              />
                            }
                          >
                            <FolderIcon aria-hidden="true" />
                            <span className={styles.rowText}>
                              <span className={styles.rowTitle}>{project.title}</span>
                              <span className={styles.rowDetail}>
                                {latestConversation
                                  ? displayTitle(latestConversation)
                                  : project.workspaceRoot}
                              </span>
                            </span>
                          </TooltipTrigger>
                          <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
                        </Tooltip>
                      ))}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={styles.openFolder}
                    onClick={() => setFolderDialogOpen(true)}
                  >
                    <PlusIcon aria-hidden="true" /> Open a folder…
                  </button>
                </section>
                <section className={styles.section} aria-labelledby="home-continue-heading">
                  <h2 className={styles.sectionHeading} id="home-continue-heading">
                    Continue
                  </h2>
                  {conversations.length > 0 ? (
                    <div className={styles.chatList}>
                      {conversations.slice(0, 6).map((conversation) => {
                        const draft = conversation.kind === "draft" || conversation.hasDraft;
                        const attention =
                          conversation.kind === "thread" &&
                          (conversation.thread.hasPendingApprovals ||
                            conversation.thread.hasPendingUserInput);
                        const sideChatCount =
                          conversation.kind === "thread" ? conversation.sideChats.length : 0;
                        return (
                          <button
                            key={conversation.key}
                            type="button"
                            className={styles.chat}
                            onClick={() => void resume(conversation)}
                          >
                            {draft ? (
                              <SquarePenIcon aria-hidden="true" />
                            ) : (
                              <MessageSquareIcon aria-hidden="true" />
                            )}
                            <span className={styles.rowText}>
                              <span className={styles.rowTitle}>{displayTitle(conversation)}</span>
                              <span className={styles.rowDetail}>
                                {conversation.project?.isScratch
                                  ? "No folder"
                                  : (conversation.project?.title ?? "Chat")}
                                {sideChatCount > 0
                                  ? ` · ${sideChatCount} side chat${sideChatCount === 1 ? "" : "s"}`
                                  : ""}
                              </span>
                            </span>
                            {attention ? (
                              <span className={`${styles.badge} ${styles.attention}`}>
                                Needs you
                              </span>
                            ) : draft ? (
                              <span className={styles.badge}>Draft</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className={styles.empty}>
                      Your recent chats and saved drafts will appear here.
                    </p>
                  )}
                </section>
              </>
            )}
          </div>
        </section>
      </SidebarInset>
    </>
  );
}
