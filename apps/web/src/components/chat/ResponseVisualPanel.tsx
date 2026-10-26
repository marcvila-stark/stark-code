import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ResponseVisualsInput,
  ResponseVisualsResult,
  ScopedThreadRef,
  NativeTurnEvidence,
  AssistantCitation,
  MessageId,
} from "@starkfuture/contracts";
import { useRef, useState, type CSSProperties } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { responseVisualsEnvironment } from "../../state/responseVisuals";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { FinishEvidenceCard } from "./FinishEvidenceCard";
import { deriveNativeFinishEvidence } from "./nativeFinishEvidence";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { ReaderSelectionToolbar } from "../reader/ReaderSelectionToolbar";

const ReaderFontSize = Schema.Literals([14, 16, 18, 20]);

export interface ReaderAnswer {
  readonly id: string;
  readonly text: string;
  readonly label: string;
  readonly truncated?: boolean;
  readonly evidence?: NativeTurnEvidence | undefined;
  readonly messageId?: MessageId | undefined;
}

/** Source stays verbatim; additions never replace the provider's answer. */
export function ResponseVisualPanel(props: {
  environmentId: EnvironmentId;
  answers: ReadonlyArray<ReaderAnswer>;
  cwd: string;
  threadRef: ScopedThreadRef;
  emptyMessage?: string | undefined;
  onQuoteText?: ((text: string, label: string) => boolean) | undefined;
  onCiteAssistantText?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
}) {
  const [chosen, setChosen] = useState("latest");
  const [pasted, setPasted] = useState("");
  const selected =
    (chosen === "latest"
      ? props.answers.at(-1)
      : props.answers.find((answer) => answer.id === chosen)) ?? props.answers.at(-1);
  const answer = chosen === "paste" ? pasted : (selected?.text ?? "");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Reply reader">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <label className="block text-xs">
          Reply to read
          <select
            aria-label="Reply to read"
            className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm"
            value={chosen === "paste" || chosen === "latest" ? chosen : (selected?.id ?? "latest")}
            onChange={(event) => setChosen(event.target.value)}
          >
            <option value="latest">
              {props.answers.length === 0
                ? "No completed replies yet"
                : "Latest reply (follow new replies)"}
            </option>
            {props.answers.toReversed().map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
            <option value="paste">Paste a reply…</option>
          </select>
        </label>
        {chosen === "paste" ? (
          <details open>
            <summary className="mb-2 cursor-pointer text-xs text-muted-foreground">
              Pasted source (collapse to read)
            </summary>
            <Textarea
              aria-label="Reply text"
              className="max-h-36"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={4}
            />
          </details>
        ) : null}
      </div>
      {chosen !== "paste" && selected?.evidence ? (
        <div className="max-h-64 shrink-0 overflow-auto px-3">
          <FinishEvidenceCard
            evidence={deriveNativeFinishEvidence(selected.id, selected.evidence)}
          />
        </div>
      ) : null}
      {answer ? (
        <VisualReader
          key={`${chosen === "paste" ? "paste" : selected?.id}:${answer}`}
          {...props}
          answer={answer}
          messageId={chosen === "paste" ? undefined : selected?.messageId}
          sourceLabel={chosen === "paste" ? "Pasted reply" : (selected?.label ?? "Reader reply")}
          truncated={chosen !== "paste" && selected?.truncated === true}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {props.emptyMessage ?? "Choose a completed reply, or paste text to read."}
        </p>
      )}
    </div>
  );
}

