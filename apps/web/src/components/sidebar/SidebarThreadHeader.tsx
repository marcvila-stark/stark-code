/** Folder, new chat and search stay visible above one compact chat list. */
import {
  ArchiveIcon,
  FolderPlusIcon,
  ImportIcon,
  MoreHorizontalIcon,
  SearchIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SidebarMenuButton } from "../ui/sidebar";
import { SidebarNavigationButton } from "./SidebarNavigationButton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export interface SidebarThreadHeaderProps {
  /** Lands on the search field so a popup can anchor to its width. */
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  /** Without projects there is nothing to scope, so those controls stay out. */
  hasProjects: boolean;
  /** The folder picker occupies its own labelled row. */
  projectScope: ReactNode;
  needsYou?: ReactNode;
  /** Sits between search and the chat list. */
  scheduledTasks?: ReactNode;
  onNewProject: () => void;
  groupByStatus: boolean;
  onGroupByStatusChange: (grouped: boolean) => void;
  onOpenArchive: () => void;
  onImportLocalChats?: () => void;
  /** Receives the click so Shift+click can skip the project picker. */
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  /** Shift+click only matters once there is more than one project to pick. */
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  searchFieldRef,
  hasProjects,
  projectScope,
  needsYou,
  scheduledTasks,
  onNewProject,
  groupByStatus,
  onGroupByStatusChange,
  onOpenArchive,
  onImportLocalChats,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New chat (${newThreadShortcutLabel})`
    : "New chat";

  return (
    <div className="stark-sidebar-nav">
      <div className="stark-sidebar-workspace">
        {hasProjects ? (
          projectScope
        ) : (
          <SidebarNavigationButton data-workspace onClick={onNewProject}>
            <FolderPlusIcon />
            <span>Open folder</span>
          </SidebarNavigationButton>
        )}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarNavigationButton
              aria-label="New chat"
              disabled={newThreadDisabled}
              onClick={onNewThread}
            />
          }
        >
          <PlusIcon />
          <span>New chat</span>
        </TooltipTrigger>
        <TooltipPopup side="right">
          <span className="flex flex-col gap-0.5">
            <span>{newThreadLabel}</span>
            {showNewThreadInProjectHint ? (
              <span className="text-muted-foreground">
                New chat in current folder: Shift+click
                {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
              </span>
            ) : null}
          </span>
        </TooltipPopup>
      </Tooltip>
      {needsYou}
      <div ref={searchFieldRef} className="stark-sidebar-search">
        <SearchIcon />
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search chats"
          aria-label="Search chats"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
          aria-activedescendant={
            activeResultExists
              ? `sidebar-thread-search-result-${activeSearchResultIndex}`
              : undefined
          }
          className="stark-sidebar-search-input"
        />
        {isSearching ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            className="shrink-0"
            aria-label="Clear chat search"
            onClick={() => {
              onClearSearch();
              searchInputRef.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      {scheduledTasks}
      <div className="stark-sidebar-list-heading">
        <span>Chats</span>
        <Menu>
          <MenuTrigger render={<SidebarHeaderIconButton label="Chat list options" />}>
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuCheckboxItem checked={groupByStatus} onCheckedChange={onGroupByStatusChange}>
              Group by status
            </MenuCheckboxItem>
            <MenuSeparator />
            {onImportLocalChats ? (
              <MenuItem onClick={onImportLocalChats}>
                <ImportIcon />
                Import local chats…
              </MenuItem>
            ) : null}
            <MenuItem onClick={onOpenArchive}>
              <ArchiveIcon />
              Archived chats
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

/**
 * Icon button with a tooltip, sized for the header's segmented pair. Spreads
 * unknown props through so it can serve as a popup trigger's render target,
 * which injects its own handlers, ref and aria state.
 */
function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  /** Accessible name; also the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
