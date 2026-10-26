import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@starkfuture/contracts";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsOverviewVisible,
  isSettingsSearchScopeAvailable,
  searchableSetting,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_NAV_GROUPS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
    searchTerms: ["long lines in code previews"],
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("finds shared Claude organizations only in an environment scope", () => {
    for (const query of ["Claude organizations", "cswap", "Claude automatic quota"]) {
      expect(searchSettings(query).map((item) => item.id)).toContain("claude-organizations");
    }
    const item = getSettingsSearchTargetScope("claude-organizations")!;
    expect(isSettingsSearchScopeAvailable(item.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(item.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(item.scope, "project")).toBe(false);
  });
  it("finds saved permission rules and the MCP server screen", () => {
    expect(searchSettings("saved approval rules")[0]?.to).toBe("/settings/permissions");
    expect(searchSettings("MCP servers")[0]?.to).toBe("/settings/mcp-servers");
  });
  it.each(["OTel", "OTLP", "telemetry export", "Grafana"])(
    "does not offer external telemetry configuration for %s",
    (query) => {
      expect(searchSettings(query).map((item) => item.id)).not.toContain("telemetry-export");
    },
  );
  it.each(["send shortcut", "multiline", "new line"])("finds Send shortcut for %s", (query) => {
    expect(searchSettings(query).map((item) => item.id)).toContain("send-shortcut");
  });

  it("matches titles, sections, and remembered setting details", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
    expect(searchSettings("long lines", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass")).toEqual([]);
    expect(searchSettings("panel animations").map((item) => item.id)).toEqual(["panel-animations"]);
    expect(searchSettings("thè\u{1ab0}mes")[0]?.id).toBe("theme");
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("gıt");
    try {
      expect(searchSettings("GIT")[0]?.id).toBe("git-fetch-interval");
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it("finds settings that used to be reachable only through their section", () => {
    expect(searchSettings("pull request template")[0]?.id).toBe("follow-change-request-templates");
    expect(searchSettings("git security keys")[0]?.id).toBe("git-fetch-interval");
    expect(searchSettings("push notifications").map((item) => item.id)).not.toContain(
      "publish-agent-activity",
    );
    expect(searchSettings("battery saver")[0]?.id).toBe("background-activity");
    expect(searchSettings("binary path")[0]?.id).toBe("provider-runtime");
    expect(searchSettings("Antigravity")).toEqual([]);
    expect(searchSettings("Google sign in")).toEqual([]);
    expect(searchSettings("authorized clients")[0]?.id).toBe("connections-environment");
    expect(searchSettings("administrative access")[0]?.id).toBe("connections-environment");
  });

  it("lists thread confirmations in panel order", () => {
    expect(searchSettings("confirmation").map((item) => item.id)).toEqual([
      "unpin-confirmation",
      "archive-confirmation",
    ]);
  });

  it.each(["usage providers", "CLIProxyAPI", "CLI proxy hub", "management key"])(
    "finds usage-provider management by %s",
    (query) => {
      expect(searchSettings(query)[0]).toMatchObject({
        id: "usage-providers",
        to: "/settings/existing-integrations",
      });
    },
  );

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("hold to quit")).toEqual([]);
    expect(searchSettings("wsl")).toEqual([]);
    expect(searchSettings("update track")).toEqual([]);
  });

  it("finds the About update rows", () => {
    expect(searchSettings("check for updates").map((item) => item.id)).toContain("app-version");
    expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === "update-track")).toMatchObject({
      title: "Update track",
      to: "/settings/about",
      releaseChannelOnly: true,
    });
  });

  it("hides macOS-only settings on other platforms", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    try {
      expect(searchSettings("font smoothing")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hides new WSL setup while preserving the catalogue anchor", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "wsl-backend")).toBe(false);
    expect(searchableSetting("wsl-backend")).toMatchObject({ id: "wsl-backend" });
  });

  it("hides settings whose controls are unavailable", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    });

    const gatedIds = new Set<string>([
      "follow-change-request-templates",
      "git-fetch-interval",
      "network-access",
      "publish-agent-activity",
      "provider-health-check-interval",
      "cursor-keychain-usage",
      "source-control-writer-model",
      "review-guide-model",
      "review-guide-instructions",
      "source-control-writing-style",
      "stark-connect",
      "hold-webhooks-while-offline",
      "tailscale-https",
      "wsl-backend",
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
    ]);
    expect(available.map((item) => item.id).filter((id) => gatedIds.has(id))).toEqual([]);
  });

  it("does not advertise new Cursor usage setup even on a Mac", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const itemIds = (macAvailable: boolean) =>
      filterAvailableSettingsSearchItems({
        ...availability,
        hasMacProviderSettingsEnvironment: macAvailable,
      }).map((item) => item.id);
    expect(itemIds(false)).not.toContain("cursor-keychain-usage");
    expect(itemIds(true)).not.toContain("cursor-keychain-usage");
  });

  it("keeps the local toggle searchable without offering hidden host publishing controls", () => {
    const availability = {
      hasCloudPublicConfig: true,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const remoteOnly = filterAvailableSettingsSearchItems({
      ...availability,
      localEnvironmentDisabled: true,
    }).map((item) => item.id);
    expect(remoteOnly).toContain("local-environment");
    expect(remoteOnly).not.toContain("stark-connect");
    expect(remoteOnly).not.toContain("publish-agent-activity");
    expect(remoteOnly).not.toContain("wsl-backend");
    // This build has no external activity publishing service.
    const browser = filterAvailableSettingsSearchItems(availability).map((item) => item.id);
    expect(browser).not.toContain("publish-agent-activity");
  });

  it("does not offer the removed managed tunnel's webhook controls", () => {
    const availability = {
      hasCloudPublicConfig: true,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: true,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const itemIds = (managedTunnelActive: boolean) =>
      filterAvailableSettingsSearchItems({ ...availability, managedTunnelActive }).map(
        (item) => item.id,
      );
    expect(itemIds(false)).not.toContain("hold-webhooks-while-offline");
    expect(itemIds(true)).not.toContain("hold-webhooks-while-offline");
  });

  it("hides beta settlement controls even when the server supports them", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: true,
    });

    expect(searchSettings("auto-settle", available)).toEqual([]);
  });

  it("finds keybinding commands by label, command id, and default key", () => {
    expect(searchSettings("toggle sidebar")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("sidebar.toggle")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("mod+b")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("copy link")[0]).toMatchObject({
      id: "keybinding-thread.copyReference",
      to: "/settings/keybindings",
    });
  });

  it("ranks keybinding commands after other settings", () => {
    const ids = searchSettings("model").map((item) => item.id);
    expect(ids[0]).toBe("default-model");
    expect(ids.indexOf("keybinding-modelPicker.toggle")).toBeGreaterThan(
      ids.indexOf("text-generation-model"),
    );
  });

  it("sends commands without a default binding to the section", () => {
    expect(searchSettings("thread.stop")[0]).toMatchObject({
      id: "keybinding-thread.stop",
      targetId: "keybindings",
    });
    expect(searchSettings("sidebar.toggle")[0]?.targetId).toBeUndefined();
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: "Word wrap" });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "Archived threads" });
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("word wrap")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("composer context")[0]).toMatchObject({
      id: "composer-context",
      to: "/settings/projects",
    });
    expect(searchSettings("environment identification")).toEqual([]);
  });

  it("routes conditional window capture settings to the stable toggle row", () => {
    const targets = [
      "capture accessibility data",
      "capture shortcut",
      "capture sound",
      "capture flash",
      "capture animations",
    ].map((query) => {
      const match = searchSettings(query)[0];
      return [match?.id, match?.targetId];
    });

    expect(targets).toEqual([
      ["snap-shot-accessibility", "snap-shot-enabled"],
      ["snap-shot-shortcut", "snap-shot-enabled"],
      ["snap-shot-sound", "snap-shot-enabled"],
      ["snap-shot-flash", "snap-shot-enabled"],
      ["snap-shot-animations", "snap-shot-enabled"],
    ]);
  });

  it("routes browser recording quality to integrations", () => {
    const result = searchSettings("recording frame rate")[0];
    expect(result).toMatchObject({
      id: "browser-recording-frame-rate",
      to: "/settings/integrations",
    });
    expect(result).not.toHaveProperty("targetId");
  });

  it("routes where links open to integrations", () => {
    expect(searchSettings("open links in")[0]).toMatchObject({
      id: "browser-link-target",
      to: "/settings/integrations",
    });
    expect(searchSettings("external links")[0]).toMatchObject({ id: "browser-link-target" });
  });

  it("finds the default browser profile action in the profiles list", () => {
    expect(searchSettings("default profile")[0]).toMatchObject({
      id: "browser-default-profile",
      to: "/settings/integrations",
      targetId: "browser-profiles",
    });
  });

  it.each([
    ["default model", "default-model", "/settings/providers"],
    ["new threads", "new-threads", "/settings/projects"],
    ["agent browser access", "agent-browser-access", "/settings/integrations"],
    ["automatically pull", "automatic-pull", "/settings/source-control"],
    ["actions", "project-actions", "/settings/projects"],
    ["project overview", "project-overview", "/settings/projects"],
  ])("routes %s to its owning category", (query, id, to) => {
    expect(searchSettings(query)[0]).toMatchObject({ id, to });
  });

  it("keeps environment settings discoverable without a primary environment", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: true,
    });
    expect(searchSettings("writing style", available)[0]?.id).toBe("source-control-writing-style");
    expect(searchSettings("auto-settle", available)).toHaveLength(0);
  });
});

