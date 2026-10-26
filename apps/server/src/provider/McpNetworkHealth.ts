// @effect-diagnostics nodeBuiltinImport:off -- bounded host diagnostic uses argv, never a shell
import * as NodeChildProcess from "node:child_process";
import type { McpServerStatusEntry } from "@starkfuture/contracts";
import { isLocalLoopbackHost, isTailnetHost } from "@starkfuture/shared/hostClassification";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as FortiClientStatus from "./FortiClientStatus.ts";

import type { NetworkState } from "./McpRecovery.ts";

type StatusCommand = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly killSignal: "SIGKILL";
  readonly shell: false;
  readonly windowsHide: true;
};
type HostRunner = (command: StatusCommand) => Effect.Effect<string | null>;
type DaemonState = "disconnected" | "running" | "unknown";

const runHostStatus: HostRunner = (command) =>
  Effect.callback<string | null>((resume) => {
    try {
      const child = NodeChildProcess.execFile(
        command.executable,
        [...command.args],
        {
          timeout: command.timeout,
          maxBuffer: command.maxBuffer,
          killSignal: command.killSignal,
          shell: command.shell,
          windowsHide: command.windowsHide,
          encoding: "utf8",
        },
        (error, stdout) => resume(Effect.succeed(error ? null : stdout)),
      );
      return Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
    } catch {
      resume(Effect.succeed(null));
    }
  });

function remoteEndpointHost(host: string | undefined): string | undefined {
  if (!host || host.length > 253 || /[\s/@?#%]/u.test(host)) return undefined;
  try {
    const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const url = new URL(`https://${authority}`);
    return !url.port && url.pathname === "/" && !isLocalLoopbackHost(url.hostname)
      ? url.hostname
      : undefined;
  } catch {
    return undefined;
  }
}

function tailscaleState(raw: string | null): DaemonState {
  if (raw === null || raw.length > 65_536) return "unknown";
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return "unknown";
    const state = (value as { BackendState?: unknown }).BackendState;
    return state === "Stopped" || state === "NeedsLogin"
      ? "disconnected"
      : state === "Running"
        ? "running"
        : "unknown";
  } catch {
    return "unknown";
  }
}

const NETWORK_FAILURE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|\b(?:connection|connect|DNS|TLS handshake) (?:timed out|timeout)\b/i;

/** Runs on the provider's server host. It never probes an endpoint or changes VPN state. */
export function makeNetworkInspector(
  runner: HostRunner,
  platform: NodeJS.Platform,
  fortiStatus: Effect.Effect<FortiClientStatus.FortiClientState> = Effect.succeed("unknown"),
) {
  const gate = Semaphore.makeUnsafe(1);
  const cached = new Map<"forticlient" | "tailscale", { state: DaemonState; expiresAt: number }>();
  const readState = (kind: "forticlient" | "tailscale") =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const previous = cached.get(kind);
      if (previous && previous.expiresAt > now) return previous.state;
      const observation =
        kind === "forticlient"
          ? fortiStatus
          : runner({
              executable: platform === "win32" ? "tailscale.exe" : "tailscale",
              args: ["status", "--json", "--peers=false"],
              timeout: 1500,
              maxBuffer: 65_536,
              killSignal: "SIGKILL",
              shell: false,
              windowsHide: true,
            }).pipe(Effect.map(tailscaleState));
      const result = yield* observation.pipe(
        Effect.catchDefect(() => Effect.succeed("unknown" as const)),
        Effect.timeoutOption("2 seconds"),
      );
      const state = Option.getOrElse(result, () => "unknown" as const);
      cached.set(kind, { state, expiresAt: (yield* Clock.currentTimeMillis) + 15_000 });
      return state;
    }).pipe(gate.withPermits(1));

  return (server: McpServerStatusEntry): Effect.Effect<NetworkState> =>
    Effect.gen(function* () {
      if (server.status !== "failed") return "unknown";
      const host = remoteEndpointHost(server.endpointHost);
      // Stdio tools often include a subprocess' network errors. Those errors
      // cannot establish that this MCP connection itself needs a VPN.
      if (host === undefined) return "unknown";
      const networkFailure = NETWORK_FAILURE.test(server.error?.slice(0, 2048) ?? "");
      if (isTailnetHost(host)) {
        const state = yield* readState("tailscale");
        if (state === "disconnected") return "vpn-off";
        if (state === "running") return "unknown";
        // A FortiClient state says nothing about a known Tailscale route.
        return networkFailure ? "network-unavailable" : "unknown";
      }
      if (networkFailure && platform === "darwin") {
        const state = yield* readState("forticlient");
        // A disconnected VPN does not establish that this host needs it. Keep
        // capped retries and expose the observation only as an advisory.
        if (state === "disconnected")
          return { state: "network-unavailable", vpnState: "forticlient-disconnected" };
        if (state === "running") return "unknown";
      }
      return networkFailure ? "network-unavailable" : "unknown";
    });
}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const fortiStatus = yield* FortiClientStatus.make;
  return makeNetworkInspector(runHostStatus, platform, fortiStatus());
});
