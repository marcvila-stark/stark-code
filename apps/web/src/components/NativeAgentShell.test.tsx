// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import {
  ProviderInstanceId,
  RESPONSE_VISUALS_MODEL,
  RESPONSE_VISUALS_VERSION,
  type NativeAgentReply,
} from "@starkfuture/contracts";
import { makeThreadFixture } from "../test-fixtures";
import type { NativeMcpWarning } from "../nativeMcpWarning";

const state = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  escapes: 0,
  replies: [] as NativeAgentReply[],
  restart: vi.fn(),
  canRestart: true,
  generate: vi.fn(),
  back: vi.fn(),
  quote: vi.fn<(text: string, label: string) => boolean>(),
  selectionActions: new Map<HTMLElement, () => void>(),
  warning: undefined as ((warning: NativeMcpWarning) => void) | undefined,
  exit: undefined as (() => void) | undefined,
  launchError: undefined as ((message: string | null) => void) | undefined,
}));
vi.mock("../lib/selectionActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/selectionActions")>()),
  observeSelectionActions: ({
    element,
    onSelection,
  }: {
    element: HTMLElement;
    onSelection: (pointer: null) => void;
  }) => {
    const update = () => onSelection(null);
    state.selectionActions.set(element, update);
    return {
      cancel: () => undefined,
      dispose: () => state.selectionActions.delete(element),
      selectionChanged: update,
    };
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "restart-permission" ? state.canRestart : true),
}));
vi.mock("../state/responseVisuals", () => ({
  responseVisualsEnvironment: { format: { permissionAtom: () => "visual-permission" } },
}));
vi.mock("../state/terminal", () => ({
  terminalEnvironment: {
    restart: { permissionAtom: () => "restart-permission" },
    write: { permissionAtom: () => "write-permission" },
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { permissionAtom?: () => string }) =>
    command.permissionAtom?.() === "restart-permission" ? state.restart : state.generate,
}));
vi.mock("../state/nativeReplies", () => ({
  useNativeReplies: (_ref: unknown, enabled: boolean) => ({
    data: enabled ? state.replies : undefined,
    error: null,
  }),
}));
vi.mock("./ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div data-markdown>{text}</div>,
}));
vi.mock("./ThreadTerminalDrawer", () => ({
  TerminalViewport: ({
    onMcpWarning,
    onSessionExited,
    onSessionLaunchError,
  }: {
    onMcpWarning?: (warning: NativeMcpWarning) => void;
    onSessionExited?: () => void;
    onSessionLaunchError?: (message: string | null) => void;
  }) => {
    state.warning = onMcpWarning;
    state.exit = onSessionExited;
    state.launchError = onSessionLaunchError;
    useEffect(() => {
      state.mounts++;
      return () => {
        state.unmounts++;
      };
    }, []);
    return (
      <input
        aria-label="CLI input"
        onKeyDown={(event) => {
          if (event.key === "Escape") state.escapes++;
        }}
      />
    );
  },
}));

import { NativeAgentShell } from "./NativeAgentShell";

let root: Root;
let container: HTMLDivElement;
let fixtureSequence = 0;
const initialRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const thread = makeThreadFixture();
const threadRef = scopeThreadRef(thread.environmentId, thread.id);
const instanceId = ProviderInstanceId.make("claude-reader");
const render = (driver = "claudeAgent") =>
  act(() =>
    root.render(
      <NativeAgentShell
        threadRef={threadRef}
        providerInstanceId={instanceId}
        driver={driver}
        cwd="/work"
        worktreePath={null}
        keybindings={[]}
        onBackToChat={state.back}
        onQuoteText={state.quote}
      />,
    ),
  );
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
};
const click = (label: string) => act(async () => button(label).click());
const escape = () =>
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
const originals = () =>
  [...container.querySelectorAll('[aria-label="Original reply"] [data-markdown]')].map(
    (source) => source.textContent,
  );

