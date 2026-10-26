// @vitest-environment jsdom
import { act, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@starkfuture/contracts";
import { NativeVoiceControl } from "./NativeVoiceControl";
import { ComposerProviderVoiceControl } from "./chat/ComposerProviderVoiceControl";
import { TooltipProvider } from "./ui/tooltip";

const state = vi.hoisted(() => ({ allowed: true, write: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../state/terminal", () => ({
  terminalEnvironment: { write: { permissionAtom: () => "write-permission" } },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.write }));
let root: Root;
let container: HTMLDivElement;
const show = vi.fn();
const props = {
  threadRef: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
  terminalId: "native-agent-codex",
  requestId: 1,
  ended: false,
  onShowTerminal: show,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.write.mockReset().mockResolvedValue({ _tag: "Success" });
  show.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) => {
  const el = [...document.querySelectorAll("button")].find((el) => el.textContent === text);
  if (!el) throw new Error(`Missing ${text}`);
  return el;
};
it.each([
  ["claudeAgent", "/voice hold"],
  ["codex", "/voice"],
])(
  "stages %s voice only after a click and never submits an unknown prompt",
  async (driver, command) => {
    await act(() => root.render(<NativeVoiceControl {...props} driver={driver} />));
    expect(state.write).not.toHaveBeenCalled();
    await act(() => button(`Prepare ${command}`).click());
    expect(state.write).toHaveBeenCalledOnce();
    const request = state.write.mock.calls[0]![0];
    expect(request.input.data).toBe(`\x1b[200~${command}\x1b[201~`);
    expect(request.input.data).not.toMatch(/[\r\n]/);
    expect(show).toHaveBeenCalledOnce();
  },
);
it("cannot type into an ended terminal or a connection without write permission", async () => {
  state.allowed = false;
  await act(() => root.render(<NativeVoiceControl {...props} driver="codex" />));
  expect(button("Prepare /voice").disabled).toBe(true);
  state.allowed = true;
  await act(() => root.render(<NativeVoiceControl {...props} driver="codex" ended />));
  expect(button("Prepare /voice").disabled).toBe(true);
  expect(state.write).not.toHaveBeenCalled();
});
it("reports a failed write instead of claiming voice started", async () => {
  state.write.mockResolvedValue({ _tag: "Failure" });
  await act(() => root.render(<NativeVoiceControl {...props} driver="codex" />));
  await act(() => button("Prepare /voice").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not prepare");
  expect(show).not.toHaveBeenCalled();
});
it.each(["claudeAgent", "codex"])(
  "consumes %s voice once and stays closed when Shell or Needs you remounts it",
  async (driver) => {
    function ShellHost({ entry }: { entry: "voice" | "closed" | "shell" | "needs-you" }) {
      const [requestId, setRequestId] = useState(1);
      const sequence = useRef(1);
      const consume = useCallback((id: number) => {
        setRequestId((current) => (current === id ? 0 : current));
      }, []);
      return (
        <>
          <button onClick={() => setRequestId(++sequence.current)}>Request voice</button>
          {entry !== "closed" ? (
            <NativeVoiceControl
              {...props}
              key={entry}
              driver={driver}
              requestId={requestId}
              onRequestConsumed={consume}
            />
          ) : null}
        </>
      );
    }
    const command = driver === "claudeAgent" ? "/voice hold" : "/voice";
    const hasPrepare = () =>
      [...document.querySelectorAll("button")].some(
        (el) => el.textContent === `Prepare ${command}`,
      );
    await act(() => root.render(<ShellHost entry="voice" />));
    // Consuming the request must not close the popover the person just opened.
    expect(hasPrepare()).toBe(true);
    await act(() => root.render(<ShellHost entry="closed" />));
    await act(() => root.render(<ShellHost entry="shell" />));
    expect(hasPrepare()).toBe(false);
    await act(() => root.render(<ShellHost entry="closed" />));
    await act(() => root.render(<ShellHost entry="needs-you" />));
    expect(hasPrepare()).toBe(false);
    await act(() => button("Request voice").click());
    expect(hasPrepare()).toBe(true);
    expect(state.write).not.toHaveBeenCalled();
  },
);
it.each(["claudeAgent", "codex"])(
  "composer hands %s voice to its native session",
  async (driver) => {
    const open = vi.fn();
    await act(() =>
      root.render(
        <TooltipProvider>
          <ComposerProviderVoiceControl driver={driver} disabled={false} onOpen={open} />
        </TooltipProvider>,
      ),
    );
    await act(() => container.querySelector("button")!.click());
    expect(open).toHaveBeenCalledOnce();
    expect(state.write).not.toHaveBeenCalled();
  },
);
it("does not show unsupported or unavailable voice, and respects a busy chat", async () => {
  const open = vi.fn();
  await act(() =>
    root.render(<ComposerProviderVoiceControl driver="other" disabled={false} onOpen={open} />),
  );
  expect(container.querySelector("button")).toBeNull();
  await act(() =>
    root.render(
      <ComposerProviderVoiceControl driver="codex" disabled={false} onOpen={undefined} />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
  await act(() =>
    root.render(
      <TooltipProvider>
        <ComposerProviderVoiceControl driver="codex" disabled onOpen={open} />
      </TooltipProvider>,
    ),
  );
  await act(() => container.querySelector("button")!.click());
  expect(open).not.toHaveBeenCalled();
});

it("does not offer subscription voice through an OpenRouter API connection", async () => {
  const open = vi.fn();
  await act(() =>
    root.render(
      <ComposerProviderVoiceControl
        driver="claudeAgent"
        apiBackend="openrouter"
        disabled={false}
        onOpen={open}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
  await act(() =>
    root.render(<NativeVoiceControl {...props} driver="claudeAgent" apiBackend="openrouter" />),
  );
  expect(container.querySelector("button")).toBeNull();
  expect(state.write).not.toHaveBeenCalled();
});
