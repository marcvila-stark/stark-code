// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@starkfuture/contracts";

const state = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    target,
    targets: [target],
    connectedEnvironments: [environment],
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [environment] }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => settings,
  useScopedSettingsMixed: () => false,
  useScopedSettingSource: () => "environment",
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({
    control,
    children,
    resetAction,
  }: {
    control: ReactNode;
    children?: ReactNode;
    resetAction?: ReactNode;
  }) => (
    <div>
      {control}
      {resetAction}
      {children}
    </div>
  ),
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>Reset {label}</button>
  ),
}));

import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("claude");
const settings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  defaultModelSelection: { instanceId, model: "claude-test" },
};
const target = { environmentId, projectId: null, settings };
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const environment = { environmentId, serverConfig: { providers: [provider] } };
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.update.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers safe Claude defaults and saves Auto through the actual picker", async () => {
  await act(async () => root.render(<ProjectDefaultsSettings category="general" />));
  expect(container.querySelector('[aria-label="Default workspace"]')).toBeNull();
  const trigger = container.querySelector<HTMLElement>('[aria-label="Default permissions"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const choices = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  expect(choices.map((choice) => choice.textContent)).toEqual([
    expect.stringMatching(/^Manual/),
    expect.stringMatching(/^Accept edits/),
    expect.stringMatching(/^Auto/),
  ]);
  const auto = choices.find((choice) => choice.textContent?.startsWith("Auto"))!;
  await act(async () => auto.click());
  expect(state.update).toHaveBeenCalledExactlyOnceWith({ defaultRuntimeMode: "auto" });
});

it("moves workspace choices to Folder settings while retaining their scoped write", async () => {
  await act(async () =>
    root.render(<ProjectDefaultsSettings category="general" section="folder" />),
  );
  expect(container.querySelector('[aria-label="Default permissions"]')).toBeNull();
  const trigger = container.querySelector<HTMLElement>('[aria-label="Default workspace"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const worktree = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (option) => option.textContent?.toLowerCase().includes("worktree"),
  );
  expect(worktree).toBeDefined();
  await act(async () => worktree!.click());
  expect(state.update).toHaveBeenCalledExactlyOnceWith({ defaultThreadEnvMode: "worktree" });
});
