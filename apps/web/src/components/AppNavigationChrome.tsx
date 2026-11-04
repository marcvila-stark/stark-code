import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import { useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FileTextIcon,
  HomeIcon,
  PanelLeftIcon,
  SettingsIcon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useState, type ComponentType, type ComponentProps } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { useEnvironments } from "../state/environments";
import { isStarkPagesLocalConnectionTarget } from "../connection/starkPagesConnection";
import { useProjects, useServerConfigs, useThreadShell, useThreadShells } from "../state/entities";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useRightPanelStore } from "../rightPanelStore";
import { resolveChatDisplayTitle, resolveComposerDraftTitle } from "./composerDraftTitle";
import { SidebarAccounts } from "./sidebar/SidebarChrome";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useSidebar } from "./ui/sidebar";
import styles from "./AppNavigationChrome.module.css";
import { rememberTitleSkills } from "./titleSkillCatalog";

/** Forward belongs to app history; it must never drive an embedded website. */
function nextHistoryEnd(end: number, index: number, action: string): number {
  return action === "PUSH" ? index : Math.max(end, index);
}

function ChromeButton({ label, children, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" className={styles.control} aria-label={label} {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function CurrentTitle() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const target = useParams({ strict: false, select: resolveThreadRouteTarget });
  const thread = useThreadShell(target?.kind === "server" ? target.threadRef : null);
  const draft = useComposerDraftStore((state) =>
    target?.kind === "draft" ? state.getDraftSession(target.draftId) : null,
  );
  const composer = useComposerDraftStore((state) =>
    target?.kind === "draft" ? state.getComposerDraft(target.draftId) : null,
  );
  const configs = useServerConfigs();
  const projects = useProjects();
  const subject = thread ?? draft;
  const project = subject
    ? projects.find(
        (item) => item.environmentId === subject.environmentId && item.id === subject.projectId,
      )
    : null;
  const providers = subject ? (configs.get(subject.environmentId)?.providers ?? []) : [];
  const cwd = subject?.worktreePath ?? project?.workspaceRoot;
  const title = thread
    ? resolveChatDisplayTitle({
        title: thread.title,
        environmentId: thread.environmentId,
        providerInstanceId: thread.providerInstanceId,
        providers,
        cwd,
      })
    : draft?.title !== undefined
      ? draft.title
      : draft && composer
        ? resolveComposerDraftTitle({
            composer,
            providers,
            cwd,
            environmentId: draft.environmentId,
            fallback: "New chat",
          })
        : target?.kind === "draft"
          ? "New chat"
          : target?.kind === "server"
            ? "Chat"
            : pathname.startsWith("/settings")
              ? "Settings"
              : pathname === "/pages"
                ? "Pages"
                : pathname === "/usage"
                  ? "Usage"
                  : pathname === "/pull-requests"
                    ? "Pull requests"
                    : "Home";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={styles.title} />}>{title}</TooltipTrigger>
      <TooltipPopup side="bottom">{title}</TooltipPopup>
    </Tooltip>
  );
}

export function AppTopBar() {
  const router = useRouter();
  const configs = useServerConfigs();
  useEffect(() => {
    for (const [environmentId, config] of configs)
      rememberTitleSkills(environmentId, config.providers);
  }, [configs]);
  const settingsOpen = useLocation({
    select: (location) => location.pathname.startsWith("/settings"),
  });
  const { toggleSidebar, open, isMobile, openMobile } = useSidebar();
  const [historyState, setHistoryState] = useState(() => ({
    index: router.history.location.state.__TSR_index,
    end: router.history.location.state.__TSR_index,
  }));
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        setHistoryState((current) => ({
          index: location.state.__TSR_index,
          end: nextHistoryEnd(current.end, location.state.__TSR_index, action.type),
        }));
      }),
    [router],
  );
  return (
    <header className={`${styles.topbar} ${isElectron ? "drag-region" : ""}`} data-app-topbar>
      <div className={styles.history}>
        <ChromeButton
          label="Back"
          disabled={historyState.index <= 0}
          onClick={() => router.history.back()}
        >
          <ArrowLeftIcon />
        </ChromeButton>
        <ChromeButton
          label="Forward"
          disabled={historyState.index >= historyState.end}
          onClick={() => router.history.forward()}
        >
          <ArrowRightIcon />
        </ChromeButton>
        <ChromeButton
          label={settingsOpen ? "Toggle settings sidebar" : "Toggle chat sidebar"}
          aria-expanded={isMobile ? openMobile : open}
          onClick={toggleSidebar}
        >
          <PanelLeftIcon />
        </ChromeButton>
      </div>
      <CurrentTitle />
      <div className={styles.balance} aria-hidden />
    </header>
  );
}

function RailButton({
  label,
  icon: Icon,
  active,
  onClick,
  disabled,
}: {
  label: string;
  icon: ComponentType<{ "aria-hidden"?: boolean }>;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={styles.railButton}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={onClick}
            disabled={disabled}
          />
        }
      >
        <Icon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function AppIconRail() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const target = useParams({ strict: false, select: resolveThreadRouteTarget });
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { isMobile, setOpenMobile, setOpen } = useSidebar();
  const draft = useComposerDraftStore((state) =>
    target?.kind === "draft" ? state.getDraftSession(target.draftId) : null,
  );
  const current =
    target?.kind === "server"
      ? threads.find(
          (thread) =>
            thread.environmentId === target.threadRef.environmentId &&
            thread.id === target.threadRef.threadId,
        )
      : null;
  const canOpenPages = (thread: Pick<(typeof threads)[number], "environmentId" | "projectId">) => {
    const environment = environments.find((entry) => entry.environmentId === thread.environmentId);
    if (
      !isElectron ||
      !environment ||
      !projects.some(
        (project) =>
          project.environmentId === thread.environmentId && project.id === thread.projectId,
      )
    )
      return false;
    try {
      return isStarkPagesLocalConnectionTarget(
        environment.entry.target,
        window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [],
      );
    } catch {
      return false;
    }
  };
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const openPages = () => {
    closeMobile();
    if (current && canOpenPages(current)) {
      useRightPanelStore
        .getState()
        .openAuxiliary(scopeThreadRef(current.environmentId, current.id), "pages");
      return;
    }
    const project =
      draft && canOpenPages(draft)
        ? projects.find(
            (entry) => entry.environmentId === draft.environmentId && entry.id === draft.projectId,
          )
        : null;
    void navigate({ to: "/pages", search: project ? { folder: project.workspaceRoot } : {} });
  };
  return (
    <nav className={styles.rail} aria-label="App navigation">
      <div className={styles.railGroup}>
        <RailButton
          label="Home"
          icon={HomeIcon}
          active={pathname === "/"}
          onClick={() => {
            closeMobile();
            void navigate({ to: "/" });
          }}
        />
        <RailButton
          label="Pages"
          icon={FileTextIcon}
          active={pathname === "/pages"}
          onClick={openPages}
        />
      </div>
      <div className={styles.railGroup}>
        <RailButton
          label="Settings"
          icon={SettingsIcon}
          active={pathname.startsWith("/settings")}
          onClick={() => {
            if (isMobile) setOpenMobile(true);
            else setOpen(true);
            void navigate({ to: "/settings" });
          }}
        />
        <Tooltip>
          <SidebarAccounts
            popupSide="right"
            trigger={
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={styles.railButton}
                    aria-label="Agents and accounts"
                  />
                }
              >
                <UserRoundIcon aria-hidden />
              </TooltipTrigger>
            }
          />
          <TooltipPopup side="right">Agents and accounts</TooltipPopup>
        </Tooltip>
      </div>
    </nav>
  );
}
