import { useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@starkfuture/client-runtime/state/models";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ProviderInstanceId,
  type ThreadId,
} from "@starkfuture/contracts";
import { newMessageId, newThreadId } from "../../lib/utils";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
} from "../../providerInstances";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { latestSideWorkResponse } from "./sideWork.logic";
import {
  cappedReviewTurn,
  MAX_REVIEW_ROUNDS,
  MAX_REVIEW_SCOPE,
  readCappedReview,
  reserveReviewRound,
  type CappedReview,
} from "./cappedReview.logic";

/** Explicit rounds only. The parent chat never receives an automatic turn or summary. */
export function CappedReviewPanel({
  parent,
  workspaceRoot,
  onOpenThread,
}: {
  parent: EnvironmentThreadShell;
  workspaceRoot: string;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const storageKey = `stark-code:capped-review:${scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id))}`;
  const [saved] = useState(() => {
    try {
      return { review: readCappedReview(localStorage.getItem(storageKey)), error: null };
    } catch {
      return {
        review: null,
        error:
          "Saved review state could not be read. Starting is blocked so its round limit is preserved.",
      };
    }
  });
  const [review, setReview] = useState<CappedReview | null>(saved.review);
  const [scope, setScope] = useState(saved.review?.scope ?? "");
  const [error, setError] = useState<string | null>(saved.error);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const canOperate = useEnvironmentScope(parent.environmentId, AuthOrchestrationOperateScope);
  const settings = useEnvironmentSettings(parent.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(parent.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    settings,
    parent.projectId,
  ).filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status === "authenticated",
  );
  const [claudeId, setClaudeId] = useState<ProviderInstanceId | null>(null);
  const [codexId, setCodexId] = useState<ProviderInstanceId | null>(null);
  const claude = entries.find(
    (entry) =>
      entry.driverKind === "claudeAgent" && (claudeId === null || entry.instanceId === claudeId),
  );
  const codex = entries.find(
    (entry) => entry.driverKind === "codex" && (codexId === null || entry.instanceId === codexId),
  );
  const latest = review?.rounds.at(-1);
  const firstRef = useMemo(
    () =>
      latest?.members[0] ? scopeThreadRef(parent.environmentId, latest.members[0].threadId) : null,
    [latest, parent.environmentId],
  );
  const secondRef = useMemo(
    () =>
      latest?.members[1] ? scopeThreadRef(parent.environmentId, latest.members[1].threadId) : null,
    [latest, parent.environmentId],
  );
  const firstShell = useThreadShell(firstRef);
  const secondShell = useThreadShell(secondRef);
  const firstProjection = useThreadProjection(firstRef)?.projection;
  const secondProjection = useThreadProjection(secondRef)?.projection;
  const firstReply = latestSideWorkResponse(firstProjection?.messages ?? []);
  const secondReply = latestSideWorkResponse(secondProjection?.messages ?? []);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const active =
    threadRuntimeIsActive(firstShell?.runtime) || threadRuntimeIsActive(secondShell?.runtime);
  const completed =
    !latest ||
    latest.members.every((_, index) => {
      const shell = index === 0 ? firstShell : secondShell;
      return (
        shell &&
        !threadRuntimeIsActive(shell.runtime) &&
        shell.latestRun?.status === "completed" &&
        Boolean(index === 0 ? firstReply : secondReply)
      );
    });
  const save = (next: CappedReview) => {
    localStorage.setItem(storageKey, JSON.stringify(next));
    setReview(next);
  };
  async function start(mode: "pair" | "codex") {
    if (!canOperate || inFlight.current || saved.error || active || !completed) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const locks = navigator.locks;
      if (!locks?.request)
        throw new Error(
          "Reviews need browser storage locking to preserve their round limit across windows. Open this tool in the desktop app or a supported browser.",
        );
      const chosen = mode === "pair" ? [claude, codex] : [codex];
      const members = chosen.map((entry) => {
        if (!entry)
          throw new Error("Connect and enable the required review profiles for this folder.");
        const model = getDefaultProviderInstanceModel(providers, entry.instanceId);
        if (!model) throw new Error("This review profile has no available model.");
        return {
          threadId: newThreadId(),
          label: entry.displayName,
          modelSelection: { instanceId: entry.instanceId, model },
        };
      });
      // Same-origin windows share this lock. Persist identities before dispatching either turn.
      const next = await locks.request(storageKey, () => {
        const previous = readCappedReview(localStorage.getItem(storageKey));
        if (JSON.stringify(previous) !== JSON.stringify(review)) {
          setReview(previous);
          if (previous) setScope(previous.scope);
          throw new Error(
            "This review changed in another panel. Check its current chats before starting another round.",
          );
        }
        const reserved = reserveReviewRound({ previous, scope, mode, members });
        save(reserved);
        return reserved;
      });
      const round = next.rounds.at(-1)!;
      const outcomes = await Promise.all(
        round.members.map(async (member, index) => {
          try {
            const result = await startTurn({
              environmentId: parent.environmentId,
              input: cappedReviewTurn({
                parent,
                member,
                messageId: newMessageId(),
                scope: next.scope,
                round: round.number,
                peerReply: review ? (index === 0 ? secondReply || firstReply : firstReply) : "",
                createdAt: new Date().toISOString(),
              }),
            });
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            return { ...member, outcome: "accepted" as const };
          } catch {
            return { ...member, outcome: "unconfirmed" as const };
          }
        }),
      );
      await locks.request(storageKey, () => {
        const current = readCappedReview(localStorage.getItem(storageKey));
        const recorded = current?.rounds.find((item) => item.number === round.number);
        if (
          !current ||
          !recorded ||
          recorded.members.some((member, index) => member.threadId !== outcomes[index]?.threadId)
        ) {
          throw new Error(
            "Saved review state changed. Check the listed chats; this start will not be replayed.",
          );
        }
        save({
          ...current,
          rounds: current.rounds.map((item) =>
            item.number === round.number ? { ...item, members: outcomes } : item,
          ),
        });
      });
      if (outcomes.some((member) => member.outcome === "unconfirmed"))
        setError(
          "A review start could not be confirmed. This round remains counted; open the listed chats to check before taking further action.",
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the review.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const count = review?.rounds.length ?? 0;
  return (
    <section aria-label="Capped review" className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
      <p className="text-sm font-medium">A second opinion, with a stop point</p>
      <p className="text-xs text-muted-foreground">
        Separate Plan + Manual chats in this folder. No automatic fixes, no parent-chat messages,
        and at most three rounds. Each round needs your click; model and tool token usage is not
        hard-capped.
      </p>
      <label className="block text-xs">
        Exact review scope
        <Textarea
          aria-label="Review scope"
          value={scope}
          maxLength={MAX_REVIEW_SCOPE}
          disabled={busy || review !== null}
          onChange={(event) => setScope(event.target.value)}
          placeholder="Which files, change or question should they review?"
        />
      </label>
      <div className="grid gap-2 text-xs">
        {(
          [
            { label: "Claude", kind: "claudeAgent", entry: claude, set: setClaudeId },
            { label: "Codex", kind: "codex", entry: codex, set: setCodexId },
          ] as const
        ).map(({ label, kind, entry, set }) => (
          <label key={kind} className="flex items-center justify-between gap-2">
            {label}
            <select
              aria-label={`${label} review profile`}
              className="min-w-0 rounded border border-border bg-background p-1"
              value={entry?.instanceId ?? ""}
              disabled={busy}
              onChange={(event) => set(event.target.value as ProviderInstanceId)}
            >
              <option value="">No available profile</option>
              {entries
                .filter((item) => item.driverKind === kind)
                .map((item) => (
                  <option key={item.instanceId} value={item.instanceId}>
                    {item.displayName}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Rounds used: {count}/{MAX_REVIEW_ROUNDS}, saved for this chat on this device. Only the scope
        you write is copied; main-chat and terminal history are excluded.
      </p>
      <div className="flex flex-wrap gap-2">
        {review ? (
          <Button
            size="sm"
            disabled={!canOperate || busy || active || !completed || count >= MAX_REVIEW_ROUNDS}
            onClick={() => void start(review.mode)}
          >
            {count >= MAX_REVIEW_ROUNDS ? "Round limit reached" : `Start round ${count + 1}`}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              disabled={
                !canOperate || busy || !scope.trim() || !claude || !codex || Boolean(saved.error)
              }
              onClick={() => void start("pair")}
            >
              Review with Claude + Codex
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canOperate || busy || !scope.trim() || !codex || Boolean(saved.error)}
              onClick={() => void start("codex")}
            >
              Check with Codex
            </Button>
          </>
        )}
      </div>
      {count >= MAX_REVIEW_ROUNDS ? (
        <p className="text-xs">
          Three-round limit reached. Review the results and decide what to do in the main chat.
        </p>
      ) : review && !completed ? (
        <p className="text-xs text-muted-foreground">
          Review chats must finish before the next round. Unconfirmed starts are never replayed
          automatically.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {review?.rounds.map((round) => (
        <div key={round.number} className="space-y-1 border-t border-border pt-2">
          <h3 className="text-xs font-medium">Round {round.number}</h3>
          {round.members.map((member) => (
            <Button
              key={member.threadId}
              size="sm"
              variant="ghost"
              onClick={() => onOpenThread(member.threadId)}
            >
              {member.label} ·{" "}
              {member.outcome === "accepted" ? "Open review" : "Start unconfirmed · open chat"}
            </Button>
          ))}
        </div>
      ))}
      {latest?.members.map((member, index) => {
        const shell = index === 0 ? firstShell : secondShell;
        const reply = index === 0 ? firstReply : secondReply;
        const ref = index === 0 ? firstRef : secondRef;
        return (
          <div key={member.threadId} className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{member.label}</h3>
              {threadRuntimeIsActive(shell?.runtime) ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canOperate || busy}
                  onClick={() => {
                    void interruptTurn({
                      environmentId: parent.environmentId,
                      input: { threadId: member.threadId },
                    }).then((result) => {
                      if (result._tag === "Failure")
                        setError("Could not stop this review. Open its chat to check its state.");
                    });
                  }}
                >
                  Stop
                </Button>
              ) : null}
            </div>
            {shell?.hasPendingApprovals || shell?.hasPendingUserInput ? (
              <Button size="sm" variant="outline" onClick={() => onOpenThread(member.threadId)}>
                Open review to answer
              </Button>
            ) : null}
            {reply ? (
              <ChatMarkdown
                reader
                text={reply}
                cwd={parent.worktreePath ?? parent.localSession?.cwd ?? workspaceRoot}
                {...(ref ? { threadRef: ref } : {})}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {shell?.runtime?.status ?? "Waiting for the review chat…"}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
