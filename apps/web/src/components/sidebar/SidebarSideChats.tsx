import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import type { EnvironmentThreadShell } from "@starkfuture/client-runtime/state/models";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon, MessageCircleIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useSideChatStore } from "../../sideChatStore";
import { useThreadHasUnsentDraft } from "../../composerDraftStore";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function SideChatDraftLabel({ chat, id }: { chat: EnvironmentThreadShell; id: string }) {
  const hasDraft = useThreadHasUnsentDraft(scopeThreadRef(chat.environmentId, chat.id));
  return hasDraft ? (
    <span id={id} className="shrink-0 text-2xs font-normal text-sidebar-muted-foreground">
      Draft
    </span>
  ) : null;
}

export function SidebarSideChats(props: {
  parent: EnvironmentThreadShell;
  chats: readonly EnvironmentThreadShell[];
  isParentActive: boolean;
  onOpen: (chat: EnvironmentThreadShell) => void;
  onContextMenu: (chat: EnvironmentThreadShell, position: { x: number; y: number }) => void;
  rename?:
    | {
        threadKey: string | null;
        title: string;
        onChange: (title: string) => void;
        onCommit: (chat: EnvironmentThreadShell, title: string) => void;
        onCancel: () => void;
      }
    | undefined;
}) {
  const parentKey = scopedThreadKey(scopeThreadRef(props.parent.environmentId, props.parent.id));
  const [expanded, setExpanded] = useLocalStorage(
    `stark-code:side-chats-expanded:${parentKey}`,
    false,
    Schema.Boolean,
  );
  const selectedId = useSideChatStore((state) => state.selectedByParent[parentKey]);
  const panelOpen = useRightPanelStore(
    (state) => state.auxiliaryPanelByThreadKey[parentKey] === "side-work",
  );
  const listId = useId();
  const renameCommitted = useRef(false);
  useEffect(() => {
    renameCommitted.current = false;
  }, [props.rename?.threadKey]);
  const needsUser = props.chats.some(
    (chat) => chat.hasPendingApprovals || chat.hasPendingUserInput,
  );
  const hasError = props.chats.some((chat) => {
    const status = resolveSidebarThreadStatus(chat);
    return status === "failed" || status === "limited";
  });

  return (
    <li className="mb-1 list-none pl-3" data-thread-selection-safe>
      <Button
        variant="ghost-muted"
        size="micro"
        aria-label={`Side chats for ${props.parent.title}, ${props.chats.length}`}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
        Side chats <span className="tabular-nums">{props.chats.length}</span>
        {needsUser || hasError ? (
          <span
            className="size-1.5 rounded-full bg-warning-foreground"
            role="img"
            aria-label={needsUser ? "Needs you" : "Needs attention"}
          />
        ) : null}
      </Button>
      {expanded ? (
        <ul id={listId} className="mt-0.5 ml-2 border-l border-sidebar-border pl-2">
          {props.chats.map((chat) => {
            const selected = props.isParentActive && panelOpen && selectedId === chat.id;
            const renaming =
              props.rename?.threadKey ===
              scopedThreadKey(scopeThreadRef(chat.environmentId, chat.id));
            const status = resolveSidebarThreadStatus(chat);
            const statusLabel =
              status === "approval" || status === "input"
                ? "Needs you"
                : status === "working"
                  ? "Working"
                  : status === "failed" || status === "limited"
                    ? "Needs attention"
                    : null;
            return (
              <li key={chat.id} className="list-none">
                {renaming && props.rename ? (
                  <Input
                    autoFocus
                    size="compact"
                    aria-label="Side chat title"
                    value={props.rename.title}
                    onChange={(event) => props.rename?.onChange(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        renameCommitted.current = true;
                        props.rename?.onCommit(chat, props.rename.title);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        renameCommitted.current = true;
                        props.rename?.onCancel();
                      }
                    }}
                    onBlur={() => {
                      if (!renameCommitted.current && props.rename) {
                        props.rename.onCommit(chat, props.rename.title);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    aria-label={`Open side chat: ${chat.title}`}
                    aria-describedby={`${listId}-draft-${chat.id}`}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selected
                        ? "bg-sidebar-row-active text-sidebar-foreground"
                        : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    )}
                    onClick={() => props.onOpen(chat)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      props.onContextMenu(chat, { x: event.clientX, y: event.clientY });
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                        return;
                      event.preventDefault();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      props.onContextMenu(chat, { x: bounds.left, y: bounds.bottom });
                    }}
                  >
                    <MessageCircleIcon aria-hidden className="size-3 shrink-0 opacity-60" />
                    <Tooltip>
                      <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                        {chat.title}
                      </TooltipTrigger>
                      <TooltipPopup side="right">
                        {chat.title}
                        {statusLabel ? ` · ${statusLabel}` : ""}
                      </TooltipPopup>
                    </Tooltip>
                    <SideChatDraftLabel chat={chat} id={`${listId}-draft-${chat.id}`} />
                    {statusLabel ? (
                      <span
                        role="status"
                        aria-label={statusLabel}
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          status === "working" ? "bg-current opacity-60" : "bg-warning-foreground",
                        )}
                      />
                    ) : null}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
