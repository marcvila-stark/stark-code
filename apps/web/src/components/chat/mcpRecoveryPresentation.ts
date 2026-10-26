import type { McpServerStatusEntry } from "@starkfuture/contracts";

function recoveryStateMessage(server: McpServerStatusEntry): string | null {
  if (server.status === "needs-auth") return "Sign in required.";
  if (server.status !== "failed" && server.status !== "connecting") return null;
  switch (server.recovery?.state) {
    case "waiting":
      return "Waiting for a safe moment to retry.";
    case "reconnecting":
      return "Reconnecting this server…";
    case "exhausted":
      return "Automatic retries stopped. Review this connection.";
    case "manual":
      return "This connection needs manual attention.";
    case "vpn-off":
      return "Your VPN is disconnected. Connect it, then check again.";
    case "network-unavailable":
      return "Server unreachable. Check your network or VPN.";
    default:
      return server.status === "failed" ? "Connection unavailable." : null;
  }
}

export function mcpRecoveryMessage(server: McpServerStatusEntry): string | null {
  const message = recoveryStateMessage(server);
  if (
    message &&
    server.status === "failed" &&
    server.recovery?.vpnState === "forticlient-disconnected"
  ) {
    // Report the observed VPN state without claiming this server depends on it.
    return `FortiClient is disconnected. ${
      server.recovery.state === "network-unavailable"
        ? "This server is unreachable; automatic retries continue."
        : message
    }`;
  }
  return message;
}
