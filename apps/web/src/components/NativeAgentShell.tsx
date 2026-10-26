import { Dialog } from "@base-ui/react/dialog";
import { useAtomValue } from "@effect/atom-react";
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import type {
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { useNativeReplies } from "../state/nativeReplies";
import { NativeReplyTranscript } from "./NativeReplyTranscript";
import { FinishEvidenceCard } from "./chat/FinishEvidenceCard";
import { deriveNativeFinishEvidence } from "./chat/nativeFinishEvidence";
import { NativeMcpReloadControl } from "./NativeMcpReloadControl";
import { NativeVoiceControl } from "./NativeVoiceControl";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { Button } from "./ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { terminalEnvironment } from "../state/terminal";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearanceFonts";
import type { NativeMcpWarning } from "../nativeMcpWarning";
import type { TerminalContextSelection } from "../lib/terminalContext";

export function nativeAgentTerminalId(instanceId: ProviderInstanceId): string {
  return `native-agent-${instanceId}`;
}

/** The terminal stays owned by the server when its view is hidden or the thread changes. */
export function NativeAgentShell(props: {
  readonly threadRef: ScopedThreadRef;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: string;
  readonly apiBackend?: "openrouter" | undefined;
  readonly existingOnly?: boolean | undefined;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly focusRequestId?: number;
  readonly voiceRequestId?: number;
  readonly onVoiceRequestConsumed?: ((requestId: number) => void) | undefined;
  readonly onBackToChat: () => void;
  readonly onAddTerminalContext?:
    | ((selection: TerminalContextSelection) => boolean | void)
    | undefined;
  readonly onQuoteText?: ((text: string, label: string) => boolean) | undefined;
}) {
  const [ended, setEnded] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [view, setView] = useState<"terminal" | "reader" | "both">("terminal");
  const [expanded, setExpanded] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
  const [mcpWarning, setMcpWarning] = useState<NativeMcpWarning | null>(null);
  const chooseView = (next: typeof view) => {
    setView(next);
    setResizeEpoch((epoch) => epoch + 1);
  };
  const expand = (next: boolean) => {
    setExpanded(next);
    setResizeEpoch((epoch) => epoch + 1);
  };
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const restart = useAtomCommand(terminalEnvironment.restart, "restart native agent shell");
  const canRestart = useAtomValue(
    terminalEnvironment.restart.permissionAtom(props.threadRef.environmentId),
  );
  const terminalId = nativeAgentTerminalId(props.providerInstanceId);
  const replies = useNativeReplies(props.threadRef, true, terminalId);
  const latestReply = replies.data?.at(-1);
  const label =
    props.apiBackend === "openrouter"
      ? "OpenRouter"
      : props.driver === "codex"
        ? "Codex"
        : "Claude";
  const showTerminal = () => {
    if (view === "reader") chooseView("terminal");
    setTerminalFocusRequest((request) => request + 1);
  };
  const restartSession = async () => {
    if (!canRestart || restarting) return;
    setRestarting(true);
    try {
      const result = await restart({
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          terminalId,
          cwd: props.cwd,
          worktreePath: props.worktreePath,
          providerInstanceId: props.providerInstanceId,
          agentShell: true,
          cols: 100,
          rows: 30,
        },
      });
      if (result._tag !== "Success") return;
      if (result.value.status === "error") {
        setLaunchError(result.value.error ?? "The native session could not start.");
        return;
      }
      setEnded(false);
      setLaunchError(null);
      setMcpWarning(null);
      showTerminal();
    } finally {
      setRestarting(false);
    }
  };
  return (
    <Dialog.Root
      open
      modal={expanded}
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (open || !expanded) return;
        // Escape remains a real CLI key when focus is inside the terminal.
        if (
          details.event.target instanceof Element &&
          details.event.target.closest("[data-thread-terminal-drawer]")
        )
          return;
        expand(false);
        expandButton.current?.focus({ preventScroll: true });
      }}
    >
      <div ref={setPortalHost} className="contents" />
      {portalHost ? (
        <Dialog.Portal keepMounted container={portalHost} className="contents">
          <Dialog.Popup
            role={expanded ? "dialog" : "region"}
            aria-modal={expanded || undefined}
            initialFocus={false}
            finalFocus={false}
            className={cn(
              "@container/native-shell flex min-h-0 min-w-0 flex-col bg-background outline-none",
              expanded ? "fixed inset-0 z-[60]" : "relative z-[45] h-full",
            )}
            aria-label={`${label} native shell`}
            data-native-shell-expanded={expanded ? "true" : "false"}
          >
            <div
              className={cn(
                "flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2",
                expanded &&
                  isElectron &&
                  "drag-region min-h-(--workspace-topbar-height) pl-(--workspace-controls-left) wco:pr-(--workspace-native-controls-inset)",
              )}
            >
              <div>
                <div className="text-sm font-medium">{label} · Native shell</div>
                <div className="text-xs text-muted-foreground">
                  All CLI commands, plugins, and skills. Shares files with chat; uses its own
                  conversation.
                  {props.driver === "codex"
                    ? " Read-only by default; approve access inside Codex when needed."
                    : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <NativeVoiceControl
                  driver={props.driver}
                  apiBackend={props.apiBackend}
                  threadRef={props.threadRef}
                  terminalId={terminalId}
                  requestId={props.voiceRequestId}
                  onRequestConsumed={props.onVoiceRequestConsumed}
                  ended={ended || launchError !== null || restarting}
                  onShowTerminal={showTerminal}
                />
                <NativeMcpReloadControl driver={props.driver} onShowTerminal={showTerminal} />
                <Button
                  ref={expandButton}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={expanded ? "Return shell to workspace" : "Fill window"}
                  onClick={() => expand(!expanded)}
                >
                  {expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
                </Button>
                <Button variant="ghost" size="sm" onClick={props.onBackToChat}>
                  Back to chat
                </Button>
              </div>
            </div>
            {mcpWarning ? (
              <div
                className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs"
                role="status"
              >
                <p className="min-w-0 flex-1">
                  {mcpWarning === "sign-in"
                    ? "A connector may need sign-in. Review it in the terminal."
                    : "A connection warning appeared in the terminal."}
                </p>
                <Button size="xs" variant="outline" onClick={showTerminal}>
                  Show terminal
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Dismiss connection warning"
                  onClick={() => setMcpWarning(null)}
                >
                  <XIcon aria-hidden />
                </Button>
              </div>
            ) : null}
            <div
              className="flex shrink-0 flex-wrap gap-1 border-b px-3 py-2"
              aria-label="Native shell view"
            >
              <Button
                variant={view === "terminal" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={view === "terminal"}
                onClick={() => chooseView("terminal")}
              >
                Terminal
              </Button>
              <Button
                variant={view === "reader" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={view === "reader"}
                onClick={() => chooseView("reader")}
              >
                Read view
              </Button>
              <Button
                variant={view === "both" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={view === "both"}
                onClick={() => chooseView("both")}
              >
                Both
              </Button>
              {view === "both" ? (
                <span className="self-center px-2 text-xs text-muted-foreground">
                  The same session. Reading uses no extra tokens.
                </span>
              ) : null}
            </div>
            {view === "terminal" && latestReply?.evidence ? (
              <div className="max-h-64 shrink-0 overflow-auto px-3">
                <FinishEvidenceCard
                  evidence={deriveNativeFinishEvidence(latestReply.id, latestReply.evidence)}
                />
              </div>
            ) : null}
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col @min-[52rem]/native-shell:flex-row"
              data-native-shell-layout={view}
            >
              <div
                className={view !== "reader" ? "min-h-0 min-w-0 flex-1" : "hidden"}
                data-thread-terminal-drawer
                aria-hidden={view === "reader"}
              >
                <TerminalViewport
                  advancedTypography={advancedTypography}
                  threadRef={props.threadRef}
                  threadId={props.threadRef.threadId}
                  terminalId={terminalId}
                  terminalLabel={`${label} native shell`}
                  cwd={props.cwd}
                  worktreePath={props.worktreePath}
                  providerInstanceId={props.providerInstanceId}
                  agentShell
                  existingOnly={props.existingOnly}
                  onSessionExited={() => setEnded(true)}
                  onSessionLaunchError={setLaunchError}
                  onMcpWarning={setMcpWarning}
                  {...(props.onAddTerminalContext
                    ? { onAddTerminalContext: props.onAddTerminalContext }
                    : {})}
                  focusRequestId={(props.focusRequestId ?? 1) + terminalFocusRequest}
                  autoFocus
                  visible={view !== "reader"}
                  resizeEpoch={resizeEpoch}
                  drawerHeight={0}
                  keybindings={props.keybindings}
                />
              </div>
              <div
                className={cn(
                  "min-h-0 min-w-0 flex-1 flex-col",
                  view === "terminal" ? "hidden" : "flex",
                  view === "both" &&
                    "border-t @min-[52rem]/native-shell:border-t-0 @min-[52rem]/native-shell:border-l",
                )}
                aria-hidden={view === "terminal"}
              >
                <NativeReplyTranscript
                  threadRef={props.threadRef}
                  cwd={props.worktreePath ?? props.cwd}
                  onQuoteText={props.onQuoteText}
                  replies={replies.data ?? []}
                  error={replies.error}
                />
              </div>
            </div>
            {ended || launchError !== null ? (
              <div className="flex shrink-0 items-center justify-between border-t px-4 py-2">
                <span className="text-sm text-muted-foreground">
                  {launchError
                    ? "The native session could not start."
                    : "The native session has exited."}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canRestart || restarting}
                  onClick={() => void restartSession()}
                >
                  {restarting
                    ? "Starting…"
                    : launchError
                      ? "Retry native session"
                      : "Start another session"}
                </Button>
              </div>
            ) : null}
          </Dialog.Popup>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
