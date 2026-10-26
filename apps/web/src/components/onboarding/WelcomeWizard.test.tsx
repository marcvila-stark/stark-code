// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  importThreads: vi.fn(),
  createProject: vi.fn(),
  complete: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: Array<{ environmentId: string }>) =>
    new Set(environments.map((entry) => entry.environmentId)),
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "import" }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "import"
      ? mocks.importThreads
      : command === "create"
        ? mocks.createProject
        : mocks.refresh,
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => mocks.complete }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  readProjects: () => mocks.projects,
}));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: { phase: "connected" },
    entry: {
      enabled: true,
      target: {
        _tag: "PrimaryConnectionTarget",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      },
    },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => [],
    configValueAtom: () => null,
    refreshProviders: "refresh",
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../clerk/useStarkConnectAuthPrompt", () => ({ useStarkConnectAuthPrompt: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.projects = [{ id: "test-project", environmentId: "test-env", workspaceRoot: "/project" }];
  mocks.complete.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 28, skippedCount: 1 },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
});

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

it("allows setup to finish without choosing a folder or importing provider history", async () => {
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  expect(document.body.textContent).toContain("Choose your main folder");
  await click("Choose later");
  expect(onDone).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(mocks.createProject).not.toHaveBeenCalled();
  expect(mocks.importThreads).not.toHaveBeenCalled();
});

it("keeps setup open when saving completion fails and retries without duplicate writes", async () => {
  mocks.complete.mockRejectedValueOnce(new Error("settings unavailable"));
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Choose later");
  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not finish setup" }),
  );
  await click("Choose later");
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.createProject).not.toHaveBeenCalled();
  expect(mocks.importThreads).not.toHaveBeenCalled();
});

it("offers browser import after agents and can revisit it without importing or signing into Pages", async () => {
  const listBrowserImportSources = vi.fn().mockResolvedValue([]);
  const importBrowserCookies = vi.fn();
  const connect = vi.fn();
  window.desktopBridge = {
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        label: "This Mac",
        runningDistro: null,
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      },
    ],
    preview: { listBrowserImportSources, importBrowserCookies },
    publishedPages: { connect },
  } as unknown as NonNullable<Window["desktopBridge"]>;
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  expect(document.body.textContent).toContain("Connect your agents");
  expect(document.body.textContent).not.toContain("Connect your computers");
  await click("Continue");
  expect(document.body.textContent).toContain("Bring your website sign-ins");
  expect(importBrowserCookies).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  await click("Skip for now");
  expect(document.body.textContent).toContain("Choose your main folder");
  const browserStep = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Browser, step 2"]',
  );
  expect(browserStep).not.toBeNull();
  await act(async () => browserStep!.click());
  expect(document.body.textContent).toContain("Bring your website sign-ins");
  expect(importBrowserCookies).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

it("starts with local agents and keeps other computers an explicit choice", async () => {
  window.desktopBridge = {
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        label: "This Mac",
        runningDistro: null,
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      },
    ],
  } as unknown as NonNullable<Window["desktopBridge"]>;
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  expect(document.body.textContent).toContain("Connect your agents");
  expect(document.body.textContent).not.toContain("Connect your computers");
  await click("Use another computer");
  expect(document.body.textContent).toContain("Connect your computers");
  await click("Continue");
  expect(document.body.textContent).toContain("Connect your agents");
  await click("Continue");
  expect(document.body.textContent).toContain("Choose your main folder");
});

it("keeps the connection choice for a remote primary, even in the desktop app", async () => {
  const listBrowserImportSources = vi.fn();
  window.desktopBridge = {
    getLocalEnvironmentBootstraps: () => [
      {
        id: "primary",
        label: "This Mac",
        runningDistro: null,
        httpBaseUrl: "http://127.0.0.1:4000",
        wsBaseUrl: "ws://127.0.0.1:4000",
      },
    ],
    preview: { listBrowserImportSources },
  } as unknown as NonNullable<Window["desktopBridge"]>;
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={vi.fn()} />));
  expect(document.body.textContent).toContain("Connect your computers");
  await click("Continue");
  await click("Continue");
  expect(document.body.textContent).toContain("Choose your main folder");
  expect(listBrowserImportSources).not.toHaveBeenCalled();
});
