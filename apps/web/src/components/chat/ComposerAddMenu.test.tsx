// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@starkfuture/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./ComposerConnectorsMenu", () => ({
  ComposerConnectorsMenu: () => null,
  ComposerConnectionsDialog: () => null,
}));
vi.mock("./ComposerSkillsDialog", () => ({
  ComposerSkillsDialog: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => (
    <section role="dialog" aria-label="Skills">
      <button onClick={() => onOpenChange(false)}>Close skills</button>
    </section>
  ),
}));
vi.mock("./ComposerSlashCommandsDialog", () => ({
  ComposerSlashCommandsDialog: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => (
    <section role="dialog" aria-label="Slash commands">
      <button onClick={() => onOpenChange(false)}>Close commands</button>
    </section>
  ),
}));

import { ComposerAddMenu } from "./ComposerAddMenu";

let root: Root;
let container: HTMLDivElement;
const onCatalogOpenChange = vi.fn();
const onAttach = vi.fn();
const onInsertSkill = vi.fn(() => true);
const onInsertCommand = vi.fn(() => true);
const props: ComponentProps<typeof ComposerAddMenu> = {
  environmentId: EnvironmentId.make("local"),
  target: { threadId: ThreadId.make("thread") },
  inspectionTarget: {
    projectId: ProjectId.make("project"),
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  providerKind: ProviderDriverKind.make("claudeAgent"),
  providerLabel: "Claude",
  disabled: false,
  canAttach: true,
  canAddContext: true,
  skills: [],
  commands: [],
  catalogPending: false,
  onAttach,
  onInsertSkill,
  onInsertCommand,
  onCatalogOpenChange,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(overrides: Partial<ComponentProps<typeof ComposerAddMenu>> = {}) {
  await act(() => root.render(<ComposerAddMenu {...props} {...overrides} />));
}
async function click(label: string) {
  const element = [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
  );
  if (!element) throw new Error(`Missing menu action: ${label}`);
  await act(() => element.click());
}

it("offers four useful actions and attaches without requesting provider catalogs", async () => {
  await render();
  await click("Add context and tools");
  expect(
    [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
  ).toEqual(["Add files or photos", "Slash commands", "Connectors", "Skills"]);
  expect(onCatalogOpenChange).not.toHaveBeenCalledWith(true);
  await click("Add files or photos");
  expect(onAttach).toHaveBeenCalledOnce();
  expect(onCatalogOpenChange).not.toHaveBeenCalledWith(true);
  expect(onInsertSkill).not.toHaveBeenCalled();
  expect(onInsertCommand).not.toHaveBeenCalled();
});

it.each([
  ["Skills", "Close skills"],
  ["Slash commands", "Close commands"],
])("loads catalogs only while the %s dialog is open", async (action, close) => {
  await render();
  await click("Add context and tools");
  expect(onCatalogOpenChange).not.toHaveBeenCalledWith(true);
  await click(action);
  expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(action);
  expect(onCatalogOpenChange).toHaveBeenLastCalledWith(true);
  expect(onAttach).not.toHaveBeenCalled();
  expect(onInsertSkill).not.toHaveBeenCalled();
  expect(onInsertCommand).not.toHaveBeenCalled();
  await click(close);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(onCatalogOpenChange).toHaveBeenLastCalledWith(false);
});

it("closes provider controls and stops catalog reads when the composer becomes unavailable", async () => {
  await render();
  await click("Add context and tools");
  await click("Skills");
  expect(onCatalogOpenChange).toHaveBeenLastCalledWith(true);
  await render({ disabled: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(onCatalogOpenChange).toHaveBeenLastCalledWith(false);
  expect(
    document.querySelector<HTMLButtonElement>('[aria-label="Add context and tools"]')?.disabled,
  ).toBe(true);
  expect(onInsertSkill).not.toHaveBeenCalled();
  expect(onInsertCommand).not.toHaveBeenCalled();
});
