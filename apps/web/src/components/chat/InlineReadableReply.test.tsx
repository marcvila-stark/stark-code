// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import { RESPONSE_VISUALS_MODEL, RESPONSE_VISUALS_VERSION } from "@starkfuture/contracts";
import { makeThreadFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({ allowed: true, generate: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/responseVisuals", () => ({
  responseVisualsEnvironment: { format: { permissionAtom: () => "visual-permission" } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.generate }));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

import { InlineReadableReply, revealReadableOverview } from "./InlineReadableReply";

let root: Root;
let container: HTMLDivElement;
let answerId = "";
let nextAnswerId = 0;
const thread = makeThreadFixture();
const threadRef = scopeThreadRef(thread.environmentId, thread.id);
const success = {
  _tag: "Success" as const,
  value: {
    summary: "A generated overview.",
    table: null,
    mermaid: null,
    reason: null,
    model: RESPONSE_VISUALS_MODEL,
    formatterVersion: RESPONSE_VISUALS_VERSION,
    cacheHit: false,
    generationUsage: null,
  },
};
const answer = "Keep this exact source, with `code` and [a reference](https://example.com).";
async function render(props: Partial<ComponentProps<typeof InlineReadableReply>> = {}) {
  await act(() =>
    root.render(
      <InlineReadableReply answerId={answerId} answer={answer} threadRef={threadRef} {...props}>
        <div data-assistant-citation-source="reply-one">
          <p>{props.answer ?? answer}</p>
        </div>
      </InlineReadableReply>,
    ),
  );
}
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
}
async function click(label: string) {
  const control = button(label);
  expect(control, `Expected ${label} button`).toBeDefined();
  await act(() => control!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  answerId = `reply-${++nextAnswerId}`;
  state.generate.mockReset().mockResolvedValue(success);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("generates in one click without a picker or replacing the quoteable source", async () => {
  await render();
  const source = container.querySelector("[data-assistant-citation-source]")!;
  const sourceText = source.firstElementChild!.firstChild!;
  const range = document.createRange();
  range.selectNodeContents(sourceText);
  window.getSelection()!.addRange(range);

  expect(state.generate).not.toHaveBeenCalled();
  await click("Make readable");
  expect(container.querySelector('[data-inline-readable="reading"]')).not.toBeNull();
  expect(container.querySelector("[data-assistant-citation-source]")).toBe(source);
  expect(window.getSelection()!.toString()).toBe(answer);
  expect(container.querySelector("select")).toBeNull();
  expect(state.generate).toHaveBeenCalledTimes(1);

  await click("Show original");
  expect(container.querySelector('[data-inline-readable="original"]')).not.toBeNull();
  expect(container.querySelector("[data-assistant-citation-source]")).toBe(source);
  expect(source.textContent).toBe(answer);
});

it("generates only for the clicked answer and reuses its summary across reading and original views", async () => {
  await render();
  await click("Make readable");
  expect(state.generate).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: { threadId: thread.id, answer, visualRequest: "auto" },
  });
  const original = container.querySelector("[data-assistant-citation-source]")!;
  expect(original.textContent).toBe(answer);
  expect(original.querySelector('[aria-label="AI overview"]')).toBeNull();
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    success.value.summary,
  );
  expect(container.querySelector("[data-inline-readable-overview] button")?.textContent).toBe(
    "Show original",
  );

  await click("Show original");
  expect(container.querySelector('[aria-label="AI overview"]')).toBeNull();
  await click("Make readable");
  expect(container.querySelector('[aria-label="AI overview"]')).not.toBeNull();
  expect(state.generate).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-assistant-citation-source]")).toBe(original);
});

it("keeps the original readable and blocks generation when permission is denied", async () => {
  state.allowed = false;
  await render();
  await click("Make readable");
  expect(button("Make readable")?.disabled).toBe(true);
  await click("Make readable");
  expect(state.generate).not.toHaveBeenCalled();
  expect(container.textContent).toContain("current permissions");
  expect(container.querySelector("[data-assistant-citation-source]")?.textContent).toBe(answer);
});

it.each([{ answer: "x".repeat(24_001) }, { truncated: true }])(
  "keeps long or truncated replies readable without sending incomplete content: %s",
  async (props) => {
    await render({ ...props, initiallyReadable: true });
    expect(button("Make readable")?.disabled).toBe(true);
    expect(container.textContent).toContain("The original is unchanged");
    expect(state.generate).not.toHaveBeenCalled();
  },
);

