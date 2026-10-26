import {
  IMPORTED_BROWSER_PROFILE_ID,
  BrowserImportFailureReason,
  type BrowserImportSource,
  type ClientSettings,
  type DesktopPreviewBridge,
  type EnvironmentId,
} from "@starkfuture/contracts";

import type { ImportOutcome, WizardTarget } from "./browserImportWizard.logic";

type BrowserProfileDataBridge = Pick<DesktopPreviewBridge, "clearCookies" | "clearCache">;

/** Environments that host server-runtime tabs keep their own copy of each profile. */
export interface ServerProfileData {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly clear: (environmentId: EnvironmentId, profileId: string) => Promise<void>;
}

export async function clearBrowserProfileData(
  bridge: BrowserProfileDataBridge | null,
  environmentIds: ReadonlyArray<EnvironmentId>,
  profileId: string,
  server?: ServerProfileData,
): Promise<void> {
  const desktopEnvironmentIds = bridge === null ? [] : environmentIds;
  const serverEnvironmentIds = server?.environmentIds ?? [];
  if (desktopEnvironmentIds.length === 0 && serverEnvironmentIds.length === 0) {
    throw new Error("Browser profile data is not available to clear.");
  }
  await Promise.all([
    ...desktopEnvironmentIds.flatMap((environmentId) => [
      bridge!.clearCookies(environmentId, profileId),
      bridge!.clearCache(environmentId, profileId),
    ]),
    ...serverEnvironmentIds.map((environmentId) => server!.clear(environmentId, profileId)),
  ]);
}

/** IPC exposes the reason token, but raw browser or Keychain errors stay private. */
export const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

interface BrowserImportDependencies {
  readonly bridge: Pick<
    DesktopPreviewBridge,
    "importBrowserCookies" | "clearCookies" | "clearCache"
  > | null;
  readonly getSettings: () => ClientSettings;
  readonly persistSettingsUpdate: (
    update: (current: ClientSettings) => ClientSettings,
  ) => Promise<ClientSettings>;
}

interface BrowserImportRequest {
  readonly source: BrowserImportSource;
  readonly environmentId: EnvironmentId;
  readonly sourceProfileDirectory: string;
  readonly target: WizardTarget;
  readonly selectedDomains: string[];
  readonly consent: true;
}

/**
 * Imports into a partition before registering a new profile. Callers own their
 * hydration and in-flight UI guards; settings are checked again after the copy.
 */
export async function runBrowserImport(
  { bridge }: BrowserImportDependencies,
  {
    source,
    environmentId,
    sourceProfileDirectory,
    target,
    selectedDomains,
    consent,
  }: BrowserImportRequest,
): Promise<ImportOutcome> {
  if (
    target.kind !== "existing" ||
    target.profileId !== IMPORTED_BROWSER_PROFILE_ID ||
    consent !== true ||
    !selectedDomains?.length
  )
    return { kind: "blocked", reason: "unsafeTarget" };
  if (!bridge) return { kind: "blocked", reason: "sessionUnavailable" };
  try {
    const result = await bridge.importBrowserCookies({
      environmentId,
      sourceId: source.id,
      sourceProfileDirectory,
      targetProfileId: IMPORTED_BROWSER_PROFILE_ID,
      selectedDomains,
      consent,
    });
    return { kind: "imported", ...result, targetName: "Personal imported sessions" };
  } catch (cause) {
    return { kind: "blocked", reason: importFailureReason(cause) };
  }
}
