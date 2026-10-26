// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  type ClaudeAccountsCommand,
  type ClaudeAccountsSnapshot,
} from "@starkfuture/contracts";

const state = vi.hoisted(() => ({
  canRead: true,
  canWrite: true,
  read: vi.fn(),
  command: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "read-permission" ? state.canRead : state.canWrite),
}));
vi.mock("../../state/claudeAccounts", () => ({
  claudeAccountsEnvironment: {
    snapshot: { kind: "read", permissionAtom: () => "read-permission" },
    command: { kind: "command", permissionAtom: () => "write-permission" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) =>
    command.kind === "read" ? state.read : state.command,
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    children,
    title,
    headerAction,
  }: {
    children: React.ReactNode;
    title: string;
    headerAction: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
}));

import { ClaudeAccountsPanel } from "./ClaudeAccountsPanel";

const environmentId = EnvironmentId.make("organization-machine");
const snapshot: ClaudeAccountsSnapshot = {
  available: true,
  activeAccountNumber: 1,
  accounts: [
    {
      number: 1,
      email: "person@example.com",
      organizationName: "Stark Engineering",
      organizationUuid: "org-engineering",
      alias: null,
      active: true,
      disabled: false,
      usageStatus: "ok",
      usageAgeSeconds: 45,
      windows: [{ name: "5 hours", percent: 92, resetsAt: "2026-10-17T16:00:00Z" }],
    },
    {
      number: 2,
      email: "person@example.com",
      organizationName: "Stark Operations",
      organizationUuid: "org-operations",
      alias: null,
      active: false,
      disabled: false,
      usageStatus: "relogin_required",
      usageAgeSeconds: null,
      windows: [],
    },
  ],
  automatic: { enabled: false, threshold: 90, lastOutcome: null },
  notice: null,
};

let root: Root;
let container: HTMLDivElement;
const success = (value: ClaudeAccountsSnapshot = snapshot) => ({ _tag: "Success" as const, value });

async function render(options?: { id?: EnvironmentId; readOnly?: boolean }) {
  await act(() =>
    root.render(
      <ClaudeAccountsPanel
        environmentId={options?.id ?? environmentId}
        environmentLabel="Work Mac"
        readOnly={options?.readOnly ?? false}
      />,
    ),
  );
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string, scope: ParentNode = document) {
  await act(() => button(label, scope).click());
}

async function load() {
  await render();
  await click("Load organizations");
}

function automaticSwitch() {
  return container.querySelector<HTMLButtonElement>(
    '[aria-label="Automatic Claude organization switching"]',
  )!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.canRead = true;
  state.canWrite = true;
  state.read.mockReset().mockResolvedValue(success());
  state.command.mockReset().mockImplementation(({ input }: { input: ClaudeAccountsCommand }) => {
    if (input.action === "automatic")
      return Promise.resolve(
        success({ ...snapshot, automatic: { ...snapshot.automatic, ...input } }),
      );
    if (input.action === "setEligible")
      return Promise.resolve(
        success({
          ...snapshot,
          accounts: snapshot.accounts.map((account) =>
            account.number === input.accountNumber
              ? { ...account, disabled: !input.eligible }
              : account,
          ),
        }),
      );
    return Promise.resolve(success());
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Claude organization controls", () => {
  it("loads only on request and keeps organizations with the same email distinct", async () => {
    await render();
    expect(state.read).not.toHaveBeenCalled();
    expect(container.textContent).toContain("macOS may ask for Keychain access");
    await click("Load organizations");
    expect(state.read).toHaveBeenCalledExactlyOnceWith({ environmentId, input: undefined });
    const organizations = container.querySelectorAll("li");
    expect(organizations).toHaveLength(2);
    expect(organizations[0]?.textContent).toContain("Stark Engineering");
    expect(organizations[0]?.textContent).toContain("org-engineering");
    expect(organizations[0]?.textContent).toContain("92% used");
    expect(organizations[1]?.textContent).toContain("Stark Operations");
    expect(organizations[1]?.textContent).toContain("org-operations");
    expect(organizations[1]?.textContent).toContain("Usage unavailable");
    expect(organizations[1]?.textContent).toContain("relogin required");
    expect(organizations[1]?.textContent).not.toContain("0% used");
    expect(automaticSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("confirms the shared-machine effect before manually switching and leaves cancel harmless", async () => {
    await load();
    const target = container.querySelectorAll("li")[1]!;
    await click("Switch", target);
    expect(state.command).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "other terminals and VS Code",
    );
    await click("Cancel");
    expect(state.command).not.toHaveBeenCalled();
    await click("Switch", target);
    await click("Switch shared login");
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        action: "switch",
        accountNumber: 2,
        expectedEmail: "person@example.com",
        expectedOrganizationUuid: "org-operations",
      },
    });
    // A command returning unchanged metadata must not claim a running session switched.
    expect(container.querySelectorAll("li")[0]?.textContent).toContain("Active shared login");
    expect(container.querySelectorAll("li")[1]?.textContent).not.toContain("Active shared login");
  });

  it("requires consent before automatic switching and can disable it immediately", async () => {
    await load();
    await act(() => automaticSwitch().click());
    expect(state.command).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "No session will be restarted",
    );
    await click("Enable automatic switching");
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { action: "automatic", enabled: true, threshold: 90 },
    });
    expect(automaticSwitch().getAttribute("aria-checked")).toBe("true");
    await act(() => automaticSwitch().click());
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId,
      input: { action: "automatic", enabled: false, threshold: 90 },
    });
    expect(automaticSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("saves the current login explicitly and excludes organizations from the shared auto-switching pool", async () => {
    await load();
    expect(container.textContent).toContain("Saving does not sign you in");
    await click("Save current login");
    expect(state.command).toHaveBeenLastCalledWith({ environmentId, input: { action: "capture" } });
    const eligible = container.querySelector<HTMLButtonElement>(
      '[aria-label="Include Stark Operations in auto-switching"]',
    )!;
    await act(() => eligible.click());
    expect(state.command).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        action: "setEligible",
        accountNumber: 2,
        expectedEmail: "person@example.com",
        expectedOrganizationUuid: "org-operations",
        eligible: false,
      },
    });
    expect(eligible.getAttribute("aria-checked")).toBe("false");
    expect(automaticSwitch().getAttribute("aria-disabled")).toBe("true");
  });

  it("shows installation steps without running any command when cswap is missing", async () => {
    state.read.mockResolvedValue(success({ ...snapshot, available: false, accounts: [] }));
    await load();
    expect(container.textContent).toContain("uv tool install claude-swap");
    expect(container.textContent).toContain("on Work Mac");
    expect(state.command).not.toHaveBeenCalled();
    expect(
      container.querySelector('[aria-label="Automatic Claude organization switching"]'),
    ).toBeNull();
  });

  it.each(["49", "100", "90.5"])(
    "rejects threshold %s and confirms a valid threshold before sending it",
    async (invalidThreshold) => {
      await load();
      const input = container.querySelector<HTMLInputElement>(
        '[aria-label="Claude switching threshold percent"]',
      )!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(() => {
        setValue.call(input, invalidThreshold);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.textContent).toContain("Choose a whole percentage from 50 to 99");
      expect(automaticSwitch().getAttribute("aria-disabled")).toBe("true");
      expect(state.command).not.toHaveBeenCalled();
      await act(() => {
        setValue.call(input, "95");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(() => automaticSwitch().click());
      await click("Enable automatic switching");
      expect(state.command).toHaveBeenLastCalledWith({
        environmentId,
        input: { action: "automatic", enabled: true, threshold: 95 },
      });
    },
  );

  it("does not count API keys as organizations with subscription quota or show stale windows as current usage", async () => {
    state.read.mockResolvedValue(
      success({
        ...snapshot,
        accounts: [
          snapshot.accounts[0]!,
          {
            ...snapshot.accounts[1]!,
            usageStatus: "api_key",
            windows: [{ name: "7 days", percent: 10, resetsAt: null }],
          },
        ],
      }),
    );
    await load();
    expect(automaticSwitch().getAttribute("aria-disabled")).toBe("true");
    const apiKey = container.querySelectorAll("li")[1]!;
    expect(apiKey.textContent).not.toContain("10% used");
    expect(apiKey.querySelector('[role="switch"]')?.getAttribute("aria-disabled")).toBe("true");
    expect(state.command).not.toHaveBeenCalled();
  });

  it("can stop automatic switching even after cswap becomes unavailable", async () => {
    state.read.mockResolvedValue(
      success({
        ...snapshot,
        available: false,
        automatic: { ...snapshot.automatic, enabled: true },
      }),
    );
    await load();
    await click("Stop automatic switching");
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { action: "automatic", enabled: false, threshold: 90 },
    });
  });

  it("keeps the old organization and allows retry when switching fails", async () => {
    state.command.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Organization changed; refresh and try again.")),
    });
    await load();
    const target = container.querySelectorAll("li")[1]!;
    await click("Switch", target);
    await click("Switch shared login");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Organization changed",
    );
    expect(container.querySelectorAll("li")[0]?.textContent).toContain("Active shared login");
    expect(button("Switch", target).disabled).toBe(false);
  });

  it("reconciles partial failures without repeating the action or hiding its error", async () => {
    state.read
      .mockResolvedValueOnce(
        success({ ...snapshot, automatic: { ...snapshot.automatic, enabled: true } }),
      )
      .mockResolvedValueOnce(success(snapshot));
    state.command.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Stopped, but preferences could not be saved.")),
    });
    await load();
    await act(() => automaticSwitch().click());
    expect(state.command).toHaveBeenCalledTimes(1);
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(automaticSwitch().getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "preferences could not be saved",
    );
  });

  it("does not read without permission, and removes an open confirmation when write access is revoked", async () => {
    state.canRead = false;
    state.canWrite = false;
    await render();
    expect(button("Load organizations").disabled).toBe(true);
    await click("Load organizations");
    expect(state.read).not.toHaveBeenCalled();
    state.canRead = true;
    state.canWrite = true;
    await load();
    await act(() => automaticSwitch().click());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    state.canWrite = false;
    await render();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(automaticSwitch().getAttribute("aria-disabled")).toBe("true");
    expect(state.command).not.toHaveBeenCalled();
  });

  it("serializes requests and does not display a late result after changing machines", async () => {
    let complete!: (value: ReturnType<typeof success>) => void;
    state.read.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof success>>((resolve) => {
          complete = resolve;
        }),
    );
    await render();
    await click("Load organizations");
    expect(button("Updating…").disabled).toBe(true);
    await act(() => button("Updating…").click());
    expect(state.read).toHaveBeenCalledTimes(1);
    await render({ id: EnvironmentId.make("another-machine") });
    await act(() => complete(success()));
    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(button("Load organizations").disabled).toBe(false);
  });
});
