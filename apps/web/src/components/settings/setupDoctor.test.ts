import { expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type McpServerStatusEntry,
} from "@starkfuture/contracts";
import {
  providerSetupFindings,
  mcpSetupFindings,
  pagesSetupFindings,
  previewBrowserSetup,
} from "./setupDoctor";
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude-work"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Work",
  enabled: true,
  installed: true,
  version: "1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T12:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const server: McpServerStatusEntry = {
  name: "Pages",
  status: "connected",
  tools: [],
  authKind: "oauth",
  locked: false,
};
it("does not mistake missing or signed-out CLI profiles for ready", () => {
  expect(providerSetupFindings([])[0]?.state).toBe("attention");
  expect(providerSetupFindings([{ ...provider, installed: false }])[0]?.state).toBe("attention");
  expect(
    providerSetupFindings([{ ...provider, auth: { status: "unauthenticated" } }])[0]?.detail,
  ).toContain("Sign-in required");
  expect(providerSetupFindings([{ ...provider, enabled: false }])[0]?.state).toBe("disabled");
  expect(providerSetupFindings([provider])[0]?.state).toBe("ready");
});
it("keeps empty MCP inspections unknown rather than all healthy", () => {
  expect(mcpSetupFindings("Work", null)[0]?.state).toBe("unknown");
  expect(mcpSetupFindings("Work", { servers: [], live: false })[0]?.state).toBe("unknown");
  expect(mcpSetupFindings("Work", null, true)[0]?.detail).toContain("Could not inspect");
});
it("reports each server independently and only trusts an explicit VPN diagnosis", () => {
  const findings = mcpSetupFindings("Work", {
    live: false,
    servers: [
      server,
      { ...server, name: "Login", status: "needs-auth" },
      { ...server, name: "Network", status: "failed", error: "private error token" },
      { ...server, name: "VPN", status: "failed", recovery: { state: "vpn-off", attempts: 1 } },
    ],
  });
  expect(findings.map((row) => row.state)).toEqual([
    "ready",
    "attention",
    "attention",
    "attention",
  ]);
  expect(findings[1]?.detail).toContain("Sign-in required");
  expect(findings[2]?.detail).not.toContain("VPN");
  expect(findings[3]?.detail).toContain("VPN");
  expect(JSON.stringify(findings)).not.toContain("private error token");
});
it("separates local Pages kit availability from sign-in and actual page access", () => {
  expect(
    pagesSetupFindings({ available: false, kit: null, status: null, failed: false })[0]?.state,
  ).toBe("unknown");
  const disconnected = pagesSetupFindings({
    available: true,
    kit: true,
    status: { state: "signed-out", message: null },
    failed: false,
  });
  expect(disconnected.map((row) => row.state)).toEqual(["ready", "attention"]);
  const connected = pagesSetupFindings({
    available: true,
    kit: false,
    status: { state: "connected", message: null },
    failed: false,
  });
  expect(connected.map((row) => row.state)).toEqual(["attention", "ready"]);
  expect(connected[1]?.detail).toContain("Page access is checked when a page opens");
});

it("offers the preview browser install only while it is missing or failed", () => {
  const totalBytes = 99_221_129;
  expect(previewBrowserSetup({ state: "not-installed", totalBytes }, false)).toMatchObject({
    finding: { state: "not-installed" },
    installLabel: "Install preview browser (about 99 MB)",
  });
  expect(
    previewBrowserSetup(
      { state: "installing", totalBytes, downloadedBytes: 37_200_000, unpacking: false },
      false,
    ),
  ).toEqual({
    finding: expect.objectContaining({
      state: "installing",
      detail: "Installing: 37 of 99 MB downloaded.",
    }),
    installLabel: null,
  });
  expect(
    previewBrowserSetup({ state: "failed", totalBytes, failure: "The disk is full." }, false),
  ).toMatchObject({
    finding: { state: "attention", detail: "The last install failed. The disk is full." },
    installLabel: "Try installing again (about 99 MB)",
  });
  expect(previewBrowserSetup({ state: "ready", totalBytes }, false).installLabel).toBeNull();
  expect(
    previewBrowserSetup({ state: "unsupported", totalBytes: null }, false).installLabel,
  ).toBeNull();
  // An unread status never claims either way.
  expect(previewBrowserSetup(null, true)).toMatchObject({
    finding: { state: "unknown" },
    installLabel: null,
  });
});
