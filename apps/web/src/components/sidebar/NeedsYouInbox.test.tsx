// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { RuntimeRequestId, type NativeAgentAttention } from "@starkfuture/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { useNeedsYouSelection } from "../../needsYouSelection";

const native = vi.hoisted(() => ({ byEnvironment: {} as Record<string, NativeAgentAttention[]> }));
vi.mock("../../state/nativeAttention", () => ({
  NativeAttentionSubscriptions: () => null,
  useNativeAttention: (select: (value: typeof native) => unknown) => select(native),
}));
import { NeedsYouInbox } from "./NeedsYouInbox";

let root: Root;
let container: HTMLDivElement;
const openThread = vi.fn();
const thread = makeThreadFixture({ title: "Review settings" });
const waiting = {
  ...thread,
  source: {
    ...thread.source,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("exact-question"),
      kind: "user_input" as const,
      createdAt: DateTime.makeUnsafe("2026-10-20T12:00:00Z"),
    },
  },
};
const render = (threads = [waiting]) =>
  act(() =>
    root.render(<NeedsYouInbox threads={threads} projects={[]} onOpenThread={openThread} />),
  );
async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(() => button!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  native.byEnvironment = {};
  openThread.mockReset();
  useNeedsYouSelection.setState({ target: null });
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens the exact pending question and disappears after resolution", async () => {
  await render();
  await click("Needs you, 1 item");
  expect(document.body.textContent).toContain("Across all folders");
  await click("Answer question: Review settings");
  expect(openThread).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  expect(useNeedsYouSelection.getState().target).toMatchObject({
    requestId: "exact-question",
    threadId: thread.id,
  });
  await render([]);
  expect(container.textContent).not.toContain("Needs you");
});

it("routes native attention to the existing terminal without creating an approval response", async () => {
  native.byEnvironment = {
    [thread.environmentId]: [
      {
        threadId: thread.id,
        terminalId: "native-agent-claude",
        provider: "claude",
        sessionId: "session",
        kind: "permission",
        requestedAt: "2026-10-20T12:00:00Z",
      },
    ],
  };
  await act(() =>
    root.render(<NeedsYouInbox threads={[thread]} projects={[]} onOpenThread={openThread} />),
  );
  await click("Needs you, 1 item");
  await click("Review approval: Review settings");
  expect(useNeedsYouSelection.getState().target).toMatchObject({
    terminalId: "native-agent-claude",
    requestId: null,
    threadId: thread.id,
  });
});

it("opens the existing Codex terminal for generic input without inventing an approval", async () => {
  native.byEnvironment = {
    [thread.environmentId]: [
      {
        threadId: thread.id,
        terminalId: "native-agent-codex",
        provider: "codex",
        kind: "input",
        requestedAt: "2026-10-20T12:00:00Z",
      },
    ],
  };
  await act(() =>
    root.render(<NeedsYouInbox threads={[thread]} projects={[]} onOpenThread={openThread} />),
  );
  await click("Needs you, 1 item");
  expect(document.body.textContent).toContain("Codex · terminal");
  expect(document.body.textContent).not.toContain("Review approval");
  await click("Input needed: Review settings");
  expect(useNeedsYouSelection.getState().target).toMatchObject({
    terminalId: "native-agent-codex",
    nativeProvider: "codex",
    requestId: null,
    threadId: thread.id,
  });
});
