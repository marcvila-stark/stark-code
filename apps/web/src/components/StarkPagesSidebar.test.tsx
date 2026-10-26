import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
vi.mock("./ui/input-group", () => ({
  InputGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InputGroupAddon: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InputGroupInput: (props: Record<string, unknown>) => <input {...props} />,
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipPopup: () => null,
}));
import { StarkPagesSidebar } from "./StarkPagesSidebar";

let renderer: ReactTestRenderer | undefined;
let listeners: Set<(event: MessageEvent) => void>;
let intervals: Set<() => void>;
let timeouts: Set<() => void>;
const frameWindow = { postMessage: vi.fn() };
const findMirror = vi.fn();
const openFollow = vi.fn();
const openLink = vi.fn();
const publish = vi.fn();
const props = (root = "/project", canPublish = true) => ({
  projectRoot: root,
  agent: "claude" as const,
  canPublish,
  onPublishRequest: publish,
  onClose: vi.fn(),
});
const panel = (root = "/project", canPublish = true) => (
  <StarkPagesSidebar {...props(root, canPublish)} />
);
const message = async (data: unknown, options: { source?: unknown; origin?: string } = {}) => {
  await act(async () => {
    const event = {
      data,
      source: options.source ?? frameWindow,
      origin: options.origin ?? "http://127.0.0.1:4317",
    } as MessageEvent;
    for (const listener of listeners) listener(event);
  });
};
const ready = (root = "/project") =>
  message({ v: 1, source: "stark-pages", type: "ready", root, port: 4317 });
const request = {
  v: 1,
  source: "stark-pages",
  type: "publish-request",
  page: { slug: "decision-one", title: "Decision" },
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  listeners = new Set();
  intervals = new Set();
  timeouts = new Set();
  for (const mock of [findMirror, openFollow, openLink, publish, frameWindow.postMessage])
    mock.mockReset();
  findMirror.mockImplementation(async (root: string) => ({ root, port: 4317 }));
  openFollow.mockResolvedValue(true);
  openLink.mockResolvedValue(true);
  vi.stubGlobal("window", {
    desktopBridge: {
      getStarkPagesMirror: findMirror,
      openStarkPagesExternal: openFollow,
      openStarkPagesLink: openLink,
    },
    setInterval: (callback: () => void) => {
      intervals.add(callback);
      return callback;
    },
    clearInterval: (callback: () => void) => intervals.delete(callback),
    setTimeout: (callback: () => void) => {
      timeouts.add(callback);
      return callback;
    },
    clearTimeout: (callback: () => void) => timeouts.delete(callback),
    addEventListener: (_name: string, callback: (event: MessageEvent) => void) =>
      listeners.add(callback),
    removeEventListener: (_name: string, callback: (event: MessageEvent) => void) =>
      listeners.delete(callback),
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(intervals.size).toBe(0);
  expect(timeouts.size).toBe(0);
  expect(listeners.size).toBe(0);
  vi.unstubAllGlobals();
});
const mount = async () => {
  await act(async () => {
    renderer = create(panel(), {
      createNodeMock: (element) =>
        element.type === "iframe" ? { contentWindow: frameWindow } : null,
    });
  });
};

it("starts Pages on open, waits for readiness, then polls without relaunching", async () => {
  let complete!: (mirror: { root: string; port: number }) => void;
  const ensure = vi.fn(
    () =>
      new Promise<{ root: string; port: number }>((resolve) => {
        complete = resolve;
      }),
  );
  window.desktopBridge!.ensureStarkPagesMirror = ensure;
  await mount();
  expect(renderer!.root.findAllByType("iframe")).toHaveLength(0);
  expect(
    renderer!.root
      .findAllByType("p")
      .flatMap((node) => node.children)
      .join(" "),
  ).toContain("Starting Pages");
  await act(async () => {
    for (const check of intervals) check();
  });
  expect(ensure).toHaveBeenCalledExactlyOnceWith("/project");
  expect(findMirror).not.toHaveBeenCalled();
  await act(async () => {
    complete({ root: "/project", port: 4317 });
  });
  expect(renderer!.root.findByType("iframe").props.src).toBe("http://127.0.0.1:4317/panel");
  await act(async () => {
    for (const check of intervals) check();
  });
  expect(findMirror).toHaveBeenCalledExactlyOnceWith("/project");
  expect(ensure).toHaveBeenCalledTimes(1);
});

it("shows a recoverable startup failure and retries only when requested", async () => {
  const ensure = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ root: "/project", port: 4317 });
  window.desktopBridge!.ensureStarkPagesMirror = ensure;
  findMirror.mockResolvedValue(null);
  await mount();
  expect(renderer!.root.findByProps({ role: "status" }).children.join(" ")).toContain(
    "Pages could not start",
  );
  await act(async () => {
    for (const check of intervals) check();
  });
  expect(ensure).toHaveBeenCalledTimes(1);
  const retryButton = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Retry Pages"))!;
  await act(async () => retryButton.props.onClick());
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
  expect(renderer!.root.findAllByType("iframe")).toHaveLength(1);
});

