import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NativeDictationAvailability } from "@starkfuture/contracts";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@starkfuture/client-runtime/voice-input";
import {
  NativeDictationController,
  nativeDictationLocale,
  type NativeDictationTarget,
} from "./nativeDictation";
import { NativeDictationMeter } from "./nativeDictationMeter";

export function useComposerDictation(input: {
  ownerKey: string;
  disabled: boolean;
  readText: NativeDictationTarget["readText"];
  readSelection: () => NativeDictationTarget["selection"];
  subscribe: NativeDictationTarget["subscribe"];
  commit: NativeDictationTarget["commit"];
}) {
  const latest = useRef(input);
  const controller = useRef<NativeDictationController | null>(null);
  const [meter] = useState(() => new NativeDictationMeter());
  const [state, setState] = useState<VoiceInputState>({
    phase: "idle",
    error: null,
    errorAction: null,
  });
  const [availability, setAvailability] = useState<NativeDictationAvailability | null>(null);
  const bridge = window.desktopBridge?.dictation;

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const active = new NativeDictationController(
      bridge,
      () => (latest.current.disabled ? "" : latest.current.ownerKey),
      (next) => {
        if (alive) setState(next);
      },
      meter,
    );
    controller.current = active;
    void bridge
      .availability()
      .then((result) => {
        if (alive) setAvailability(result);
      })
      .catch(() => {
        if (alive)
          setAvailability({
            available: false,
            reason: "Dictation is unavailable. Restart Stark Code and try again.",
          });
      });
    const hidden = () => {
      if (document.hidden) active.cancel();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active.busy) {
        event.preventDefault();
        event.stopPropagation();
        active.cancel();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("keydown", escape, true);
    return () => {
      alive = false;
      active.dispose();
      controller.current = null;
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("keydown", escape, true);
    };
  }, [bridge, meter]);

  useLayoutEffect(() => {
    const changedOwner = latest.current.ownerKey !== input.ownerKey;
    latest.current = input;
    if (changedOwner || (input.disabled && controller.current?.busy)) controller.current?.cancel();
  }, [input]);

  const start = useCallback(() => {
    const target = latest.current;
    if (target.disabled || !availability?.available) return;
    controller.current?.start(
      { ...target, selection: target.readSelection() },
      nativeDictationLocale(window.desktopBridge?.getSystemLocale?.(), navigator.language),
    );
  }, [availability]);
  const stop = useCallback(() => controller.current?.stop(), []);
  const cancel = useCallback(() => controller.current?.cancel(), []);
  const isBusy = useCallback(() => controller.current?.busy ?? false, []);

  return {
    supported: bridge !== undefined,
    available: availability?.available ?? false,
    unavailableReason: availability?.reason ?? "Preparing dictation…",
    state,
    meter,
    busy: voiceInputBlocksSubmission(state),
    isBusy,
    start,
    stop,
    cancel,
  };
}
