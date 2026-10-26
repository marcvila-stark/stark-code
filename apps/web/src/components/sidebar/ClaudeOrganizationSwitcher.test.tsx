// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ClaudeAccountsSnapshot } from "@starkfuture/contracts";

const state = vi.hoisted(() => ({
  canRead: true,
  isConnected: true,
  canWrite: true,
  read: vi.fn(),
  command: vi.fn(),
  manage: vi.fn(),
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
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: string }) => unknown) =>
    select({ timestampFormat: "24-hour" }),
}));

import { ClaudeOrganizationSwitcher } from "./ClaudeOrganizationSwitcher";
import { SidebarProvider } from "../ui/sidebar";

const environmentId = EnvironmentId.make("quick-switch-machine");
const snapshot: ClaudeAccountsSnapshot = {
  available: true,
  activeAccountNumber: 1,
  accounts: [
    {
      number: 1,
      email: "person@example.com",
      organizationName: "Stark Future 1",
      organizationUuid: "org-1",
      alias: null,
      active: true,
      disabled: false,
      usageStatus: "ok",
      usageAgeSeconds: 20,
      windows: [{ name: "5 hours", percent: 89, resetsAt: null }],
    },
    {
      number: 2,
      email: "person@example.com",
      organizationName: "Stark Future 2",
      organizationUuid: "org-2",
      alias: null,
      active: false,
      disabled: true,
      usageStatus: "ok",
      usageAgeSeconds: 300,
      windows: [{ name: "5 hours", percent: 37, resetsAt: null }],
    },
    {
      number: 3,
      email: "person@example.com",
      organizationName: "Stark Future 3",
      organizationUuid: "org-3",
      alias: null,
      active: false,
      disabled: false,
      usageStatus: "relogin_required",
      usageAgeSeconds: 30,
      windows: [{ name: "5 hours", percent: 21, resetsAt: null }],
    },
  ],
  automatic: { enabled: false, threshold: 90, lastOutcome: null },
  notice: null,
};
const switched = {
  ...snapshot,
  activeAccountNumber: 2,
  accounts: snapshot.accounts.map((account) => ({ ...account, active: account.number === 2 })),
};
const success = (value: ClaudeAccountsSnapshot = snapshot) => ({ _tag: "Success" as const, value });
let root: Root;
let container: HTMLDivElement;

async function render(id: EnvironmentId = environmentId) {
  await act(() =>
    root.render(
      <SidebarProvider>
        <ClaudeOrganizationSwitcher
          environmentId={id}
          environmentLabel="Work Mac"
          isConnected={state.isConnected}
          onManage={state.manage}
        />
      </SidebarProvider>,
    ),
  );
}
function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) =>
      element.textContent?.trim() === text || element.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
const click = (text: string) => act(() => button(text).click());
const org = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((element) =>
    element.textContent?.startsWith(label),
  )!;
