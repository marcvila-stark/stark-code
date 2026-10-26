// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@starkfuture/contracts";
import { OpenRouterSetupDialog, openRouterInstanceWithKey } from "./OpenRouterSetupDialog";

const state = vi.hoisted(() => ({
  settings: { providerInstances: {} as Record<string, ProviderInstanceConfig> },
  allowed: true,
  persist: vi.fn(),
  openExternal: vi.fn(),
  environmentIds: [] as string[],
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => state.settings,
  usePersistEnvironmentProviderInstanceMutation: (id: string) => {
    state.environmentIds.push(id);
    return state.persist;
  },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));

let root: Root;
let container: HTMLDivElement;
const close = vi.fn();
const saved = vi.fn();
const environmentId = EnvironmentId.make("configured-device");
const render = (instanceId?: ProviderInstanceId) =>
  act(() =>
    root.render(
      <OpenRouterSetupDialog
        environmentId={environmentId}
        environmentLabel="This Mac"
        instanceId={instanceId}
        onOpenChange={close}
        onSaved={saved}
      />,
    ),
  );
const submit = () =>
  act(() => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
const typeKey = (value: string) =>
  act(() => {
    const input = document.querySelector<HTMLInputElement>("#openrouter-api-key")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = { providerInstances: {} };
  state.allowed = true;
  state.environmentIds = [];
  state.persist.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.openExternal.mockReset().mockResolvedValue(undefined);
  close.mockReset();
  saved.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("saves a separate OpenRouter connection on the selected device without placing the key in config", async () => {
  state.settings.providerInstances.openrouter = {
    driver: ProviderDriverKind.make("claudeAgent"),
    config: { apiBackend: "openrouter" },
  };
  await render();
  expect(document.body.textContent).toContain("bills these requests separately");
  await act(() => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Get an API key")!
      .click();
  });
  expect(state.openExternal).toHaveBeenCalledWith("https://openrouter.ai/settings/keys");
  await typeKey("fixture-only-key");
  await submit();
  const mutation = state.persist.mock.calls[0]![0];
  expect(state.environmentIds.every((id) => id === environmentId)).toBe(true);
  expect(mutation.instanceId).toBe("openrouter_2");
  expect(mutation.instance.config).toEqual({
    apiBackend: "openrouter",
    homePath: "~/.stark-code/openrouter/openrouter_2",
    customModels: [],
  });
  expect(mutation.instance.environment).toContainEqual({
    name: "ANTHROPIC_AUTH_TOKEN",
    value: "fixture-only-key",
    sensitive: true,
  });
  expect(JSON.stringify(mutation.instance.config)).not.toContain("fixture-only-key");
  expect(saved).toHaveBeenCalledWith("openrouter_2");
  expect(close).toHaveBeenCalledWith(false);
});

it("keeps a stored write-only key when editing blank and replaces it explicitly", async () => {
  const instanceId = ProviderInstanceId.make("openrouter_team");
  const marker = { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true };
  const existing: ProviderInstanceConfig = {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Team API",
    enabled: false,
    config: {
      apiBackend: "openrouter",
      homePath: "~/separate-router",
      customModels: ["vendor/model"],
    },
    environment: [marker],
  };
  state.settings.providerInstances[instanceId] = existing;
  await render(instanceId);
  expect(document.querySelector<HTMLInputElement>("#openrouter-api-key")!.value).toBe("");
  expect(document.body.textContent).toContain("Leave blank to keep your saved key");
  await submit();
  expect(state.persist.mock.calls[0]![0].instance.environment).toContainEqual(marker);
  const replacement = openRouterInstanceWithKey(instanceId, "replacement-fixture", existing);
  expect(replacement.enabled).toBe(false);
  expect(replacement.config).toEqual(existing.config);
  expect(replacement.environment).toContainEqual({
    name: "ANTHROPIC_AUTH_TOKEN",
    value: "replacement-fixture",
    sensitive: true,
  });
  expect(replacement.environment?.some((entry) => entry.valueRedacted)).toBe(false);
});

it("blocks missing keys, permission revocation and duplicate saves", async () => {
  await render();
  await submit();
  expect(document.body.textContent).toContain("Enter your OpenRouter API key");
  expect(state.persist).not.toHaveBeenCalled();
  await typeKey("fixture-only-key");
  state.allowed = false;
  await submit();
  expect(state.persist).not.toHaveBeenCalled();
  state.allowed = true;
  let finish!: (result: { _tag: "Success" }) => void;
  state.persist.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await submit();
  await submit();
  expect(state.persist).toHaveBeenCalledOnce();
  await act(async () => {
    finish({ _tag: "Success" });
  });
});

it("shows a retryable save error without displaying a secret included in a backend error", async () => {
  state.persist.mockRejectedValueOnce(new Error("fixture-secret failure"));
  await render();
  await typeKey("fixture-secret");
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  expect(document.body.textContent).not.toContain("fixture-secret");
  expect(close).not.toHaveBeenCalled();
});
