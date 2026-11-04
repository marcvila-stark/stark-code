import type { BrowserImportFailureReason, BrowserImportSource } from "@starkfuture/contracts";

export interface WizardTargetProfile {
  readonly id: string;
  readonly name: string;
}

export type WizardTarget =
  | { readonly kind: "new"; readonly profileId: string }
  | { readonly kind: "existing"; readonly profileId: string; readonly name: string };

export type WizardTargetSelection =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly profileId: string };

export function initialTargetSelection(
  canCreateProfile: boolean,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTargetSelection {
  if (canCreateProfile) return { kind: "new" };
  const first = targetProfiles[0];
  return first ? { kind: "existing", profileId: first.id } : { kind: "new" };
}

export function resolveWizardTarget(
  selection: WizardTargetSelection,
  newProfileId: string,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTarget | undefined {
  if (selection.kind === "new") return { kind: "new", profileId: newProfileId };
  const profile = targetProfiles.find((candidate) => candidate.id === selection.profileId);
  if (profile === undefined) return undefined;
  return {
    kind: "existing",
    profileId: selection.profileId,
    name: profile.name,
  };
}

/**
 * What the import wizard produces once it has actually tried to import. The
 * parent runs the import and classifies the result; the wizard only reacts to
 * it, which keeps the step transitions pure and testable.
 */
export type ImportOutcome =
  | {
      readonly kind: "imported";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
    }
  | { readonly kind: "blocked"; readonly reason: BrowserImportFailureReason };

/**
 * The wizard's screens. Every one is a place the user can act from — there are
 * no dead ends. `blocked` covers the reasons no local step recovers.
 */
export type WizardStep =
  | { readonly step: "quit" }
  | {
      readonly step: "fullDiskAccess";
      readonly resume: "configure" | "import";
      readonly checked?: boolean;
    }
  | { readonly step: "configure" }
  | { readonly step: "checking"; readonly check: "browser" | "fullDiskAccess" }
  | { readonly step: "importing" }
  | {
      readonly step: "done";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
    }
  | { readonly step: "blocked"; readonly reason: BrowserImportFailureReason };

/** The import owns its target partition until the write finishes. */
export function canCloseWizard(step: WizardStep): boolean {
  return step.step !== "importing";
}

/**
 * Where the wizard opens for a source. A running browser is the one thing we
 * know up front, from the source listing; everything else is discovered by
 * trying, so the wizard starts by letting the user choose what to import.
 */
export function initialWizardStep(source: BrowserImportSource): WizardStep {
  if (source.unavailable === "browserRunning") return { step: "quit" };
  if (source.unavailable === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "configure" };
  }
  if (source.unavailable !== undefined) return { step: "blocked", reason: source.unavailable };
  if (source.profiles.length === 0) return { step: "blocked", reason: "unknownSourceProfile" };
  return { step: "configure" };
}

/** Where an attempted import lands the wizard, by how it turned out. */
export function outcomeToStep(outcome: ImportOutcome): WizardStep {
  if (outcome.kind === "imported") {
    return {
      step: "done",
      imported: outcome.imported,
      skipped: outcome.skipped,
      skippedDomains: outcome.skippedDomains,
      targetName: outcome.targetName,
    };
  }
  // A browser that reopened mid-import routes back to the quit screen; every
  // other failure surfaces on the blocked screen, which offers a retry when
  // one could help.
  if (outcome.reason === "browserRunning") return { step: "quit" };
  if (outcome.reason === "needsFullDiskAccess") {
    // The failed import already checked access, so explain that it is still
    // denied instead of returning to an indistinguishable permission screen.
    return { step: "fullDiskAccess", resume: "import", checked: true };
  }
  return { step: "blocked", reason: outcome.reason };
}

/** Where a fresh availability check lands the wizard after the user quits. */
export function refreshedSourceStep(source: BrowserImportSource | undefined): WizardStep {
  if (source === undefined) return { step: "blocked", reason: "unknownSource" };
  return initialWizardStep(source);
}

/** A denied FDA recheck returns to the permission step with visible feedback. */
export function fullDiskAccessRecheckStep(source: BrowserImportSource | undefined): WizardStep {
  const next = refreshedSourceStep(source);
  return next.step === "fullDiskAccess" ? { ...next, checked: true } : next;
}

/** Preserve the chosen source profile when a post-quit refresh still lists it. */
export function refreshedSourceProfileDirectory(
  currentDirectory: string,
  source: BrowserImportSource,
): string {
  if (source.profiles.some((profile) => profile.directory === currentDirectory)) {
    return currentDirectory;
  }
  return source.profiles[0]?.directory ?? "";
}

/**
 * Whether retrying could clear a failure. The keychain prompt can be approved
 * on a second try, a missing key appears once the user signs in to the
 * browser (which is what its copy asks for), and a read or session error may
 * be transient; an unsupported browser will not change, so it gets no retry
 * button.
 */
export function isRetryableReason(reason: BrowserImportFailureReason): boolean {
  switch (reason) {
    case "needsKeychainApproval":
    case "keychainItemMissing":
    case "keychainUnavailable":
    case "readFailed":
    case "sessionUnavailable":
    case "profileNotSaved":
      return true;
    default:
      return false;
  }
}

/**
 * Names the sites whose cookies were skipped: "example.com and google.com",
 * or "a, b, c and 4 more" past a few, so the line stays short.
 */
export function formatSkippedDomains(domains: ReadonlyArray<string>): string {
  if (domains.length === 0) return "";
  if (domains.length === 1) return domains[0]!;
  if (domains.length <= 3) return `${domains.slice(0, -1).join(", ")} and ${domains.at(-1)}`;
  return `${domains.slice(0, 3).join(", ")} and ${domains.length - 3} more`;
}

/**
 * One import from this dialog copies at most this many exact hosts. The wire
 * (`BROWSER_IMPORT_MAX_DOMAINS`) allows more; the dialog keeps a hand-picked list short.
 */
export const MAX_IMPORT_SITES = 100;

const STARK_ROOT_HOST = "starkfuture.com";
const STARK_LEAD_HOST = "pages.starkfuture.com";

/**
 * Hosts that sign people in to other sites. Copying them lets a site's
 * "Sign in with…" redirect finish instead of asking for a fresh login.
 */
const SIGN_IN_PROVIDER_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "github.com",
] as const;

