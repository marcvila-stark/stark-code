import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  SettingsIcon,
  UserRoundIcon,
} from "lucide-react";
import { cloneElement, memo, useCallback, type ReactElement, type ComponentProps } from "react";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { APP_BASE_NAME } from "../../branding";
import { cn } from "../../lib/utils";
import {
  useEnvironment,
  usePrimaryEnvironmentId,
  usePullRequestsSupported,
} from "../../state/environments";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isSharedClaudeOrganizationContext } from "../../claudeSharedLogin";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { searchableSetting } from "../settings/settingsSearch";
import { ClaudeOrganizationSwitcher } from "./ClaudeOrganizationSwitcher";
import { ProviderAccountSwitcher } from "./ProviderAccountSwitcher";
import { sidebarAccountContextKey, useSidebarAccountContexts } from "./sidebarAccountContext";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";
import { SidebarNavigationButton } from "./SidebarNavigationButton";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      className={cn("stark-sidebar-brandrow", isElectron && "drag-region")}
      data-has-pill={pillLabel ? true : undefined}
      data-has-backdrop={backdropVariant ? true : undefined}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <div className="stark-sidebar-environment">
          <Badge data-environment-identification="pill" size="sm" variant="secondary">
            {pillLabel}
          </Badge>
        </div>
      ) : null}
      <div className="relative z-10 ml-auto shrink-0">
        <SidebarTrigger aria-label="Toggle main sidebar" />
      </div>
    </div>
  );
});

// Match the header's visible content, including native window-control clearance.
function SidebarBrandWidthProbe({ onWidthChange }: { onWidthChange: (width: number) => void }) {
  const observeWidth = useCallback(
    (probe: HTMLDivElement) => {
      return observeResize(probe, ([entry]) => {
        if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
      });
    },
    [onWidthChange],
  );

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent"
      ref={observeWidth}
    >
      <div className="stark-sidebar-brand-probe">
        <span className="stark-sidebar-brand">
          <span className="stark-sidebar-brandmark" />
          <span>{APP_BASE_NAME}</span>
        </span>
        <span className="w-(--workspace-titlebar-control-size)" />
      </div>
    </div>
  );
}

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <Link
      aria-label="Go to chats"
      className={cn("stark-sidebar-brand", onBackdrop && "text-white")}
      to="/"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
      }}
    >
      <span className="stark-sidebar-brandmark" aria-hidden="true" />
      <span>{APP_BASE_NAME}</span>
    </Link>
  );
}

const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleAppearanceClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings/appearance" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigateToMainApp();
  }, [closeMobileSidebar, navigateToMainApp]);

  const handleHistoryClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/history" });
  }, [closeMobileSidebar, navigate]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarNavigationButton
            className="stark-sidebar-utility-button"
            onClick={handleBackClick}
          >
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarNavigationButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarNavigationButton
              className="stark-sidebar-utility-button"
              aria-label="Settings"
              onClick={handleSettingsClick}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarNavigationButton>
          </SidebarMenuItem>
          <SidebarMenuItem className="shrink-0">
            <Menu>
              <MenuTrigger
                render={
                  <SidebarNavigationButton
                    className="stark-sidebar-utility-button"
                    data-icon
                    aria-label="More app options"
                  />
                }
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup side="top" align="end">
                <MenuItem onClick={handleAppearanceClick}>
                  <PaletteIcon />
                  Appearance…
                </MenuItem>
                {pullRequestsSupported ? (
                  <MenuItem onClick={handlePullRequestsClick}>
                    <PullRequestGlyph.pullRequest />
                    Pull requests
                  </MenuItem>
                ) : null}
                <MenuItem onClick={handleUsageClick}>
                  <ChartNoAxesColumnIcon />
                  Usage
                </MenuItem>
                <MenuItem onClick={handleHistoryClick}>
                  <HistoryIcon />
                  History
                </MenuItem>
              </MenuPopup>
            </Menu>
          </SidebarMenuItem>
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export function SidebarAccounts({
  trigger,
  popupSide,
}: {
  trigger?: ReactElement<ComponentProps<"button">>;
  popupSide?: "top" | "right";
} = {}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftEnvironmentId = useComposerDraftStore((store) => {
    if (routeTarget?.kind !== "draft") return null;
    const draft = store.getDraftSession(routeTarget.draftId);
    return draft?.promotedTo?.environmentId ?? draft?.environmentId ?? null;
  });
  const context = useSidebarAccountContexts((store) =>
    routeTarget ? (store.contexts[sidebarAccountContextKey(routeTarget)] ?? null) : null,
  );
  // Follow the conversation's machine, including drafts. Never fall back to the
  // local login when a selected remote conversation is unavailable.
  const environmentId =
    context?.environmentId ??
    (routeTarget?.kind === "server"
      ? routeTarget.threadRef.environmentId
      : routeTarget?.kind === "draft"
        ? draftEnvironmentId
        : primaryEnvironmentId);
  const environment = useEnvironment(environmentId);
  const selected = context?.entries.find((entry) => entry.instanceId === context.instanceId);
  const onManage = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/settings/providers",
      search: environmentId ? { machine: environmentId } : {},
      ...(isSharedClaudeOrganizationContext(selected?.snapshot)
        ? { hash: searchableSetting("claude-organizations").id }
        : {}),
    });
  };
  const onUsage = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  };
  if (!environment || !context || !selected) {
    return trigger ? (
      cloneElement(trigger, { onClick: onManage })
    ) : (
      <SidebarMenuButton onClick={onManage}>
        <UserRoundIcon />
        <span>Agents &amp; accounts</span>
      </SidebarMenuButton>
    );
  }
  return isSharedClaudeOrganizationContext(selected.snapshot) ? (
    <ClaudeOrganizationSwitcher
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      isConnected={environment.connection.phase === "connected"}
      onManage={onManage}
      onUsage={onUsage}
      trigger={trigger}
      popupSide={popupSide}
    />
  ) : (
    <ProviderAccountSwitcher
      key={`${environment.environmentId}:${selected.driverKind}`}
      context={context}
      selected={selected}
      environmentLabel={environment.label}
      connected={environment.connection.phase === "connected"}
      onManage={onManage}
      onUsage={onUsage}
      trigger={trigger}
      popupSide={popupSide}
    />
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <div className="stark-sidebar-footer">
      <SidebarFooter>
        <SidebarThreadUndoNotice />
        <SidebarProviderUpdatePill />
        <SidebarUpdateArchitectureWarning />
        <SidebarAccounts />
        <div data-stark-sidebar-utility-menu>
          <SidebarUtilityMenu />
        </div>
      </SidebarFooter>
    </div>
  );
});
