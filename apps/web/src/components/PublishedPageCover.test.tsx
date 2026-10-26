// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { StarkPublishedPageDocument } from "@starkfuture/contracts";
import { PublishedPageCover } from "./PublishedPageCover";

let root: Root;
let container: HTMLDivElement;
const observers = new Map<Element, (visible?: boolean) => void>();
const openPage = vi.fn();

function page(name: string, source = "<h1>Real page title</h1>"): StarkPublishedPageDocument {
  return {
    root: name,
    path: "index.html",
    mimeType: "text/html",
    source,
    assets: [],
    warnings: [],
    publicUrl: null,
  };
}

function deferred() {
  let resolve!: (value: StarkPublishedPageDocument) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<StarkPublishedPageDocument>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      target?: Element;
      constructor(
        private callback: (entries: Pick<IntersectionObserverEntry, "isIntersecting">[]) => void,
      ) {}
      observe(target: Element) {
        this.target = target;
        observers.set(target, (visible = true) => this.callback([{ isIntersecting: visible }]));
      }
      disconnect() {
        if (this.target) observers.delete(this.target);
      }
    },
  );
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { publishedPages: { openPage } },
  });
  openPage.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  observers.clear();
  vi.unstubAllGlobals();
});

it("reads only visible covers and releases a slot before the next read", async () => {
  const first = deferred();
  const second = deferred();
  const third = deferred();
  openPage
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  await act(() =>
    root.render(
      <>
        {["one", "two", "three"].map((name) => (
          <PublishedPageCover key={name} root={name} title={name} />
        ))}
      </>,
    ),
  );
  expect(openPage).not.toHaveBeenCalled();
  await act(() => [...observers.values()].forEach((visible) => visible()));
  expect(openPage.mock.calls.map(([input]) => input.root)).toEqual(["one", "two"]);
  await act(() => first.resolve(page("one")));
  expect(openPage.mock.calls.map(([input]) => input.root)).toEqual(["one", "two", "three"]);
  await act(() => {
    second.resolve(page("two"));
    third.resolve(page("three"));
  });
  expect(container.querySelectorAll("iframe")).toHaveLength(3);
});

it("skips unmounted queued covers and does not retry a missing index", async () => {
  const first = deferred();
  const second = deferred();
  openPage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await act(() =>
    root.render(
      <>
        {["one", "two", "three"].map((name) => (
          <PublishedPageCover key={name} root={name} title={name} />
        ))}
      </>,
    ),
  );
  await act(() => [...observers.values()].forEach((visible) => visible()));
  await act(() => root.render(<PublishedPageCover key="one" root="one" title="one" />));
  await act(() => {
    first.reject(new Error("Missing index"));
    second.resolve(page("two"));
  });
  expect(openPage).toHaveBeenCalledTimes(2);
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("one");
  expect(container.textContent).not.toContain("Missing index");
  expect(observers.size).toBe(0);
});

it("skips a queued cover that leaves the viewport until it becomes visible again", async () => {
  const first = deferred();
  const second = deferred();
  const third = deferred();
  openPage
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  await act(() =>
    root.render(
      <>
        {["one", "two", "three"].map((name) => (
          <PublishedPageCover key={name} root={name} title={name} />
        ))}
      </>,
    ),
  );
  const callbacks = [...observers.values()];
  await act(() => callbacks.forEach((visible) => visible()));
  await act(() => callbacks[2]!(false));
  await act(() => first.resolve(page("one")));
  expect(openPage).toHaveBeenCalledTimes(2);
  await act(() => callbacks[2]!(true));
  expect(openPage).toHaveBeenCalledTimes(3);
  await act(() => {
    second.resolve(page("two"));
    third.resolve(page("three"));
  });
});

it("retains an in-flight and completed cover when previews are hidden and enabled again", async () => {
  const result = deferred();
  openPage.mockReturnValueOnce(result.promise);
  await act(() => root.render(<PublishedPageCover root="one" title="one" />));
  await act(() => [...observers.values()].forEach((visible) => visible()));
  await act(() => root.render(<PublishedPageCover root="one" title="one" enabled={false} />));
  await act(() => root.render(<PublishedPageCover root="one" title="one" />));
  await act(() => result.resolve(page("one")));
  expect(container.querySelector("iframe")?.srcdoc).toContain("Real page title");
  await act(() => root.render(<PublishedPageCover root="one" title="one" enabled={false} />));
  await act(() => root.render(<PublishedPageCover root="one" title="one" />));
  expect(openPage).toHaveBeenCalledTimes(1);
  expect(container.querySelector("iframe")?.srcdoc).toContain("Real page title");
});

it("retains real page styling while removing scripts, remote resources and reader bridges", async () => {
  openPage.mockResolvedValue(
    page(
      "one",
      '<style>h1{color:blue}</style><h1>Actual cover</h1><script>alert(1)</script><img src="https://remote.invalid/private"><form action="https://remote.invalid">Submit</form>',
    ),
  );
  await act(() => root.render(<PublishedPageCover root="one" title="one" />));
  await act(() => [...observers.values()].forEach((visible) => visible()));
  const frame = container.querySelector("iframe")!;
  const source = new DOMParser().parseFromString(frame.srcdoc, "text/html");
  expect(source.querySelector("h1")?.textContent).toBe("Actual cover");
  expect(source.querySelector("style")?.textContent).toBeDefined();
  expect(source.documentElement.outerHTML).toContain("h1{color:blue}");
  expect(source.querySelector("script,form")).toBeNull();
  expect(source.querySelector("img")?.hasAttribute("src")).toBe(false);
  expect(source.querySelector("meta")?.content).toContain("script-src 'none'");
  expect(source.querySelector("meta")?.content).toContain("connect-src 'none'");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.tabIndex).toBe(-1);
});
