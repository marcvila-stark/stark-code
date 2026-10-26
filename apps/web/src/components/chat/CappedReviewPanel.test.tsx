// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@starkfuture/contracts";
import { scopeThreadRef, scopedThreadKey } from "@starkfuture/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
const state = vi.hoisted(() => ({
  allowed: true,
  start: vi.fn(),
  providers: [] as ServerProvider[],
  settings: null as UnifiedSettings | null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => state.settings }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { providersValueAtom: () => "providers" },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => null,
  useThreadProjection: () => null,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { startTurn: "start", interruptTurn: "stop" },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: string) => (command === "start" ? state.start : vi.fn()),
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
import { CappedReviewPanel } from "./CappedReviewPanel";
import { readCappedReview } from "./cappedReview.logic";
const parent = makeThreadFixture({ runtimeMode: "full-access" });
const storageKey = `stark-code:capped-review:${scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id))}`;
const provider = (driver: "claudeAgent" | "codex"): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  displayName: driver === "claudeAgent" ? "Claude Work" : "Codex Work",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T00:00:00Z",
  models: [
    { slug: "review-model", name: "Model", isDefault: true, isCustom: false, capabilities: {} },
  ],
  slashCommands: [],
  skills: [],
});
let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(() =>
    root.render(
      <CappedReviewPanel parent={parent} workspaceRoot="/work" onOpenThread={() => undefined} />,
    ),
  );
}
function button(label: string) {
  const el = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!el) throw new Error(`Missing ${label}`);
  return el;
}
async function scope() {
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "Review src/auth.ts",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: vi.fn(async (_key: string, action: () => unknown) => action()) },
  });
  state.allowed = true;
  state.providers = [provider("claudeAgent"), provider("codex")];
  state.settings = structuredClone(DEFAULT_UNIFIED_SETTINGS);
  state.start.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("reserves both children before dispatch, starts only one round, and keeps the cap after remount", async () => {
  state.start.mockImplementation(async () => {
    const saved = readCappedReview(localStorage.getItem(storageKey));
    expect(saved?.rounds[0]?.members).toHaveLength(2);
    expect(saved?.rounds[0]?.members.every((entry) => entry.outcome === "reserved")).toBe(true);
    return { _tag: "Success" };
  });
  await scope();
  await act(() => button("Review with Claude + Codex").click());
  expect(state.start).toHaveBeenCalledTimes(2);
  for (const [call] of state.start.mock.calls) {
    expect(call.environmentId).toBe(parent.environmentId);
    expect(call.input.threadId).not.toBe(parent.id);
    expect(call.input.runtimeMode).toBe("approval-required");
    expect(call.input.interactionMode).toBe("plan");
  }
  expect(button("Start round 2").disabled).toBe(true);
  await act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain("Rounds used: 1/3");
  expect(state.start).toHaveBeenCalledTimes(2);
});
it("counts a partially unknown start and never retries it automatically", async () => {
  state.start
    .mockResolvedValueOnce({ _tag: "Success" })
    .mockRejectedValueOnce(new Error("disconnected"));
  await scope();
  await act(() => button("Review with Claude + Codex").click());
  expect(
    readCappedReview(localStorage.getItem(storageKey))?.rounds[0]?.members.map(
      (entry) => entry.outcome,
    ),
  ).toEqual(["accepted", "unconfirmed"]);
  expect(container.textContent).toContain("round remains counted");
  await render();
  expect(state.start).toHaveBeenCalledTimes(2);
});
it("honors project-disabled providers and offers the available Codex-only check", async () => {
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    projectSettingsOverrides: {
      [parent.projectId]: {
        providerInstances: { [ProviderInstanceId.make("claudeAgent")]: { enabled: false } },
      },
    },
  };
  await render();
  await scope();
  expect(button("Review with Claude + Codex").disabled).toBe(true);
  expect(button("Check with Codex").disabled).toBe(false);
  await act(() => button("Check with Codex").click());
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(state.start.mock.calls[0]![0].input.modelSelection.instanceId).toBe("codex");
});
it("does not dispatch without permission or when local reservation cannot be saved", async () => {
  state.allowed = false;
  await render();
  await scope();
  expect(button("Check with Codex").disabled).toBe(true);
  state.allowed = true;
  await render();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage full");
  });
  await act(() => button("Check with Codex").click());
  expect(state.start).not.toHaveBeenCalled();
  expect(container.textContent).toContain("storage full");
});

it("fails closed when cross-window locking is unavailable", async () => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  await scope();
  await act(() => button("Check with Codex").click());
  expect(state.start).not.toHaveBeenCalled();
  expect(container.textContent).toContain("storage locking");
});

it("uses the saved scope and refuses a stale start when another window has reserved the round", async () => {
  await scope();
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      version: 1,
      scope: "Other window's explicit scope",
      mode: "codex",
      rounds: [
        {
          number: 1,
          members: [
            {
              threadId: "reserved-review",
              label: "Codex Work",
              modelSelection: { instanceId: "codex", model: "review-model" },
              outcome: "reserved",
            },
          ],
        },
      ],
    }),
  );
  await act(() => button("Check with Codex").click());
  expect(state.start).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")?.value).toBe("Other window's explicit scope");
  expect(button("Start round 2").disabled).toBe(true);
  expect(container.textContent).toContain("changed in another panel");
});