it("accepts requests only from its own ready frame, then updates capabilities when the active thread changes", async () => {
  await mount();
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await message(
    { v: 1, source: "stark-pages", type: "ready", root: "/project", port: 4317 },
    { source: {} },
  );
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await ready();
  expect(frameWindow.postMessage).toHaveBeenLastCalledWith(
    { v: 1, source: "stark-host", type: "host", canPublish: true, agent: "claude" },
    "http://127.0.0.1:4317",
  );
  await message(request, { origin: "http://127.0.0.1:4318" });
  expect(publish).not.toHaveBeenCalled();
  await message(request);
  expect(publish).toHaveBeenCalledExactlyOnceWith("decision-one", "Decision");
  await act(async () => renderer!.update(panel("/project", false)));
  expect(frameWindow.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ canPublish: false }),
    "http://127.0.0.1:4317",
  );
  await message(request);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "Stark plugin",
  );
});

it("rechecks the project on switching and refuses a foreign ready root", async () => {
  await mount();
  await ready();
  await act(async () => renderer!.update(panel("/other")));
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await ready("/project");
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "different project",
  );
  await ready("/other");
  await message(request);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(findMirror).toHaveBeenLastCalledWith("/other");
});

it("validates follower and source links before opening the external browser", async () => {
  await mount();
  await ready();
  const send = (type: string, url: string) => message({ v: 1, source: "stark-pages", type, url });
  await send("open-external", "http://127.0.0.1:4318/follow?slug=decision-one");
  await send("open-external", "https://example.com/follow?slug=decision-one");
  await send("open-link", "javascript:alert(1)");
  await send("open-link", "https://user:password@example.com");
  expect(openFollow).not.toHaveBeenCalled();
  expect(openLink).not.toHaveBeenCalled();
  await send("open-external", "http://127.0.0.1:4317/follow?slug=decision-one");
  expect(openFollow).toHaveBeenCalledExactlyOnceWith({
    projectRoot: "/project",
    url: "http://127.0.0.1:4317/follow?slug=decision-one",
  });
  await send("open-link", "https://starkfuture.com/source");
  expect(openLink).toHaveBeenCalledExactlyOnceWith("https://starkfuture.com/source");
});

it("shows the empty state when a mirror stops and resets trust when it returns", async () => {
  await mount();
  await ready();
  findMirror.mockResolvedValue(null);
  await act(async () => {
    for (const check of intervals) check();
  });
  expect(renderer!.root.findAllByType("iframe")).toHaveLength(0);
  expect(
    renderer!.root
      .findAllByType("p")
      .flatMap((node) => node.children)
      .join(" "),
  ).toContain("No pages yet");
  findMirror.mockResolvedValue({ root: "/project", port: 4317 });
  await act(async () => {
    for (const check of intervals) check();
  });
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await ready();
  await message(request);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("keeps publishing disabled for Codex even if the caller requests it", async () => {
  await mount();
  await act(async () => renderer!.update(<StarkPagesSidebar {...props()} agent="codex" />));
  await ready();
  expect(frameWindow.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ canPublish: false, agent: "codex" }),
    "http://127.0.0.1:4317",
  );
  await message(request);
  expect(publish).not.toHaveBeenCalled();
});

