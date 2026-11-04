import { useAtomValue } from "@effect/atom-react";
import {
  checksForRun,
  correctionLinkOfRun,
  correctionsOfRun,
  type TurnCheck,
} from "@starkfuture/client-runtime/state/review-chain";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  type ProjectScript,
  type RunId,
  type ScopedThreadRef,
} from "@starkfuture/contracts";
import type { TimestampFormat } from "@starkfuture/contracts/settings";
import { resolveProjectScripts } from "@starkfuture/shared/projectScripts";
import {
  latestCheckSubjectRun,
  validateUserShellCheckSubject,
} from "@starkfuture/shared/userShellChecks";
import * as DateTime from "effect/DateTime";
import { PlayIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  useProject,
  useThreadHistory,
  useThreadProjection,
  useThreadShell,
} from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useThreadRunningTerminalIds } from "~/state/terminalSessions";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { formatShortTimestamp } from "~/timestampFormat";

import {
  buildTurnCheckDispatch,
  checkFixPrompt,
  checkOutputTail,
  checkRanAfterLabel,
  checkScripts,
  shellOutputAttachment,
  turnCheckAvailability,
  turnCheckNeedsFix,
  turnCheckResultLabel,
} from "../chat/turnChecks";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/** Appends a correction request to the composer draft. The user reviews and sends it. */
function draftIntoComposer(target: ScopedThreadRef | DraftId, prompt: string) {
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(target)?.prompt ?? "";
  store.setPrompt(target, existing ? `${existing}\n\n${prompt}` : prompt, "human");
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function CheckRow(props: {
  readonly check: TurnCheck;
  readonly turnLabel: string;
  readonly timestampFormat: TimestampFormat;
  readonly onStop: (() => void) | null;
  readonly onCancel: (() => void) | null;
  readonly onOpenOutput: (path: string) => void;
  readonly onAskForFix: () => void;
}) {
  const { check } = props;
  const item = check.item;
  const destructive =
    turnCheckNeedsFix(check) || check.outcome === "unknown" || check.outcome === "stopped";
  return (
    <li className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">{check.scriptName ?? check.command}</span>
        <span className={destructive ? "text-destructive" : "text-muted-foreground"}>
          {turnCheckResultLabel(check)}
        </span>
        {item?.completedAt ? (
          <span className="text-muted-foreground">
            {formatShortTimestamp(DateTime.formatIso(item.completedAt), props.timestampFormat)}
          </span>
        ) : null}
        {props.onStop ? (
          <Button size="micro" variant="outline" onClick={props.onStop}>
            Stop
          </Button>
        ) : null}
        {props.onCancel ? (
          <Button size="micro" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        {item?.fullOutputPath ? (
          <Button
            size="micro"
            variant="link"
            onClick={() => props.onOpenOutput(item.fullOutputPath!)}
          >
            Full output
          </Button>
        ) : null}
        {turnCheckNeedsFix(check) ? (
          <Button size="micro" variant="outline" onClick={props.onAskForFix}>
            Ask for a fix
          </Button>
        ) : null}
      </div>
      <p className="text-muted-foreground">
        {check.skipReason ??
          (check.outcome === "cancelled"
            ? "Removed from the queue before it ran."
            : check.outcome === "queued" || check.outcome === "running"
              ? `Runs after ${props.turnLabel} in the live folder.`
              : `${sentence(checkRanAfterLabel(props.turnLabel))}.`)}
      </p>
      {item?.outputOmitted ? (
        <p className="text-muted-foreground">
          The output is too long to show here; it is with the check in the conversation.
        </p>
      ) : item?.output?.trim() ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Output</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono">
            {checkOutputTail(item.output)}
          </pre>
        </details>
      ) : null}
      {check.laterWork ? (
        <p className="text-warning-foreground">
          Later work ran in this folder, so this result may be out of date.
        </p>
      ) : null}
    </li>
  );
}

/**
 * The selected turn's checks and correction links in the Changes panel, plus Run controls for
 * the latest turn. A check is a recorded human shell command: it runs in the thread's live
 * folder with the user's shell, under the same permissions as `!` commands.
 */
export function TurnCheckStrip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly selectedRunId: RunId;
  /** The turn number the Changes panel shows; the run's ordinal stands in when it is unknown. */
  readonly turnOrdinal: number | null;
  readonly cwd: string | null;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly onSelectTurn: (runId: RunId) => void;
}) {
  const { environmentId, threadId } = props.threadRef;
  const projection = useThreadProjection(props.threadRef)?.projection ?? null;
  const thread = useThreadShell(props.threadRef);
  const history = useThreadHistory(props.threadRef);
  const project = useProject(thread ? { environmentId, projectId: thread.projectId } : null);
  const settings = useEnvironmentSettings(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const nativeAgentRunning = useThreadRunningTerminalIds({ environmentId, threadId }).some((id) =>
    id.startsWith("native-agent-"),
  );
  const dispatch = useOrchestrationCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const interrupt = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const cancelQueued = useAtomCommand(threadEnvironment.cancelQueuedRun, {
    reportFailure: false,
  });
  const [dispatching, setDispatching] = useState(false);

  const historyOptions = useMemo(
    () => ({ historyComplete: !history.hasMoreHistory }),
    [history.hasMoreHistory],
  );
  const subjectRun = useMemo(
    () => (projection === null ? null : latestCheckSubjectRun(projection)),
    [projection],
  );
  const turnChecks = useMemo(
    () =>
      projection === null ? null : checksForRun(projection, props.selectedRunId, historyOptions),
    [historyOptions, projection, props.selectedRunId],
  );
  const correction = useMemo(
    () =>
      projection === null
        ? null
        : {
            corrects: correctionLinkOfRun(projection, props.selectedRunId, historyOptions),
            correctedIn: correctionsOfRun(projection, props.selectedRunId, historyOptions),
          },
    [historyOptions, projection, props.selectedRunId],
  );
  const availability = turnCheckAvailability({
    capability:
      serverConfig?.environment.capabilities.userShellCommand === true &&
      serverConfig.environment.capabilities.userShellChecks === true,
    allowed: settings.allowUserShellCommands,
    canOperateThread,
    canOperateTerminal,
    driver:
      serverConfig?.providers.find(
        (provider) => provider.instanceId === thread?.modelSelection.instanceId,
      )?.driver ?? null,
    nativeAgentRunning,
    providerSubagent: thread !== null && isProviderNativeSubagentThread(thread.source),
    subject:
      projection === null || subjectRun === null
        ? null
        : validateUserShellCheckSubject(projection, subjectRun.id, "dispatch"),
  });
  const scripts = useMemo(
    () => (project ? checkScripts(resolveProjectScripts(settings, project)) : []),
    [project, settings],
  );

  if (projection === null || turnChecks === null || correction === null) return null;
  if (
    availability.kind === "hidden" &&
    turnChecks.checks.length === 0 &&
    correction.corrects === null &&
    correction.correctedIn.length === 0
  ) {
    return null;
  }

  const runRef = (runId: RunId) => projection.runs.find((run) => run.id === runId);
  const reviewedLink = correction.corrects?.kind === "linked" ? correction.corrects : null;
  const reviewed = reviewedLink ? runRef(reviewedLink.reviewedRunId) : undefined;
  const isSubject = subjectRun?.id === props.selectedRunId;
  const selectedCheck = projection.messages.find(
    (message) => message.id === runRef(props.selectedRunId)?.userMessageId,
  )?.userShell?.check;
  const selectedCheckSubject = selectedCheck ? runRef(selectedCheck.subjectRunId) : undefined;
  const turnOrdinal = props.turnOrdinal ?? runRef(props.selectedRunId)?.ordinal ?? null;
  const turnLabel = turnOrdinal === null ? "this turn" : `Turn ${turnOrdinal}`;
  const activeRunId =
    projection.runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status))?.id ?? null;

  const runScript = async (script: ProjectScript) => {
    if (subjectRun === null) return;
    setDispatching(true);
    try {
      const result = await dispatch({
        environmentId,
        input: buildTurnCheckDispatch({
          commandId: CommandId.make(randomUUID()),
          threadId,
          messageId: MessageId.make(randomUUID()),
          script,
          subjectRunId: subjectRun.id,
          running: activeRunId !== null,
          nativeAgentRunning,
        }),
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not run ${script.name}`,
        description: error instanceof Error ? error.message : "The check did not start.",
      });
    } finally {
      setDispatching(false);
    }
  };
  const reportFailure = (title: string) => (result: { readonly _tag: string }) => {
    if (result._tag === "Failure") toastManager.add({ type: "error", title });
  };

  return (
    <section
      aria-label="Checks for this turn"
      className="shrink-0 space-y-1.5 border-b border-border/70 px-3 py-2 text-2xs"
    >
      {selectedCheck ? (
        <p className="text-muted-foreground">
          This turn is a check that{" "}
          {checkRanAfterLabel(
            selectedCheckSubject ? `Turn ${selectedCheckSubject.ordinal}` : "an earlier turn",
          )}
          .
        </p>
      ) : null}
      {correction.corrects?.kind === "incomplete" ? (
        <p className="text-muted-foreground">
          Corrects a turn outside the loaded history. Load earlier messages to see which.
        </p>
      ) : reviewed && reviewedLink ? (
        <p className="text-muted-foreground">
          Corrects{" "}
          <Button size="micro" variant="link" onClick={() => props.onSelectTurn(reviewed.id)}>
            Turn {reviewed.ordinal}
          </Button>{" "}
          ({reviewedLink.commentCount} {reviewedLink.commentCount === 1 ? "comment" : "comments"})
        </p>
      ) : null}
      {correction.correctedIn.length > 0 ? (
        <p className="text-muted-foreground">
          Corrected in{" "}
          {correction.correctedIn.map((run) => (
            <Button
              key={run.id}
              size="micro"
              variant="link"
              onClick={() => props.onSelectTurn(run.id)}
            >
              Turn {run.ordinal}
            </Button>
          ))}
        </p>
      ) : null}
      {turnChecks.checks.length > 0 ? (
        <ol className="space-y-1.5">
          {turnChecks.checks.map((check) => (
            <CheckRow
              key={check.runId}
              check={check}
              turnLabel={turnLabel}
              timestampFormat={settings.timestampFormat}
              onStop={
                check.runId === activeRunId && canOperateThread
                  ? () =>
                      void interrupt({ environmentId, input: { threadId } }).then(
                        reportFailure("Could not stop the check"),
                      )
                  : null
              }
              onCancel={
                check.outcome === "queued" && canOperateThread
                  ? () =>
                      void cancelQueued({
                        environmentId,
                        input: { threadId, runId: check.runId },
                      }).then(reportFailure("Could not cancel the check"))
                  : null
              }
              onOpenOutput={(path) => {
                const attachment = shellOutputAttachment(path);
                if (attachment) {
                  useRightPanelStore.getState().openAttachment(props.threadRef, attachment);
                }
              }}
              onAskForFix={() =>
                draftIntoComposer(
                  props.composerDraftTarget,
                  checkFixPrompt({
                    turnLabel,
                    command: check.command,
                    exitCode: check.item?.exitCode ?? null,
                    timedOut: check.item?.timedOut === true,
                    output: check.item?.outputOmitted ? null : (check.item?.output ?? ""),
                  }),
                )
              }
            />
          ))}
        </ol>
      ) : null}
      {turnChecks.incomplete || correction.corrects?.kind === "unknown" ? (
        <p className="text-muted-foreground">
          Older history is not loaded, so some checks or review links for this turn may be missing.
        </p>
      ) : null}
      {availability.kind === "hidden" ? null : !isSubject ? (
        <p className="text-muted-foreground">Checks run after the latest turn only.</p>
      ) : availability.kind === "unavailable" ? (
        <p className="text-muted-foreground">{availability.reason}</p>
      ) : scripts.length === 0 ? (
        <p className="text-muted-foreground">
          Add a project action with the test or lint icon to run it here after a turn.
        </p>
      ) : (
        <div className="space-y-1">
          {scripts.map((script) => (
            <div key={script.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Button
                size="micro"
                variant="outline"
                disabled={dispatching}
                onClick={() => void runScript(script)}
              >
                <PlayIcon />
                Run {script.name}
              </Button>
              <code className="min-w-0 break-all font-mono text-foreground">{script.command}</code>
            </div>
          ))}
          <p className="break-all text-muted-foreground">
            Runs in {props.cwd ?? "the thread's folder"} with your shell and permissions, not an
            agent sandbox. The result is recorded in this thread, and the agent sees it with your
            next message.
          </p>
        </div>
      )}
    </section>
  );
}
