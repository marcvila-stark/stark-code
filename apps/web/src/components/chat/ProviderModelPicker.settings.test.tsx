// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@starkfuture/contracts";

vi.mock("./ModelPickerContent", async (load) => {
  const actual = await load<typeof import("./ModelPickerContent")>();
  return { ...actual, ModelPickerContent: () => <div data-model-picker-content>Models</div> };
});

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { TooltipProvider } from "../ui/tooltip";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { TraitsPicker, traitsSummary } from "./TraitsPicker";

let root: Root;
let container: HTMLDivElement;
const instanceId = ProviderInstanceId.make("codex_work");
const driver = ProviderDriverKind.make("codex");
const model: ServerProviderModel = {
  slug: "test-model",
  name: "Test model",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ],
  },
};
const provider: ServerProvider = {
  instanceId,
  driver,
  displayName: "Work profile",
  enabled: true,
  installed: true,
  status: "ready",
  version: null,
  checkedAt: "2026-10-19T12:00:00Z",
  auth: { status: "authenticated" },
  models: [model],
  slashCommands: [],
  skills: [],
};

function ComposerModel({ compact = false }: { compact?: boolean }) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection> | undefined>([
    { id: "reasoningEffort", value: "low" },
  ]);
  const traitsProps = {
    provider: driver,
    instanceId,
    models: [model],
    model: model.slug,
    modelOptions: options,
    prompt: "",
    onPromptChange: () => {},
    planModeEnabled: true,
  };
  return (
    <TooltipProvider>
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model.slug}
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([provider])}
        modelOptionsByInstance={new Map([[instanceId, [model]]])}
        onInstanceModelChange={() => {}}
        showProviderIdentity
        isComposerOwned
        size={compact ? "xs" : "sm"}
        modelSettingsSummary={traitsSummary(traitsProps)}
        modelSettings={<TraitsPicker {...traitsProps} onModelOptionsChange={setOptions} />}
      />
      <output>{options?.[0]?.value}</output>
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "changes effort inside the model picker in compact=%s mode",
  async (compact) => {
    await act(() => root.render(<ComposerModel compact={compact} />));
    const modelTrigger = container.querySelector<HTMLButtonElement>(
      "[data-chat-provider-model-picker]",
    )!;
    expect(modelTrigger.getAttribute("aria-label")).toContain("Codex · Work profile");
    expect(modelTrigger.textContent).toContain("Low");
    await act(() => modelTrigger.click());
    const settings = document.querySelector("[data-composer-model-settings]");
    expect(settings?.textContent).toContain("Effort and model options");
    await act(() => settings?.querySelector<HTMLButtonElement>("button")?.click());
    const high = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).find(
      (item) => item.textContent === "High",
    );
    expect(high).toBeDefined();
    await act(() => high?.click());
    expect(container.querySelector("output")?.textContent).toBe("high");
    expect(modelTrigger.textContent).toContain("High");
  },
);
