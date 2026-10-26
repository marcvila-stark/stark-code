// @vitest-environment jsdom
import type { VoiceInputState } from "@starkfuture/client-runtime/voice-input";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ComposerDictationStatus } from "./ComposerDictationStatus";
import { NativeDictationMeter } from "./nativeDictationMeter";

let root: Root;
let container: HTMLDivElement;
let meter: NativeDictationMeter;
const onParentRender = vi.fn();

function Parent({ phase }: { phase: VoiceInputState["phase"] }) {
  useEffect(() => {
    onParentRender();
  });
  return (
    <ComposerDictationStatus phase={phase} meter={meter} onStop={() => {}} onCancel={() => {}} />
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
  meter = new NativeDictationMeter();
  onParentRender.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const timer = () => container.querySelector('[role="timer"]');
const status = () => container.querySelector('[role="status"]');
const bars = () => [...container.querySelectorAll<HTMLElement>("[data-dictation-waveform] > span")];
async function render(phase: VoiceInputState["phase"]) {
  await act(() => root.render(<Parent phase={phase} />));
}

it("shows real microphone samples without rerendering the editor or animating silence", async () => {
  meter.start();
  await render("recording");
  expect(status()?.textContent).toBe("Listening");
  expect(bars()).toHaveLength(24);
  expect(bars().every((bar) => bar.style.height === "3px")).toBe(true);
  const rendersBeforeSamples = onParentRender.mock.calls.length;
  await act(() => {
    meter.sample(0);
    meter.sample(0.25);
    meter.sample(1);
  });
  expect(
    bars()
      .slice(-3)
      .map((bar) => bar.style.height),
  ).toEqual(["3px", "18.5px", "34px"]);
  expect(onParentRender).toHaveBeenCalledTimes(rendersBeforeSamples);
  const heights = bars().map((bar) => bar.style.height);
  await act(() => vi.advanceTimersByTime(3000));
  expect(bars().map((bar) => bar.style.height)).toEqual(heights);
  expect(timer()?.textContent).toBe("Recording duration: 00:03");
  expect(onParentRender).toHaveBeenCalledTimes(rendersBeforeSamples);
  expect(container.querySelector("[data-dictation-waveform]")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  expect(timer()?.getAttribute("aria-live")).toBe("off");
  expect(status()?.contains(timer())).toBe(false);
});

it("starts elapsed time at native recording, freezes it on stop, and resets for a new recording", async () => {
  await render("preparing");
  expect(status()?.textContent).toBe("Starting…");
  expect(timer()).toBeNull();
  expect(bars()).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  await act(() => vi.advanceTimersByTime(20_000));
  await act(() => meter.start());
  await render("recording");
  expect(timer()?.textContent).toBe("Recording duration: 00:00");
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTime(65_900));
  await act(() => meter.stop());
  await render("transcribing");
  expect(status()?.textContent).toBe("Transcribing…");
  expect(timer()?.textContent).toBe("Recording duration: 01:05");
  expect(vi.getTimerCount()).toBe(0);
  await act(() => vi.advanceTimersByTime(10_000));
  expect(timer()?.textContent).toBe("Recording duration: 01:05");
  await act(() => meter.reset());
  await render("preparing");
  expect(timer()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await act(() => meter.start());
  await render("recording");
  expect(timer()?.textContent).toBe("Recording duration: 00:00");
  await act(() => vi.advanceTimersByTime(1000));
  expect(timer()?.textContent).toBe("Recording duration: 00:01");
});

it("removes the clock when inactive and unsubscribes from samples on unmount", async () => {
  const subscribe = meter.subscribe;
  const unsubscribed = vi.fn();
  vi.spyOn(meter, "subscribe").mockImplementation((listener) => {
    const unsubscribe = subscribe(listener);
    return () => {
      unsubscribed();
      unsubscribe();
    };
  });
  meter.start();
  await render("recording");
  expect(vi.getTimerCount()).toBe(1);
  await render("idle");
  expect(container.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  await render("error");
  expect(container.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  await act(() => root.render(null));
  expect(unsubscribed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
