import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import type { BrowserImportSource, BrowserImportSourceProfile } from "@starkfuture/contracts";
import { BROWSER_IMPORT_FAILURE_COPY } from "@starkfuture/contracts";
import { ArrowDownIcon, ArrowRightIcon, CheckIcon, HardDriveIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { BrowserImportSitePicker } from "./BrowserImportSitePicker";
import {
  initialWizardStep,
  initialTargetSelection,
  canCloseWizard,
  isRetryableReason,
  formatSkippedDomains,
  fullDiskAccessRecheckStep,
  outcomeToStep,
  refreshedSourceProfileDirectory,
  refreshedSourceStep,
  resolveWizardTarget,
  type ImportOutcome,
  type WizardTarget,
  type WizardTargetProfile,
  type WizardTargetSelection,
  type WizardStep,
} from "./browserImportWizard.logic";

export type { WizardTarget } from "./browserImportWizard.logic";

interface BrowserImportWizardProps {
  readonly layer?: "default" | "workspace";
  readonly source: BrowserImportSource;
  /** Captured when the wizard opens so destination copy and writes stay stable. */
  readonly destinationEnvironmentName: string;
  /** Existing profiles the import can go into. Incognito is excluded upstream. */
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  /** Whether a new profile can still be created (profile cap). */
  readonly canCreateProfile: boolean;
  /**
   * Runs the import and returns how it went. For a new target the caller only
   * registers the profile once the import succeeds, so a blocked attempt never
   * leaves an empty profile behind.
   */
  readonly onImport: (input: {
    readonly sourceProfileDirectory: string;
    readonly target: WizardTarget;
    readonly selectedDomains: string[];
    readonly consent: true;
  }) => Promise<ImportOutcome>;
  /** Re-checks the source's availability after the user quits the browser. */
  readonly onRefreshSource: () => Promise<BrowserImportSource | undefined>;
  /** Opens the OS setting that grants access to a protected cookie store. */
  readonly onOpenFullDiskAccessSettings: () => void | Promise<void>;
  readonly onCheckFullDiskAccess?: (() => Promise<boolean>) | undefined;
  readonly onClose: () => void;
}

/**
 * Guides one browser's cookies into a profile.
 *
 * Every state the import can be in — the browser is open, a profile has to be
 * chosen, the read failed — is a screen the user can move forward from, rather
 * than a disabled row that only says no.
 */
export function BrowserImportWizard({
  layer = "default",
  source: initialSource,
  destinationEnvironmentName,
  targetProfiles,
  canCreateProfile,
  onImport,
  onRefreshSource,
  onOpenFullDiskAccessSettings,
  onCheckFullDiskAccess,
  onClose,
}: BrowserImportWizardProps) {
  const [source, setSource] = useState(initialSource);
  const [step, setStep] = useState<WizardStep>(() => initialWizardStep(initialSource));
  const [sourceProfileDirectory, setSourceProfileDirectory] = useState(
    () => initialSource.profiles[0]?.directory ?? "",
  );
  const [target, setTarget] = useState<WizardTargetSelection>(() =>
    initialTargetSelection(canCreateProfile, targetProfiles),
  );
  const [targetError, setTargetError] = useState<string>();
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  // Stable across retries so a keychain re-approval lands in one profile, not
  // a new one each time.
  const newProfileId = useRef(`profile-${randomUUID()}`);
  // A second Import click before React has left the configure screen would
  // start a second run; the parent refuses it, and applying that refusal here
  // would drop the wizard out of the importing step while the first write is
  // still going. The ref settles synchronously where state does not.
  const importInFlight = useRef(false);

  const runImport = () => {
    if (importInFlight.current || !consent || selectedDomains.length === 0) return;
    const chosen = resolveWizardTarget(target, newProfileId.current, targetProfiles);
    if (chosen === undefined) {
      setTargetError("That profile is no longer available. Choose where to import these cookies.");
      setStep({ step: "configure" });
      return;
    }
    setTargetError(undefined);
    importInFlight.current = true;
    setStep({ step: "importing" });
    void onImport({ sourceProfileDirectory, target: chosen, selectedDomains, consent: true })
      .then((outcome) => setStep(outcomeToStep(outcome)))
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }))
      .finally(() => {
        importInFlight.current = false;
      });
  };

  // Re-lists the source after the user did something outside the app (quit the
  // browser, granted access) and routes to wherever the refreshed source says.
  const recheckSource = (
    check: "browser" | "fullDiskAccess",
    nextStep: (refreshed: BrowserImportSource | undefined) => WizardStep,
  ) => {
    setStep({ step: "checking", check });
    void onRefreshSource()
      .then((refreshed) => {
        if (refreshed) {
          setSource(refreshed);
          const nextDirectory = refreshedSourceProfileDirectory(sourceProfileDirectory, refreshed);
          if (nextDirectory !== sourceProfileDirectory) {
            // Consent belongs to the account profile the user chose. A
            // post-quit refresh must not transfer it to a replacement profile.
            setSelectedDomains([]);
            setConsent(false);
          }
          setSourceProfileDirectory(nextDirectory);
        }
        setStep(nextStep(refreshed));
      })
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }));
  };
  const recheckAfterQuit = () => recheckSource("browser", refreshedSourceStep);
  const recheckFullDiskAccess = () => recheckSource("fullDiskAccess", fullDiskAccessRecheckStep);

  return (
    <Dialog open onOpenChange={(open) => (open || !canCloseWizard(step) ? undefined : onClose())}>
      <DialogPopup
        variant="brand"
        layer={layer}
        className="max-w-xl"
        showCloseButton={canCloseWizard(step)}
      >
        {step.step === "quit" ? (
          <QuitStep source={source} onCancel={onClose} onRechecked={recheckAfterQuit} />
        ) : step.step === "fullDiskAccess" ? (
          <FullDiskAccessStep
            source={source}
            onCancel={onClose}
            onOpenSettings={onOpenFullDiskAccessSettings}
            onCheck={
              onCheckFullDiskAccess ??
              (async () => {
                const refreshed = await onRefreshSource();
                return refreshed !== undefined && refreshed.unavailable === undefined;
              })
            }
            onGranted={step.resume === "import" ? runImport : recheckFullDiskAccess}
            stillRequired={step.checked === true}
          />
        ) : step.step === "importing" ? (
          <ImportingStep />
        ) : step.step === "checking" ? (
          <CheckingStep sourceName={source.name} check={step.check} />
        ) : step.step === "done" ? (
          <DoneStep
            {...step}
            destinationEnvironmentName={destinationEnvironmentName}
            onClose={onClose}
          />
        ) : step.step === "blocked" ? (
          <BlockedStep
            source={source}
            reason={step.reason}
            onClose={onClose}
            onRetry={isRetryableReason(step.reason) ? runImport : undefined}
          />
        ) : (
          <ConfigureStep
            source={source}
            destinationEnvironmentName={destinationEnvironmentName}
            targetProfiles={targetProfiles}
            canCreateProfile={canCreateProfile}
            sourceProfileDirectory={sourceProfileDirectory}
            onSourceProfileChange={(directory) => {
              setSourceProfileDirectory(directory);
              setSelectedDomains([]);
              setConsent(false);
            }}
            target={target}
            onTargetChange={(selection) => {
              setTarget(selection);
              setTargetError(undefined);
            }}
            targetError={targetError}
            importReady={consent && selectedDomains.length > 0}
            selectedSiteCount={selectedDomains.length}
            sitePicker={
              <BrowserImportSitePicker
                key={sourceProfileDirectory}
                profile={source.profiles.find(
                  (profile) => profile.directory === sourceProfileDirectory,
                )}
                selectedDomains={selectedDomains}
                onSelectionChange={setSelectedDomains}
                consent={consent}
                onConsentChange={setConsent}
              />
            }
            onCancel={onClose}
            onImport={runImport}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function QuitStep({
  source,
  onCancel,
  onRechecked,
}: {
  readonly source: BrowserImportSource;
  readonly onCancel: () => void;
  readonly onRechecked: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Quit {source.name} to import</DialogTitle>
        <DialogDescription>
          {source.name} is open, so its cookies can&rsquo;t be read yet. Quit it, then continue.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onRechecked}>I&rsquo;ve quit it</Button>
      </DialogFooter>
    </>
  );
}

function sourceSiteCountLabel(profile: BrowserImportSourceProfile): string {
  if (profile.domains === undefined) return "Choose sites by address";
  const count = new Set(profile.domains).size;
  return `${count.toLocaleString()}${profile.domainsTruncated ? "+" : ""} ${count === 1 ? "site" : "sites"} found`;
}

function cookieResultCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;
}

type ConfigureStepProps = {
  readonly source: BrowserImportSource;
  readonly destinationEnvironmentName: string;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  readonly sourceProfileDirectory: string;
  readonly onSourceProfileChange: (directory: string) => void;
  readonly target: WizardTargetSelection;
  readonly targetError: string | undefined;
  readonly sitePicker: import("react").ReactNode;
  readonly importReady: boolean;
  readonly selectedSiteCount: number;
  readonly onTargetChange: (target: WizardTargetSelection) => void;
  readonly onCancel: () => void;
  readonly onImport: () => void;
};

function FullDiskAccessStep({
  source,
  onCancel,
  onOpenSettings,
  onGranted,
  stillRequired,
  onCheck,
}: {
  readonly source: BrowserImportSource;
  readonly onCancel: () => void;
  readonly onOpenSettings: () => void | Promise<void>;
  readonly onCheck: () => Promise<boolean>;
  readonly onGranted: () => void;
  readonly stillRequired: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const permission = usePermissionStatus(async () => ({ fullDiskAccess: await onCheck() }), {
    fullDiskAccess: false,
  });
  const allow = () => {
    if (opening) return;
    setOpening(true);
    setOpeningError(null);
    void Promise.resolve()
      .then(onOpenSettings)
      .catch(() => setOpeningError("Could not open System Settings. Try Allow again."))
      .finally(() => setOpening(false));
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Let Stark Code read {source.name}&rsquo;s cookies</DialogTitle>
        <DialogDescription>
          To import cookies from {source.name}, Stark Code needs Full Disk Access. Turn it on in
          System Settings, then come back to finish the import — you can revoke it again once the
          import is done.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <PermissionChecklist
          busy={opening}
          permissions={[
            {
              id: "fullDiskAccess",
              icon: (
                <HardDriveIcon
                  className="size-8 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              ),
              title: "Full Disk Access",
              description: `Read ${source.name}'s cookies for this import.`,
              granted: permission.status.fullDiskAccess,
              onAllow: () => void allow(),
            },
          ]}
        />
        {openingError || permission.error ? (
          <p role="status" className="mt-3 text-xs text-muted-foreground">
            {openingError ?? permission.error}
          </p>
        ) : null}
        {!permission.isReady(["fullDiskAccess"]) ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {stillRequired
              ? "Access is still required. Quit and reopen Stark Code if you just allowed it, then retry the import."
              : "If access doesn't update after you allow it, quit and reopen Stark Code, then retry the import."}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <PermissionContinueButton
          ready={permission.isReady(["fullDiskAccess"])}
          busy={opening}
          onClick={onGranted}
        >
          Continue
        </PermissionContinueButton>
      </DialogFooter>
    </>
  );
}
function ConfigureStep({
  source,
  destinationEnvironmentName,
  targetProfiles,
  canCreateProfile,
  sourceProfileDirectory,
  onSourceProfileChange,
  target,
  targetError,
  sitePicker,
  importReady,
  selectedSiteCount,
  onTargetChange,
  onCancel,
  onImport,
}: ConfigureStepProps) {
  const targetMissing =
    target.kind === "existing" &&
    !targetProfiles.some((profile) => profile.id === target.profileId);
  // The "New profile" tile is unrendered once the cap is reached, so a target
  // chosen before that leaves nothing selected in "Into" — say so, the same
  // way a vanished existing target is explained.
  const targetUncreatable = target.kind === "new" && !canCreateProfile;
  const targetFeedback =
    targetError ??
    (targetMissing
      ? "That profile is no longer available. Choose where to import these cookies."
      : targetUncreatable
        ? "You've reached the profile limit. Choose an existing profile to import into."
        : undefined);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import from {source.name}</DialogTitle>
        <DialogDescription>
          Bring sign-ins for the sites you choose into {destinationEnvironmentName}.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {source.profiles.length === 1 &&
        targetProfiles.length === 1 &&
        !canCreateProfile &&
        target.kind === "existing" &&
        target.profileId === targetProfiles[0]!.id ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-border px-3 py-2">
            <p className="min-w-0 wrap-anywhere text-sm">
              {source.profiles[0]!.name}
              <span className="text-xs text-muted-foreground">
                {" · "}
                {sourceSiteCountLabel(source.profiles[0]!)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">Into {targetProfiles[0]!.name}</p>
          </div>
        ) : (
          /* Zero-minimum columns keep long account names inside the dialog. */
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-4">
            <section className="min-w-0 space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                From
              </p>
              {source.profiles.map((profile) => (
                <SelectableTile
                  key={profile.directory}
                  selected={sourceProfileDirectory === profile.directory}
                  title={profile.name}
                  subtitle={sourceSiteCountLabel(profile)}
                  onSelect={() => onSourceProfileChange(profile.directory)}
                />
              ))}
            </section>
            <div className="flex shrink-0 items-center justify-center text-muted-foreground">
              <ArrowDownIcon className="size-4 sm:hidden" />
              <ArrowRightIcon className="hidden size-4 sm:block" />
            </div>
            <section className="min-w-0 space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Into
              </p>
              {canCreateProfile ? (
                <SelectableTile
                  selected={target.kind === "new"}
                  title="New profile"
                  subtitle="Created for these cookies"
                  onSelect={() => onTargetChange({ kind: "new" })}
                />
              ) : null}
              {targetProfiles.map((profile) => (
                <SelectableTile
                  key={profile.id}
                  selected={target.kind === "existing" && target.profileId === profile.id}
                  title={profile.name}
                  subtitle="Existing profile"
                  onSelect={() => onTargetChange({ kind: "existing", profileId: profile.id })}
                />
              ))}
            </section>
          </div>
        )}
        {sitePicker}
        {targetFeedback ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {targetFeedback}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={
            !importReady || sourceProfileDirectory === "" || targetMissing || targetUncreatable
          }
          onClick={onImport}
        >
          {selectedSiteCount > 0
            ? `Import ${selectedSiteCount.toLocaleString()} ${selectedSiteCount === 1 ? "site" : "sites"}`
            : "Select sites to import"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** One selectable option: a name, an optional detail line, and a check. */
function SelectableTile({
  selected,
  title,
  subtitle,
  onSelect,
}: {
  readonly selected: boolean;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-primary/8"
          : "border-border/60 hover:border-border hover:bg-muted/40",
      )}
    >
      <span className="min-w-0">
        <span className="block wrap-anywhere text-sm font-medium text-foreground">{title}</span>
        {subtitle ? (
          <span className="block wrap-anywhere text-xs tabular-nums text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {selected ? <CheckIcon className="size-2.5" /> : null}
      </span>
    </button>
  );
}

function ImportingStep() {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Importing cookies</DialogTitle>
        <DialogDescription>This may take a moment.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 py-2">
          <Spinner size="md" tone="muted" />
          <span className="text-sm text-muted-foreground">Importing…</span>
        </div>
      </DialogPanel>
    </>
  );
}

function CheckingStep({
  sourceName,
  check,
}: {
  readonly sourceName: string;
  readonly check: "browser" | "fullDiskAccess";
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Checking {sourceName}</DialogTitle>
        <DialogDescription>
          {check === "fullDiskAccess"
            ? "Checking Full Disk Access."
            : "Checking whether the browser has closed."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 py-2">
          <Spinner size="md" tone="muted" />
          <span className="text-sm text-muted-foreground">
            {check === "fullDiskAccess" ? "Checking access…" : "Checking…"}
          </span>
        </div>
      </DialogPanel>
    </>
  );
}

function DoneStep({
  imported,
  skipped,
  skippedDomains,
  targetName,
  destinationEnvironmentName,
  onClose,
}: {
  readonly imported: number;
  readonly skipped: number;
  readonly skippedDomains: ReadonlyArray<string>;
  readonly targetName: string;
  readonly destinationEnvironmentName: string;
  readonly onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {imported > 0
            ? `Imported ${cookieResultCount(imported)}`
            : skipped > 0
              ? `Skipped ${cookieResultCount(skipped)}`
              : "No cookies found"}
        </DialogTitle>
        <DialogDescription>
          {imported > 0
            ? `Added to ${targetName} for ${destinationEnvironmentName}.${skipped > 0 ? ` ${cookieResultCount(skipped)} skipped.` : ""}`
            : skipped > 0
              ? `No cookies were imported for ${destinationEnvironmentName}.`
              : `There were no cookies to import for ${destinationEnvironmentName}.`}
        </DialogDescription>
      </DialogHeader>
      {skippedDomains.length > 0 ? (
        <DialogPanel>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Skipped
          </p>
          <p className="mt-1 text-sm text-foreground">{formatSkippedDomains(skippedDomains)}</p>
        </DialogPanel>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button />} onClick={onClose}>
          Done
        </DialogClose>
      </DialogFooter>
    </>
  );
}

function BlockedStep({
  source,
  reason,
  onClose,
  onRetry,
}: {
  readonly source: BrowserImportSource;
  readonly reason: keyof typeof BROWSER_IMPORT_FAILURE_COPY;
  readonly onClose: () => void;
  readonly onRetry: (() => void) | undefined;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Couldn&rsquo;t import from {source.name}</DialogTitle>
        <DialogDescription>{BROWSER_IMPORT_FAILURE_COPY[reason]}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
      </DialogFooter>
    </>
  );
}
