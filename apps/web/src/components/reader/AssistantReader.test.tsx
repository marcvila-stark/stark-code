// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AssistantReader } from "./AssistantReader";

const observers = new Set<() => void>();
vi.mock("../../lib/observeResize", () => ({
  observeResize: (_elements: unknown, callback: () => void) => {
    observers.add(callback);
    return () => observers.delete(callback);
  },
}));

let host: HTMLDivElement;
let root: Root;
let contentHeight = 800;
let viewportHeight = 500;
let replyTop = 0;
let composerTop = 500;
let composerHeight = 0;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const scroll = vi.fn();
const source =
  "# First section\n\nThe first paragraph remains visible.\n\n## Second section\n\nThe second paragraph.\n\n## Third section\n\nThe final paragraph.";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  host.style.overflowY = "auto";
  document.body.append(host);
  Object.defineProperty(host, "clientHeight", { get: () => viewportHeight });
  contentHeight = 800;
  viewportHeight = 500;
  replyTop = 0;
  composerTop = 500;
  composerHeight = 0;
  scroll.mockReset();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute("data-chat-composer-overlay"))
      return new DOMRect(0, composerTop, 640, composerHeight);
    if (this.hasAttribute("data-assistant-reader-content"))
      return new DOMRect(
        0,
        replyTop + (contentsButton() ? 40 : 0) - host.scrollTop,
        640,
        contentHeight,
      );
    return new DOMRect(0, 0, 640, this === host ? viewportHeight : 0);
  });
  vi.stubGlobal("innerHeight", 1000);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await measure(); // Popover focus restoration may finish on the next frame.
  host.remove();
  expect(observers.size).toBe(0);
  expect(frames.size).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const measure = async () => {
  await act(async () => {
    for (const callback of observers) callback();
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  });
};
const render = async (text = source, isStreaming = false) => {
  await act(async () =>
    root.render(
      <StrictMode>
        <AssistantReader contentKey={text} isStreaming={isStreaming}>
          <div className="chat-markdown">
            <ReactMarkdown>{text}</ReactMarkdown>
          </div>
        </AssistantReader>
      </StrictMode>,
    ),
  );
  await measure();
};
const contents = () => document.querySelector('nav[aria-label="Reply contents"]');
const contentsButton = () =>
  [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Contents ("),
  );
const openContents = async () => {
  await act(async () => contentsButton()!.click());
};

it("shows real section labels only when a completed reply exceeds its chat viewport", async () => {
  contentHeight = 500;
  await render();
  expect(contentsButton()).toBeUndefined();
  contentHeight = 700; // Taller than the chat viewport, but shorter than the whole window.
  await measure();
  expect(contents()).toBeNull();
  expect(contentsButton()?.textContent).toBe("Contents (3)");
  await openContents();
  expect([...contents()!.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "First section",
    "Second section",
    "Third section",
  ]);
  viewportHeight = 900;
  await measure();
  expect(contentsButton()).toBeUndefined();
  expect(contentsButton()).toBeUndefined();
  expect(host.textContent).toContain("The final paragraph.");
});

it("keeps the original DOM and scroll position stable while streaming and reveals contents on completion", async () => {
  const initial = "# First section\n\nThe first paragraph remains visible.";
  await render(initial, true);
  const original = host.querySelector(".chat-markdown p");
  await render(source, true);
  expect(contents()).toBeNull();
  expect(host.querySelector(".chat-markdown p")).toBe(original);
  await render(source, false);
  expect(contentsButton()).toBeDefined();
  expect(host.querySelector(".chat-markdown p")).toBe(original);
  expect(scroll).not.toHaveBeenCalled();
  expect(host.textContent).toContain("The first paragraph remains visible.");
});

it("recognizes standalone and run-in paragraph/list labels but excludes ordinary inline emphasis, quotes and code", async () => {
  await render(
    "**Overview:**\nFirst body.\n\n**Details:** Second body.\n\n**Next steps:**\nThird body.\n\nText **Inline:** continues.\n\n**No colon** continues.\n\n- **List label:** body\n- Ordinary **inline:** body\n\n- **Loose label:** body\n\n  More paragraph.\n\n> # Quoted heading\n\n```md\n# Code heading\n**Code label:**\n```",
  );
  await openContents();
  expect([...contents()!.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "Overview:",
    "Details:",
    "Next steps:",
    "List label:",
    "Loose label:",
  ]);
  expect(host.querySelector("pre")?.textContent).toContain("# Code heading");
});

it.each(["\n", "  \n"])(
  "recognizes standalone labels after Markdown line breaks (%j) and navigates the correct line",
  async (lineBreak) => {
    await render(
      [
        "**Leading:** Run-in body.",
        "**Second:**",
        "Body with ordinary **inline:** emphasis.",
        "**Third:**",
        "Third body.",
        "**Not standalone:** Continued body on the same line.",
        "**Fourth:**",
        "Last body.",
      ].join(lineBreak),
    );
    expect(host.querySelectorAll(".chat-markdown > p")).toHaveLength(1);
    expect(host.querySelectorAll(".chat-markdown br").length > 0).toBe(lineBreak !== "\n");
    await openContents();
    const links = [...contents()!.querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).toEqual([
      "Leading:",
      "Second:",
      "Third:",
      "Fourth:",
    ]);
    const target = [...host.querySelectorAll<HTMLElement>(".chat-markdown strong")].find(
      (element) => element.textContent === "Third:",
    );
    await act(async () => links[2]!.click());
    expect(scroll.mock.contexts[0]).toBe(target);
    expect(document.activeElement).toBe(target);
  },
);

it("does not invent contents for long responses with fewer than three sections", async () => {
  await render("# One section\n\nA long body.\n\n## Two sections\n\nMore body.");
  expect(contents()).toBeNull();
  expect(host.querySelectorAll(".chat-markdown h1, .chat-markdown h2")).toHaveLength(2);
});

it("navigates duplicate labels to their actual sections without changing the URL or hiding content", async () => {
  await render("## Same\n\nFirst.\n\n## Same\n\nSecond.\n\n## Last\n\nThird.");
  await openContents();
  const heading = host.querySelectorAll<HTMLElement>(".chat-markdown h2")[1]!;
  const links = contents()!.querySelectorAll("a");
  expect(links[0]!.hash).not.toBe(links[1]!.hash);
  const hash = window.location.hash;
  await act(async () => links[1]!.click());
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "auto" });
  expect(scroll.mock.contexts[0]).toBe(heading);
  expect(document.activeElement).toBe(heading);
  expect(contentsButton()?.getAttribute("aria-expanded")).toBe("false");
  expect(window.location.hash).toBe(hash);
  expect(host.querySelector(".chat-markdown")?.textContent).toContain("First.");
});