beforeEach(() => {
  fixtureSequence++;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  localStorage.clear();
  state.mounts = 0;
  state.unmounts = 0;
  state.escapes = 0;
  state.warning = undefined;
  state.exit = undefined;
  state.launchError = undefined;
  state.canRestart = true;
  state.back.mockReset();
  state.quote.mockReset().mockReturnValue(true);
  state.selectionActions.clear();
  state.restart.mockReset().mockResolvedValue({ _tag: "Success", value: { status: "running" } });
  state.generate.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      summary: "A saved overview.",
      table: null,
      mermaid: null,
      reason: null,
      model: RESPONSE_VISUALS_MODEL,
      formatterVersion: RESPONSE_VISUALS_VERSION,
      cacheHit: false,
      generationUsage: null,
    },
  });
  state.replies = ["First completed reply.", "Latest completed reply."].map((text, index) => ({
    id: `fixture-${fixtureSequence}-reply-${index}`,
    threadId: thread.id,
    terminalId: `native-agent-${instanceId}`,
    provider: "claude",
    sessionId: "native-session",
    turnId: null,
    text,
    capturedAt: "2026-10-17T00:00:00.000Z",
    sequence: index + 1,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (initialRangeRect)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", initialRangeRect);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
});

it("keeps one terminal and its input while changing views and filling/restoring the window", async () => {
  await render();
  const input = container.querySelector<HTMLInputElement>('[aria-label="CLI input"]')!;
  input.value = "unfinished native command";
  await click("Read view");
  expect(originals()).toEqual(["First completed reply.", "Latest completed reply."]);
  await click("Both");
  await click("Fill window");
  expect(container.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  await click("Terminal");
  await click("Return shell to workspace");
  await click("Both");
  expect(container.querySelector('[aria-label="CLI input"]')).toBe(input);
  expect(input.value).toBe("unfinished native command");
  expect(originals()).toEqual(["First completed reply.", "Latest completed reply."]);
  expect(state.mounts).toBe(1);
  expect(state.unmounts).toBe(0);
  expect(state.restart).not.toHaveBeenCalled();
  expect(state.generate).not.toHaveBeenCalled();
  expect(state.back).not.toHaveBeenCalled();
});

it("surfaces passive connection warnings without changing terminal input or restarting", async () => {
  await render();
  const input = container.querySelector<HTMLInputElement>('[aria-label="CLI input"]')!;
  input.value = "unfinished command";
  await click("Read view");
  await act(() => state.warning?.("sign-in"));
  expect(container.textContent).toContain(
    "A connector may need sign-in. Review it in the terminal.",
  );
  await click("Show terminal");
  expect(
    container.querySelector("[data-native-shell-layout]")?.getAttribute("data-native-shell-layout"),
  ).toBe("terminal");
  expect(input.value).toBe("unfinished command");
  expect(state.mounts).toBe(1);
  expect(state.restart).not.toHaveBeenCalled();
  await click("Dismiss connection warning");
  expect(container.textContent).not.toContain("A connector may need sign-in.");
  await act(() => state.warning?.("connection"));
  expect(container.textContent).toContain("A connection warning appeared in the terminal.");
  state.restart.mockResolvedValue({ _tag: "Success", value: { status: "running" } });
  await act(() => state.exit?.());
  await click("Start another session");
  expect(container.textContent).not.toContain("A connection warning appeared in the terminal.");
  expect(state.restart).toHaveBeenCalledTimes(1);
});

it.each(["claudeAgent", "codex"])(
  "quotes the selected captured %s reply while preserving its unsent CLI input",
  async (driver) => {
    state.replies = state.replies.map((reply) => ({
      ...reply,
      provider: driver === "codex" ? "codex" : "claude",
    }));
    const rect = new DOMRect(20, 20, 300, 300);
    const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => rect,
    });
    const elementRect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(rect);
    try {
      await render(driver);
      const input = container.querySelector<HTMLInputElement>('[aria-label="CLI input"]')!;
      input.value = "unfinished native command";
      await click("Read view");
      await click("Fill window");
      const range = document.createRange();
      range.selectNodeContents(
        container.querySelector('[aria-label="Original reply"] [data-markdown]')!,
      );
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      await act(() => document.dispatchEvent(new Event("selectionchange")));
      const quote = document.querySelector<HTMLButtonElement>(
        '[aria-label="Quote selection in chat"]',
      )!;
      expect(container.querySelector('[role="dialog"]')?.contains(quote)).toBe(true);
      await act(() => quote.click());
      expect(state.quote).toHaveBeenCalledExactlyOnceWith(
        "First completed reply.",
        `${driver === "codex" ? "Codex" : "Claude"} · First completed reply.`,
      );
      expect(container.querySelector("[data-assistant-citation-source]")).toBeNull();
      expect(input.value).toBe("unfinished native command");
      expect(state.mounts).toBe(1);
      expect(state.generate).not.toHaveBeenCalled();
      expect(state.restart).not.toHaveBeenCalled();
    } finally {
      window.getSelection()?.removeAllRanges();
      elementRect.mockRestore();
      if (originalRect)
        Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRect);
      else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  },
);

