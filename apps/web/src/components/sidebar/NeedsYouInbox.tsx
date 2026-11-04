import { useMemo, useState } from "react";
import {
  BellDotIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  LogInIcon,
  RotateCcwIcon,
} from "lucide-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@starkfuture/client-runtime/state/models";
import { EnvironmentId, type ScopedThreadRef } from "@starkfuture/contracts";
import { collectNeedsYou } from "../../needsYou";
import { useNeedsYouSelection } from "../../needsYouSelection";
import { NativeAttentionSubscriptions, useNativeAttention } from "../../state/nativeAttention";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarNavigationButton } from "./SidebarNavigationButton";
import styles from "./needsYouInbox.module.css";

export function NeedsYouInbox({
  threads,
  projects,
  onOpenThread,
}: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  projects: ReadonlyArray<EnvironmentProject>;
  onOpenThread: (threadRef: ScopedThreadRef) => Promise<unknown> | void;
}) {
  const nativeByEnvironment = useNativeAttention((state) => state.byEnvironment);
  const entries = useMemo(
    () =>
      collectNeedsYou(
        threads,
        projects,
        Object.entries(nativeByEnvironment).flatMap(([id, rows]) =>
          rows.map((row) => ({ ...row, environmentId: EnvironmentId.make(id) })),
        ),
      ),
    [threads, projects, nativeByEnvironment],
  );
  const [open, setOpen] = useState(false);
  return (
    <>
      <NativeAttentionSubscriptions />
      {entries.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <SidebarNavigationButton
                aria-label={`Needs you, ${entries.length} ${entries.length === 1 ? "item" : "items"}`}
              />
            }
          >
            <BellDotIcon />
            <span>Needs you</span>
            <span className={styles.count}>{entries.length}</span>
          </PopoverTrigger>
          <PopoverPopup side="right" align="start" width="md" padding="compact">
            <div className={styles.heading}>
              <strong>Needs you</strong>
              <span>Across all folders</span>
            </div>
            <ul className={styles.list} aria-label="Chats waiting for you">
              {entries.map((entry) => {
                const Icon =
                  entry.kind === "question" || entry.kind === "input"
                    ? MessageCircleQuestionIcon
                    : entry.kind === "sign-in"
                      ? LogInIcon
                      : entry.kind === "lost"
                        ? RotateCcwIcon
                        : ShieldQuestionIcon;
                const action =
                  entry.kind === "question"
                    ? "Answer question"
                    : entry.kind === "input"
                      ? "Input needed"
                      : entry.kind === "sign-in"
                        ? "Sign in"
                        : entry.kind === "lost"
                          ? "Ask again"
                          : "Review approval";
                return (
                  <li key={entry.key}>
                    <button
                      type="button"
                      className={styles.entry}
                      aria-label={`${action}: ${entry.title}`}
                      onClick={() => {
                        if (entry.terminalId && entry.nativeProvider)
                          useNeedsYouSelection
                            .getState()
                            .openNative(entry.threadRef, entry.terminalId, entry.nativeProvider);
                        else if (entry.requestId)
                          useNeedsYouSelection.getState().open(entry.threadRef, entry.requestId);
                        setOpen(false);
                        void onOpenThread(entry.threadRef);
                      }}
                    >
                      <Icon aria-hidden="true" />
                      <span className={styles.entry_text}>
                        <strong>{entry.title}</strong>
                        <span>
                          {action} · {entry.folder} · {entry.provider}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </PopoverPopup>
        </Popover>
      ) : null}
    </>
  );
}
