// @vitest-environment jsdom
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@starkfuture/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ refresh: vi.fn(), query: {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => false }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    mcpServers: () => state.query,
    setMcpServerEnabled: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { live: true, servers: [] },
    error: null,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ presentation: null }),
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("./McpServersPanel", () => ({
  McpServersPanel: () => <input aria-label="MCP sign-in callback" />,
}));

import { Menu, MenuPopup, MenuSub, MenuSubTrigger, MenuTrigger } from "../ui/menu";
import { ComposerConnectionsDialog, ComposerConnectorsMenu } from "./ComposerConnectorsMenu";
import { isInsideRestingComposerControlScope } from "./composerEventScope";

const props = {
  environmentId: EnvironmentId.make("local"),
  target: {
    projectId: ProjectId.make("project"),
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  providerKind: "claudeAgent" as const,
  providerLabel: "Claude",
};
let root: Root;
let container: HTMLDivElement;
const composerKey = vi.fn();
const manage = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  composerKey.mockReset();
  manage.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps sign-in input focus outside the resting composer and contains Enter without cancelling its default", async () => {
  await act(() =>
    root.render(
      <div onKeyDown={composerKey}>
        <ComposerConnectionsDialog {...props} open onOpenChange={vi.fn()} />
      </div>,
    ),
  );
  const input = document.querySelector<HTMLInputElement>('[aria-label="MCP sign-in callback"]')!;
  expect(isInsideRestingComposerControlScope(input)).toBe(true);
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(() => input.dispatchEvent(enter));
  expect(composerKey).not.toHaveBeenCalled();
  expect(enter.defaultPrevented).toBe(false);
});

it("keeps connector menu actions outside composer focus and Enter handling", async () => {
  await act(() =>
    root.render(
      <div onKeyDown={composerKey}>
        <Menu open>
          <MenuTrigger>More</MenuTrigger>
          <MenuPopup>
            <MenuSub open>
              <MenuSubTrigger>Connections</MenuSubTrigger>
              <ComposerConnectorsMenu
                {...props}
                target={{ threadId: ThreadId.make("thread") }}
                open
                onManage={manage}
              />
            </MenuSub>
          </MenuPopup>
        </Menu>
      </div>,
    ),
  );
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === "Manage connections",
  )!;
  expect(item).toBeDefined();
  expect(isInsideRestingComposerControlScope(item)).toBe(true);
  await act(() => {
    item.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  expect(composerKey).not.toHaveBeenCalled();
});
