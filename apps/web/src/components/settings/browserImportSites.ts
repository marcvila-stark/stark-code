import {
  BROWSER_IMPORT_MAX_DOMAINS,
  type BrowserImportSourceProfile,
} from "@starkfuture/contracts";

/** A URL is only a convenient way to enter its host; it never expands cookie scope. */
export function normalizeImportSite(value: string): string | undefined {
  let host = value.trim().toLowerCase().replace(/^\./, "");
  if (/^https?:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return undefined;
    }
  }
  if (
    host.length === 0 ||
    host.length > 253 ||
    !host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    return undefined;
  return host;
}

/** A company-domain shortcut, never a guess about the account on a shared service. */
export function isStarkImportSite(host: string): boolean {
  return host === "starkfuture.com" || host.endsWith(".starkfuture.com");
}

export function browserImportSites(profile: BrowserImportSourceProfile | undefined) {
  const sites = [
    ...new Set(
      (profile?.domains ?? []).flatMap((value) => {
        const host = normalizeImportSite(value);
        return host ? [host] : [];
      }),
    ),
  ].sort(
    (left, right) =>
      Number(isStarkImportSite(right)) - Number(isStarkImportSite(left)) ||
      left.localeCompare(right),
  );
  // Older desktops bounded raw hosts before normalization, so even a shorter
  // legacy list can be incomplete. Only explicit completeness enables All.
  const complete =
    profile?.domains !== undefined &&
    profile.domainsTruncated === false &&
    sites.length <= BROWSER_IMPORT_MAX_DOMAINS;
  return { sites, complete, starkSites: sites.filter(isStarkImportSite) };
}