/** A set of hosts the site picker offers as one checkbox. */
export interface RecommendedSiteGroup {
  readonly id: "stark" | "signInProviders";
  readonly title: string;
  /** Why the set is worth copying; absent when the title already says it. */
  readonly description: string | undefined;
  /** The hosts in a few words, e.g. "pages.starkfuture.com and 3 more". */
  readonly hostsLabel: string;
  readonly hosts: ReadonlyArray<string>;
}

export interface SiteGroups {
  readonly recommended: ReadonlyArray<RecommendedSiteGroup>;
  /** Every listed host that is not in a recommended set, in listing order. */
  readonly other: ReadonlyArray<string>;
}

const isStarkHost = (host: string) =>
  host === STARK_ROOT_HOST || host.endsWith(`.${STARK_ROOT_HOST}`);

/**
 * Splits a source profile's cookie hosts into the sets most people want (Stark
 * sites, sign-in providers) and everything else. Only hosts the profile
 * actually lists are offered; a set with none is left out.
 */
export function recommendedSiteGroups(domains: ReadonlyArray<string>): SiteGroups {
  const hosts = [...new Set(domains.map((domain) => domain.toLowerCase()))];
  const listed = new Set(hosts);
  const starkHosts = hosts.filter(isStarkHost);
  const stark = starkHosts.includes(STARK_LEAD_HOST)
    ? [STARK_LEAD_HOST, ...starkHosts.filter((host) => host !== STARK_LEAD_HOST)]
    : starkHosts;
  const providers = SIGN_IN_PROVIDER_HOSTS.filter((host) => listed.has(host));
  const grouped = new Set<string>([...stark, ...providers]);
  const recommended: RecommendedSiteGroup[] = [];
  if (stark.length > 0) {
    recommended.push({
      id: "stark",
      title: "Stark sites",
      description: undefined,
      hostsLabel: stark.length === 1 ? stark[0]! : `${stark[0]} and ${stark.length - 1} more`,
      hosts: stark,
    });
  }
  if (providers.length > 0) {
    recommended.push({
      id: "signInProviders",
      title: "Sign-in providers",
      description: "Needed when a site asks you to sign in again",
      hostsLabel: providers.join(", "),
      hosts: providers,
    });
  }
  return { recommended, other: hosts.filter((host) => !grouped.has(host)) };
}

