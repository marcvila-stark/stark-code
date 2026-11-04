import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import type { EnvironmentThreadShell } from "@starkfuture/client-runtime/state/models";
import {
  providerKindDisplayName,
  resolveProviderInstanceDisplayName,
} from "@starkfuture/client-runtime/state/provider-instance-display";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import { resolveSubagentMetadata } from "@starkfuture/client-runtime/state/subagent-display";
import {
  deriveThreadWorkers,
  threadWorkerIsActive,
  workerRunAgainText,
  workerStopInput,
  type ThreadWorker,
} from "@starkfuture/client-runtime/state/thread-workers";
import type { OrchestrationV2ThreadProjection, ThreadId } from "@starkfuture/contracts";
import { resolveWorkerRetry } from "@starkfuture/shared/workerRetry";
import { ArrowUpRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn, newMessageId } from "../../lib/utils";
import { useNeedsYouSelection } from "../../needsYouSelection";
import { useServerConfigs, useThreadProjection, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  WORKER_STATE_LABELS,
  summarizeWorkers,
  workerOpenLabel,
  workerRetryOffer,
  workerWorkspaceLabel,
} from "./workers.logic";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * The parent chat's delegated workers in one list. Rows read only thread
 * shells; a worker's own chat loads when its details are open, which is where
 * Retry decides between repeating setup and running the brief again.
 */
export function WorkersPanel(props: {
  readonly parent: EnvironmentThreadShell;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly canOperate: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId } = props.parent;
  const shells = useThreadShells();
  const providers = useServerConfigs().get(environmentId)?.providers;
  const workers = useMemo(
    () =>
      props.projection === null
        ? []
        : deriveThreadWorkers({
            projection: props.projection,
            shells: shells
              .filter((shell) => shell.environmentId === environmentId)
              .map((shell) => shell.source),
          }),
    [environmentId, props.projection, shells],
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {workers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {props.projection === null
            ? "Loading workers…"
            : "Workers appear here when an agent in this chat delegates tasks. Each one runs in its own chat."}
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">{summarizeWorkers(workers)}</p>
          <ul aria-label="Workers" className="space-y-2">
            {workers.map((worker) => {
              const provider = providers?.find(
                (entry) => entry.instanceId === worker.providerInstanceId,
              );
              return (
                <WorkerRow
                  key={worker.childThreadId}
                  worker={worker}
                  environmentId={environmentId}
                  providerName={
                    provider
                      ? resolveProviderInstanceDisplayName(provider)
                      : providerKindDisplayName(worker.providerInstanceId)
                  }
                  modelLabel={resolveSubagentMetadata({ model: worker.model, provider }).modelLabel}
                  canOperate={props.canOperate}
                  onOpen={() => props.onOpenThread(worker.childThreadId)}
                />
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function WorkerRow(props: {
  readonly worker: ThreadWorker;
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly providerName: string;
  readonly modelLabel: string;
  readonly canOperate: boolean;
  readonly onOpen: () => void;
}) {
  const { worker } = props;
  const [expanded, setExpanded] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const lost = worker.lostDecision;
  // Opening a worker with a lost decision focuses the chat notice that resolves it.
  const open = () => {
    if (lost !== null) {
      useNeedsYouSelection
        .getState()
        .open(scopeThreadRef(props.environmentId, worker.childThreadId), lost.requestId);
    }
    props.onOpen();
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setError(null);
    const result = await interruptTurn({
      environmentId: props.environmentId,
      input: workerStopInput(worker),
    });
    setStopping(false);
    if (result._tag === "Failure") setError(failureMessage(result, "Could not stop this worker."));
  };

  return (
    <li className="rounded-lg border border-border p-2">
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left text-sm font-medium break-words hover:underline disabled:no-underline"
          disabled={!worker.available}
          onClick={open}
        >
          {worker.title}
        </button>
        <span
          className={cn(
            "shrink-0 text-xs",
            worker.state === "failed"
              ? "text-destructive"
              : worker.state === "needs_approval" || worker.state === "needs_answer"
                ? "text-warning"
                : "text-muted-foreground",
          )}
        >
          {WORKER_STATE_LABELS[worker.state]}
        </span>
      </div>
      {lost !== null ? <p className="mt-1 break-words text-xs text-warning">{lost.label}</p> : null}
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {props.providerName} · {props.modelLabel}
        {worker.attempts > 1 ? ` · Attempt ${worker.attempts}` : ""}
      </p>
      <p className="mt-1 break-all text-xs text-muted-foreground">{workerWorkspaceLabel(worker)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Button variant="ghost" size="xs" disabled={!worker.available} onClick={open}>
          {workerOpenLabel(worker)} <ArrowUpRightIcon />
        </Button>
        {worker.canStop ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={!props.canOperate || stopping}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide details" : worker.retryable ? "Details and retry" : "Details"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {expanded ? (
        <WorkerDetails
          worker={worker}
          environmentId={props.environmentId}
          canOperate={props.canOperate}
        />
      ) : null}
    </li>
  );
}

function WorkerDetails(props: {
  readonly worker: ThreadWorker;
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly canOperate: boolean;
}) {
  const { worker } = props;
  const childRef = useMemo(
    () => (worker.retryable ? scopeThreadRef(props.environmentId, worker.childThreadId) : null),
    [props.environmentId, worker.childThreadId, worker.retryable],
  );
  const childProjection = useThreadProjection(childRef)?.projection ?? null;
  const offer =
    childProjection === null ? null : workerRetryOffer(resolveWorkerRetry(childProjection), worker);
  const retryWorker = useOrchestrationCommand(threadEnvironment.retryWorker, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    if (offer?.kind !== "action" || busy) return;
    setBusy(true);
    setError(null);
    const result = await retryWorker({
      environmentId: props.environmentId,
      input: {
        threadId: worker.childThreadId,
        expected: offer.expected,
        text: workerRunAgainText(worker),
        messageId: newMessageId(),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result, "Could not run this worker again."));
    }
  };

  return (
    <div className="mt-2 space-y-2 border-t border-border pt-2 text-xs">
      {worker.result !== null ? (
        <section aria-label="Worker result">
          <h4 className="font-medium">
            {worker.attempts > 1 ? `Result of attempt ${worker.attempts}` : "Result"}
          </h4>
          <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
            {worker.result}
          </p>
        </section>
      ) : (
        <p className="text-muted-foreground">
          {threadWorkerIsActive(worker.state)
            ? "This attempt has no result yet."
            : "No result was recorded for this attempt. Open the chat to see what happened."}
        </p>
      )}
      <details>
        <summary className="cursor-pointer font-medium">Original brief</summary>
        <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
          {worker.brief}
        </p>
      </details>
      {worker.retryable ? (
        offer === null ? (
          <p role="status" className="text-muted-foreground">
            Checking whether this worker can run again…
          </p>
        ) : offer.kind === "unavailable" ? (
          <p className="text-muted-foreground">{offer.hint}</p>
        ) : (
          <div className="space-y-1">
            <Button
              variant="outline"
              size="xs"
              disabled={offer.kind === "blocked" || !props.canOperate || busy}
              onClick={() => void retry()}
            >
              {busy ? "Starting…" : offer.label}
            </Button>
            <p className="text-muted-foreground">{offer.hint}</p>
          </div>
        )
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