async function open() {
  await render();
  await click("Switch Claude organization");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.canRead = true;
  state.isConnected = true;
  state.canWrite = true;
  state.read.mockReset().mockResolvedValue(success());
  state.command.mockReset().mockResolvedValue(success(switched));
  state.manage.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("quick Claude organization switcher", () => {
  it("shows the current organization before opening and refreshes without changing the login", async () => {
    await render();
    expect(state.read).toHaveBeenCalledExactlyOnceWith({ environmentId, input: undefined });
    expect(button("Switch Claude organization").textContent).toContain("Stark Future 1");
    expect(button("Switch Claude organization").textContent).toContain("person@example.com");
    await click("Switch Claude organization");
    expect(state.read).toHaveBeenCalledExactlyOnceWith({ environmentId, input: undefined });
    expect(
      document.querySelector('section[aria-label="person@example.com"]')?.querySelectorAll("li"),
    ).toHaveLength(3);
    expect(button("Switch Claude organization").textContent).toContain("Stark Future 1");
    expect(org("Stark Future 1").getAttribute("aria-pressed")).toBe("true");
    expect(org("Stark Future 1").textContent).toContain("89% used");
    expect(org("Stark Future 2").textContent).toContain("37% used");
    expect(org("Stark Future 2").textContent).toContain("Out of date · checked 5 min ago");
    expect(org("Stark Future 3").textContent).not.toContain("21% used");
    expect(org("Stark Future 3").textContent).toContain("Sign in again");
    await click("Refresh");
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(state.command).not.toHaveBeenCalled();
    await click("Manage organizations");
    expect(state.manage).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps stale reported usage visible but never presents an expired window as current", async () => {
    const now = Date.now();
    state.read.mockResolvedValueOnce(
      success({
        ...snapshot,
        accounts: [
          {
            ...snapshot.accounts[0]!,
            usageAgeSeconds: 600,
            windows: [
              { name: "Session", percent: 28, resetsAt: new Date(now - 60_000).toISOString() },
              { name: "Weekly", percent: 86, resetsAt: new Date(now + 86_400_000).toISOString() },
              { name: "Fable", percent: 60, resetsAt: null },
            ],
          },
        ],
      }),
    );
    await open();
    const content = org("Stark Future 1").textContent;
    expect(content).toContain("Out of date · checked 10 min ago");
    expect(content).toContain("Session Not reported");
    expect(content).not.toContain("28% used");
    expect(content).toContain("86% used");
    expect(content).toContain("60% used");
    expect(state.command).not.toHaveBeenCalled();
  });

  it("waits for the connection before loading the footer and retries on reconnect", async () => {
    state.isConnected = false;
    await render();
    expect(state.read).not.toHaveBeenCalled();
    state.isConnected = true;
    await render();
    expect(state.read).toHaveBeenCalledExactlyOnceWith({ environmentId, input: undefined });
    expect(button("Switch Claude organization").textContent).toContain("Stark Future 1");
    state.isConnected = false;
    await render();
    state.read.mockResolvedValueOnce(success(switched));
    state.isConnected = true;
    await render();
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(button("Switch Claude organization").textContent).toContain("Stark Future 2");
    expect(state.command).not.toHaveBeenCalled();
  });

  it("retries a failed initial load when opened without waiting for the cache interval", async () => {
    state.read.mockRejectedValueOnce(new Error("Work Mac is not connected."));
    await render();
    expect(state.read).toHaveBeenCalledTimes(1);
    await click("Switch Claude organization");
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(button("Switch Claude organization").textContent).toContain("Stark Future 1");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(state.command).not.toHaveBeenCalled();
  });

  it("switches directly between same-email organizations, including one excluded from auto-switching", async () => {
    await open();
    expect(org("Stark Future 2").disabled).toBe(false);
    await act(() => org("Stark Future 2").click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        action: "switch",
        accountNumber: 2,
        expectedEmail: "person@example.com",
        expectedOrganizationUuid: "org-2",
      },
    });
    expect(org("Stark Future 2").getAttribute("aria-pressed")).toBe("true");
    expect(org("Stark Future 1").getAttribute("aria-pressed")).toBe("false");
    expect(button("Switch Claude organization").textContent).toContain("Stark Future 2");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Active organization: Stark Future 2.",
    );
    expect(document.body.textContent).toContain("Running sessions may need restarting");
  });

  it("serializes switching and disables other targets until the first selection finishes", async () => {
    let resolve!: (value: ReturnType<typeof success>) => void;
    state.command.mockImplementation(
      () =>
        new Promise<ReturnType<typeof success>>((complete) => {
          resolve = complete;
        }),
    );
    await open();
    await act(() => {
      org("Stark Future 2").click();
      org("Stark Future 2").click();
      org("Stark Future 3").click();
    });
    expect(state.command).toHaveBeenCalledTimes(1);
    expect(org("Stark Future 3").disabled).toBe(true);
    expect(button("Refresh").disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Switching organization…");
    await act(() => resolve(success(switched)));
    expect(org("Stark Future 3").disabled).toBe(false);
  });

  it("reconciles a failed switch without repeating it or hiding the failure", async () => {
    state.read.mockResolvedValueOnce(success()).mockResolvedValueOnce(success(switched));
    state.command.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Usage refresh failed after switching.")),
    });
    await open();
    await act(() => org("Stark Future 2").click());
    expect(state.command).toHaveBeenCalledTimes(1);
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(org("Stark Future 2").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Usage refresh failed after switching.",
    );
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("reports the confirmed organization and clears the prior notice when refreshed", async () => {
    state.command.mockResolvedValueOnce(success());
    await open();
    await act(() => org("Stark Future 2").click());
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Active organization: Stark Future 1.",
    );
    expect(org("Stark Future 1").getAttribute("aria-pressed")).toBe("true");
    state.read.mockResolvedValueOnce(success(switched));
    await click("Refresh");
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(button("Switch Claude organization").textContent).toContain("Stark Future 2");
  });

  it("handles rejected reads and commands without losing the last known selection", async () => {
    state.read
      .mockRejectedValueOnce(new Error("Connection unavailable."))
      .mockRejectedValueOnce(new Error("Connection unavailable."));
    await open();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Connection unavailable.",
    );
    await click("Refresh");
    state.command.mockRejectedValueOnce(new Error("Switch interrupted."));
    state.read.mockRejectedValueOnce(new Error("Still disconnected."));
    await act(() => org("Stark Future 2").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Switch interrupted.");
    expect(button("Switch Claude organization").textContent).toContain("Stark Future 1");
    expect(org("Stark Future 2").disabled).toBe(false);
    expect(state.command).toHaveBeenCalledTimes(1);
  });

  it("does not read without permission and disables switching when write access is revoked", async () => {
    state.canRead = false;
    state.canWrite = false;
    await open();
    expect(state.read).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("permission is needed to view");
    state.canRead = true;
    state.canWrite = true;
    await render();
    expect(state.read).toHaveBeenCalledTimes(1);
    state.canWrite = false;
    await render();
    expect(org("Stark Future 2").disabled).toBe(true);
    await act(() => org("Stark Future 2").click());
    expect(state.command).not.toHaveBeenCalled();
  });

  it("shows setup instead of organization actions when unavailable or no accounts are saved", async () => {
    state.read
      .mockResolvedValueOnce(
        success({ ...snapshot, available: false, accounts: [], activeAccountNumber: null }),
      )
      .mockResolvedValueOnce(success({ ...snapshot, accounts: [], activeAccountNumber: null }));
    await open();
    expect(document.body.textContent).toContain("needs claude-swap on Work Mac");
    expect(document.querySelector("button[aria-pressed]")).toBeNull();
    await click("Refresh");
    expect(document.body.textContent).toContain(
      "No organizations saved yet. Add them in Manage organizations.",
    );
    await click("Manage organizations");
    expect(state.manage).toHaveBeenCalledTimes(1);
    expect(state.command).not.toHaveBeenCalled();
  });

  it("discards late results and resets the menu when changing environments", async () => {
    let resolve!: (value: ReturnType<typeof success>) => void;
    state.read.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof success>>((complete) => {
          resolve = complete;
        }),
    );
    state.read.mockResolvedValueOnce(success(switched));
    await open();
    await render(EnvironmentId.make("different-machine"));
    await act(() => resolve(success()));
    expect(button("Switch Claude organization").textContent).toContain("Stark Future 2");
    expect(document.querySelector('[aria-label="Claude organizations"][role="dialog"]')).toBeNull();
    expect(state.read).toHaveBeenCalledTimes(2);
    await click("Switch Claude organization");
    expect(state.read).toHaveBeenLastCalledWith({
      environmentId: EnvironmentId.make("different-machine"),
      input: undefined,
    });
    expect(state.command).not.toHaveBeenCalled();
  });

  it("refreshes only while the menu is open and the app is visible", async () => {
    vi.useFakeTimers();
    await open();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(state.read).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(state.read).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(state.read).toHaveBeenCalledTimes(3);
    await click("Switch Claude organization");
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(state.read).toHaveBeenCalledTimes(3);
    expect(state.command).not.toHaveBeenCalled();
    visibility.mockRestore();
  });
});
