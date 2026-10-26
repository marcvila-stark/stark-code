// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
  pickFolder: vi.fn(),
  createProject: vi.fn(),
  openFolder: vi.fn(),
  connected: true,
}));
vi.mock("../../hooks/useOpenFolder", () => ({ useOpenFolder: () => state.openFolder }));
vi.mock("../../state/environments", () => {
  const primary = {
    environmentId: "this-mac",
    label: "This Mac",
    connection: { phase: "connected" },
    entry: { target: { _tag: "PrimaryConnectionTarget" } },
  };
  return {
    useEnvironments: () => ({ environments: state.connected ? [primary] : [] }),
    usePrimaryEnvironment: () => primary,
  };
});
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
  readProjects: () => state.projects,
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.createProject }));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { pickFolder: state.pickFolder } }),
}));

import { OpenFolderDialog } from "./OpenFolderDialog";

let root: Root;
let container: HTMLDivElement;
const workspaceRoot = "/Users/fixture/Desktop/work";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  window.desktopBridge = {} as never;
  state.projects = [];
  state.connected = true;
  state.pickFolder.mockResolvedValue(workspaceRoot);
  state.openFolder.mockResolvedValue(true);
  state.createProject.mockImplementation(async ({ environmentId, input }) => {
    state.projects = [
      ...state.projects,
      { id: input.projectId, environmentId, workspaceRoot: input.workspaceRoot },
    ];
    return { _tag: "Success" };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  );
  expect(result).toBeDefined();
  return result!;
}

it("reopens a recent folder selected in the native picker without duplicating it", async () => {
  state.projects = [{ id: "work", environmentId: "this-mac", workspaceRoot }];
  const onClose = vi.fn();
  await act(() => root.render(<OpenFolderDialog onClose={onClose} />));
  expect(document.body.textContent).toContain("It opens as one workspace.");
  expect(document.body.textContent).not.toContain("Choose later");
  await act(() => button("Choose folder…").click());
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.openFolder).toHaveBeenCalledExactlyOnceWith(
    {
      environmentId: "this-mac",
      projectId: "work",
    },
    { isCurrent: expect.any(Function) },
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("opens the chosen main folder once as one workspace", async () => {
  const onClose = vi.fn();
  await act(() => root.render(<OpenFolderDialog onClose={onClose} />));
  await act(() => button("Choose folder…").click());
  expect(state.createProject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      environmentId: "this-mac",
      input: expect.objectContaining({
        workspaceRoot,
        title: "work",
        createWorkspaceRootIfMissing: false,
      }),
    }),
  );
  expect(state.projects).toHaveLength(1);
  expect(state.openFolder).toHaveBeenCalledExactlyOnceWith(
    {
      environmentId: "this-mac",
      projectId: state.projects[0]!.id,
    },
    { isCurrent: expect.any(Function) },
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("cancels without changing the selected folder or creating a draft", async () => {
  const onClose = vi.fn();
  await act(() => root.render(<OpenFolderDialog onClose={onClose} />));
  await act(() => button("Cancel").click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(state.pickFolder).not.toHaveBeenCalled();
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.openFolder).not.toHaveBeenCalled();
});

it("recovers from a missing project event and retries without creating another workspace", async () => {
  const onClose = vi.fn();
  state.createProject.mockResolvedValue({ _tag: "Success" });
  await act(() => root.render(<OpenFolderDialog onClose={onClose} />));
  vi.useFakeTimers();
  await act(() => button("Choose folder…").click());
  expect(button("Cancel").disabled).toBe(true);
  expect(state.openFolder).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTime(10_000));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "connection has not caught up",
  );
  expect(button("Cancel").disabled).toBe(false);
  const created = state.createProject.mock.calls[0]![0];
  state.projects = [
    { environmentId: created.environmentId, id: created.input.projectId, workspaceRoot },
  ];
  await act(() => button("Choose folder…").click());
  expect(state.createProject).toHaveBeenCalledTimes(1);
  expect(state.openFolder).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

it("can close after the computer disconnects while the native picker is pending", async () => {
  const onClose = vi.fn();
  let complete!: (path: string) => void;
  state.pickFolder.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await act(() => root.render(<OpenFolderDialog onClose={onClose} />));
  await act(() => button("Choose folder…").click());
  state.connected = false;
  await act(() => root.render(<OpenFolderDialog onClose={onClose} />));
  expect(button("Cancel").disabled).toBe(false);
  await act(() => button("Cancel").click());
  await act(async () => {
    complete(workspaceRoot);
  });
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.openFolder).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});
