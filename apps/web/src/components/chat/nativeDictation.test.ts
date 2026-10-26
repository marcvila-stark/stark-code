import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { NativeDictationEvent } from "@starkfuture/contracts";
import type { VoiceInputState } from "@starkfuture/client-runtime/voice-input";
import {
  NativeDictationController,
  nativeDictationLocale,
  type NativeDictationBridge,
  type NativeDictationTarget,
} from "./nativeDictation";

function setup(initial = "Fix this") {
  let owner = "thread-a";
  let text = initial;
  let listener: ((event: NativeDictationEvent) => void) | undefined;
  let onDraftChange: (() => void) | undefined;
  const states: VoiceInputState[] = [];
  const unsubscribe = vi.fn();
  const unsubscribeDraft = vi.fn(() => {
    onDraftChange = undefined;
  });
  const bridge: NativeDictationBridge = {
    availability: vi.fn(async () => ({ available: true })),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onEvent: vi.fn((next) => {
      listener = next;
      return unsubscribe;
    }),
  };
  const commit = vi.fn((previous: string, next: string) => {
    if (previous !== text) return false;
    text = next;
    return true;
  });
  const target: NativeDictationTarget = {
    ownerKey: owner,
    readText: () => text,
    selection: { start: initial.length, end: initial.length },
    subscribe: (next) => {
      onDraftChange = next;
      return unsubscribeDraft;
    },
    commit,
  };
  const controller = new NativeDictationController(
    bridge,
    () => owner,
    (state) => states.push(state),
  );
  const id = () => vi.mocked(bridge.start).mock.calls.at(-1)![0].sessionId;
  const emit = (
    event: Omit<NativeDictationEvent, "sessionId"> & {
      text?: string;
      message?: string;
      audioLevel?: number;
      finalizing?: boolean;
    },
    sessionId = id(),
  ) => listener!({ ...event, sessionId } as NativeDictationEvent);
  return {
    controller,
    bridge,
    target,
    commit,
    states,
    id,
    emit,
    unsubscribe,
    unsubscribeDraft,
    readText: () => text,
    changeText: (next: string) => {
      text = next;
      onDraftChange?.();
    },
    changeOwner: (next: string) => {
      owner = next;
    },
  };
}

