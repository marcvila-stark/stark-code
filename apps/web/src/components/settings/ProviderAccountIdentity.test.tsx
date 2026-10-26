// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@starkfuture/contracts";
import { ProviderAccountIdentity } from "./ProviderAccountIdentity";

const state = vi.hoisted(() => ({ canRead: true, read: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.canRead }));
vi.mock("../../state/claudeAccounts", () => ({
  claudeAccountsEnvironment: { snapshot: { permissionAtom: () => ({}) } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.read }));

const environmentId = EnvironmentId.make("settings-test");
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", label: "Claude subscription" },
  checkedAt: "2026-10-20T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.canRead = true;
  state.read.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      accounts: [
        { active: false, organizationName: "Other organization" },
        { active: true, organizationName: "Current organization" },
      ],
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(value: ServerProvider) {
  await act(async () => {
    root.render(<ProviderAccountIdentity environmentId={environmentId} provider={value} />);
  });
}

it.each([provider, { ...provider, usesSharedClaudeLogin: false }])(
  "uses the configured provider identity without reading a shared credential catalog",
  async (value) => {
    await render(value);
    expect(state.read).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Claude subscription");
  },
);

it("shows the selected shared-login organization without changing the login", async () => {
  await render({ ...provider, usesSharedClaudeLogin: true });
  expect(state.read).toHaveBeenCalledExactlyOnceWith({ environmentId, input: undefined });
  expect(container.textContent).toBe("Current organization · selected organization");
});
it("does not query the catalog without provider management permission", async () => {
  state.canRead = false;
  await render({ ...provider, usesSharedClaudeLogin: true });
  expect(state.read).not.toHaveBeenCalled();
});
