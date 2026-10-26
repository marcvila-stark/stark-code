import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@starkfuture/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type Project = { id: ProjectId; environmentId: EnvironmentId; workspaceRoot: string };
type CreateProjectInput = {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; workspaceRoot: string };
};
const state = vi.hoisted(() => ({
  selectedEnvironment: "primary",
  availableEnvironments: null as string[] | null,
  registry: null as AtomRegistry.AtomRegistry | null,
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  projects: null as Atom.Writable<ReadonlyArray<Project>> | null,
  providers: null as Atom.Atom<ReadonlyArray<never>> | null,
  config: null as Atom.Atom<null> | null,
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshProviders: vi.fn(),
  connectPairing: vi.fn(),
  completeOnboarding: vi.fn(),
  onDone: vi.fn(),
  pickFolder: vi.fn(),
  scan: vi.fn(),
}));

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@starkfuture/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
  }),
}));
vi.mock("../../rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("../../hooks/useTheme", () => ({ mountOnboardingTheme: () => () => {} }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [false, () => {}] }));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), copied: false }),
}));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../clerk/useStarkConnectAuthPrompt", () => ({ useStarkConnectAuthPrompt: vi.fn() }));
vi.mock("../../onboarding/firstRun", () => ({
  useCompleteOnboarding: () => state.completeOnboarding,
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { pickFolder: state.pickFolder } }),
}));
vi.mock("../../state/environments", () => {
  const environment = (environmentId: string) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    entry: {
      enabled: true,
      target: {
        _tag: environmentId === "primary" ? "PrimaryConnectionTarget" : "DirectConnectionTarget",
      },
    },
  });
  const primary = environment("primary");
  return {
    usePrimaryEnvironment: () => primary,
    useEnvironments: () => ({
      environments: (state.availableEnvironments ?? [state.selectedEnvironment]).map(environment),
    }),
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => state.providers,
    configValueAtom: () => state.config,
    refreshProviders: "refreshProviders",
  },
}));
vi.mock("../../state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useProjects: () => useAtomValue(state.projects!),
    readProjects: () => state.registry!.get(state.projects!),
  };
});
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "createProject" } }));
vi.mock("../../state/agentSessions", () => ({
  agentSessionScan: state.scan,
  agentSessionImport: "importThreads",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: "div",
  DialogPopup: "div",
  DialogTitle: "div",
  DialogHeader: "div",
}));
vi.mock("./OnboardingLayout", () => ({
  OnboardingPanel: "div",
  OnboardingSteps: "div",
  OnboardingPopup: "div",
  OnboardingHeader: "div",
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/tooltip", () => ({ Tooltip: "div", TooltipTrigger: "span", TooltipPopup: "span" }));
vi.mock("../../connection/onboarding", () => ({ connectPairing: "connectPairing" }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    command: "createProject" | "importThreads" | "refreshProviders" | "connectPairing",
  ) => state[command],
}));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: "div" }));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({ CloudEnvironmentConnectRows: "div" }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../settings/providerDriverMeta", () => ({
  providerClients: { get: () => ({ label: "Agent" }) },
}));
vi.mock("../settings/providerStatus", () => ({
  getProviderSummary: () => ({ headline: "Checking", detail: null }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/collapsible", () => ({
  Collapsible: "div",
  CollapsiblePanel: "div",
  CollapsibleTrigger: "button",
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(), close: vi.fn(), update: vi.fn() } }));

import { WelcomeWizard } from "./WelcomeWizard";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const permissionMessage = "This connection cannot open folders.";
let renderer: ReactTestRenderer | undefined;

function session(scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState {
  return {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope, ...scopes],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "stark_session",
    },
  };
}

function setGrant(environmentId: EnvironmentId, allowed: boolean) {
  state.registry!.set(
    state.sessions.get(environmentId)!,
    AsyncResult.success(session(allowed ? [AuthOrchestrationOperateScope] : [])),
  );
}

function recordProject({ environmentId, input }: CreateProjectInput) {
  state.registry!.set(state.projects!, [
    ...state.registry!.get(state.projects!),
    { id: input.projectId, environmentId, workspaceRoot: input.workspaceRoot },
  ]);
  return AsyncResult.success(undefined);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

function button(label: string) {
  const found = renderer!.root.findAllByType("button").find((node) => text(node) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  const target = button(label);
  expect(target.props.disabled).not.toBe(true);
  await act(async () => target.props.onClick());
}

async function mountImport(remote = false) {
  state.selectedEnvironment = remote ? "remote" : "primary";
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <WelcomeWizard localAvailable={!remote} onDone={state.onDone} />
      </RegistryContext.Provider>,
    );
  });
  await click("Continue");
  await click("Continue");
  expect(text(renderer!.root)).toContain("Choose your main folder");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("document", { activeElement: null, body: {}, getElementById: () => null });
  state.availableEnvironments = null;
  state.registry = AtomRegistry.make();
  for (const id of [primaryId, remoteId]) {
    state.sessions.set(
      id,
      Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
        Atom.keepAlive,
      ),
    );
  }
  state.projects = Atom.make<ReadonlyArray<Project>>([]).pipe(Atom.keepAlive);
  state.providers = Atom.make<ReadonlyArray<never>>([]).pipe(Atom.keepAlive);
  state.config = Atom.make(null).pipe(Atom.keepAlive);
  state.createProject
    .mockReset()
    .mockImplementation(async (input: CreateProjectInput) => recordProject(input));
  state.importThreads
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ importedCount: 1, skippedCount: 0 }));
  state.refreshProviders.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.connectPairing.mockReset().mockResolvedValue(AsyncResult.success(remoteId));
  state.completeOnboarding.mockReset().mockResolvedValue(undefined);
  state.onDone.mockReset();
  state.pickFolder.mockReset().mockResolvedValue(null);
  state.scan.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  state.sessions.clear();
  vi.unstubAllGlobals();
});

