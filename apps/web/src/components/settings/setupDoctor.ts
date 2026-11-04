import {
  previewBrowserDownloadSize,
  previewBrowserInstallProgress,
  type McpServersListResult,
  type PreviewBrowserStatus,
  type ServerProvider,
  type StarkPublishedPagesStatus,
} from "@starkfuture/contracts";

export type SetupFinding = {
  id: string;
  title: string;
  state:
    | "ready"
    | "attention"
    | "unknown"
    | "disabled"
    | "not-installed"
    | "installing"
    | "unavailable";
  detail: string;
};

/** Provider readiness is its reported snapshot, never an installation or sign-in attempt. */
export function providerSetupFindings(providers: readonly ServerProvider[]): SetupFinding[] {
  if (providers.length === 0)
    return [
      {
        id: "providers",
        title: "Agents",
        state: "attention",
        detail: "No agent configured. Add Claude or Codex in Agents & accounts.",
      },
    ];
  return providers.map((provider) => {
    const common = { id: provider.instanceId, title: provider.displayName ?? provider.instanceId };
    if (!provider.enabled) return { ...common, state: "disabled", detail: "Disabled in settings." };
    if (!provider.installed)
      return {
        ...common,
        state: "attention",
        detail: "Command-line tool not found. Check this profile's binary path or install its CLI.",
      };
    if (provider.auth.status === "unauthenticated")
      return {
        ...common,
        state: "attention",
        detail: "Sign-in required. Use this profile's own sign-in controls.",
      };
    if (provider.status === "ready" && provider.auth.status === "authenticated")
      return {
        ...common,
        state: "ready",
        detail: `Ready${provider.version ? ` · ${provider.version}` : ""}. Reported ${new Date(provider.checkedAt).toLocaleString()}.`,
      };
    return {
      ...common,
      state: "unknown",
      detail: "Readiness has not been confirmed. Refresh this agent's status in its settings.",
    };
  });
}

export function mcpSetupFindings(
  label: string,
  result: McpServersListResult | null,
  failed = false,
): SetupFinding[] {
  if (failed)
    return [
      {
        id: "mcp",
        title: `${label} connections`,
        state: "unknown",
        detail: "Could not inspect connections. Open Connected tools for details.",
      },
    ];
  if (!result)
    return [
      {
        id: "mcp",
        title: `${label} connections`,
        state: "unknown",
        detail: "Checking reported connection status…",
      },
    ];
  if (result.servers.length === 0)
    return [
      {
        id: "mcp",
        title: `${label} connections`,
        state: "unknown",
        detail:
          "No servers reported for this profile and folder. This does not confirm that tools are configured.",
      },
    ];
  return result.servers.map((server) => ({
    id: server.name,
    title: `${label} · ${server.name}`,
    state:
      server.status === "connected"
        ? "ready"
        : server.status === "disabled"
          ? "disabled"
          : server.status === "connecting"
            ? "unknown"
            : "attention",
    detail:
      server.status === "connected"
        ? `Connected · ${server.tools.length} tools reported.`
        : server.status === "needs-auth"
          ? "Sign-in required. Open Connected tools and sign in to this server."
          : server.status === "disabled"
            ? "Disabled in this profile."
            : server.status === "connecting"
              ? "Connection is in progress."
              : server.recovery?.state === "vpn-off"
                ? "VPN is disconnected. Connect your VPN, then check this server again."
                : "Connection failed. Open Connected tools to inspect or reconnect this server.",
  }));
}

export function pagesSetupFindings(input: {
  available: boolean;
  kit: boolean | null;
  status: StarkPublishedPagesStatus | null;
  failed: boolean;
}): SetupFinding[] {
  if (!input.available)
    return [
      {
        id: "pages",
        title: "Stark Pages",
        state: "unknown",
        detail: "Pages setup is available in the local desktop app.",
      },
    ];
  return [
    {
      id: "kit",
      title: "Pages kit · this desktop",
      state: input.kit === true ? "ready" : input.kit === false ? "attention" : "unknown",
      detail:
        input.kit === true
          ? "Bundled kit is available. A folder preview is checked when you open Pages."
          : input.kit === false
            ? "Bundled kit is missing. Reinstall a Stark Code build that includes the kit."
            : "Could not inspect the bundled kit.",
    },
    {
      id: "published",
      title: "Published Pages · this desktop",
      state:
        input.status?.state === "connected"
          ? "ready"
          : input.status?.state === "signed-out" || input.status?.state === "error"
            ? "attention"
            : "unknown",
      detail: input.failed
        ? "Could not read the Pages sign-in status."
        : input.status?.state === "connected"
          ? "Sign-in is present. Page access is checked when a page opens."
          : input.status?.state === "connecting"
            ? "Sign-in is in progress."
            : "Open Pages in a chat and choose Sign in. Browser sessions are not copied for this check.",
    },
  ];
}

/**
 * The preview browser row and the install the user can start from it. Nothing
 * installs it except that button: agents only read its status.
 */
export function previewBrowserSetup(
  status: PreviewBrowserStatus | null,
  failed: boolean,
): { readonly finding: SetupFinding; readonly installLabel: string | null } {
  const common = { id: "preview-browser", title: "Preview browser" };
  if (failed || status === null)
    return {
      finding: {
        ...common,
        state: "unknown",
        detail: failed
          ? "Could not read the preview browser status."
          : "Checking the preview browser…",
      },
      installLabel: null,
    };
  const size = previewBrowserDownloadSize(status);
  const withSize = (label: string) => (size === null ? label : `${label} (${size})`);
  switch (status.state) {
    case "ready":
      return {
        finding: {
          ...common,
          state: "ready",
          detail: "Installed. Agents use it to check HTML pages before showing them.",
        },
        installLabel: null,
      };
    case "not-installed":
      return {
        finding: {
          ...common,
          state: "not-installed",
          detail:
            "Agents use it to check HTML pages before showing them. Previews never download it on their own. Pages and mermaid diagrams still show without it.",
        },
        installLabel: withSize("Install preview browser"),
      };
    case "installing":
      return {
        finding: {
          ...common,
          state: "installing",
          detail: `Installing: ${previewBrowserInstallProgress(status)}.`,
        },
        installLabel: null,
      };
    case "failed":
      return {
        finding: {
          ...common,
          state: "attention",
          detail: `The last install failed. ${status.failure ?? ""}`.trim(),
        },
        installLabel: withSize("Try installing again"),
      };
    case "unsupported":
      return {
        finding: {
          ...common,
          state: "unavailable",
          detail:
            "There is no preview browser build for this machine. Pages still show, but agents cannot check them first.",
        },
        installLabel: null,
      };
  }
}