it.each(["claudeAgent", "codex"])(
  "retries a failed %s session in place after its workspace becomes available",
  async (driver) => {
    await render(driver);
    const input = container.querySelector<HTMLInputElement>('[aria-label="CLI input"]')!;
    const error =
      "A native agent is already running in this workspace. Exit it or use another Git worktree.";
    await act(() => state.launchError?.(error));
    expect(button("Retry native session").disabled).toBe(false);
    expect(state.restart).not.toHaveBeenCalled();

    state.canRestart = false;
    await render(driver);
    expect(button("Retry native session").disabled).toBe(true);
    await click("Retry native session");
    expect(state.restart).not.toHaveBeenCalled();
    state.canRestart = true;
    await render(driver);

    let complete: ((value: unknown) => void) | undefined;
    state.restart.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await click("Retry native session");
    expect(button("Starting…").disabled).toBe(true);
    await click("Starting…");
    expect(state.restart).toHaveBeenCalledTimes(1);
    await act(async () => complete?.({ _tag: "Success", value: { status: "error", error } }));
    expect(button("Retry native session").disabled).toBe(false);

    // A successful user retry after the owner exits keeps the same chat and viewport.
    await click("Retry native session");
    expect(state.restart).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId: `native-agent-${instanceId}`,
        cwd: "/work",
        worktreePath: null,
        providerInstanceId: instanceId,
        agentShell: true,
        cols: 100,
        rows: 30,
      },
    });
    expect(container.textContent).not.toContain("Retry native session");
    expect(container.textContent).not.toContain("The native session could not start.");
    expect(container.querySelector('[aria-label="CLI input"]')).toBe(input);
    expect(state.mounts).toBe(1);
    expect(state.unmounts).toBe(0);
    expect(state.back).not.toHaveBeenCalled();
  },
);

it("keeps every reply, its reading position and visual summary when switching views", async () => {
  await render();
  await click("Read view");
  expect(originals()).toEqual(["First completed reply.", "Latest completed reply."]);
  await click("Make readable");
  const reader = container.querySelector<HTMLElement>("[data-native-reply-transcript]")!;
  reader.scrollTop = 240;
  await click("Terminal");
  await click("Fill window");
  await click("Both");
  await click("Return shell to workspace");
  await click("Read view");
  expect(container.querySelector("[data-native-reply-transcript]")).toBe(reader);
  expect(reader.scrollTop).toBe(240);
  expect(originals()).toEqual(["First completed reply.", "Latest completed reply."]);
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "A saved overview.",
  );
  expect(state.generate).toHaveBeenCalledTimes(1);
  await click("Show original");
  await click("Make readable");
  expect(state.generate).toHaveBeenCalledTimes(1);
});

