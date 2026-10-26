import { FileTextIcon, MessageCircleIcon, XIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export const CONVERSATION_CHAT_TAB_ID = "chat";

export interface ConversationPageTab {
  id: string;
  title: string;
}

export interface ConversationPageTabsProps {
  pages: readonly ConversationPageTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  className?: string;
  panelId?: string;
  onChatActions?: ((position: { x: number; y: number }) => void) | undefined;
  chatTitleEditor?: ReactNode;
}

export function conversationPageTabElementId(panelId: string, tabId: string): string {
  return `${panelId}-tab-${encodeURIComponent(tabId)}`;
}

/** Chat stays in view while explicitly opened pages scroll beside it. */
export function ConversationPageTabs({
  pages,
  activeTabId,
  onSelect,
  onClose,
  className,
  panelId,
  onChatActions,
  chatTitleEditor,
}: ConversationPageTabsProps) {
  const tabs = [
    { id: CONVERSATION_CHAT_TAB_ID, title: "Chat" },
    ...pages.filter((page) => page.id !== CONVERSATION_CHAT_TAB_ID),
  ];
  const selectedId = tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : CONVERSATION_CHAT_TAB_ID;
  const [focusState, setFocusState] = useState({ selectedId, focusedId: selectedId });
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabStopId =
    focusState.selectedId === selectedId && tabs.some((tab) => tab.id === focusState.focusedId)
      ? focusState.focusedId
      : selectedId;

  const focusTab = (id: string) => {
    setFocusState({ selectedId, focusedId: id });
    const tab = tabRefs.current.get(id);
    tab?.focus({ preventScroll: true });
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  const closePage = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index <= 0) return;
    const nextId = tabs[index - 1]!.id;
    focusTab(nextId);
    onClose(id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    let nextIndex: number;
    switch (event.key) {
      case "ContextMenu":
      case "F10": {
        if (
          id !== CONVERSATION_CHAT_TAB_ID ||
          !onChatActions ||
          (event.key === "F10" && !event.shiftKey)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        onChatActions({ x: bounds.left, y: bounds.bottom });
        return;
      }
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        event.stopPropagation();
        onSelect(id);
        return;
      case "Delete":
        if (id !== CONVERSATION_CHAT_TAB_ID) {
          event.preventDefault();
          event.stopPropagation();
          closePage(id);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusTab(tabs[nextIndex]!.id);
  };

  const renderTab = (tab: ConversationPageTab, isChat = false) => {
    const selected = selectedId === tab.id;
    const tabButton = (
      <button
        key={tab.id}
        ref={(element) => {
          if (element) tabRefs.current.set(tab.id, element);
          else tabRefs.current.delete(tab.id);
        }}
        type="button"
        role="tab"
        id={panelId ? conversationPageTabElementId(panelId, tab.id) : undefined}
        aria-controls={panelId}
        aria-selected={selected}
        data-conversation-chat-tab={isChat ? "true" : undefined}
        aria-keyshortcuts={isChat ? undefined : "Delete"}
        tabIndex={tabStopId === tab.id ? 0 : -1}
        className={cn(
          "flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isChat
            ? "stark-conversation-chat-tab shrink-0 font-medium"
            : "max-w-[min(470px,60vw)] border-transparent font-medium",
          !isChat &&
            (selected
              ? "text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"),
        )}
        onFocus={() => setFocusState({ selectedId, focusedId: tab.id })}
        onClick={() => onSelect(tab.id)}
        onContextMenu={
          isChat && onChatActions
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onChatActions({ x: event.clientX, y: event.clientY });
              }
            : undefined
        }
        onKeyDown={(event) => handleKeyDown(event, tab.id)}
      >
        {isChat ? (
          <MessageCircleIcon
            className="size-3.5 shrink-0 text-stark-gold-foreground"
            aria-hidden="true"
          />
        ) : (
          <FileTextIcon className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="truncate">{tab.title || "Untitled page"}</span>
      </button>
    );
    return (
      <Tooltip key={tab.id}>
        <TooltipTrigger render={tabButton} />
        <TooltipPopup>{tab.title || "Untitled page"}</TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <div data-conversation-page-tabs className={cn("min-w-0 flex-1", className)}>
      <div
        role="tablist"
        aria-label="Chat and opened pages"
        className="stark-conversation-tablist flex min-w-0 items-center gap-2"
      >
        {chatTitleEditor ?? renderTab(tabs[0]!, true)}
        <div
          role="presentation"
          className="min-w-0 overflow-x-auto overscroll-x-contain [-webkit-app-region:no-drag]"
        >
          <div role="presentation" className="flex w-max items-center gap-1 py-0.5">
            {tabs.slice(1).map((page) => (
              <div
                key={page.id}
                role="presentation"
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-md pr-1",
                  selectedId === page.id && "bg-accent",
                )}
              >
                {renderTab(page)}
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`Close ${page.title || "Untitled page"}`}
                  tabIndex={-1}
                  onClick={() => closePage(page.id)}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
