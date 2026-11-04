import { RuntimeRequestId, ThreadId, TurnItemId } from "@starkfuture/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { type PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

// Browser worker startup is verified in the live client; these tests exercise approval copy.
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const codexRead: PendingApproval = {
  requestId: RuntimeRequestId.make("codex-read"),
  requestKind: "command",
  createdAt: "2026-10-28T00:00:00Z",
  detail: "/bin/zsh -lc 'cat brief.md'",
  command: "/bin/zsh -lc 'cat brief.md'",
  responseCapability: "live",
};

const render = (approval: PendingApproval) =>
  act(() => {
    renderer = create(<ComposerPendingApprovalPanel approval={approval} pendingCount={1} />);
  });
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const labelled = (label: string) =>
  renderer!.root.findAll(
    (node) => typeof node.type === "string" && node.props["aria-label"] === label,
  );
const order = () => text(renderer!.root);

it("leads a wrapped read-only command with its effect and keeps the exact command one click away", () => {
  render(codexRead);
  const all = order();
  expect(all).toContain("Read-only command");
  expect(text(labelled("Command")[0]!)).toBe("cat brief.md");
  expect(all.indexOf("Expected to read only — shows brief.md.")).toBeLessThan(
    all.indexOf("cat brief.md"),
  );
  expect(all).not.toContain("No writes");
  expect(all).not.toContain("Not explained");
  expect(all).not.toContain("startup settings");
  expect(labelled("Exact command")).toHaveLength(0);

  const disclosure = renderer!.root.find(
    (node) => node.type === "button" && node.props["aria-expanded"] === false,
  );
  act(() => disclosure.props.onClick());
  expect(text(labelled("Exact command")[0]!)).toBe("/bin/zsh -lc 'cat brief.md'");
  expect(order()).toContain("The shell's startup settings may also run commands.");
  expect(order()).toContain(
    "The read-only label is based on the command text only. Aliases, shell startup files, environment variables and repository settings such as Git helpers can still run other programs.",
  );
});

it("does not call a command read-only when any part can write", () => {
  render({
    ...codexRead,
    detail: "/bin/zsh -lc 'cat a && git push'",
    command: "/bin/zsh -lc 'cat a && git push'",
  });
  expect(order()).not.toContain("Read-only command");
  expect(order()).not.toContain("Expected to read only");
  expect(text(labelled("Command explanation")[0]!)).toContain("Caution:");
});

it("keeps unexplained commands below the command they describe", () => {
  render({ ...codexRead, detail: "npm run build", command: "npm run build" });
  const all = order();
  expect(text(labelled("Command")[0]!)).toBe("npm run build");
  expect(all.indexOf("npm run build")).toBeLessThan(all.indexOf("Not explained:"));
});

it("shows the agent's description as prose under the title and keeps only the command focusable", () => {
  render({
    ...codexRead,
    detail: "List files under src and docs",
    command: "find src docs -type f | wc -l",
  });
  const [description] = labelled("Description");
  expect(text(description!)).toBe("List files under src and docs");
  // Prose, not a second command: no monospace face and no focus stop of its own.
  expect(description!.props.className).not.toContain("font-mono");
  expect(description!.props.tabIndex).toBeUndefined();
  expect(labelled("Command")).toHaveLength(0);
  expect(text(labelled("Exact command")[0]!)).toBe("find src docs -type f | wc -l");
  const focusable = renderer!.root.findAll(
    (node) => typeof node.type === "string" && node.props.tabIndex === 0,
  );
  expect(focusable.map(text)).toEqual(["find src docs -type f | wc -l"]);
  const all = order();
  expect(all.indexOf("Command approval")).toBeLessThan(all.indexOf("List files under src"));
  expect(all.indexOf("List files under src")).toBeLessThan(all.indexOf("find src docs"));
  expect(text(labelled("Command explanation")[0]!)).toBe(
    "Expected to read only — lists files under src and docs, then counts the lines.",
  );
});