it("deduplicates clicks during generation and leaves the original usable after failure", async () => {
  let reject!: (error: Error) => void;
  state.generate.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await render({ initiallyReadable: true });
  const makeVisual = button("Make readable")!;
  await act(() => {
    makeVisual.click();
    makeVisual.click();
  });
  expect(state.generate).toHaveBeenCalledTimes(1);
  expect(button("Making readable…")?.disabled).toBe(true);
  await act(() => reject(new Error("Claude is disabled for this project.")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Claude is disabled for this project.",
  );
  expect(container.querySelector("[data-assistant-citation-source]")?.textContent).toBe(answer);
  await click("Make readable");
  expect(state.generate).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("does not show readability controls for an empty or still streaming response", async () => {
  await render({ answer: "" });
  expect(button("Make readable")).toBeUndefined();
  await render({ completed: false });
  expect(button("Make readable")).toBeUndefined();
  expect(state.generate).not.toHaveBeenCalled();
});

it("resets additions when the answer changes so a stale summary cannot attach to another reply", async () => {
  await render({ initiallyReadable: true });
  await click("Make readable");
  await render({ answerId: "reply-two", answer: "Another reply." });
  expect(container.querySelector('[aria-label="AI overview"]')).toBeNull();
  expect(container.querySelector("[data-assistant-citation-source]")?.textContent).toBe(
    "Another reply.",
  );
  expect(button("Make readable")).toBeDefined();
  expect(state.generate).toHaveBeenCalledTimes(1);
});

it("reveals the returned overview after one click and when reopening its cached result", async () => {
  container.style.overflowY = "auto";
  Object.defineProperty(container, "clientHeight", { value: 600 });
  container.scrollTop = 240;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(
      0,
      this.hasAttribute("data-inline-readable-overview") ? 100 - container.scrollTop : 0,
      600,
      600,
    );
  });
  await render();
  await click("Make readable");
  expect(container.scrollTop).toBe(84);
  await click("Show original");
  container.scrollTop = 700;
  await click("Make readable");
  expect(container.scrollTop).toBe(84);
  expect(state.generate).toHaveBeenCalledTimes(1);
});

it("keeps the user's reading position if they scrolled while generation was in progress", async () => {
  let resolve!: (value: typeof success) => void;
  state.generate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  container.style.overflowY = "auto";
  Object.defineProperty(container, "clientHeight", { value: 600 });
  container.scrollTop = 240;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 600));
  await render();
  const paragraph = container.querySelector("p")!;
  vi.spyOn(paragraph, "getBoundingClientRect").mockImplementation(
    () =>
      new DOMRect(
        0,
        container.querySelector('[data-inline-readable="reading"]') ? 120 : 100,
        300,
        100,
      ),
  );
  await click("Make readable");
  container.scrollTop = 300;
  await act(() => resolve(success));
  expect(container.scrollTop).toBe(320);
});

it("preserves reading and an in-flight visual across virtualized row remounts", async () => {
  let resolve!: (value: typeof success) => void;
  state.generate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await click("Make readable");
  await act(() => root.render(null));
  await render();
  expect(container.querySelector('[data-inline-readable="original"]')).not.toBeNull();
  expect(button("Making readable…")?.disabled).toBe(true);
  await act(() => resolve(success));
  expect(container.querySelector('[aria-label="AI overview"]')).not.toBeNull();
  await act(() => root.render(null));
  await render();
  expect(container.querySelector('[aria-label="AI overview"]')).not.toBeNull();
  expect(state.generate).toHaveBeenCalledTimes(1);
});

function controlledFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    frames,
    async advance() {
      const frame = frames.entries().next().value;
      expect(frame).toBeDefined();
      frames.delete(frame![0]);
      frame![1](0);
      await Promise.resolve();
    },
  };
}

it("settles through the list controller after a virtualizer restores the old bottom offset", async () => {
  const { advance, frames } = controlledFrames();
  const overview = document.createElement("div");
  container.append(overview);
  Object.defineProperties(container, {
    clientHeight: { value: 728 },
    scrollHeight: { value: 4000 },
  });
  container.scrollTop = 1934;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 52, 800, 728));
  vi.spyOn(overview, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 652 - container.scrollTop, 600, 300),
  );
  const scrollToOffset = vi.fn((offset: number) => {
    container.scrollTop = offset;
    return Promise.resolve();
  });
  const onSettled = vi.fn();
  const dispose = revealReadableOverview({
    overview,
    viewport: container,
    scrollToOffset,
    onSettled,
  });
  await advance();
  expect(scrollToOffset).toHaveBeenLastCalledWith(584);
  container.scrollTop = 1934; // A delayed virtualizer size measurement re-pins the bottom.
  await advance();
  expect(scrollToOffset).toHaveBeenCalledTimes(2);
  await advance();
  await advance();
  expect(overview.getBoundingClientRect().top).toBe(68);
  expect(onSettled).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  dispose();
});

it("cancels pending reveal navigation on a user gesture instead of pulling them back", async () => {
  const { advance, frames } = controlledFrames();
  const overview = document.createElement("div");
  container.append(overview);
  Object.defineProperties(container, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 3000 },
  });
  container.scrollTop = 1400;
  vi.spyOn(overview, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -600, 600, 300));
  let complete!: () => void;
  const scrollToOffset = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const cancelScroll = vi.fn();
  const onSettled = vi.fn();
  const dispose = revealReadableOverview({
    overview,
    viewport: container,
    scrollToOffset,
    cancelScroll,
    onSettled,
  });
  await advance();
  container.dispatchEvent(new Event("wheel"));
  complete();
  await Promise.resolve();
  expect(cancelScroll).toHaveBeenCalledOnce();
  expect(onSettled).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  dispose();
});

it("cancels a deferred list scroll when its conversation is left", async () => {
  const { advance, frames } = controlledFrames();
  const overview = document.createElement("div");
  container.append(overview);
  Object.defineProperties(container, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 3000 },
  });
  container.scrollTop = 1400;
  vi.spyOn(overview, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -600, 600, 300));
  let complete!: () => void;
  const cancelScroll = vi.fn();
  const onSettled = vi.fn();
  const dispose = revealReadableOverview({
    overview,
    viewport: container,
    scrollToOffset: () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    cancelScroll,
    onSettled,
  });
  await advance();
  dispose();
  complete();
  await Promise.resolve();
  expect(cancelScroll).toHaveBeenCalledOnce();
  expect(onSettled).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});
