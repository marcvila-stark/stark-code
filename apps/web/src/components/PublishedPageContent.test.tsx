// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { StarkPublishedPageDocument } from "@starkfuture/contracts";
import { PublishedPageContent } from "./PublishedPageContent";

const page: StarkPublishedPageDocument = {
  root: "demo",
  path: "guide/index.html",
  source: '<h1>Guide</h1><a href="../next.html">Next</a>',
  mimeType: "text/html",
  assets: [],
  warnings: [],
  publicUrl: "https://pages.starkfuture.com/demo/guide/index.html",
};
let container: HTMLDivElement;
let root: Root;
const exit = vi.fn();
const navigate = vi.fn();
const openLink = vi.fn();
const quote = vi.fn();
const render = (expanded: boolean) =>
  act(() =>
    root.render(
      <PublishedPageContent
        document={page}
        expanded={expanded}
        onExitExpanded={exit}
        onNavigate={navigate}
        onQuote={quote}
        quotePage={{ kind: "published", root: page.root, path: page.path, title: "Guide" }}
      />,
    ),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [exit, navigate, openLink, quote]) mock.mockReset();
  quote.mockReturnValue(true);
  window.desktopBridge = {
    openStarkPagesLink: openLink,
  } as unknown as NonNullable<Window["desktopBridge"]>;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("quotes only after an explicit click and rejects foreign or stale frame selections", async () => {
  await render(true);
  const frame = container.querySelector("iframe")!;
  const selectionToken = new DOMParser()
    .parseFromString(frame.srcdoc, "text/html")
    .querySelector("script[nonce]")!
    .getAttribute("nonce");
  const data = {
    source: "stark-published-page",
    type: "selection",
    selectionToken,
    text: "A selected sentence",
    title: "Injected title",
    url: "https://evil.invalid",
  };
  const send = (
    payload: unknown,
    origin = "null",
    source: MessageEventSource | null = frame.contentWindow,
  ) =>
    act(() => window.dispatchEvent(new MessageEvent("message", { data: payload, origin, source })));
  await send(data, window.location.origin);
  await send(data, "null", window);
  await send({ ...data, selectionToken: "old" });
  await send({ ...data, text: "x".repeat(8001) });
  expect(container.querySelector("button")).toBeNull();
  await send(data);
  expect(quote).not.toHaveBeenCalled();
  const action = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Quote in chat"),
  )!;
  await act(() => action.click());
  expect(quote).toHaveBeenCalledExactlyOnceWith({
    text: "A selected sentence",
    page: { kind: "published", root: "demo", path: "guide/index.html", title: "Guide" },
    url: page.publicUrl,
  });
  expect(container.querySelector("button")).toBeNull();
  await send({ ...data, text: "" });
  expect(container.querySelector("button")).toBeNull();
});

it("explains oversized selections and preserves a quote if the composer cannot accept it", async () => {
  await render(true);
  const frame = container.querySelector("iframe")!;
  const selectionToken = new DOMParser()
    .parseFromString(frame.srcdoc, "text/html")
    .querySelector("script[nonce]")!
    .getAttribute("nonce");
  const send = (text: string, tooLong = false) =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "null",
          data: {
            source: "stark-published-page",
            type: "selection",
            selectionToken,
            text,
            tooLong,
          },
        }),
      ),
    );
  await send("", true);
  expect(container.textContent).toContain("Shorten selection to 8,000 characters");
  const button = () => container.querySelector<HTMLButtonElement>("button")!;
  expect(button().disabled).toBe(true);
  await act(() => button().click());
  expect(quote).not.toHaveBeenCalled();
  await send("Valid selection");
  quote.mockReturnValueOnce(false);
  await act(() => button().click());
  expect(button()).not.toBeNull();
  await act(() => button().click());
  expect(quote).toHaveBeenCalledTimes(2);
  expect(container.querySelector("button")).toBeNull();
});

it("quotes selected markdown text only from within the displayed document", async () => {
  const markdown = {
    ...page,
    mimeType: "text/markdown",
    source: "# Guide\n\nSelected markdown sentence",
  };
  await act(() =>
    root.render(
      <PublishedPageContent
        document={markdown}
        onQuote={quote}
        quotePage={{ kind: "published", root: page.root, path: page.path, title: "Guide" }}
      />,
    ),
  );
  const paragraph = container.querySelector("p")!;
  const selected = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  selected.removeAllRanges();
  selected.addRange(range);
  await act(() => paragraph.dispatchEvent(new Event("pointerup", { bubbles: true })));
  expect(quote).not.toHaveBeenCalled();
  await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(quote).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "Selected markdown sentence",
      page: expect.objectContaining({ root: "demo", title: "Guide" }),
    }),
  );
  selected.removeAllRanges();
});

it("does not retain a selected quote after the published document changes", async () => {
  await render(true);
  const frame = container.querySelector("iframe")!;
  const token = new DOMParser()
    .parseFromString(frame.srcdoc, "text/html")
    .querySelector("script[nonce]")!
    .getAttribute("nonce");
  const data = {
    source: "stark-published-page",
    type: "selection",
    selectionToken: token,
    text: "Old page",
  };
  const send = () =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data, origin: "null", source: frame.contentWindow }),
      ),
    );
  await send();
  expect(container.querySelector("button")).not.toBeNull();
  await act(() =>
    root.render(
      <PublishedPageContent
        document={{ ...page, source: "<h1>Refreshed guide</h1>" }}
        quotePage={{ kind: "published", root: page.root, path: page.path, title: "Guide" }}
        onQuote={quote}
      />,
    ),
  );
  await send();
  expect(container.querySelector("button")).toBeNull();
  expect(quote).not.toHaveBeenCalled();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});

it("preserves the document and iframe reading position when expanding and returning to the panel", async () => {
  await render(false);
  const frame = container.querySelector("iframe")!;
  const childWindow = frame.contentWindow;
  const source = frame.srcdoc;
  const scroll = frame.contentDocument!.documentElement;
  scroll.scrollTop = 230;
  await render(true);
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(childWindow);
  expect(frame.srcdoc).toBe(source);
  expect(scroll.scrollTop).toBe(230);
  await render(false);
  expect(container.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(childWindow);
  expect(frame.srcdoc).toBe(source);
  expect(scroll.scrollTop).toBe(230);
});

it("accepts Escape only from the displayed opaque-origin frame while expanded and keeps link routing", async () => {
  await render(true);
  const frame = container.querySelector("iframe")!;
  const send = (
    data: unknown,
    origin = "null",
    source: MessageEventSource | null = frame.contentWindow,
  ) => act(() => window.dispatchEvent(new MessageEvent("message", { data, origin, source })));
  const escape = { source: "stark-published-page", type: "exit-expanded" };
  await send(escape, window.location.origin);
  await send(escape, "null", window);
  await send({ source: "other-page", type: "exit-expanded" });
  expect(exit).not.toHaveBeenCalled();
  await send(escape);
  expect(exit).toHaveBeenCalledOnce();
  await send({ source: "stark-published-page", type: "open-link", url: "../next.html" });
  expect(navigate).toHaveBeenCalledExactlyOnceWith("next.html");
  await send({ source: "stark-published-page", type: "open-link", url: "https://example.com" });
  expect(openLink).toHaveBeenCalledExactlyOnceWith("https://example.com/");
  await send({ source: "stark-published-page", type: "unknown", url: "../ignored.html" });
  expect(navigate).toHaveBeenCalledOnce();
  await render(false);
  await send(escape);
  expect(exit).toHaveBeenCalledOnce();
});
