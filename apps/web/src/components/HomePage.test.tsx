// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@starkfuture/contracts";
import type { ComposerThreadDraftState, DraftThreadState } from "../composerDraftStore";

const state = vi.hoisted(() => ({
  newChat: vi.fn(),
  startScratch: vi.fn(),
  openFolder: vi.fn(),
  navigate: vi.fn(),
  draftSessions: {} as Record<string, DraftThreadState>,
  composers: {} as Record<string, ComposerThreadDraftState>,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: state.navigate }) }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: state.newChat, selectedProjectRef: null }),
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => "local",
    startScratchThread: state.startScratch,
  }),
}));
vi.mock("../hooks/useOpenFolder", () => ({ useOpenFolder: () => state.openFolder }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => [],
  readThreadShells: () => [],
  useServerConfigs: () => new Map(),
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../composerDraftStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../composerDraftStore")>()),
  useComposerDraftStore: (select: (value: unknown) => unknown) =>
    select({
      draftThreadsByThreadKey: state.draftSessions,
      draftsByThreadKey: state.composers,
    }),
}));
vi.mock("./sidebar/OpenFolderDialog", () => ({ OpenFolderDialog: () => <div>Folder picker</div> }));

import { HomePage } from "./HomePage";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.navigate.mockResolvedValue(undefined);
  state.draftSessions = {
    saved: {
      threadId: ThreadId.make("future-thread"),
      environmentId: EnvironmentId.make("local"),
      projectId: ProjectId.make("work"),
      logicalProjectKey: "work",
      createdAt: "2026-10-25T00:00:00.000Z",
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
    },
  };
  state.composers = {
    saved: {
      prompt: "Resume my exact draft\nIncluding a second line",
      images: [],
      files: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      modelSelectionByProvider: {},
      activeProvider: null,
      runtimeMode: null,
      interactionMode: null,
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("visiting Home is passive; continuing an existing draft restores its exact route and content", async () => {
  const savedPrompt = state.composers.saved!.prompt;
  const savedSession = state.draftSessions.saved;
  await act(() =>
    root.render(
      <StrictMode>
        <HomePage />
      </StrictMode>,
    ),
  );
  expect(state.newChat).not.toHaveBeenCalled();
  expect(state.startScratch).not.toHaveBeenCalled();
  expect(state.openFolder).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  const savedRow = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Resume my exact draft"),
  );
  expect(savedRow).toBeDefined();
  await act(() => savedRow!.click());
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/draft/$draftId",
    params: { draftId: "saved" },
  });
  expect(state.newChat).not.toHaveBeenCalled();
  expect(state.draftSessions.saved).toBe(savedSession);
  expect(state.composers.saved!.prompt).toBe(savedPrompt);
});

it("starts a projectless chat through the scratch workflow when no folders exist", async () => {
  state.startScratch.mockResolvedValue(undefined);
  await act(() => root.render(<HomePage />));
  const newChat = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "New chat",
  );
  expect(newChat).toBeDefined();
  await act(() => newChat!.click());
  expect(state.startScratch).toHaveBeenCalledExactlyOnceWith("local");
  expect(state.openFolder).not.toHaveBeenCalled();
});