const page = `<!doctype html><style>${"body { margin: 0; }\n".repeat(40)}</style><img src="/work/lunch/swatches.png">`;
const htmlRender: PendingApproval = {
  requestId: RuntimeRequestId.make("claude-html-render"),
  requestKind: "command",
  createdAt: "2026-10-30T00:00:00Z",
  detail: "Render an HTML page: Lunch proposal",
  responseCapability: "live",
  toolCall: {
    itemId: TurnItemId.make("html-render-item"),
    threadId: ThreadId.make("thread"),
    toolName: "mcp__stark-code__html_render",
    input: { html: page, title: "Lunch proposal", height: 640 },
    revision: "live",
  },
};

it("shows a Stark HTML call as a tool approval with its files and complete arguments", () => {
  render(htmlRender);
  const all = order();
  expect(all).toContain("Stark Code tool approval");
  expect(all).not.toContain("Command approval");
  expect(all).not.toContain("Not explained");
  expect(text(labelled("Tool effect")[0]!)).toBe(
    "Show the HTML page “Lunch proposal” in this chat",
  );
  expect(text(labelled("Local files it reads")[0]!)).toBe("/work/lunch/swatches.png");
  expect(labelled("Tool arguments")).toHaveLength(0);

  const disclosure = renderer!.root.find(
    (node) => node.type === "button" && node.props["aria-expanded"] === false,
  );
  act(() => disclosure.props.onClick());
  // The whole page, including the image path past any preview length.
  expect(text(labelled("Tool arguments")[0]!)).toContain(page);
});

it("waits for the full call before listing files from a summarized one", () => {
  const summarized = {
    ...htmlRender,
    toolCall: { ...htmlRender.toolCall!, input: { summary: "<!doctype html>", truncated: true } },
  } satisfies PendingApproval;
  const panel = (input: unknown, loaded: boolean) => (
    <ComposerPendingApprovalPanel
      approval={summarized}
      pendingCount={1}
      toolCallInput={{ input, pending: !loaded, error: null, loaded }}
    />
  );
  act(() => {
    renderer = create(panel(summarized.toolCall.input, false));
  });
  expect(order()).toContain("Loading the full arguments…");
  expect(labelled("Local files it reads")).toHaveLength(0);

  act(() => renderer!.update(panel(htmlRender.toolCall!.input, true)));
  expect(order()).not.toContain("Loading the full arguments…");
  expect(text(labelled("Local files it reads")[0]!)).toBe("/work/lunch/swatches.png");
});

it("names another server's tool without explaining or relabeling it as a command", () => {
  render({
    ...htmlRender,
    detail: 'mcp__ably__publish: {"channel":"lunch"}',
    toolCall: {
      ...htmlRender.toolCall!,
      toolName: "mcp__ably__publish",
      input: { channel: "lunch" },
    },
  });
  const all = order();
  expect(all).toContain("Tool approval");
  expect(all).not.toContain("Stark Code tool approval");
  expect(all).not.toContain("Command approval");
  expect(all).toContain("This app can't tell what this tool does.");
  // The provider's prompt only restated the call.
  expect(all).not.toContain('mcp__ably__publish: {"channel"');
});

it("shows a hook's ask and the Stark Pages reason as notes, not as the command's description", () => {
  render({
    ...codexRead,
    detail:
      "Asked by a hook\nStark Code cannot tell whether this command publishes to Stark Pages, which is available only in native Claude shell mode, so it needs your approval.",
    command: 'spage "$sub" ./site',
  });
  expect(text(labelled("Asked by a hook")[0]!)).toBe("Asked by a hook");
  expect(text(labelled("Stark Pages")[0]!)).toBe(
    "May publish to Stark Pages, which is available only in native Claude shell mode, so it needs your approval each time.",
  );
  expect(labelled("Description")).toHaveLength(0);
  expect(text(labelled("Exact command")[0]!)).toBe('spage "$sub" ./site');
});
