import type { ConnectionTarget } from "@starkfuture/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopEnvironmentBootstrap,
} from "@starkfuture/contracts";
import { desktopLocalBackendId } from "./desktopLocal";

type PagesBootstrap = Pick<
  DesktopEnvironmentBootstrap,
  "id" | "runningDistro" | "httpBaseUrl" | "wsBaseUrl"
>;

function loopbackEndpoint(raw: string | null, websocket: boolean): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      !(websocket ? ["ws:", "wss:"] : ["http:", "https:"]).includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Pages discovery reads the desktop host's filesystem, not a WSL or remote backend's. */
export function isStarkPagesLocalConnectionTarget(
  target: ConnectionTarget,
  bootstraps: readonly PagesBootstrap[],
): boolean {
  const backendId =
    target._tag === "PrimaryConnectionTarget"
      ? PRIMARY_LOCAL_ENVIRONMENT_ID
      : desktopLocalBackendId(target);
  if (!backendId || backendId.startsWith("wsl:")) return false;
  const bootstrap = bootstraps.find((entry) => entry.id === backendId);
  // An omitted distro is unknown, rather than proof of a native host backend.
  if (!bootstrap || bootstrap.runningDistro !== null) return false;
  const http = loopbackEndpoint(bootstrap.httpBaseUrl, false);
  const ws = loopbackEndpoint(bootstrap.wsBaseUrl, true);
  if (http === null || ws === null) return false;
  // A primary can also be an ordinary browser-origin or configured remote URL.
  // Only the endpoints actually advertised by this desktop own its local files.
  return (
    target._tag !== "PrimaryConnectionTarget" ||
    (loopbackEndpoint(target.httpBaseUrl, false) === http &&
      loopbackEndpoint(target.wsBaseUrl, true) === ws)
  );
}