function VisualReader(props: {
  environmentId: EnvironmentId;
  answer: string;
  cwd: string;
  threadRef: ScopedThreadRef;
  truncated: boolean;
  messageId?: MessageId | undefined;
  sourceLabel: string;
  onQuoteText?: ((text: string, label: string) => boolean) | undefined;
  onCiteAssistantText?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [source, setSource] = useState<HTMLDivElement | null>(null);
  const [fontSize, setFontSize] = useLocalStorage("starkcode:reader-font-size", 16, ReaderFontSize);
  const canGenerate = useAtomValue(
    responseVisualsEnvironment.format.permissionAtom(props.environmentId),
  );
  const generate = useAtomCommand(responseVisualsEnvironment.format, { reportFailure: false });
  const [results, setResults] = useState<
    Partial<Record<NonNullable<ResponseVisualsInput["visualRequest"]>, ResponseVisualsResult>>
  >({});
  const [shown, setShown] = useState<NonNullable<ResponseVisualsInput["visualRequest"]> | null>(
    null,
  );
  const result = shown === null ? null : (results[shown] ?? null);
  const [busy, setBusy] = useState<NonNullable<ResponseVisualsInput["visualRequest"]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visualRequest, setVisualRequest] = useState<"auto" | "table" | "flowchart">("auto");
  const sending = useRef(false);
  const tooLong =
    props.answer.length > 24_000 || new TextEncoder().encode(props.answer).byteLength > 48 * 1024;
  async function makeVisual(request: NonNullable<ResponseVisualsInput["visualRequest"]>) {
    if (sending.current || !canGenerate || tooLong) return;
    setShown(request);
    setError(null);
    if (results[request]) {
      setResults((current) => ({
        ...current,
        [request]: { ...current[request]!, cacheHit: true },
      }));
      return;
    }
    sending.current = true;
    setBusy(request);
    setError(null);
    try {
      const response = await generate({
        environmentId: props.environmentId,
        input: { threadId: props.threadRef.threadId, answer: props.answer, visualRequest: request },
      });
      if (response._tag === "Failure") {
        const cause = squashAtomCommandFailure(response);
        setError(cause instanceof Error ? cause.message : "Could not prepare this reply overview.");
      } else setResults((current) => ({ ...current, [request]: response.value }));
    } finally {
      sending.current = false;
      setBusy(null);
    }
  }
  return (
    <div
      ref={setViewport}
      className="min-h-0 min-w-0 flex-1 overflow-auto p-4"
      data-reply-reader
      data-assistant-citation-viewport="true"
      style={{ "--reply-reader-size": `${fontSize}px` } as CSSProperties}
    >
      {props.messageId && props.onCiteAssistantText ? (
        <AssistantSelectionToolbar
          viewport={viewport}
          threadRef={props.threadRef}
          onCite={props.onCiteAssistantText}
        />
      ) : props.onQuoteText ? (
        <ReaderSelectionToolbar
          viewport={viewport}
          source={source}
          label={props.sourceLabel}
          onQuote={props.onQuoteText}
        />
      ) : null}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || !canGenerate || tooLong}
          onClick={() => void makeVisual(visualRequest)}
        >
          {busy !== null && busy !== "summary" ? "Making visual…" : "Make visual"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || !canGenerate || tooLong}
          onClick={() => void makeVisual("summary")}
        >
          {busy === "summary" ? "Summarizing…" : "Summarize"}
        </Button>
        <select
          aria-label="Visual format"
          className="max-w-full rounded-md border border-input bg-background p-2 text-xs"
          value={visualRequest}
          disabled={busy !== null}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "auto" || value === "table" || value === "flowchart") {
              setVisualRequest(value);
              setShown(value);
            }
          }}
        >
          <option value="auto">Choose useful additions</option>
          <option value="table">Table</option>
          <option value="flowchart">Flowchart</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Text size
          <select
            aria-label="Reader text size"
            className="rounded-md border border-input bg-background p-2 text-xs"
            value={fontSize}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value === 14 || value === 16 || value === 18 || value === 20) setFontSize(value);
            }}
          >
            <option value={14}>Small</option>
            <option value={16}>Standard</option>
            <option value={18}>Large</option>
            <option value={20}>Extra large</option>
          </select>
        </label>
        <p className="w-full text-xs text-muted-foreground">
          Reading uses no tokens. Summarize and Make visual use Sonnet for this reply only. Saved
          results are reused; the original stays below.
        </p>
        {tooLong ? (
          <p className="text-xs text-muted-foreground">
            This reply exceeds the generation limit. Paste a shorter excerpt to summarize or make
            visual.
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {result ? (
        <>
          <div className="mb-2 flex justify-end">
            <Button size="xs" variant="ghost" onClick={() => setShown(null)}>
              Hide overview
            </Button>
          </div>
          <ResponseVisualOverview result={result} />
        </>
      ) : null}
      <div className="min-w-0" aria-label="Original reply">
        {props.truncated ? (
          <p className="mb-3 text-sm text-muted-foreground">
            This captured reply was shortened. Read the full reply in the terminal.
          </p>
        ) : null}
        {result ? (
          <h3 className="mb-3 text-xs font-medium text-muted-foreground">Original reply</h3>
        ) : null}
        <div
          ref={setSource}
          data-assistant-citation-source={props.messageId}
          data-assistant-citation-environment={
            props.messageId ? props.threadRef.environmentId : undefined
          }
          data-assistant-citation-thread={props.messageId ? props.threadRef.threadId : undefined}
        >
          <ChatMarkdown
            reader
            remoteImagePolicy="click-to-load"
            text={props.answer}
            cwd={props.cwd}
            threadRef={props.threadRef}
          />
        </div>
      </div>
    </div>
  );
}

/* oxlint-disable react/no-array-index-key -- Generated tables are immutable and have no row-local state. */
export function ResponseVisualOverview({ result }: { result: ResponseVisualsResult }) {
  const usage = result.generationUsage;
  return (
    <section
      className="mb-6 min-w-0 space-y-4 rounded-xl border border-border bg-muted/30 p-4"
      aria-label="AI overview"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          AI overview
        </h3>
        <span className="text-xs text-muted-foreground">
          {result.cacheHit ? "Saved · no new model call" : "Sonnet"}
        </span>
      </div>
      {result.summary ? <p className="text-base leading-relaxed">{result.summary}</p> : null}
      {result.summaryBullets?.length ? (
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed">
          {result.summaryBullets.map((bullet, index) => (
            <li key={`${index}:${bullet}`}>{bullet}</li>
          ))}
        </ul>
      ) : null}
      {result.table ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {result.table.columns.map((column, index) => (
                  <th
                    key={`${index}:${column}`}
                    className="border-b border-border px-2 py-2 font-medium"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.table.rows.map((row, index) => (
                <tr key={`${index}:${row.join("|")}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${cellIndex}:${cell}`}
                      className="border-b border-border px-2 py-2 align-top break-words"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {result.mermaid ? (
        <ChatMarkdown
          cwd={undefined}
          text={`\x60\x60\x60mermaid\n${result.mermaid}\n\x60\x60\x60`}
        />
      ) : null}
      {result.reason ? <p className="text-sm text-muted-foreground">{result.reason}</p> : null}
      {usage ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Generation usage</summary>
          <p className="mt-2">
            Original call: {usage.freshInputTokens ?? "unreported"} fresh input,{" "}
            {usage.cacheReadInputTokens ?? "unreported"} cache-read,{" "}
            {usage.cacheWriteInputTokens ?? "unreported"} cache-write,{" "}
            {usage.outputTokens ?? "unreported"} output tokens.
            {usage.costUsd === null ? "" : ` CLI-reported cost: $${usage.costUsd.toFixed(4)}.`}
          </p>
        </details>
      ) : null}
    </section>
  );
}

/* oxlint-enable react/no-array-index-key */
