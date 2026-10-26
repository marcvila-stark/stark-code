import type { ScopedThreadRef } from "@starkfuture/contracts";
import { PlugZapIcon } from "lucide-react";
import { useState } from "react";
import { isElectron } from "../../env";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { McpServersPanel } from "./McpServersPanel";
import {
  mcpConnectionLabel,
  relevantMcpFailures,
  type McpActivityContext,
} from "./mcpHealthRelevance";
import { mcpRecoveryMessage } from "./mcpRecoveryPresentation";
import { isLocalMcpDesktopTarget, mcpDisplayText } from "./mcpServerPresentation";
import { useMcpServersQuery } from "./useMcpServersQuery";

type Props = McpActivityContext & {
  threadRef: ScopedThreadRef;
  providerKind?: "claudeAgent" | "codex" | undefined;
  sessionBusy?: boolean;
};

export function McpHealthBanner(props: Props) {
  return (
    <McpHealthBannerTarget
      key={`${props.threadRef.environmentId}:${props.threadRef.threadId}:${props.runId ?? "idle"}`}
      {...props}
    />
  );
}

function McpHealthBannerTarget({
  threadRef,
  providerKind,
  sessionBusy = false,
  runId,
  turnItems,
}: Props) {
  const query = useMcpServersQuery(threadRef.environmentId, { threadId: threadRef.threadId });
  const { presentation } = useEnvironmentPresentation(threadRef.environmentId);
  const hasManagePermission = useEnvironmentScope(threadRef.environmentId, "providers:manage");
  const canManage =
    hasManagePermission &&
    presentation &&
    isLocalMcpDesktopTarget(isElectron, presentation.entry.target);
  const [open, setOpen] = useState(false);
  const [signInName, setSignInName] = useState<string | undefined>();
  const failures =
    query.data?.live && !query.error
      ? relevantMcpFailures(query.data.servers, { runId, turnItems })
      : [];
  const firstFailure = failures[0];
  // Keep an explicitly opened sign-in panel alive if the warning resolves during OAuth.
  if (!firstFailure && !open) return null;
  return (
    <div className="min-w-0">
      {firstFailure ? (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-xs text-muted-foreground"
          role="status"
          aria-label="Connection needed for this reply"
        >
          <PlugZapIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1 break-words">
            <span className="font-medium">
              {mcpDisplayText(mcpConnectionLabel(firstFailure), 100)}
            </span>
            {firstFailure.status === "needs-auth"
              ? " needs sign-in for this reply."
              : ` is unavailable for this reply. ${mcpRecoveryMessage(firstFailure) ?? ""}`}
          </p>
          {firstFailure.status === "needs-auth" && !firstFailure.locked && canManage ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={sessionBusy}
              aria-label={`Sign in to ${mcpDisplayText(mcpConnectionLabel(firstFailure), 100)}`}
              onClick={() => {
                if (sessionBusy) return;
                setSignInName(firstFailure.name);
                setOpen(true);
              }}
            >
              Sign in
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setSignInName(undefined);
              setOpen(true);
            }}
          >
            {failures.length > 1 ? `Review ${failures.length} connections` : "Review connection"}
          </Button>
        </div>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSignInName(undefined);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Connections</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <McpServersPanel
              environmentId={threadRef.environmentId}
              target={{ threadId: threadRef.threadId }}
              providerKind={providerKind}
              sessionBusy={sessionBusy}
              initialSignIn={signInName}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
