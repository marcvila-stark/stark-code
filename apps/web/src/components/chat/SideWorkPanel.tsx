import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import type { EnvironmentThreadShell } from "@starkfuture/client-runtime/state/models";
import { threadRuntimeIsActive } from "@starkfuture/client-runtime/state/models";
import { derivePendingThreadRequests } from "@starkfuture/client-runtime/state/thread-requests";
import { deriveThreadWorkers } from "@starkfuture/client-runtime/state/thread-workers";
import type { ApprovalResponseInput } from "@starkfuture/client-runtime/approvals/permission-presentation";
import {
  canAnswerRuntimeRequest,
  isSendingRuntimeResponse,
} from "@starkfuture/client-runtime/state/runtime-request-response";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@starkfuture/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type AssistantCitation,
  type CommandId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@starkfuture/contracts";
import { htmlRenderFromToolItem } from "@starkfuture/shared/toolOutput";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  CheckIcon,
  HistoryIcon,
  MessageCircleIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { newMessageId, newThreadId } from "../../lib/utils";
import { derivePendingApprovals } from "../../session-logic";
import {
  useServerConfigs,
  useAllEnvironmentShellsBootstrapped,
  useThreadProjection,
  useThreadShell,
  useThreadShells,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import {
  runtimeRequestCardState,
  toastRuntimeResponseFailure,
  useRuntimeResponseAttempts,
} from "../../runtimeRequestResponse";
import { useRightPanelStore } from "../../rightPanelStore";
import { useSideChatStore } from "../../sideChatStore";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import ChatMarkdown from "../ChatMarkdown";
import { resolveChatDisplayTitle } from "../composerDraftTitle";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { RuntimeRequestResponseNotice } from "./RuntimeRequestResponseNotice";
import { WorkersPanel } from "./WorkersPanel";
import { sideChatTranscript } from "./sideChatTranscript";
import {
  readSideWorkRecords,
  parseSideQuestionPrompt,
  forgetLegacySideWorkRecord,
  sideWorkContext,
  sideWorkPrompt,
  sideWorkStatus,
  sideWorkTurn,
  type SideWorkRecord,
} from "./sideWork.logic";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

function SideWorkButton(props: { open: boolean; onToggle: () => void }) {
  return (
    <Button variant="ghost" size="sm" aria-pressed={props.open} onClick={props.onToggle}>
      <MessageCircleIcon aria-hidden />
      Side chat
    </Button>
  );
}

/** Mounted with the parent's scoped key: navigation cannot accidentally reuse another chat's context. */
export function SideWorkPanel(props: {
  parent: EnvironmentThreadShell;
  projection: OrchestrationV2ThreadProjection | null;
  workspaceRoot: string;
  nativeShellMode: boolean;
  onOpenThread: (threadId: ThreadId) => void;
  onClose: () => void;
  onBringBack?: (text: string, source: string) => boolean;
  showHeader?: boolean;
  active?: boolean;
  onCiteAssistantText?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
}) {
  const { parent } = props;
  const parentRef = useMemo(
    () => scopeThreadRef(parent.environmentId, parent.id),
    [parent.environmentId, parent.id],
  );
  const parentKey = scopedThreadKey(parentRef);
  const storageKey = `stark-code:side-work:${parentKey}`;
  const [legacyRecords, setLegacyRecords] = useState(() => {
    try {
      return readSideWorkRecords(localStorage.getItem(storageKey));
    } catch {
      return [];
    }
  });
  const threads = useThreadShells();
  const shellsReady = useAllEnvironmentShellsBootstrapped();
  const serverConfig = useServerConfigs().get(parent.environmentId);
  const supportsSideChats = serverConfig?.environment.capabilities.threadSideChats === true;
  const titleFor = (title: string, shell?: EnvironmentThreadShell) =>
    resolveChatDisplayTitle({
      title: title.replace(/^Side question: /, ""),
      environmentId: parent.environmentId,
      providers: serverConfig?.providers ?? [],
      providerInstanceId: shell?.runtime?.providerInstanceId ?? shell?.modelSelection.instanceId,
      cwd: shell?.worktreePath ?? shell?.localSession?.cwd ?? props.workspaceRoot,
      fallback: "Side chat",
    });
  const parentTitle = titleFor(parent.title, parent);
  const recordTitle = (record: SideWorkRecord) =>
    titleFor(
      record.title,
      threads.find(
        (thread) => thread.environmentId === parent.environmentId && thread.id === record.threadId,
      ),
    );
  const [pendingRecord, setPendingRecord] = useState<SideWorkRecord | null>(null);
  useEffect(() => {
    const canonical = new Set(
      threads
        .filter(
          (thread) =>
            thread.environmentId === parent.environmentId &&
            (thread.lineage.relationshipToParent !== null || thread.archivedAt),
        )
        .map((thread) => thread.id),
    );
    setLegacyRecords((current) => {
      const remaining = current.filter(
        (record) => record.kind !== "question" || !canonical.has(record.threadId),
      );
      return remaining.length === current.length ? current : remaining;
    });
    setPendingRecord((current) => (current && canonical.has(current.threadId) ? null : current));
  }, [threads, parent.environmentId]);
  const records = useMemo(() => {
    const byId = new Map(legacyRecords.map((record) => [record.threadId, record]));
    if (pendingRecord) byId.set(pendingRecord.threadId, pendingRecord);
    for (const thread of threads) {
      if (thread.environmentId !== parent.environmentId) continue;
      if (
        thread.lineage.relationshipToParent === "side_chat" &&
        thread.lineage.parentThreadId === parent.id &&
        !thread.archivedAt
      ) {
        byId.set(thread.id, { threadId: thread.id, kind: "question", title: thread.title });
      } else if (
        byId.get(thread.id)?.kind === "question" &&
        thread.lineage.relationshipToParent !== null
      ) {
        byId.delete(thread.id);
      }
    }
    return [...byId.values()];
  }, [legacyRecords, pendingRecord, threads, parent.environmentId, parent.id]);
  const selectedId = useSideChatStore((state) => state.selectedByParent[parentKey]);
  const selected = records.find((record) => record.threadId === selectedId) ?? null;
  const draftKey = selected
    ? scopedThreadKey(scopeThreadRef(parent.environmentId, selected.threadId))
    : `${parentKey}:new`;
  const request = useSideChatStore((state) => state.draftsByChat[draftKey] ?? "");
  const setRequest = (value: string) => useSideChatStore.getState().setDraft(draftKey, value);
  const [replyViewport, setReplyViewport] = useState<HTMLDivElement | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScroll = useRef<{ key: string; top: number } | null>(null);
  useEffect(
    () => () => {
      if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
      scrollTimer.current = null;
      if (pendingScroll.current)
        useSideChatStore.getState().setScroll(pendingScroll.current.key, pendingScroll.current.top);
      pendingScroll.current = null;
    },
    [draftKey],
  );
  const [broughtBackId, setBroughtBackId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const canOperate = useEnvironmentScope(parent.environmentId, AuthOrchestrationOperateScope);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const [responding, setResponding] = useState(false);
  const selectedRef = useMemo(
    () => (selected ? scopeThreadRef(parent.environmentId, selected.threadId) : null),
    [parent.environmentId, selected],
  );
  const selectedShell = useThreadShell(selectedRef);
  const selectedProjection = useThreadProjection(selectedRef)?.projection ?? null;
  const isRunning = threadRuntimeIsActive(selectedShell?.runtime);
  const workspaceWait = isRunning
    ? selectedProjection?.turnItems.findLast(
        (item) =>
          item.type === "notification" &&
          item.toolNonExecutionKind === "workspace_wait" &&
          item.status === "waiting" &&
          selectedProjection.runs.some(
            (run) =>
              run.id === item.runId && (run.status === "starting" || run.status === "running"),
          ),
      )
    : undefined;
  const questionRecords = records.filter((record) => record.kind === "question").toReversed();
  const formattingRecords = records.filter((record) => record.kind === "format").toReversed();
  const approval = selectedProjection
    ? derivePendingApprovals(derivePendingThreadRequests(selectedProjection).approvals)[0]
    : undefined;
  // The side chat's approval answers only over a live connection and a synchronized chat.
  const selectedThreadStatus = useThreadStatus(selectedRef);
  const environmentConnectionPhase =
    useEnvironment(parent.environmentId)?.connection.phase ?? "available";
  const runtimeResponseAttempts = useRuntimeResponseAttempts(parent.environmentId);
  const approvalResponseState = runtimeRequestCardState({
    request: approval ?? null,
    attempts: runtimeResponseAttempts,
    connectionPhase: environmentConnectionPhase,
    threadStatus: selectedThreadStatus,
    canOperate,
    responding,
  });
  // A failed answer is explained by the side chat as it is when the failure arrives.
  const selectedRequestTruthRef = useRef({
    threadStatus: selectedThreadStatus,
    runtimeRequests: selectedProjection?.runtimeRequests ?? null,
  });
  useEffect(() => {
    selectedRequestTruthRef.current = {
      threadStatus: selectedThreadStatus,
      runtimeRequests: selectedProjection?.runtimeRequests ?? null,
    };
  }, [selectedProjection?.runtimeRequests, selectedThreadStatus]);

  async function answerApproval(
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    response?: ApprovalResponseInput,
    commandId?: CommandId,
  ) {
    if (!selected) return;
    setResponding(true);
    try {
      const result = await respondToApproval({
        environmentId: parent.environmentId,
        input: {
          threadId: selected.threadId,
          requestId,
          decision,
          ...response,
          ...(commandId === undefined ? {} : { commandId }),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastRuntimeResponseFailure({
          ...selectedRequestTruthRef.current,
          requestId,
          kind: "approval",
          error: squashAtomCommandFailure(result),
        });
      }
    } finally {
      setResponding(false);
    }
  }

  // The chat's delegated workers share this panel with its side chats.
  const [view, setView] = useState<"chat" | "workers">("chat");
  const hasWorkers =
    props.projection !== null &&
    deriveThreadWorkers({ projection: props.projection, shells: [] }).length > 0;
  // Another surface, such as Lineage's Workers link, can ask for a view.
  const pendingTab = useRightPanelStore((state) => state.pendingSideWorkTab);
  useEffect(() => {
    if (pendingTab === null) return;
    const requested = useRightPanelStore.getState().consumeSideWorkTabRequest(parentRef);
    if (requested === null) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Adopts a view another surface requested through the panel store.
    setView(requested);
    setError(null);
  }, [parentRef, pendingTab]);
  const htmlRenders =
    selectedProjection?.turnItems.flatMap((item) => {
      if (item.type !== "dynamic_tool" || item.status !== "completed") return [];
      const render = htmlRenderFromToolItem(item);
      return render ? [render] : [];
    }) ?? [];

  useEffect(() => {
    if (
      (selectedId === undefined || (shellsReady && selectedId !== null && !selected)) &&
      questionRecords.length > 0
    ) {
      useSideChatStore.getState().select(parentRef, questionRecords[0]!.threadId);
    }
  }, [selectedId, questionRecords, parentRef, shellsReady, selected]);

  // Restore only when a conversation is opened/loaded, never while reading a stream.
  const transcript = useMemo(() => sideChatTranscript(selectedProjection), [selectedProjection]);
  const hasMessages = transcript.length > 0;
  useLayoutEffect(() => {
    if (!replyViewport || !hasMessages || props.active === false) return;
    replyViewport.scrollTop =
      useSideChatStore.getState().scrollByChat[draftKey] ?? replyViewport.scrollHeight;
  }, [replyViewport, draftKey, hasMessages, props.active]);

  function selectChat(next: SideWorkRecord | null) {
    useSideChatStore.getState().select(parentRef, next?.threadId ?? null);
    setBroughtBackId(null);
    setError(null);
  }

  async function makeIndependent() {
    if (
      !selected ||
      !canOperate ||
      busy ||
      !supportsSideChats ||
      selectedShell?.lineage.relationshipToParent !== "side_chat"
    )
      return;
    if (request.trim()) {
      setError("Send or clear this side-chat draft before making the chat independent.");
      return;
    }
    if (!forgetLegacySideWorkRecord(localStorage, storageKey, selected.threadId)) {
      setError("Could not update the saved link. Keep this side chat open and try again.");
      return;
    }
    setBusy(true);
    const result = await updateMetadata({
      environmentId: parent.environmentId,
      input: { threadId: selected.threadId, sideChatParentThreadId: null },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    useSideChatStore.getState().select(parentRef, null);
    props.onOpenThread(selected.threadId);
  }

  async function send() {
    if (sending.current || !canOperate || isRunning) return;
    if (!selected && (!supportsSideChats || parent.lineage.relationshipToParent === "side_chat")) {
      setError(
        supportsSideChats
          ? "Open the main chat to start another side chat."
          : "Update this connection's server to save side chats.",
      );
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const kind = selected?.kind ?? "question";
      const prompt = selected
        ? request.trim()
        : sideWorkPrompt({
            kind,
            request,
            context: props.nativeShellMode ? [] : sideWorkContext(props.projection?.messages ?? []),
            response: "",
          });
      if (!prompt) throw new Error("Write a follow-up first.");
      const threadId = selected?.threadId ?? newThreadId();
      const title =
        selected?.title ??
        (kind === "question"
          ? request.trim().slice(0, 90)
          : `Visual response: ${parent.title.trim().slice(0, 90)}`);
      const result = await startTurn({
        environmentId: parent.environmentId,
        input: sideWorkTurn({
          parent: selectedShell ?? parent,
          threadId,
          messageId: newMessageId(),
          title,
          kind,
          prompt,
          createdAt: new Date().toISOString(),
          firstTurn: selected === null,
        }),
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        throw cause instanceof Error ? cause : new Error("Could not start the side chat.");
      }
      useSideChatStore.getState().setDraft(draftKey, "");
      setPendingRecord({ threadId, kind, title });
      useSideChatStore.getState().select(parentRef, threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the side chat.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <aside
      aria-label="Side chat content"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
    >
      {props.showHeader !== false ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">Side chat</h2>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close side chat"
            onClick={props.onClose}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ) : null}
      {hasWorkers || view === "workers" ? (
        <div
          className="flex shrink-0 gap-1 border-b border-border/50 px-3 py-2"
          aria-label="Side panel views"
        >
          {(
            [
              ["chat", "Side chat"],
              ["workers", "Workers"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={view === value ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={view === value}
              onClick={() => {
                setView(value);
                setError(null);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : null}
      {view === "workers" ? (
        <WorkersPanel
          parent={parent}
          projection={props.projection}
          canOperate={canOperate}
          onOpenThread={props.onOpenThread}
        />
      ) : (
        <>
          {records.length > 0 ? (
            <div className="flex min-w-0 shrink-0 items-start justify-between gap-2 border-b border-border/50 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium">
                  {selected ? recordTitle(selected) : "New side chat"}
                </p>
                <Tooltip>
                  <TooltipTrigger render={<p className="truncate text-xs text-muted-foreground" />}>
                    In {parentTitle}
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">{parentTitle}</TooltipPopup>
                </Tooltip>
              </div>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label="Side chat history"
                      disabled={busy}
                    />
                  }
                >
                  <HistoryIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end" aria-label="Side chat history">
                  <MenuItem onClick={() => selectChat(null)}>
                    <PlusIcon aria-hidden /> New side chat
                  </MenuItem>
                  {questionRecords.length > 0 ? (
                    <>
                      <MenuSeparator />
                      <MenuGroup>
                        <MenuGroupLabel>Recent side chats</MenuGroupLabel>
                        {questionRecords.map((record) => (
                          <MenuItem key={record.threadId} onClick={() => selectChat(record)}>
                            <MessageCircleIcon aria-hidden />
                            <span className="max-w-64 truncate">{recordTitle(record)}</span>
                            {selected?.threadId === record.threadId ? (
                              <CheckIcon aria-hidden />
                            ) : null}
                          </MenuItem>
                        ))}
                      </MenuGroup>
                    </>
                  ) : null}
                  {selected &&
                  canOperate &&
                  supportsSideChats &&
                  selectedShell?.lineage.relationshipToParent === "side_chat" ? (
                    <>
                      <MenuSeparator />
                      <MenuItem onClick={() => void makeIndependent()}>
                        <ArrowUpRightIcon aria-hidden /> Make independent chat
                      </MenuItem>
                    </>
                  ) : null}
                  {formattingRecords.length > 0 ? (
                    <>
                      <MenuSeparator />
                      <MenuGroup>
                        <MenuGroupLabel>Earlier formatting chats</MenuGroupLabel>
                        {formattingRecords.map((record) => (
                          <MenuItem
                            key={record.threadId}
                            onClick={() => props.onOpenThread(record.threadId)}
                          >
                            <ArrowUpRightIcon aria-hidden />
                            <span className="max-w-64 truncate">{recordTitle(record)}</span>
                          </MenuItem>
                        ))}
                      </MenuGroup>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
          ) : null}
          <div
            ref={setReplyViewport}
            className="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-5 scrollbar-gutter-both"
            onScroll={(event) => {
              if (!hasMessages || props.active === false) return;
              pendingScroll.current = { key: draftKey, top: event.currentTarget.scrollTop };
              if (scrollTimer.current !== null) return;
              scrollTimer.current = setTimeout(() => {
                scrollTimer.current = null;
                if (pendingScroll.current)
                  useSideChatStore
                    .getState()
                    .setScroll(pendingScroll.current.key, pendingScroll.current.top);
                pendingScroll.current = null;
              }, 150);
            }}
            aria-live="polite"
            data-assistant-citation-viewport="true"
          >
            {props.onCiteAssistantText && selectedRef ? (
              <AssistantSelectionToolbar
                viewport={replyViewport}
                threadRef={selectedRef}
                onCite={props.onCiteAssistantText}
              />
            ) : null}
            {selected === null ? (
              <div className="mx-auto flex min-h-52 max-w-64 flex-col items-center justify-center gap-3 py-8 text-center">
                <MessageCircleIcon aria-hidden className="size-6 text-muted-foreground/65" />
                <h3 className="text-sm font-medium">Explore a side question</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {props.nativeShellMode
                    ? "Paste the context you need. Terminal output is not included automatically."
                    : "Uses a short excerpt of this chat. Your main conversation stays here."}
                </p>
              </div>
            ) : null}
            {transcript.map((message, index) => {
              if (message.role === "user") {
                const isFirstUser = !transcript
                  .slice(0, index)
                  .some((entry) => entry.role === "user");
                const initialQuestion = isFirstUser ? parseSideQuestionPrompt(message.text) : null;
                const question = initialQuestion?.question ?? message.text;
                return (
                  <div key={message.id} className="ml-6 space-y-2">
                    <p className="rounded-2xl bg-muted/60 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
                      {question}
                    </p>
                    {initialQuestion ? (
                      <details className="px-1 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Shared context</summary>
                        <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                          {initialQuestion.sharedContext}
                        </p>
                      </details>
                    ) : null}
                  </div>
                );
              }
              return (
                <div
                  key={message.id}
                  data-assistant-citation-source={
                    message.role === "assistant" && !message.streaming
                      ? message.citationMessageId
                      : undefined
                  }
                  data-assistant-citation-environment={selectedRef?.environmentId}
                  data-assistant-citation-thread={selectedRef?.threadId}
                >
                  {message.isPlan ? (
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Proposed plan</p>
                  ) : null}
                  <ChatMarkdown
                    reader
                    text={message.text}
                    cwd={
                      selectedShell?.worktreePath ??
                      selectedShell?.localSession?.cwd ??
                      props.workspaceRoot
                    }
                    threadRef={selectedRef ?? undefined}
                    isStreaming={message.streaming}
                  />
                  {props.onBringBack &&
                  message.role === "assistant" &&
                  message.canBringBack &&
                  message.text.trim() ? (
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        variant="ghost-muted"
                        size="sm"
                        onClick={() => {
                          if (message.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) {
                            setError(
                              "This answer is too long to quote at once. Select the part you want and choose Quote in chat.",
                            );
                            return;
                          }
                          if (
                            props.onBringBack?.(
                              message.text,
                              `Side chat · ${selected ? recordTitle(selected) : "Discussion"}`,
                            )
                          ) {
                            setBroughtBackId(message.id);
                            setError(null);
                          }
                        }}
                      >
                        <ArrowLeftIcon aria-hidden /> Bring back to main chat
                      </Button>
                      {broughtBackId === message.id ? (
                        <span role="status" className="text-xs text-muted-foreground">
                          Added to draft
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {htmlRenders.map((render) => (
              <HtmlRenderFrame
                key={render.attachmentId}
                environmentId={parent.environmentId}
                htmlRender={render}
                threadRef={selectedRef ?? undefined}
              />
            ))}
            {selectedShell?.runtime?.lastError ? (
              <p role="alert" className="text-sm text-destructive">
                {selectedShell.runtime.lastError}
              </p>
            ) : null}
            {selectedShell?.hasPendingUserInput ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => selected && props.onOpenThread(selected.threadId)}
              >
                Answer the agent in its chat
              </Button>
            ) : null}
          </div>
          {approval ? (
            <div className="space-y-3 border-t border-border p-3">
              <ComposerPendingApprovalPanel
                approval={approval}
                pendingCount={1}
                scope={approval.scope}
              />
              {approvalResponseState ? (
                <RuntimeRequestResponseNotice
                  state={approvalResponseState}
                  onRetry={() => {
                    // Sends the unconfirmed answer again under its original command.
                    const attempt = runtimeResponseAttempts.get(approval.requestId);
                    if (attempt?.kind === "approval" && attempt.phase === "unconfirmed") {
                      void answerApproval(
                        approval.requestId,
                        attempt.input.decision,
                        {
                          ...(attempt.input.optionId === undefined
                            ? {}
                            : { optionId: attempt.input.optionId }),
                          ...(attempt.input.feedback === undefined
                            ? {}
                            : { feedback: attempt.input.feedback }),
                        },
                        attempt.commandId,
                      );
                    }
                  }}
                />
              ) : null}
              <ComposerPendingApprovalActions
                requestId={approval.requestId}
                options={approval.options}
                defaultToNo={approval.scope?.defaultToNo}
                isResponding={
                  approvalResponseState !== null && isSendingRuntimeResponse(approvalResponseState)
                }
                canRespond={
                  canOperate &&
                  approval.responseCapability !== "not_resumable" &&
                  approvalResponseState !== null &&
                  canAnswerRuntimeRequest(approvalResponseState)
                }
                onRespondToApproval={(requestId, decision, response) =>
                  answerApproval(requestId, decision, response)
                }
              />
            </div>
          ) : null}
          <form
            className="shrink-0 space-y-2 p-3 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {!selected && !supportsSideChats ? (
              <p className="text-xs text-muted-foreground">
                Update this connection’s server to save side chats.
              </p>
            ) : null}
            <Textarea
              aria-label={selected ? "Side chat follow-up" : "Side question"}
              placeholder={selected ? "Follow up…" : "Ask a side question…"}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              disabled={!canOperate || busy}
            />
            {workspaceWait?.type === "notification" ? (
              <p role="status" className="text-xs text-muted-foreground">
                {workspaceWait.summary}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  {workspaceWait
                    ? "Waiting for folder"
                    : isRunning
                      ? "Thinking…"
                      : selectedShell?.hasPendingApprovals || selectedShell?.hasPendingUserInput
                        ? sideWorkStatus(selectedShell)
                        : "Plan · Manual"}
                </span>
                {selected ? (
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label="Open side chat in main view"
                    onClick={() => props.onOpenThread(selected.threadId)}
                  >
                    <ArrowUpRightIcon aria-hidden />
                  </Button>
                ) : null}
              </div>
              {isRunning ? (
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label="Stop side chat"
                  disabled={!canOperate}
                  onClick={() => {
                    if (!selected) return;
                    void interruptTurn({
                      environmentId: parent.environmentId,
                      input: { threadId: selected.threadId },
                    }).then((result) => {
                      if (result._tag === "Failure")
                        setError(String(squashAtomCommandFailure(result)));
                    });
                  }}
                >
                  <SquareIcon aria-hidden />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon-sm"
                  aria-label={selected ? "Send follow-up" : "Ask in side chat"}
                  disabled={
                    !canOperate || busy || !request.trim() || (!selected && !supportsSideChats)
                  }
                >
                  <ArrowUpIcon aria-hidden />
                </Button>
              )}
            </div>
          </form>
        </>
      )}
      {error ? (
        <p role="alert" className="shrink-0 px-4 pb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
