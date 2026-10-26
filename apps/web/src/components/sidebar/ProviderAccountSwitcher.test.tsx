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
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderAccountSwitcher } from "./ProviderAccountSwitcher";
import { SidebarProvider } from "../ui/sidebar";

const refreshProviders = vi.hoisted(() =>
  vi.fn(async () => ({ _tag: "Success", value: undefined })),
);
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: { permissionAtom: () => true } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => refreshProviders }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-10-19T12:00" }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (value: { timestampFormat: string }) => unknown) =>
    select({ timestampFormat: "24-hour" }),
}));

const provider = (id: string, email: string, used: number): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  displayName: id === "codex" ? "Work account" : "Second account",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email },
  checkedAt: "2026-10-19T12:00:00Z",
  models: [
    { slug: "gpt-test", name: "GPT Test", isDefault: true, isCustom: false, capabilities: {} },
  ],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-10-19T12:00:00Z",
    windows: [
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: used,
        resetsAt: "2026-10-21T12:00:00Z",
      },
    ],
  },
});
const entries = deriveProviderInstanceEntries([
  provider("codex", "work@example.com", 48),
  provider("codex_second", "second@example.com", 12),
]);
let root: Root;
let container: HTMLDivElement;
const select = vi.fn();
const manage = vi.fn();
async function render(
  options: {
    connected?: boolean;
    blocked?: string | null;
    claude?: boolean;
  } = {},
) {
  const shownEntries = options.claude
    ? deriveProviderInstanceEntries(
        [
          {
            ...provider("claude-one", "same@example.com", 48),
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Stark One",
            auth: {
              status: "authenticated" as const,
              email: "same@example.com",
              workspaceId: "org-one",
            },
          },
          {
            ...provider("claude-two", "same@example.com", 12),
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Stark Two",
            auth: {
              status: "authenticated" as const,
              email: "same@example.com",
              workspaceId: "org-two",
            },
          },
        ].map((entry) => ({
          ...entry,
          usageLimits: {
            ...entry.usageLimits!,
            windows: entry.usageLimits!.windows.map((window) => ({ ...window, id: "seven_day" })),
          },
        })),
      )
    : entries;
  await act(() =>
    root.render(
      <SidebarProvider>
        <ProviderAccountSwitcher
          context={{
            environmentId: EnvironmentId.make("remote"),
            instanceId: shownEntries[0]!.instanceId,
            entries: shownEntries,
            unavailableReason: options.blocked ?? null,
            getModelDisabledReason: () => null,
            onSelect: select,
          }}
          selected={shownEntries[0]!}
          environmentLabel="Remote Mac"
          connected={options.connected ?? true}
          onManage={manage}
        />
      </SidebarProvider>,
    ),
  );
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.getAttribute("aria-label") === label || el.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(() => button.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  select.mockReset();
  manage.mockReset();
  refreshProviders.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows Codex accounts and their own real limits without inventing a session allowance", async () => {
  await render();
  await click("Codex accounts");
  expect(document.body.textContent).toContain("Remote Mac");
  expect(document.body.textContent).toContain("48% used");
  expect(document.body.textContent).toContain("12% used");
  expect(document.body.textContent).toContain("Not reported");
  expect(document.body.textContent).not.toContain("Claude");
  expect(document.body.textContent).not.toContain("0% used");
  await click("Refresh");
  expect(refreshProviders).toHaveBeenCalledTimes(2);
  expect(refreshProviders).toHaveBeenLastCalledWith({
    environmentId: EnvironmentId.make("remote"),
    input: {},
  });
  expect(select).not.toHaveBeenCalled();
  const second = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
    (el) => el.textContent?.includes("Second account"),
  )!;
  await act(() => second.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(
    ProviderInstanceId.make("codex_second"),
    "gpt-test",
  );
});

it("keeps OpenRouter connections separate from Claude organizations and subscription usage", async () => {
  const shown = deriveProviderInstanceEntries([
    {
      ...provider("openrouter_team", "", 48),
      driver: ProviderDriverKind.make("claudeAgent"),
      apiBackend: "openrouter",
      displayName: "Team API",
      usesSharedClaudeLogin: false,
      auth: { status: "authenticated", type: "apiKey", label: "OpenRouter API key" },
    },
    {
      ...provider("claudeAgent", "work@example.com", 82),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude organization",
    },
  ]);
  await act(() =>
    root.render(
      <SidebarProvider>
        <ProviderAccountSwitcher
          context={{
            environmentId: EnvironmentId.make("remote"),
            instanceId: shown[0]!.instanceId,
            entries: shown,
            unavailableReason: null,
            getModelDisabledReason: () => null,
            onSelect: select,
          }}
          selected={shown[0]!}
          environmentLabel="Remote Mac"
          connected
          onManage={manage}
          onUsage={vi.fn()}
        />
      </SidebarProvider>,
    ),
  );
  await click("OpenRouter accounts");
  expect(document.body.textContent).toContain("Billed through OpenRouter");
  expect(document.body.textContent).not.toContain("Claude organization");
  expect(document.body.textContent).not.toContain("48% used");
  expect(document.body.textContent).not.toContain("View usage");
});

it("keeps disconnected and native sessions from silently selecting another account", async () => {
  await render({ connected: false });
  await click("Codex accounts");
  expect(document.body.textContent).toContain("Reconnect to see current usage");
  expect(document.body.textContent).not.toContain("48% used");
  const accounts = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
  expect(accounts.every((button) => button.disabled)).toBe(true);
  await render({ blocked: "Choose the account before opening a native session." });
  expect(document.body.textContent).toContain("before opening a native session");
  expect(select).not.toHaveBeenCalled();
  await click("Manage accounts");
  expect(manage).toHaveBeenCalledExactlyOnceWith();
});

it("loads account usage only on menu open and caches repeated opens for 60 seconds", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
  await render();
  expect(refreshProviders).not.toHaveBeenCalled();
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(refreshProviders).not.toHaveBeenCalled();
  await click("Codex accounts");
  expect(refreshProviders).toHaveBeenCalledTimes(1);
  await click("Codex accounts");
  now.mockReturnValue(159_999);
  await click("Codex accounts");
  expect(refreshProviders).toHaveBeenCalledTimes(1);
  await click("Codex accounts");
  now.mockReturnValue(160_001);
  await click("Codex accounts");
  expect(refreshProviders).toHaveBeenCalledTimes(2);
});

it("keeps same-login Claude organizations separate and blocks switching in an active session", async () => {
  await render({
    claude: true,
    blocked: "Account selection is unavailable while this chat is busy.",
  });
  expect(container.textContent).toContain("Stark One");
  await click("Claude accounts");
  expect(document.body.textContent).toContain("Stark Two");
  expect(document.body.textContent).toContain("48% used");
  expect(document.body.textContent).toContain("12% used");
  const other = [
    ...document.querySelectorAll<HTMLButtonElement>("button[data-account-option]"),
  ].find((button) => button.textContent?.includes("Stark Two"))!;
  expect(other.disabled).toBe(true);
  await act(() => other.click());
  expect(select).not.toHaveBeenCalled();
  await render({ claude: true });
  await act(() => other.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(ProviderInstanceId.make("claude-two"), "gpt-test");
});