it("explains a missing handshake and retries with a fresh, untrusted frame", async () => {
  await mount();
  await act(async () => {
    for (const timeout of timeouts) timeout();
  });
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "did not connect",
  );
  const retry = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Retry Pages"));
  await act(async () => retry!.props.onClick());
  expect(findMirror).toHaveBeenCalledTimes(2);
  expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
  await message(request);
  expect(publish).not.toHaveBeenCalled();
  await ready();
  await message(request);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(timeouts.size).toBe(0);
});

it("reports a failed browser open without an unhandled rejection", async () => {
  await mount();
  await ready();
  openLink.mockRejectedValue(new Error("Browser unavailable"));
  await message({ v: 1, source: "stark-pages", type: "open-link", url: "https://starkfuture.com" });
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "Could not open this link",
  );
});

it("opens named pages only from the trusted active frame and pins a tab to its page", async () => {
  const onOpenPage = vi.fn();
  const tab = (active: boolean) => (
    <StarkPagesSidebar
      {...props()}
      initialSlug="decision-one"
      active={active}
      onOpenPage={onOpenPage}
    />
  );
  await act(async () => {
    renderer = create(tab(true), {
      createNodeMock: (element) =>
        element.type === "iframe" ? { contentWindow: frameWindow } : null,
    });
  });
  const show = { ...request, type: "show" };
  await message(show);
  expect(onOpenPage).not.toHaveBeenCalled();
  await ready();
  expect(frameWindow.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "host", presentation: "document" }),
    "http://127.0.0.1:4317",
  );
  expect(frameWindow.postMessage).toHaveBeenCalledWith(
    { v: 1, source: "stark-host", type: "pause" },
    "http://127.0.0.1:4317",
  );
  await message(show, { source: {} });
  await message(show, { origin: "http://127.0.0.1:4318" });
  expect(onOpenPage).not.toHaveBeenCalled();
  await message(show);
  expect(onOpenPage).toHaveBeenCalledExactlyOnceWith({
    kind: "local",
    slug: "decision-one",
    title: "Decision",
  });
  const iframe = renderer!.root.findByType("iframe");
  expect(iframe.props.src).toBe("http://127.0.0.1:4317/panel?slug=decision-one");
  await act(async () => renderer!.update(tab(false)));
  await message({ ...show, page: { slug: "another-page", title: "Another" } });
  await message(request);
  expect(onOpenPage).toHaveBeenCalledTimes(1);
  expect(publish).not.toHaveBeenCalled();
  expect(renderer!.root.findByType("iframe")).toBe(iframe);
  await act(async () => renderer!.update(tab(true)));
  expect(frameWindow.postMessage).toHaveBeenLastCalledWith(
    { v: 1, source: "stark-host", type: "show", slug: "decision-one" },
    "http://127.0.0.1:4317",
  );
});

it("keeps initial and followed catalog pages as previews until the user opens a tab", async () => {
  const onOpenPage = vi.fn();
  await act(async () => {
    renderer = create(<StarkPagesSidebar {...props()} onOpenPage={onOpenPage} />, {
      createNodeMock: (element) =>
        element.type === "iframe" ? { contentWindow: frameWindow } : null,
    });
  });
  await ready();
  await message({ ...request, type: "show" });
  expect(onOpenPage).not.toHaveBeenCalled();
  await message({
    ...request,
    type: "show",
    page: { slug: "new-report", title: "New report" },
  });
  expect(onOpenPage).not.toHaveBeenCalled();
  const open = renderer!.root
    .findAllByType("button")
    .find((item) => item.children.includes("Open page in tab"))!;
  await act(async () => open.props.onClick());
  expect(onOpenPage).toHaveBeenCalledExactlyOnceWith({
    kind: "local",
    slug: "new-report",
    title: "New report",
  });
});

