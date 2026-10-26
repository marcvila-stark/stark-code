// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  DesktopBridge,
  NativeDictationEvent,
  NativeDictationBridge,
} from "@starkfuture/contracts";
import { useComposerDictation } from "./useComposerDictation";
import { ComposerDictationControl } from "./ComposerDictationControl";
import { ComposerDictationStatus } from "./ComposerDictationStatus";
import { TooltipProvider } from "../ui/tooltip";

let root: Root;
let container: HTMLDivElement;
let bridge: NativeDictationBridge;
let emit: (event: NativeDictationEvent) => void;
let voice: ReturnType<typeof useComposerDictation>;
let text: string;
const commit = vi.fn((_previous: string, next: string) => {
  text = next;
  return true;
});

function Harness({ owner = "thread-a", disabled = false }: { owner?: string; disabled?: boolean }) {
  const current = useComposerDictation({
    ownerKey: owner,
    disabled,
    readText: () => text,
    readSelection: () => ({ start: text.length, end: text.length }),
    subscribe: () => () => {},
    commit,
  });
  useLayoutEffect(() => {
    voice = current;
  });
  return (
    <TooltipProvider>
      <ComposerDictationControl voice={current} disabled={disabled} />
      {current.busy ? (
        <ComposerDictationStatus
          phase={current.state.phase}
          meter={current.meter}
          onStop={current.stop}
          onCancel={current.cancel}
        />
      ) : null}
      <output>{current.state.phase}</output>
    </TooltipProvider>
  );
}
const render = (owner = "thread-a", disabled = false) =>
  act(() => root.render(<Harness owner={owner} disabled={disabled} />));
const button = (label: string) => {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
};
const sessionId = () => vi.mocked(bridge.start).mock.calls.at(-1)![0].sessionId;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  text = "Please fix";
  commit.mockClear();
  bridge = {
    availability: vi.fn(async () => ({ available: true })),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onEvent: vi.fn((listener) => {
      emit = listener;
      return () => {};
    }),
  };
  window.desktopBridge = { dictation: bridge, getSystemLocale: () => "en-GB" } as DesktopBridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("finishes dictation into the draft and keeps submission blocked until the final result", async () => {
  await render();
  await act(() => button("Dictate a message").click());
  expect(voice.busy).toBe(true);
  expect(vi.mocked(bridge.start).mock.calls[0]?.[0].locale).toBe("en-GB");
  expect(button("Preparing dictation").disabled).toBe(true);
  await act(() => emit({ sessionId: sessionId(), type: "recording" }));
  await act(() => button("Finish dictation").click());
  expect(voice.isBusy()).toBe(true);
  expect(commit).not.toHaveBeenCalled();
  expect(button("Transcribing").disabled).toBe(true);
  await act(() => emit({ sessionId: sessionId(), type: "transcript", text: "the tests" }));
  expect(text).toBe("Please fix the tests");
  expect(voice.busy).toBe(false);
});

it("cancels on navigation and ignores the old transcript", async () => {
  await render();
  await act(() => button("Dictate a message").click());
  const oldId = sessionId();
  await render("thread-b");
  expect(bridge.cancel).toHaveBeenCalledWith(oldId);
  await act(() => emit({ sessionId: oldId, type: "transcript", text: "old answer" }));
  expect(commit).not.toHaveBeenCalled();
});

it("cancels on Escape, when hidden, and when an approval takes the composer", async () => {
  await render();
  await act(() => button("Dictate a message").click());
  await act(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })),
  );
  expect(voice.isBusy()).toBe(false);
  await act(() => button("Dictate a message").click());
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(voice.isBusy()).toBe(false);
  await act(() => button("Dictate a message").click());
  await render("thread-a", true);
  expect(voice.isBusy()).toBe(false);
  expect(bridge.cancel).toHaveBeenCalledTimes(3);
  expect(commit).not.toHaveBeenCalled();
});

it("does not offer a microphone in clients without the native bridge", async () => {
  delete window.desktopBridge;
  await render();
  expect(container.querySelector("button")).toBeNull();
  expect(bridge.availability).not.toHaveBeenCalled();
});

it("keeps an unavailable microphone disabled and never starts recording", async () => {
  vi.mocked(bridge.availability).mockResolvedValue({
    available: false,
    reason: "On-device speech recognition is not available.",
  });
  await render();
  const mic = button("On-device speech recognition is not available.");
  expect(mic.disabled).toBe(true);
  await act(() => mic.click());
  expect(bridge.start).not.toHaveBeenCalled();
});