describe("native dictation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("streams bounded microphone history without rerendering the composer for each sample", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const h = setup();
    const meter = h.controller.meter;
    h.controller.start(h.target, "en-US");
    expect(meter.getSnapshot().startedAt).toBeNull();
    h.emit({ type: "recording" });
    expect(meter.getSnapshot().startedAt).toBe(1000);
    const phaseUpdates = h.states.length;
    for (let i = 0; i < 30; i++) h.emit({ type: "recording", audioLevel: i / 100 });
    expect(meter.getSnapshot().levels).toEqual(Array.from({ length: 24 }, (_, i) => (i + 6) / 100));
    expect(h.states).toHaveLength(phaseUpdates);
    expect(meter.getSnapshot().startedAt).toBe(1000);
    const valid = meter.getSnapshot();
    for (const audioLevel of [NaN, Infinity, -0.1, 1.1]) {
      h.emit({ type: "recording", audioLevel });
    }
    h.emit({ type: "recording", audioLevel: 1 }, "other-session");
    expect(meter.getSnapshot()).toBe(valid);

    now.mockReturnValue(4500);
    h.controller.stop();
    const stopped = meter.getSnapshot();
    expect(stopped.stoppedAt).toBe(4500);
    h.emit({ type: "recording", audioLevel: 1 });
    expect(meter.getSnapshot()).toBe(stopped);
    h.emit({ type: "transcript", text: "words" });
    expect(meter.getSnapshot()).toEqual({ levels: [], startedAt: null, stoppedAt: null });
  });

  it("clears the meter on cancel and ignores samples from the previous recording", () => {
    const h = setup();
    const meter = h.controller.meter;
    const changed = vi.fn();
    const unsubscribe = meter.subscribe(changed);
    h.controller.start(h.target, "en-US");
    const oldId = h.id();
    h.emit({ type: "recording", audioLevel: 0.4 });
    expect(changed).toHaveBeenCalled();
    h.controller.cancel();
    expect(meter.getSnapshot().levels).toEqual([]);
    expect(meter.getSnapshot().startedAt).toBeNull();
    changed.mockClear();
    h.controller.start(h.target, "en-US");
    h.emit({ type: "recording", audioLevel: 0.9 }, oldId);
    expect(changed).not.toHaveBeenCalled();
    expect(h.states.at(-1)?.phase).toBe("preparing");
    h.emit({ type: "recording", audioLevel: 0 });
    expect(meter.getSnapshot().levels).toEqual([0]);
    unsubscribe();
    changed.mockClear();
    h.emit({ type: "recording", audioLevel: 0.5 });
    expect(changed).not.toHaveBeenCalled();
    h.emit({ type: "error", message: "Microphone disconnected." });
    expect(meter.getSnapshot().startedAt).toBeNull();
  });

  it("freezes the timer and shows transcription when the native recording limit ends audio", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const h = setup();
    h.controller.start(h.target, "en-US");
    h.emit({ type: "recording", audioLevel: 0.4 });
    now.mockReturnValue(301_000);
    h.emit({ type: "recording", finalizing: true });
    expect(h.states.at(-1)?.phase).toBe("transcribing");
    expect(h.controller.meter.getSnapshot().stoppedAt).toBe(301_000);
    expect(h.controller.busy).toBe(true);
    expect(h.bridge.stop).not.toHaveBeenCalled();
    const snapshot = h.controller.meter.getSnapshot();
    h.emit({ type: "recording", audioLevel: 1 });
    expect(h.controller.meter.getSnapshot()).toBe(snapshot);
    h.emit({ type: "transcript", text: "the tests" });
    expect(h.readText()).toBe("Fix this the tests");
    expect(h.controller.busy).toBe(false);
  });

  it("normalizes macOS POSIX locale modifiers and falls back from invalid locale values", () => {
    expect(nativeDictationLocale("en_US@rg=gezzzz", "fr-FR")).toBe("en-US");
    expect(nativeDictationLocale("en-US@rg=gezzzz", "fr-FR")).toBe("en-US");
    expect(nativeDictationLocale("not a language", "fr-FR")).toBe("fr-FR");
    expect(nativeDictationLocale(null, "bad language")).toBe("en-US");
  });
  it("inserts one final transcript at the captured selection without sending anything", () => {
    const h = setup("Fix 👩‍💻 now");
    h.target.selection = { start: 4, end: 9 };
    h.controller.start(h.target, "en-US");
    expect(h.controller.busy).toBe(true);
    expect(h.commit).not.toHaveBeenCalled();
    h.emit({ type: "recording" });
    h.controller.stop();
    h.controller.stop();
    expect(h.bridge.stop).toHaveBeenCalledTimes(1);
    expect(h.states.at(-1)?.phase).toBe("transcribing");
    h.emit({ type: "transcript", text: "the tests" });
    h.emit({ type: "transcript", text: "duplicate" });
    expect(h.readText()).toBe("Fix the tests now");
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.unsubscribeDraft).toHaveBeenCalledOnce();
    expect(h.controller.busy).toBe(false);
  });

  it("keeps the draft after an edit followed by undo while recording", () => {
    const h = setup();
    h.controller.start(h.target, "en-US");
    h.changeText("Changed");
    h.changeText("Fix this");
    h.emit({ type: "transcript", text: "and test" });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.readText()).toBe("Fix this");
    expect(h.states.at(-1)?.error).toContain("draft changed");
  });

  it("rejects late results after cancel, even when a new recording already started", () => {
    const h = setup();
    h.controller.start(h.target, "en-US");
    const old = h.id();
    h.controller.cancel();
    h.controller.start(h.target, "en-US");
    h.emit({ type: "transcript", text: "old words" }, old);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.controller.busy).toBe(true);
    h.emit({ type: "transcript", text: "new words" });
    expect(h.readText()).toBe("Fix this new words");
  });

  it("cancels rather than writing to a different conversation", () => {
    const h = setup();
    h.controller.start(h.target, "en-US");
    h.changeOwner("thread-b");
    h.emit({ type: "transcript", text: "wrong conversation" });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.bridge.cancel).toHaveBeenCalledWith(h.id());
    expect(h.controller.busy).toBe(false);
  });

  it("shows permission errors and lets the user retry", () => {
    const h = setup();
    h.controller.start(h.target, "en-US");
    h.emit({ type: "error", message: "Allow microphone access in System Settings." });
    expect(h.states.at(-1)?.error).toContain("System Settings");
    expect(h.controller.busy).toBe(false);
    h.controller.start(h.target, "en-US");
    h.emit({ type: "transcript", text: "try again" });
    expect(h.commit).toHaveBeenCalledOnce();
  });

  it("ignores start failure after cancellation and another start", async () => {
    const h = setup();
    let rejectStart!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    vi.mocked(h.bridge.start).mockReturnValueOnce(pending);
    h.controller.start(h.target, "en-US");
    h.controller.cancel();
    h.controller.start(h.target, "en-US");
    rejectStart(new Error("old failure"));
    await pending.catch(() => {});
    expect(h.states.at(-1)?.phase).toBe("preparing");
    expect(h.controller.busy).toBe(true);
  });

  it("stays transcribing if a ready event arrives after finish, and reports empty speech", () => {
    const h = setup();
    h.controller.start(h.target, "en-US");
    h.emit({ type: "recording" });
    h.controller.stop();
    h.emit({ type: "recording" });
    expect(h.states.at(-1)?.phase).toBe("transcribing");
    h.emit({ type: "transcript", text: "  " });
    expect(h.states.at(-1)?.error).toContain("No speech");
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("disposes the microphone and subscriptions without applying a late result", () => {
    const h = setup();
    h.controller.start(h.target, "en-US");
    h.controller.dispose();
    h.emit({ type: "transcript", text: "late" });
    expect(h.bridge.cancel).toHaveBeenCalledOnce();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.unsubscribeDraft).toHaveBeenCalledOnce();
    expect(h.commit).not.toHaveBeenCalled();
  });
});
