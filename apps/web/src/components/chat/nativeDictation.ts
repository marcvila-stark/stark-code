import type { DesktopBridge } from "@starkfuture/contracts";
import { randomUUID } from "../../lib/utils";
import { NativeDictationMeter } from "./nativeDictationMeter";
import {
  resolveTranscriptCommit,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@starkfuture/client-runtime/voice-input";

export type NativeDictationBridge = NonNullable<DesktopBridge["dictation"]>;
export type NativeDictationTarget = {
  ownerKey: string;
  readText: () => string;
  selection: VoiceDraftSnapshot["selection"];
  subscribe: (onChange: () => void) => () => void;
  commit: (previous: string, text: string, cursor: number) => boolean;
};

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function nativeDictationLocale(
  systemLocale: string | null | undefined,
  browserLocale: string,
): string {
  for (const locale of [systemLocale, browserLocale, "en-US"]) {
    if (!locale) continue;
    try {
      // macOS can return POSIX modifiers, such as en_US@rg=gezzzz, instead of BCP-47.
      const normalized = new Intl.Locale(locale.split("@")[0]!.replaceAll("_", "-")).baseName;
      if (normalized.length <= 64) return normalized;
    } catch {}
  }
  return "en-US";
}

/** Owns one native microphone session and rejects results for drafts changed since Start. */
export class NativeDictationController {
  private active: {
    id: string;
    target: NativeDictationTarget;
    captured: VoiceDraftSnapshot;
    revision: number;
    locale: string;
    unsubscribe: () => void;
  } | null = null;
  private state = IDLE;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly bridge: NativeDictationBridge,
    private readonly readOwner: () => string,
    private readonly onStateChange: (state: VoiceInputState) => void,
    readonly meter = new NativeDictationMeter(),
  ) {
    this.unsubscribe = bridge.onEvent((event) => {
      const active = this.active;
      if (!active || event.sessionId !== active.id) return;
      if (this.readOwner() !== active.target.ownerKey) {
        this.cancel();
        return;
      }
      if (event.type === "recording") {
        // A delayed ready event must not turn a finishing recording back on.
        if (this.state.phase === "preparing") {
          this.meter.start();
          this.update("recording");
        }
        if (this.state.phase !== "recording") return;
        if (event.finalizing) {
          this.meter.stop();
          this.update("transcribing");
          return;
        }
        if (event.audioLevel !== undefined) {
          this.meter.sample(event.audioLevel);
        }
        return;
      }
      this.releaseTarget();
      if (event.type === "cancelled") this.update("idle");
      else if (event.type === "error") this.fail(event.message);
      else {
        const result = resolveTranscriptCommit(
          active.captured,
          { ...active.captured, text: active.target.readText(), revision: active.revision },
          event.text,
          active.locale,
        );
        if (result.kind === "empty") this.fail("No speech was detected. Try again.");
        else if (
          result.kind === "stale" ||
          !active.target.commit(active.captured.text, result.text, result.selection.end)
        ) {
          this.fail("The draft changed during dictation. Your draft was kept; please try again.");
        } else this.update("idle");
      }
    });
  }

  get busy(): boolean {
    return this.active !== null;
  }

  start(target: NativeDictationTarget, locale: string): void {
    if (this.active) return;
    const text = target.readText();
    const active = {
      id: randomUUID(),
      target,
      captured: { ownerKey: target.ownerKey, text, selection: target.selection, revision: 0 },
      revision: 0,
      locale,
      unsubscribe: () => {},
    };
    let previous = text;
    active.unsubscribe = target.subscribe(() => {
      const current = target.readText();
      if (current !== previous) {
        active.revision += 1;
        previous = current;
      }
    });
    this.active = active;
    this.update("preparing");
    void this.bridge.start({ sessionId: active.id, locale }).catch((error: unknown) => {
      if (this.active !== active) return;
      this.releaseTarget();
      this.fail(error instanceof Error ? error.message : "Could not start dictation. Try again.");
    });
  }

  stop(): void {
    const active = this.active;
    if (!active || this.state.phase !== "recording") return;
    this.meter.stop();
    this.update("transcribing");
    void this.bridge.stop(active.id).catch(() => {
      if (this.active !== active) return;
      this.cancel();
      this.fail("Could not finish dictation. Try again.");
    });
  }

  cancel(): void {
    const active = this.active;
    this.releaseTarget();
    this.update("idle");
    if (active) void this.bridge.cancel(active.id).catch(() => {});
  }

  dispose(): void {
    this.cancel();
    this.unsubscribe();
  }

  private releaseTarget(): void {
    this.active?.unsubscribe();
    this.active = null;
    this.meter.reset();
  }

  private update(phase: VoiceInputState["phase"]): void {
    this.state = { phase, error: null, errorAction: null };
    this.onStateChange(this.state);
  }

  private fail(error: string): void {
    this.state = { phase: "error", error, errorAction: "retry" };
    this.onStateChange(this.state);
  }
}
