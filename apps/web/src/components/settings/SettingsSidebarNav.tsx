import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BlocksIcon,
  BotIcon,
  createLucideIcon,
  CalendarClockIcon,
  GitBranchIcon,
  HardDriveIcon,
  PanelsTopLeftIcon,
  KeyboardIcon,
  Link2Icon,
  PaletteIcon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { SidebarUpdatePill } from "../sidebar/SidebarUpdatePill";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  SETTINGS_SECTION_LABELS,
  SETTINGS_NAV_GROUPS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { validateSettingsScopeSearch } from "./settingsScope";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { isElectron } from "../../env";

const SnapShotIcon = createLucideIcon("snap-shot", [
  [
    "path",
    {
      d: "M8 3H6a3 3 0 0 0-3 3v2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2",
      key: "capture-frame",
    },
  ],
  ["rect", { width: "10", height: "8", x: "7", y: "8", rx: "2", key: "window" }],
  ["circle", { cx: "12", cy: "12", r: "1.5", key: "lens" }],
]);

const StarkConnectSidebarSignIn = lazy(() =>
  import("../clerk/StarkConnectSidebarSignIn").then((module) => ({
    default: module.StarkConnectSidebarSignIn,
  })),
);
const StarkConnectSidebarAvatar = lazy(() =>
  import("../clerk/StarkConnectSidebarSignIn").then((module) => ({
    default: module.StarkConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/advanced": Settings2Icon,
  "/settings/about": Settings2Icon,
  "/settings/existing-integrations": BlocksIcon,
  "/settings/diagnostics": Settings2Icon,
  "/settings/appearance": PaletteIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/snap-shot": SnapShotIcon,
  "/settings/providers": BotIcon,
  "/settings/permissions": Settings2Icon,
  "/settings/mcp-servers": BlocksIcon,
  "/settings/integrations": BlocksIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/storage": HardDriveIcon,
  "/settings/connections": Link2Icon,
  "/settings/archived": ArchiveIcon,
};

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground/60" />;
}

export function SettingsSidebarHeader() {
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <div
      className={`stark-review-surface stark-settings-back-header${isElectron ? " drag-region" : ""}`}
    >
      <Button
        variant="ghost-muted"
        size="compact"
        aria-label="Back to chat"
        title="Back to chat"
        onClick={navigateToMainApp}
      >
        <ArrowLeftIcon aria-hidden />
        {isElectron ? "Chat" : "Back to chat"}
      </Button>
    </div>
  );
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const currentSearch = useLocation({ select: (location) => location.search });
  const scopeSearch = useMemo(() => validateSettingsScopeSearch(currentSearch), [currentSearch]);
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const searchableItems = useAvailableSettingsSearchItems(scopeSearch);
  const results = useMemo(() => searchSettings(query, searchableItems), [query, searchableItems]);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;

  useEffect(() => {
    setActiveResultIndex((index) => Math.min(index, Math.max(results.length - 1, 0)));
  }, [results.length]);

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isFindShortcut =
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      const isSlashShortcut =
        event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!isFindShortcut && !isSlashShortcut) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ((isSlashShortcut &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)) ||
          // Preserve dialog and popup focus traps, and let shortcut recorders
          // capture the keypress without moving focus into the sidebar search.
          target.closest(
            '[role="dialog"], [aria-modal="true"], [data-slot$="popup"], [data-keybinding-capture]',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      if (isMobile) {
        setOpenMobile(true);
      } else if (!open) {
        setOpen(true);
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, open, setOpen, setOpenMobile]);

  const handleSectionClick = useCallback(
    (to: SettingsPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to,
        hash: "",
        replace: true,
        hashScrollIntoView: false,
      });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const handleSearchResultClick = useCallback(
    (item: SettingsSearchItem) => {
      clearSearch();
      if (isMobile) {
        setOpenMobile(false);
      }
      const targetId = item.targetId ?? item.id;
      if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
        scrollToSettingsTarget(targetId);
        return;
      }
      void navigate({
        to: item.to,
        hash: targetId,
        replace: true,
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: true },
      });
    },
    [clearSearch, currentHash, isMobile, navigate, pathname, setOpenMobile],
  );
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && isSearching) {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveResultIndex((index) => (index + 1) % results.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeResultIndex];
        if (result) handleSearchResultClick(result);
      }
    },
    [activeResultIndex, clearSearch, handleSearchResultClick, isSearching, results],
  );
  const renderSectionLink = (to: SettingsPath) => {
    const parentPath = [
      "/settings/storage",
      "/settings/source-control",
      "/settings/connections",
      "/settings/scheduled-tasks",
      "/settings/existing-integrations",
      "/settings/diagnostics",
      "/settings/snap-shot",
    ].includes(pathname)
      ? "/settings/advanced"
      : pathname === "/settings/integrations"
        ? "/settings/mcp-servers"
        : pathname === "/settings/permissions"
          ? "/settings/providers"
          : pathname === "/settings/keybindings"
            ? "/settings/general"
            : pathname;
    const isActive = parentPath === to || pathname.startsWith(`${to}/`);
    return (
      <SidebarMenuItem key={to}>
        <button
          type="button"
          className="stark-settings-nav-link"
          aria-current={isActive ? "page" : undefined}
          onClick={() => handleSectionClick(to)}
        >
          {SETTINGS_SECTION_LABELS[to]}
        </button>
      </SidebarMenuItem>
    );
  };
  return (
    <div className="stark-review-surface stark-settings-navigation flex min-h-0 flex-1 flex-col">
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            <div className="stark-settings-search">
              <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveResultIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search settings"
                aria-label="Search settings"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isSearching && hasResults}
                aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
                aria-activedescendant={
                  isSearching && results[activeResultIndex]
                    ? `settings-search-result-${results[activeResultIndex].id}`
                    : undefined
                }
                className="stark-settings-search-input"
              />
              {isSearching ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear settings search"
                  onClick={() => {
                    clearSearch();
                    searchInputRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : (
                <Kbd>/</Kbd>
              )}
            </div>
            {isSearching && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                No settings found
              </p>
            ) : null}
            {isSearching ? (
              <SidebarMenu
                id={hasResults ? "settings-search-results" : undefined}
                role={hasResults ? "listbox" : undefined}
                aria-label={hasResults ? "Settings search results" : undefined}
              >
                {results.map((item, index) => (
                  <SidebarMenuItem key={item.id} role="presentation">
                    <SidebarMenuButton
                      id={`settings-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start"
                      onMouseMove={() => setActiveResultIndex(index)}
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <SettingsSectionIcon to={item.to} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-sidebar-foreground">
                          {item.title}
                        </span>
                        <span className="block truncate text-2xs text-sidebar-muted-foreground/75">
                          {SETTINGS_SECTION_LABELS[item.to]}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : (
              <div className="stark-settings-nav-groups">
                {SETTINGS_NAV_GROUPS.map((group) => (
                  <SidebarMenu key={group.label}>{group.paths.map(renderSectionLink)}</SidebarMenu>
                ))}
              </div>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Suspense fallback={null}>
          <StarkConnectSidebarSignIn />
        </Suspense>
        <div className="flex items-center gap-1">
          <SidebarMenu className="min-w-0 flex-1 flex-row items-center">
            <SidebarMenuItem className="min-w-0 flex-1">
              <button
                type="button"
                className="stark-settings-nav-link"
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                  void navigate({ to: "/settings/about" });
                }}
              >
                About & Help
              </button>
            </SidebarMenuItem>
            <SidebarUpdatePill />
          </SidebarMenu>
          <Suspense fallback={null}>
            <StarkConnectSidebarAvatar />
          </Suspense>
        </div>
      </SidebarFooter>
    </div>
  );
}
