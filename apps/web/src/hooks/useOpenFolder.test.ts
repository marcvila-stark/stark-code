import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@starkfuture/contracts";

const state = vi.hoisted(() => ({
  router: {
    state: { location: { href: "/thread/verification" } },
    navigate: vi.fn(async (_request: unknown) => {}),
  },
  waitForProject: vi.fn(),
  newThread: vi.fn(),
  setScope: vi.fn(),
  openSideChat: vi.fn(),
  toast: vi.fn(),
  threads: [] as Array<Record<string, unknown>>,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useRef: <T>(value: T) => ({ current: value }),
  useEffect: () => {},
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => state.router }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => state.newThread }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: object) => unknown) =>
    select({ sidebarThreadSortOrder: "updated_at" }),
}));
vi.mock("../logicalProject", () => ({
  selectProjectGroupingSettings: () => ({}),
  deriveLogicalProjectKeyFromSettings: (project: { id: string; environmentId: string }) =>
    `${project.environmentId}:${project.id}`,
}));
vi.mock("../state/entities", () => ({
  waitForProject: state.waitForProject,
  readThreadShells: () => state.threads,
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: { getState: () => ({ setSidebarProjectScopeKey: state.setScope }) },
}));
vi.mock("../sideChatStore", () => ({ openSideChat: state.openSideChat }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: state.toast },
}));

import { useOpenFolder } from "./useOpenFolder";

const work: ScopedProjectRef = {
  environmentId: EnvironmentId.make("this-mac"),
  projectId: ProjectId.make("work"),
};
const project = { ...work, id: work.projectId, workspaceRoot: "/Users/fixture/Desktop/work" };
const thread = (id: string, environmentId = work.environmentId) => ({
  id,
  environmentId,
  projectId: work.projectId,
  archivedAt: null,
  settledOverride: null,
  lineage: { parentThreadId: null, relationshipToParent: null },
  createdAt: "2026-10-20T12:00:00Z",
  updatedAt: "2026-10-21T12:00:00Z",
});
beforeEach(() => {
  vi.clearAllMocks();
  state.router.state.location.href = "/thread/verification";
  state.waitForProject.mockResolvedValue(project);
  state.newThread.mockResolvedValue({ draftId: "work-draft", threadId: "work-thread" });
  state.threads = [];
});

it("reopens the chosen folder's chat and makes it the next new-chat destination", async () => {
  state.threads = [
    thread("work-chat"),
    {
      ...thread("other-machine-chat", EnvironmentId.make("remote")),
      updatedAt: "2026-10-22T12:00:00Z",
    },
  ];
  expect(await useOpenFolder()(work)).toBe(true);
  expect(state.router.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "this-mac", threadId: "work-chat" },
  });
  expect(state.setScope).toHaveBeenCalledExactlyOnceWith("this-mac:work");
  expect(state.newThread).not.toHaveBeenCalled();
  expect(state.openSideChat).not.toHaveBeenCalled();
});

it("reopens the main chat with its newest side chat when returning to a folder", async () => {
  state.threads = [
    thread("main-chat"),
    {
      ...thread("side-chat"),
      updatedAt: "2026-10-22T12:00:00Z",
      lineage: { parentThreadId: "main-chat", relationshipToParent: "side_chat" },
    },
  ];
  expect(await useOpenFolder()(work)).toBe(true);
  expect(state.router.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "this-mac", threadId: "main-chat" },
  });
  expect(state.openSideChat).toHaveBeenCalledExactlyOnceWith(
    { environmentId: "this-mac", threadId: "main-chat" },
    "side-chat",
  );
  expect(state.setScope).toHaveBeenCalledExactlyOnceWith("this-mac:work");
  expect(state.newThread).not.toHaveBeenCalled();
});

it.each(["missing", "archived", "other-environment"])(
  "keeps a side chat accessible when its parent is %s",
  async (parentState) => {
    const parent =
      parentState === "missing"
        ? []
        : [
            {
              ...thread(
                "main-chat",
                parentState === "other-environment"
                  ? EnvironmentId.make("remote")
                  : work.environmentId,
              ),
              archivedAt: parentState === "archived" ? "2026-10-21T12:00:00Z" : null,
            },
          ];
    state.threads = [
      ...parent,
      {
        ...thread("side-chat"),
        updatedAt: "2026-10-22T12:00:00Z",
        lineage: { parentThreadId: "main-chat", relationshipToParent: "side_chat" },
      },
    ];
    expect(await useOpenFolder()(work)).toBe(true);
    expect(state.router.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "this-mac", threadId: "side-chat" },
    });
    expect(state.openSideChat).not.toHaveBeenCalled();
    expect(state.setScope).toHaveBeenCalledExactlyOnceWith("this-mac:work");
  },
);

it("waits for the opened folder to reach the store before starting its draft", async () => {
  let complete!: (value: typeof project) => void;
  state.waitForProject.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const pending = useOpenFolder()(work);
  expect(state.newThread).not.toHaveBeenCalled();
  expect(state.setScope).not.toHaveBeenCalled();
  complete(project);
  expect(await pending).toBe(true);
  expect(state.newThread).toHaveBeenCalledExactlyOnceWith(work, {
    isCurrent: expect.any(Function),
  });
  expect(state.setScope).toHaveBeenCalledExactlyOnceWith("this-mac:work");
});

it("does not pull the user back if they navigate while the folder loads", async () => {
  let complete!: (value: typeof project) => void;
  state.waitForProject.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const pending = useOpenFolder()(work);
  state.router.state.location.href = "/thread/another-chat";
  complete(project);
  expect(await pending).toBe(false);
  expect(state.newThread).not.toHaveBeenCalled();
  expect(state.setScope).not.toHaveBeenCalled();
});

it("keeps the current folder when loading or navigating the requested folder fails", async () => {
  state.waitForProject.mockRejectedValueOnce(new Error("Folder unavailable"));
  expect(await useOpenFolder()(work)).toBe(false);
  expect(state.setScope).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Folder unavailable" }),
  );
  state.newThread.mockRejectedValueOnce(new Error("Navigation unavailable"));
  expect(await useOpenFolder()(work)).toBe(false);
  expect(state.setScope).not.toHaveBeenCalled();
});

it("does not change scope when draft creation was superseded", async () => {
  state.newThread.mockResolvedValueOnce(null);
  expect(await useOpenFolder()(work)).toBe(false);
  expect(state.setScope).not.toHaveBeenCalled();
});

it("keeps a grouped search's settled chat when explicitly reopening its folder", async () => {
  state.threads = [{ ...thread("settled-chat"), settledOverride: "settled" }];
  expect(await useOpenFolder()(work, { reopenSettled: true })).toBe(true);
  expect(state.router.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      params: { environmentId: "this-mac", threadId: "settled-chat" },
    }),
  );
  expect(state.newThread).not.toHaveBeenCalled();
  expect(state.setScope).toHaveBeenCalledWith("this-mac:work");
});