function folderInput() {
  return renderer!.root.findByProps({ id: "onboarding-main-folder" });
}

async function enterPath(value: string) {
  await act(async () => folderInput().props.onChange({ target: { value } }));
}

async function openFolder() {
  expect(button("Open folder").props.disabled).not.toBe(true);
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

it("chooses one main folder without scanning or importing any history", async () => {
  await mountImport();
  expect(text(renderer!.root)).not.toContain("/projects/first");
  expect(button("Open folder").props.disabled).toBe(true);
  await enterPath("/Users/test/Desktop/work");
  await openFolder();
  expect(state.createProject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      environmentId: primaryId,
      input: expect.objectContaining({
        workspaceRoot: "/Users/test/Desktop/work",
        title: "work",
        createWorkspaceRootIfMissing: false,
      }),
    }),
  );
  expect(state.scan).not.toHaveBeenCalled();
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(state.onDone).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ environmentId: primaryId }),
  );
});

it("skips folder setup without creating or importing anything", async () => {
  await mountImport();
  await click("Choose later");
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.scan).not.toHaveBeenCalled();
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(state.onDone).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("keeps manual path and skipping available to a paired read-only environment", async () => {
  setGrant(remoteId, false);
  await mountImport(true);
  await enterPath("/projects/main");
  expect(button("Open folder").props.disabled).toBe(true);
  expect(text(renderer!.root)).toContain(permissionMessage);
  expect(text(renderer!.root)).not.toContain("Choose folder…");
  await click("Choose later");
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("reuses an existing project at the selected root, including a trailing slash", async () => {
  const projectId = ProjectId.make("existing-main");
  state.registry!.set(state.projects!, [
    { id: projectId, environmentId: primaryId, workspaceRoot: "/projects/main" },
  ]);
  await mountImport();
  await enterPath("/projects/main/");
  await openFolder();
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.onDone).toHaveBeenCalledExactlyOnceWith({ environmentId: primaryId, projectId });
});

it("rechecks a retained submit callback after the selected grant is revoked", async () => {
  await mountImport(true);
  await enterPath("/projects/main");
  const retainedSubmit = renderer!.root.findByType("form").props.onSubmit;
  await act(async () => {
    setGrant(remoteId, false);
    retainedSubmit({ preventDefault() {} });
  });
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.onDone).not.toHaveBeenCalled();
  expect(text(renderer!.root)).toContain(permissionMessage);
  await act(async () => setGrant(remoteId, true));
  await openFolder();
  expect(state.createProject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ environmentId: remoteId }),
  );
});