describe("settings search targets", () => {
  it("has no telemetry export destination", () => {
    expect(getSettingsSearchTargetScope("telemetry-export")).toBeNull();
  });
  it.each([
    "auto-settle-inactive-threads",
    "auto-settle-merged-threads",
    "days-before-auto-settle",
  ])("retains the capability requirement for %s", (targetId) => {
    expect(getSettingsSearchTargetScope(targetId)).toMatchObject({
      scope: "project-defaults",
      requiresThreadAutoSettlement: true,
    });
  });

  it("treats device-local rows as reachable from every selection", () => {
    const setting = getSettingsSearchTargetScope("time-format")!;
    expect(setting).toEqual({ title: "Time format", scope: null });
    expect(isSettingsSearchScopeAvailable(setting.scope, "project")).toBe(true);
    expect(isSettingsSearchScopeAvailable(setting.scope, "all")).toBe(true);
    expect(getSettingsSearchTargetScope("appearance")).toMatchObject({ scope: null });
    expect(getSettingsSearchTargetScope("missing-setting")).toBeNull();
  });

  it.each(["all", "environment", "project", "checkout"] as const)(
    "makes browser access editable at the %s scope",
    (kind) => {
      const setting = getSettingsSearchTargetScope("agent-browser-access")!;
      expect(isSettingsSearchScopeAvailable(setting.scope, kind)).toBe(true);
      expect(isSettingsSearchScopeAvailable(setting.scope, "unavailable")).toBe(false);
    },
  );

  it("lets project-scopable rows resolve at every server-backed scope", () => {
    const model = getSettingsSearchTargetScope("text-generation-model")!;
    expect(isSettingsSearchScopeAvailable(model.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(model.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(model.scope, "project")).toBe(true);
  });

  it("reaches source control discovery and git fetch interval from the default scope", () => {
    for (const id of ["source-control", "git-fetch-interval"]) {
      const item = getSettingsSearchTargetScope(id)!;
      expect(isSettingsSearchScopeAvailable(item.scope, "all")).toBe(true);
      expect(isSettingsSearchScopeAvailable(item.scope, "environment")).toBe(true);
      expect(isSettingsSearchScopeAvailable(item.scope, "project")).toBe(false);
    }
  });

  it("keeps environment-wide settings out of project scopes", () => {
    const updates = getSettingsSearchTargetScope("provider-update-checks")!;
    expect(updates.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(updates.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "project")).toBe(false);
    const streaming = getSettingsSearchTargetScope("response-streaming")!;
    expect(streaming.scope).toBe("project-defaults");
    expect(isSettingsSearchScopeAvailable(streaming.scope, "project")).toBe(true);
    for (const id of ["legacy-plan-mode", "legacy-context-window-indicator", "legacy-sidebar"]) {
      expect(getSettingsSearchTargetScope(id)!.scope).toBeNull();
    }
  });
});

describe("auto-settlement search availability", () => {
  function environment(id: string, { connected = true, loaded = true, supported = true } = {}) {
    return {
      environmentId: EnvironmentId.make(id),
      connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
      serverConfig: loaded
        ? { environment: { capabilities: { threadAutoSettlement: supported } } }
        : null,
    };
  }

  const capable = environment("capable");
  const unsupported = environment("unsupported", { supported: false });
  const offline = environment("offline", { connected: false });
  const loading = environment("loading", { loaded: false });
  const environments = [capable, unsupported, offline, loading];

  it("detects capable environments without advertising beta controls in alpha", () => {
    const availability = getThreadAutoSettlementSearchAvailability(environments);
    expect(availability.eligibleEnvironmentIds).toEqual([capable.environmentId]);
    const items = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: availability.eligibleEnvironmentIds.length > 0,
    });
    expect(searchSettings("auto-settle", items)).toEqual([]);
  });

  it("offers only capable environments when an aggregate has mixed capabilities", () => {
    expect(
      getThreadAutoSettlementSearchAvailability(environments, {
        kind: "all",
        environmentIds: environments.map((entry) => entry.environmentId),
      }),
    ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
  });

  it("allows a capable named environment regardless of other environments' capabilities", () => {
    expect(
      getThreadAutoSettlementSearchAvailability(environments, {
        kind: "environment",
        environmentIds: [capable.environmentId],
      }).isTargetAvailable,
    ).toBe(true);
  });

  it.each([unsupported, offline, loading])(
    "does not render the target on $environmentId or silently fall back",
    (selected) => {
      expect(
        getThreadAutoSettlementSearchAvailability(environments, {
          kind: "environment",
          environmentIds: [selected.environmentId],
        }),
      ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
    },
  );

  it("offers a capable environment instead of a dead target at an unavailable scope", () => {
    expect(
      getThreadAutoSettlementSearchAvailability(environments, {
        kind: "unavailable",
        environmentIds: [capable.environmentId],
      }),
    ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
  });

  it("ignores offline and unloaded targets when all connected targets support the setting", () => {
    const selected = [capable, offline, loading];
    expect(
      getThreadAutoSettlementSearchAvailability(selected, {
        kind: "all",
        environmentIds: selected.map((entry) => entry.environmentId),
      }).isTargetAvailable,
    ).toBe(true);
  });

  it("offers no unavailable environments when none can render the setting", () => {
    const selected = [unsupported, offline, loading];
    expect(
      getThreadAutoSettlementSearchAvailability(selected, {
        kind: "all",
        environmentIds: selected.map((entry) => entry.environmentId),
      }),
    ).toEqual({ eligibleEnvironmentIds: [], isTargetAvailable: false });
    expect(getThreadAutoSettlementSearchAvailability([]).eligibleEnvironmentIds).toEqual([]);
  });
});

describe("settings sidebar scope", () => {
  it("shows Overview only for project and checkout targets", () => {
    expect(isSettingsOverviewVisible({})).toBe(false);
    expect(isSettingsOverviewVisible({ machine: "remote" })).toBe(false);
    expect(isSettingsOverviewVisible({ project: "project" })).toBe(true);
    expect(isSettingsOverviewVisible({ project: "project", checkout: "checkout" })).toBe(true);
  });
});

describe("alpha settings navigation", () => {
  it("has five normal destinations and keeps content and support out of the preference nav", () => {
    expect(SETTINGS_NAV_GROUPS.flatMap((group) => group.paths)).toEqual([
      "/settings/general",
      "/settings/appearance",
      "/settings/providers",
      "/settings/mcp-servers",
      "/settings/advanced",
    ]);
  });
  it.each(["git-fetch-interval", "provider-health-check-interval"])(
    "routes %s to the one background editor",
    (id) => {
      expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === id)).toMatchObject({
        to: "/settings/advanced",
        targetId: "background-activity",
      });
    },
  );
  it.each(["default-model", "default-permissions", "project-defaults"])(
    "routes agent default %s to Agents & accounts",
    (id) => {
      expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === id)?.to).toBe("/settings/providers");
    },
  );
  it.each([
    "new-threads",
    "worktree-submodules",
    "start-from-origin",
    "project-order",
    "composer-context",
  ])("routes folder control %s to Folder settings", (id) => {
    expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === id)?.to).toBe("/settings/projects");
  });
  it.each([
    "legacy-plan-mode",
    "project-grouping",
    "device-hub",
    "remote-environments",
    "keybinding-themeEditor.toggle",
    "diff-layout",
    "delete-confirmation",
    "time-format",
  ])("does not offer removed control %s in search", (id) => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === id)).toBe(false);
  });
});