/**
 * Adds hosts to the selection as one step. A step that would pass the import
 * cap adds nothing, so a set is never left half-selected by the limit.
 */
export function selectSites(
  current: ReadonlyArray<string>,
  hosts: ReadonlyArray<string>,
): { readonly selected: string[]; readonly limitReached: boolean } {
  const next = [...new Set([...current, ...hosts])];
  if (next.length > MAX_IMPORT_SITES) return { selected: [...current], limitReached: true };
  return { selected: next, limitReached: false };
}

export function deselectSites(
  current: ReadonlyArray<string>,
  hosts: ReadonlyArray<string>,
): string[] {
  const removed = new Set(hosts);
  return current.filter((host) => !removed.has(host));
}

/** Drives a set's checkbox: checked, mixed, or clear. */
export function siteGroupState(
  selected: ReadonlyArray<string>,
  hosts: ReadonlyArray<string>,
): "all" | "some" | "none" {
  const chosen = hosts.filter((host) => selected.includes(host)).length;
  if (chosen === 0) return "none";
  return chosen === hosts.length ? "all" : "some";
}

/**
 * "3 of 4 selected" while a set is only partly chosen, so a host unticked
 * inside a collapsed set stays visible. Nothing when the checkbox says it all.
 */
export function siteGroupSelectionLabel(
  selected: ReadonlyArray<string>,
  hosts: ReadonlyArray<string>,
): string | undefined {
  if (siteGroupState(selected, hosts) !== "some") return undefined;
  const chosen = hosts.filter((host) => selected.includes(host)).length;
  return `${chosen} of ${hosts.length} selected`;
}

const EXACT_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Reads a typed site as one exact host: "pages.starkfuture.com", a pasted
 * URL, or a cookie-style ".example.com". Anything else is undefined.
 */
export function parseSiteInput(draft: string): string | undefined {
  let host = draft.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return undefined;
    }
  }
  host = host.replace(/^\./, "");
  if (host.length > 253 || !EXACT_HOST.test(host)) return undefined;
  return host;
}

/** Hosts matching a filter, capped so a profile with thousands stays light to render. */
export function filterSites(
  hosts: ReadonlyArray<string>,
  query: string,
  limit = 200,
): { readonly visible: ReadonlyArray<string>; readonly hiddenCount: number } {
  const needle = query.trim().toLowerCase();
  const matches = needle === "" ? hosts : hosts.filter((host) => host.includes(needle));
  return { visible: matches.slice(0, limit), hiddenCount: Math.max(0, matches.length - limit) };
}

/**
 * "412 sites" for a source profile, "2,000+ sites" when the browser listed only
 * part of them; nothing when its hosts could not be listed.
 */
export function siteCountLabel(
  domains: ReadonlyArray<string> | undefined,
  truncated?: boolean,
): string | undefined {
  if (domains === undefined) return undefined;
  if (domains.length === 0) return "No sites";
  const more = truncated === true ? "+" : "";
  return `${domains.length.toLocaleString()}${more} ${domains.length === 1 && !more ? "site" : "sites"}`;
}

/** The confirm button, which is also the user's acknowledgement. */
export function copySignInsLabel(count: number): string {
  if (count === 0) return "Copy sign-ins";
  return `Copy sign-ins for ${count} ${count === 1 ? "site" : "sites"}`;
}