it("retries an uncertain create failure with the same project and command identities", async () => {
  state.createProject.mockRejectedValueOnce(new Error("connection dropped"));
  await mountImport();
  await enterPath("/projects/main");
  await openFolder();
  expect(text(renderer!.root)).toContain("Could not open that folder");
  expect(state.onDone).not.toHaveBeenCalled();
  await openFolder();
  expect(state.createProject).toHaveBeenCalledTimes(2);
  expect(state.createProject.mock.calls[1]![0]).toEqual(state.createProject.mock.calls[0]![0]);
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("waits for the accepted project to reach the projection before navigation", async () => {
  let acceptedInput: CreateProjectInput | undefined;
  state.createProject.mockImplementationOnce(async (input: CreateProjectInput) => {
    acceptedInput = input;
    return AsyncResult.success(undefined);
  });
  await mountImport();
  await enterPath("/projects/main");
  await openFolder();
  expect(state.createProject).toHaveBeenCalledOnce();
  expect(state.onDone).not.toHaveBeenCalled();
  expect(button("Opening…").props.disabled).toBe(true);
  await act(async () => {
    recordProject(acceptedInput!);
  });
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("retries onboarding completion without creating the already opened folder twice", async () => {
  state.completeOnboarding.mockRejectedValueOnce(new Error("settings unavailable"));
  await mountImport();
  await enterPath("/projects/main");
  await openFolder();
  expect(state.onDone).not.toHaveBeenCalled();
  expect(button("Open folder").props.disabled).not.toBe(true);
  await openFolder();
  expect(state.createProject).toHaveBeenCalledOnce();
  expect(state.completeOnboarding).toHaveBeenCalledTimes(2);
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("opens the exact native folder selection without a second import confirmation", async () => {
  vi.stubGlobal("window", { desktopBridge: {} });
  state.pickFolder.mockResolvedValue("/Users/test/Desktop/work");
  await mountImport();
  await click("Choose folder…");
  expect(state.pickFolder).toHaveBeenCalledOnce();
  expect(state.createProject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      input: expect.objectContaining({ workspaceRoot: "/Users/test/Desktop/work" }),
    }),
  );
  expect(state.scan).not.toHaveBeenCalled();
  expect(state.importThreads).not.toHaveBeenCalled();
  expect(state.onDone).toHaveBeenCalledOnce();
});

it("does nothing when the native picker is cancelled and can retry", async () => {
  vi.stubGlobal("window", { desktopBridge: {} });
  await mountImport();
  await click("Choose folder…");
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.onDone).not.toHaveBeenCalled();
  expect(button("Choose folder…").props.disabled).not.toBe(true);
  state.pickFolder.mockResolvedValue("/projects/main");
  await click("Choose folder…");
  expect(state.createProject).toHaveBeenCalledOnce();
});

it("shows picker failures and leaves manual path entry available", async () => {
  vi.stubGlobal("window", { desktopBridge: {} });
  state.pickFolder.mockRejectedValue(new Error("picker unavailable"));
  await mountImport();
  await click("Choose folder…");
  expect(text(renderer!.root)).toContain("Could not choose a folder");
  await enterPath("/projects/main");
  await openFolder();
  expect(state.createProject).toHaveBeenCalledOnce();
});

it("rechecks access after the native picker returns", async () => {
  vi.stubGlobal("window", { desktopBridge: {} });
  const picked = deferred<string>();
  state.pickFolder.mockReturnValue(picked.promise);
  await mountImport();
  await click("Choose folder…");
  expect(button("Opening…").props.disabled).toBe(true);
  await act(async () => {
    setGrant(primaryId, false);
    picked.resolve("/projects/main");
  });
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.onDone).not.toHaveBeenCalled();
  expect(text(renderer!.root)).toContain(permissionMessage);
});

it("ignores native picker callbacks after leaving setup", async () => {
  vi.stubGlobal("window", { desktopBridge: {} });
  const picked = deferred<string>();
  state.pickFolder.mockReturnValue(picked.promise);
  await mountImport();
  await click("Choose folder…");
  await act(async () => {
    renderer!.unmount();
  });
  renderer = undefined;
  await act(async () => {
    picked.resolve("/projects/main");
  });
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.onDone).not.toHaveBeenCalled();
});

it("defaults a multi-computer setup to the primary computer and opens only the chosen target", async () => {
  state.availableEnvironments = ["remote", "primary"];
  await mountImport();
  const chooser = renderer!.root.findByType("select");
  expect(chooser.props.value).toBe(primaryId);
  await act(async () => chooser.props.onChange({ target: { value: remoteId } }));
  await enterPath("/remote/work");
  await openFolder();
  expect(state.createProject).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      environmentId: remoteId,
      input: expect.objectContaining({ workspaceRoot: "/remote/work" }),
    }),
  );
  expect(state.onDone).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ environmentId: remoteId }),
  );
});

it("rejects relative paths without creating directories", async () => {
  await mountImport();
  await enterPath("work/my-project");
  await openFolder();
  expect(text(renderer!.root)).toContain("Enter the full path");
  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.onDone).not.toHaveBeenCalled();
});

it("keeps setup busy and prevents duplicate actions while the native picker is open", async () => {
  vi.stubGlobal("window", { desktopBridge: {} });
  const picked = deferred<string | null>();
  state.pickFolder.mockReturnValue(picked.promise);
  await mountImport();
  const retainedChoose = button("Choose folder…").props.onClick;
  const retainedSkip = button("Choose later").props.onClick;
  await act(async () => {
    retainedChoose();
    retainedChoose();
    retainedSkip();
  });
  expect(button("Choose later").props.disabled).toBe(true);
  expect(state.pickFolder).toHaveBeenCalledOnce();
  expect(state.onDone).not.toHaveBeenCalled();
  await act(async () => {
    picked.resolve(null);
  });
  expect(button("Choose later").props.disabled).not.toBe(true);
});

it("ignores project-create completions after setup is unmounted", async () => {
  const creation = deferred<void>();
  state.createProject.mockImplementationOnce(async () => {
    await creation.promise;
    return AsyncResult.success(undefined);
  });
  await mountImport();
  await enterPath("/projects/main");
  await openFolder();
  await act(async () => {
    renderer!.unmount();
  });
  renderer = undefined;
  await act(async () => {
    creation.resolve();
  });
  expect(state.onDone).not.toHaveBeenCalled();
});
