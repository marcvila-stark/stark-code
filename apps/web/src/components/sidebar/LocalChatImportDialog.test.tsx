// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: {
    enabled: false,
    projectId: null as string | null,
    running: false,
    lastSyncedAt: null,
    lastResult: null as unknown,
    error: null,
  },
  connected: true,
  multipleEnvironments: false,
  granted: true,
  projects: [
    { id: "work", environmentId: "this-mac", title: "work", workspaceRoot: "/fixture/work" },
  ],
  refresh: vi.fn(),
  runImport: vi.fn(),
  configure: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.granted }));
vi.mock("../../state/agentSessions", () => ({
  agentSessionImport: { kind: "import", permissionAtom: () => true },
  agentSessionSyncConfigure: { kind: "configure", permissionAtom: () => true },
  agentSessionSyncStatus: () => ({}),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) =>
    command.kind === "import" ? state.runImport : state.configure,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.status,
    dataUpdatedAt: 1,
    refresh: state.refresh,
    error: null,
  }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "this-mac",
        label: "This Mac",
        connection: { phase: state.connected ? "connected" : "disconnected" },
      },
      ...(state.multipleEnvironments
        ? [
            {
              environmentId: "remote-machine-uuid",
              label: "Build Mac",
              connection: { phase: "connected" },
            },
          ]
        : []),
    ],
  }),
  usePrimaryEnvironmentId: () => "this-mac",
}));
import { LocalChatImportDialog } from "./LocalChatImportDialog";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.status = {
    enabled: false,
    projectId: null,
    running: false,
    lastSyncedAt: null,
    lastResult: null,
    error: null,
  };
  state.connected = true;
  state.multipleEnvironments = false;
  state.granted = true;
  state.projects = [
    { id: "work", environmentId: "this-mac", title: "work", workspaceRoot: "/fixture/work" },
  ];
  state.runImport.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 3, skippedCount: 0 },
  });
  state.configure.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { ...state.status, ...input },
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const text = () => document.body.textContent ?? "";
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  );
  expect(found).toBeDefined();
  return found!;
}
function syncSwitch() {
  return document.querySelector<HTMLButtonElement>('[role="switch"]')!;
}
async function render(onClose = vi.fn()) {
  await act(() => root.render(<LocalChatImportDialog onClose={onClose} />));
}

it("imports all local history into one folder only after an explicit click, then enables discovery", async () => {
  await render();
  expect(state.runImport).not.toHaveBeenCalled();
  expect(state.configure).not.toHaveBeenCalled();
  expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
  await act(() => button("Import all local chats").click());
  expect(state.runImport).toHaveBeenCalledExactlyOnceWith({
    environmentId: "this-mac",
    input: { projectId: "work", expectedWorkspaceRoot: "/fixture/work", scope: "all-local" },
  });
  expect(state.configure).toHaveBeenCalledExactlyOnceWith({
    environmentId: "this-mac",
    input: { enabled: true, projectId: "work" },
  });
  expect(text()).toContain("3 imported");
  expect(text()).toContain("Nothing is sent to an agent.");
});
it("allows a one-time import without turning on discovery", async () => {
  await render();
  await act(() => syncSwitch().click());
  expect(state.configure).not.toHaveBeenCalled();
  await act(() => button("Import all local chats").click());
  expect(state.configure).toHaveBeenCalledExactlyOnceWith({
    environmentId: "this-mac",
    input: { enabled: false, projectId: "work" },
  });
});
it("stops sync without deleting or reimporting chats", async () => {
  state.status = { ...state.status, enabled: true, projectId: "work" };
  await render();
  await act(() => syncSwitch().click());
  expect(state.configure).toHaveBeenCalledExactlyOnceWith({
    environmentId: "this-mac",
    input: { enabled: false, projectId: "work" },
  });
  expect(state.runImport).not.toHaveBeenCalled();
  expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
});
it.each([true, false])("reports batched imports and how to continue (sync=%s)", async (enabled) => {
  state.runImport.mockResolvedValue({
    _tag: "Success",
    value: {
      importedCount: 4,
      updatedCount: 2,
      unchangedCount: 8,
      skippedCount: 1,
      truncated: true,
    },
  });
  await render();
  if (!enabled) await act(() => syncSwitch().click());
  await act(() => button("Import all local chats").click());
  expect(text()).toContain("4 imported · 2 updated · 8 already up to date · 1 skipped");
  expect(text()).toContain(
    enabled
      ? "More history remains. Automatic sync continues in batches; very large transcripts may stay incomplete."
      : "More history remains. Import again to continue; very large transcripts may stay incomplete.",
  );
  expect(button("Check again").disabled).toBe(false);
});
it("allows retry after failure without claiming sync was enabled", async () => {
  state.runImport.mockRejectedValueOnce(new Error("History is temporarily unavailable."));
  await render();
  await act(() => button("Import all local chats").click());
  expect(text()).toContain("History is temporarily unavailable.");
  expect(state.configure).not.toHaveBeenCalled();
  await act(() => button("Import all local chats").click());
  expect(state.runImport).toHaveBeenCalledTimes(2);
  expect(state.configure).toHaveBeenCalledTimes(1);
});
it("gates imports when the connection cannot operate chats", async () => {
  state.granted = false;
  await render();
  expect(button("Import all local chats").disabled).toBe(true);
  expect(syncSwitch().getAttribute("aria-disabled")).toBe("true");
  expect(text()).toContain("This connection cannot import or sync chats.");
  expect(state.configure).not.toHaveBeenCalled();
});
it("prevents a second import while a scan runs, but can stop future sync", async () => {
  state.status = { ...state.status, enabled: true, projectId: "work", running: true };
  await render();
  expect(button("Import all local chats").disabled).toBe(true);
  expect(text()).toContain("Checking local history…");
  await act(() => syncSwitch().click());
  expect(state.configure).toHaveBeenCalledOnce();
  expect(state.runImport).not.toHaveBeenCalled();
});
it("pauses status polling while hidden and releases the interval on close", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("visible");
  await render();
  state.refresh.mockClear();
  await act(() => vi.advanceTimersByTime(5_000));
  expect(state.refresh).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("hidden");
  await act(() => vi.advanceTimersByTime(15_000));
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await act(() => root.unmount());
  await act(() => vi.advanceTimersByTime(10_000));
  expect(state.refresh).toHaveBeenCalledTimes(1);
  root = createRoot(container);
});
it("requires an existing destination folder", async () => {
  state.projects = [];
  await render();
  expect(text()).toContain("Open a folder first");
  expect(button("Import all local chats").disabled).toBe(true);
});

it("shows friendly folder and computer names before either picker has been opened", async () => {
  const projectId = "c899fa44-6344-45e6-8b8e-8d99ee00d11f";
  state.multipleEnvironments = true;
  state.projects = [
    {
      id: projectId,
      environmentId: "this-mac",
      title: "Main workspace",
      workspaceRoot: "/fixture/work",
    },
  ];
  state.status = { ...state.status, projectId, enabled: true };
  await render();
  const destination = document.querySelector<HTMLButtonElement>(
    '[aria-label="Show imported chats in"]',
  )!;
  const computer = document.querySelector<HTMLButtonElement>(
    '[aria-label="Computer with the local history"]',
  )!;
  expect(destination.textContent).toBe("Main workspace");
  expect(destination.disabled).toBe(true);
  expect(computer.textContent).toBe("This Mac");
  expect(text()).not.toContain(projectId);
  expect(text()).not.toContain("remote-machine-uuid");
});
