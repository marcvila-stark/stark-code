import { getPairingTokenFromUrl } from "./pairingUrl";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export type HostedAppChannel = "latest" | "nightly";

/** The hosted app origin shared links point at. */
export function configuredHostedAppUrl(): string {
  return "";
}

export function isHostedStaticApp(_url?: URL): boolean {
  return false;
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(_input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string {
  throw new Error("Hosted pairing is not included in this application.");
}

export function buildHostedChannelSelectionUrl(_input: {
  readonly channel: HostedAppChannel;
}): string {
  throw new Error("Hosted release channels are not included in this application.");
}
