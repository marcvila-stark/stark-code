import type { NativeAgentReply, ScopedThreadRef } from "@starkfuture/contracts";
import { useState } from "react";
import ChatMarkdown from "./ChatMarkdown";
import { FinishEvidenceCard } from "./chat/FinishEvidenceCard";
import { InlineReadableReply } from "./chat/InlineReadableReply";
import { deriveNativeFinishEvidence } from "./chat/nativeFinishEvidence";
import { ReaderSelectionToolbar } from "./reader/ReaderSelectionToolbar";

/** Capture is a chronological transcript; arriving replies never replace the source being read. */
export function NativeReplyTranscript(props: {
  replies: ReadonlyArray<NativeAgentReply>;
  threadRef: ScopedThreadRef;
  cwd: string;
  error?: string | null | undefined;
  onQuoteText?: ((text: string, label: string) => boolean) | undefined;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setViewport}
      className="scrollbar-gutter-both min-h-0 min-w-0 flex-1 overflow-auto px-5 py-6 @min-[52rem]/native-shell:px-8"
      data-native-reply-transcript
      aria-label="Native replies"
    >
      {props.error ? (
        <p role="status" className="mb-5 text-sm text-muted-foreground">
          Replies could not be refreshed. The terminal is still available.
        </p>
      ) : null}
      {props.replies.length === 0 ? (
        <p className="text-sm text-muted-foreground">Completed replies appear here.</p>
      ) : (
        <div className="mx-auto max-w-3xl space-y-10">
          {props.replies.map((reply) => (
            <NativeReply
              key={reply.id}
              reply={reply}
              threadRef={props.threadRef}
              cwd={props.cwd}
              viewport={viewport}
              onQuoteText={props.onQuoteText}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NativeReply({
  reply,
  threadRef,
  cwd,
  viewport,
  onQuoteText,
}: {
  reply: NativeAgentReply;
  threadRef: ScopedThreadRef;
  cwd: string;
  viewport: HTMLElement | null;
  onQuoteText?: ((text: string, label: string) => boolean) | undefined;
}) {
  const [source, setSource] = useState<HTMLDivElement | null>(null);
  const provider = reply.provider === "claude" ? "Claude" : "Codex";
  return (
    <article className="min-w-0" data-native-reply-id={reply.id}>
      <div className="mb-3 text-xs font-medium text-muted-foreground">{provider}</div>
      {reply.truncated ? (
        <p className="mb-3 text-xs text-muted-foreground">
          This captured reply was shortened. Read the full reply in Terminal.
        </p>
      ) : null}
      {onQuoteText ? (
        <ReaderSelectionToolbar
          viewport={viewport}
          source={source}
          label={`${provider} · ${reply.text.replace(/\s+/g, " ").slice(0, 90)}`}
          onQuote={onQuoteText}
        />
      ) : null}
      <InlineReadableReply
        answerId={reply.id}
        answer={reply.text}
        threadRef={threadRef}
        cwd={cwd}
        completed
        truncated={reply.truncated === true}
        initiallyReadable
      >
        <div ref={setSource} aria-label="Original reply">
          <ChatMarkdown
            reader
            remoteImagePolicy="click-to-load"
            text={reply.text}
            cwd={cwd}
            threadRef={threadRef}
          />
        </div>
      </InlineReadableReply>
      {reply.evidence ? (
        <FinishEvidenceCard evidence={deriveNativeFinishEvidence(reply.id, reply.evidence)} />
      ) : null}
    </article>
  );
}
