import type { VoiceInputState } from "@starkfuture/client-runtime/voice-input";
import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import type { NativeDictationMeter } from "./nativeDictationMeter";

type DictationPhase = VoiceInputState["phase"];
const SAMPLE_COUNT = 24;

const RecordingTime = memo(function RecordingTime({
  phase,
  startedAt,
  stoppedAt,
}: {
  phase: DictationPhase;
  startedAt: number;
  stoppedAt: number | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (phase !== "recording" || stoppedAt !== null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase, stoppedAt]);
  const seconds = Math.max(0, Math.floor(((stoppedAt ?? now) - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return (
    <span role="timer" aria-live="off" className="shrink-0 tabular-nums">
      <span className="sr-only">Recording duration: </span>
      {minutes}:{remainder}
    </span>
  );
});

/** Only this small indicator subscribes to microphone samples; the editor stays still. */
export function ComposerDictationStatus({
  phase,
  meter,
  onStop,
  onCancel,
}: {
  phase: DictationPhase;
  meter: NativeDictationMeter;
  onStop: () => void;
  onCancel: () => void;
}) {
  const snapshot = useSyncExternalStore(meter.subscribe, meter.getSnapshot, meter.getSnapshot);
  if (phase === "idle" || phase === "error") return null;
  const startedAt = phase === "preparing" ? null : snapshot.startedAt;
  const padding = SAMPLE_COUNT - snapshot.levels.length;
  return (
    <div
      data-composer-dictation-status="true"
      data-chat-composer-footer="true"
      className="px-3 pb-3 sm:px-4 sm:pb-4"
    >
      <div className="flex min-h-16 min-w-0 items-center gap-3 rounded-2xl bg-stark-gold-surface px-3 py-2 ring-1 ring-inset ring-stark-gold/20">
        <button
          type="button"
          aria-label="Cancel dictation"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stark-gold"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-3 @[30rem]/composer-surface:gap-5">
          <div className="flex min-h-10 shrink-0 flex-col justify-center gap-0.5">
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="text-sm font-medium text-foreground"
            >
              {phase === "recording"
                ? "Listening"
                : phase === "preparing"
                  ? "Starting…"
                  : "Transcribing…"}
            </span>
            {startedAt !== null ? (
              <span className="text-xs text-muted-foreground">
                <RecordingTime
                  key={startedAt}
                  phase={phase}
                  startedAt={startedAt}
                  stoppedAt={snapshot.stoppedAt}
                />
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-1 justify-center overflow-hidden">
            {startedAt !== null ? (
              <span
                aria-hidden="true"
                data-dictation-waveform="true"
                className={`flex h-10 w-full max-w-56 items-center justify-center gap-0.5 @[30rem]/composer-surface:gap-1 ${phase === "recording" ? "text-stark-gold-foreground" : "text-muted-foreground/40"}`}
              >
                {Array.from({ length: SAMPLE_COUNT }, (_, index) => {
                  const level = snapshot.levels[index - padding] ?? 0;
                  return (
                    <span
                      key={index}
                      className={`min-w-0 max-w-1 flex-1 rounded-full bg-current ${index < 8 ? "hidden @[30rem]/composer-surface:block" : ""}`}
                      style={{
                        height: `${3 + Math.sqrt(level) * 31}px`,
                        opacity: index < padding ? 0.2 : 1,
                      }}
                    />
                  );
                })}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          aria-label={
            phase === "recording"
              ? "Finish dictation"
              : phase === "preparing"
                ? "Preparing dictation"
                : "Transcribing"
          }
          data-chat-composer-transition-actions="true"
          disabled={phase !== "recording"}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onStop}
          className="flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full bg-foreground px-3 text-sm font-medium text-background outline-none hover:bg-foreground/85 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stark-gold disabled:cursor-default disabled:opacity-30 @[30rem]/composer-surface:px-4"
        >
          <CheckIcon className="size-4" aria-hidden="true" />
          Done
        </button>
      </div>
    </div>
  );
}