it("appends new captured replies without replacing the source being read or spending tokens", async () => {
  await render();
  await click("Read view");
  const reader = container.querySelector<HTMLElement>("[data-native-reply-transcript]")!;
  const source = container.querySelector('[aria-label="Original reply"] [data-markdown]')!;
  reader.scrollTop = 240;
  const range = document.createRange();
  range.selectNodeContents(source);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  state.replies = [
    ...state.replies,
    {
      ...state.replies[1]!,
      id: `fixture-${fixtureSequence}-reply-2`,
      text: "A new completed reply.",
      sequence: 3,
    },
  ];
  await render();
  expect(originals()).toEqual([
    "First completed reply.",
    "Latest completed reply.",
    "A new completed reply.",
  ]);
  expect(container.querySelector('[aria-label="Original reply"] [data-markdown]')).toBe(source);
  expect(window.getSelection()?.toString()).toBe("First completed reply.");
  expect(reader.scrollTop).toBe(240);
  expect(container.querySelector('[aria-label="Reply to read"]')).toBeNull();
  expect(container.querySelector('[aria-label="Reply text"]')).toBeNull();
  expect(state.generate).not.toHaveBeenCalled();
  window.getSelection()?.removeAllRanges();
});

it("shows a quiet empty state without starting or restarting a native session", async () => {
  state.replies = [];
  await render();
  await click("Read view");
  expect(container.textContent).toContain("Completed replies appear here.");
  expect(container.querySelector('[aria-label="Reply to read"]')).toBeNull();
  expect(state.restart).not.toHaveBeenCalled();
  expect(state.generate).not.toHaveBeenCalled();
});

it("quotes only an original reply, not generated summaries or text spanning replies", async () => {
  const rect = new DOMRect(20, 20, 300, 300);
  const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
  const elementRect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(rect);
  const select = (range: Range) =>
    act(() => {
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  const quoteButton = () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Quote selection in chat"]');
  try {
    await render();
    await click("Read view");
    await click("Make readable");
    const sources = container.querySelectorAll('[aria-label="Original reply"] [data-markdown]');
    const secondReply = document.createRange();
    secondReply.selectNodeContents(sources[1]!);
    await select(secondReply);
    await act(() => quoteButton()!.click());
    expect(state.quote).toHaveBeenCalledExactlyOnceWith(
      "Latest completed reply.",
      "Claude · Latest completed reply.",
    );

    const overview = document.createRange();
    overview.selectNodeContents(container.querySelector('[aria-label="AI overview"]')!);
    await select(overview);
    expect(quoteButton()).toBeNull();

    const acrossReplies = document.createRange();
    acrossReplies.setStart(sources[0]!.firstChild!, 0);
    acrossReplies.setEnd(sources[1]!.firstChild!, "Latest completed reply.".length);
    await select(acrossReplies);
    expect(quoteButton()).toBeNull();
  } finally {
    window.getSelection()?.removeAllRanges();
    elementRect.mockRestore();
    if (originalRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRect);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
});

it("delivers Escape to the native CLI, and restores full view only when focus is outside the terminal", async () => {
  await render();
  await click("Both");
  await click("Fill window");
  const input = container.querySelector<HTMLInputElement>('[aria-label="CLI input"]')!;
  await act(() => input.focus());
  await escape();
  expect(state.escapes).toBe(1);
  expect(container.querySelector('[data-native-shell-expanded="true"]')).not.toBeNull();
  await act(() => container.querySelector<HTMLElement>("[data-native-shell-expanded]")!.focus());
  await escape();
  expect(container.querySelector('[data-native-shell-expanded="true"]')).toBeNull();
  expect(document.activeElement).toBe(button("Fill window"));
  const workspaceControl = document.createElement("button");
  document.body.append(workspaceControl);
  try {
    await act(() => workspaceControl.focus());
    expect(document.activeElement).toBe(workspaceControl);
    await escape();
    expect(container.querySelector('[data-native-shell-expanded="false"]')).not.toBeNull();
  } finally {
    workspaceControl.remove();
  }
  expect(state.back).not.toHaveBeenCalled();
  expect(state.restart).not.toHaveBeenCalled();
});