it("replaces the outline when completed content changes and never navigates old sections", async () => {
  await render();
  await render("## New one\n\nFirst.\n\n## New two\n\nSecond.\n\n## New three\n\nThird.");
  await openContents();
  expect([...contents()!.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "New one",
    "New two",
    "New three",
  ]);
  await act(async () => contents()!.querySelector("a")!.click());
  expect(document.activeElement?.textContent).toBe("New one");
});

it("keeps the reading anchor stable when contents is inserted above it and when the list opens", async () => {
  host.scrollTop = 160;
  await render(source, true);
  const original = host.querySelector<HTMLElement>("[data-assistant-reader-content]")!;
  const before = original.getBoundingClientRect().top;
  await render(source, false);
  expect(host.scrollTop).toBe(200);
  expect(original.getBoundingClientRect().top).toBe(before);
  await openContents();
  expect(original.getBoundingClientRect().top).toBe(before);
  expect(host.scrollTop).toBe(200);
  viewportHeight = 1000;
  await measure();
  expect(contentsButton()).toBeUndefined();
  expect(original.getBoundingClientRect().top).toBe(before);
  expect(host.scrollTop).toBe(160);
});

it("qualifies against the actual composer overlap and responds when it shrinks", async () => {
  const canvas = document.createElement("div");
  canvas.setAttribute("data-chat-canvas", "");
  host.replaceWith(canvas);
  canvas.append(host);
  const composer = document.createElement("div");
  composer.setAttribute("data-chat-composer-overlay", "true");
  canvas.append(composer);
  try {
    contentHeight = 450;
    composerTop = 300;
    composerHeight = 200;
    await render();
    expect(contentsButton()).toBeDefined();
    composerTop = 480;
    composerHeight = 20;
    await measure();
    expect(contentsButton()).toBeUndefined();
    composer.style.display = "none";
  } finally {
    canvas.replaceWith(host);
  }
});