it("offers local page quotes only for the trusted current selection and an explicit active click", async () => {
  const onQuote = vi.fn(() => true);
  const view = (active: boolean) => (
    <StarkPagesSidebar {...props()} active={active} onQuote={onQuote} />
  );
  await act(async () => {
    renderer = create(view(true), {
      createNodeMock: (element) =>
        element.type === "iframe" ? { contentWindow: frameWindow } : null,
    });
  });
  await ready();
  await message({ ...request, type: "show" });
  const host = frameWindow.postMessage.mock.calls.findLast(([data]) => data.type === "host")![0];
  const selection = {
    v: 1,
    source: "stark-pages",
    type: "selection",
    selectionToken: host.selectionToken,
    slug: "decision-one",
    text: "The chosen evidence",
    title: "Untrusted title",
  };
  const actions = () =>
    renderer!.root
      .findAllByType("button")
      .filter((button) => button.children.includes("Quote in chat"));
  await message(selection, { source: {} });
  await message(selection, { origin: "http://127.0.0.1:4318" });
  await message({ ...selection, selectionToken: "old" });
  await message({ ...selection, slug: "another-page" });
  expect(actions()).toHaveLength(0);
  await message({ ...selection, text: "", tooLong: true });
  expect(actions()[0]!.props.disabled).toBe(true);
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "Shorten selection",
  );
  await message(selection);
  expect(onQuote).not.toHaveBeenCalled();
  expect(actions()).toHaveLength(1);
  onQuote.mockReturnValueOnce(false);
  await act(async () => actions()[0]!.props.onClick());
  expect(actions()).toHaveLength(1);
  await act(async () => actions()[0]!.props.onClick());
  expect(onQuote).toHaveBeenCalledTimes(2);
  expect(onQuote).toHaveBeenLastCalledWith({
    text: "The chosen evidence",
    page: { kind: "local", slug: "decision-one", title: "Decision" },
    projectRoot: "/project",
  });
  expect(actions()).toHaveLength(0);
  await act(async () => renderer!.update(view(false)));
  await message(selection);
  expect(actions()).toHaveLength(0);
  await act(async () => renderer!.update(view(true)));
  await ready();
  await message({ ...request, type: "show" });
  await message(selection);
  expect(actions()).toHaveLength(0);
});

it("starts in a local library, opens the selected document and returns to the catalog", async () => {
  const page = {
    slug: "weekly-report",
    title: "Weekly report",
    type: "report",
    status: "draft",
    mtime: "2026-10-23T10:00:00.000Z",
  };
  const list = vi.fn().mockResolvedValue([page]);
  window.desktopBridge!.listStarkPages = list;
  const changed = vi.fn();
  const opened = vi.fn();
  await act(async () => {
    renderer = create(
      <StarkPagesSidebar {...props()} onPageChange={changed} onOpenPage={opened} />,
      {
        createNodeMock: (element) =>
          element.type === "iframe" ? { contentWindow: frameWindow } : null,
      },
    );
  });
  expect(list).toHaveBeenCalledExactlyOnceWith("/project");
  expect(renderer!.root.findAllByType("iframe")).toHaveLength(0);
  const card = renderer!.root.findByProps({ "aria-label": "Open Weekly report" });
  await act(async () => card.props.onClick());
  expect(opened).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledExactlyOnceWith({
    kind: "local",
    slug: page.slug,
    title: page.title,
  });
  expect(renderer!.root.findByType("iframe").props.src).toBe(
    "http://127.0.0.1:4317/panel?slug=weekly-report",
  );
  await ready();
  expect(frameWindow.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "host", presentation: "document", embeddedControls: true }),
    "http://127.0.0.1:4317",
  );
  const back = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("All pages"))!;
  await act(async () => back.props.onClick());
  expect(renderer!.root.findAllByType("iframe")).toHaveLength(0);
  expect(renderer!.root.findAllByProps({ "aria-label": "Open Weekly report" })).toHaveLength(1);
});

it("ignores an old folder catalog response after changing working folders", async () => {
  let complete!: (pages: readonly unknown[]) => void;
  const list = vi.fn().mockImplementation((root: string) =>
    root === "/project"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : Promise.resolve([]),
  );
  window.desktopBridge!.listStarkPages = list;
  await mount();
  await act(async () => renderer!.update(panel("/other")));
  await act(async () =>
    complete([
      { slug: "old-page", title: "Old folder page", type: "report", status: "draft", mtime: "" },
    ]),
  );
  expect(renderer!.root.findAllByProps({ "aria-label": "Open Old folder page" })).toHaveLength(0);
  expect(renderer!.root.findByType("h3").children.join("")).toBe("Your first page starts in chat");
});
