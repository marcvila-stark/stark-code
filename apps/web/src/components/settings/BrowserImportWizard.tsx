import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import type { BrowserImportSource } from "@starkfuture/contracts";
import { BROWSER_IMPORT_FAILURE_COPY } from "@starkfuture/contracts";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  HardDriveIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { cn, randomUUID } from "~/lib/utils";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  initialWizardStep,
  initialTargetSelection,
  canCloseWizard,
  copySignInsLabel,
  deselectSites,
  filterSites,
  isRetryableReason,
  formatSkippedDomains,
  fullDiskAccessRecheckStep,
  MAX_IMPORT_SITES,
  outcomeToStep,
  parseSiteInput,
  recommendedSiteGroups,
  refreshedSourceProfileDirectory,
  refreshedSourceStep,
  resolveWizardTarget,
  selectSites,
  siteCountLabel,
  siteGroupSelectionLabel,
  siteGroupState,
  type ImportOutcome,
  type RecommendedSiteGroup,
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
  const availableDomains = source.profiles.find(
    (profile) => profile.directory === sourceProfileDirectory,
  )?.domains;
  // Stable across retries so a keychain re-approval lands in one profile, not
  // a new one each time.
  const newProfileId = useRef(`profile-${randomUUID()}`);
  // A second Import click before React has left the configure screen would
  // start a second run; the parent refuses it, and applying that refusal here
  // would drop the wizard out of the importing step while the first write is
  // still going. The ref settles synchronously where state does not.
  const importInFlight = useRef(false);

  const runImport = () => {
    // Pressing the copy button is the acknowledgement; it is only enabled once
    // the user has chosen at least one site.
    if (importInFlight.current || selectedDomains.length === 0) return;
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
            // The chosen sites belong to the account profile the user chose. A
            // post-quit refresh must not transfer them to a replacement profile.
            setSelectedDomains([]);
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
        className="max-w-lg"
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
            targetProfiles={targetProfiles}
            canCreateProfile={canCreateProfile}
            sourceProfileDirectory={sourceProfileDirectory}
            onSourceProfileChange={(directory) => {
              setSourceProfileDirectory(directory);
              setSelectedDomains([]);
            }}
            target={target}
            onTargetChange={(selection) => {
              setTarget(selection);
              setTargetError(undefined);
            }}
            targetError={targetError}
            selectedCount={selectedDomains.length}
            sitePicker={
              <SitePicker
                key={sourceProfileDirectory}
                domains={availableDomains}
                selected={selectedDomains}
                onChange={setSelectedDomains}
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

function cookieResultCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;
}

type ConfigureStepProps = {
  readonly source: BrowserImportSource;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  readonly sourceProfileDirectory: string;
  readonly onSourceProfileChange: (directory: string) => void;
  readonly target: WizardTargetSelection;
  readonly targetError: string | undefined;
  readonly sitePicker: ReactNode;
  /** How many exact hosts are chosen; the copy button names it. */
  readonly selectedCount: number;
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
  targetProfiles,
  canCreateProfile,
  sourceProfileDirectory,
  onSourceProfileChange,
  target,
  targetError,
  sitePicker,
  selectedCount,
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
  // Settings and setup both import into the one personal profile; a picker
  // with a single fixed choice reads better as a line.
  const fixedTarget =
    !canCreateProfile && targetProfiles.length === 1 ? targetProfiles[0] : undefined;
  const sourceTiles = source.profiles.map((profile) => (
    <SelectableTile
      key={profile.directory}
      selected={sourceProfileDirectory === profile.directory}
      title={profile.name}
      subtitle={siteCountLabel(profile.domains, profile.domainsTruncated)}
      onSelect={() => onSourceProfileChange(profile.directory)}
    />
  ));
  return (
    <>
      <DialogHeader>
        <DialogTitle>Use your {source.name} sign-ins in Stark Code</DialogTitle>
        <DialogDescription>
          Stark Code copies the sign-in cookies of the sites you pick into its own browser profile
          on this computer, so sites like Stark Pages open already signed in.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {fixedTarget ? (
          <section className="min-w-0 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              From
            </p>
            {sourceTiles}
            <p className="text-xs text-muted-foreground">
              Into: <span className="font-medium text-foreground">{fixedTarget.name}</span>
            </p>
          </section>
        ) : (
          // Zero-minimum columns keep long account names inside the dialog.
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-4">
            <section className="min-w-0 space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                From
              </p>
              {sourceTiles}
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
          <p role="alert" className="text-sm text-destructive">
            {targetFeedback}
          </p>
        ) : null}
        <SignInSafetyNotes />
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={
            selectedCount === 0 ||
            sourceProfileDirectory === "" ||
            targetMissing ||
            targetUncreatable
          }
          onClick={onImport}
        >
          {copySignInsLabel(selectedCount)}
        </Button>
      </DialogFooter>
    </>
  );
}

const SITE_LIMIT_NOTICE = `One import can copy up to ${MAX_IMPORT_SITES} sites. Clear some to add more.`;

/**
 * Chooses the exact hosts to copy. Stark sites and sign-in providers are one
 * click each and open to single hosts; everything else sits behind "Other
 * sites". Nothing starts selected.
 */
function SitePicker({
  domains,
  selected,
  onChange,
}: {
  /** The source profile's cookie hosts; absent when they could not be listed. */
  readonly domains: ReadonlyArray<string> | undefined;
  readonly selected: ReadonlyArray<string>;
  readonly onChange: (selected: string[]) => void;
}) {
  const groups = useMemo(() => recommendedSiteGroups(domains ?? []), [domains]);
  const [othersOpen, setOthersOpen] = useState(groups.recommended.length === 0);
  const [filter, setFilter] = useState("");
  const [siteDraft, setSiteDraft] = useState("");
  const [notice, setNotice] = useState<string>();
  const selectedSet = new Set(selected);
  const listed = new Set(groups.recommended.flatMap((group) => group.hosts));
  for (const host of groups.other) listed.add(host);
  // Sites typed in by hand join the other sites so they can be unticked too.
  const otherHosts = [...selected.filter((host) => !listed.has(host)), ...groups.other];
  const otherSelected = otherHosts.filter((host) => selectedSet.has(host)).length;
  const { visible, hiddenCount } = filterSites(otherHosts, filter);

  const select = (hosts: ReadonlyArray<string>) => {
    const result = selectSites(selected, hosts);
    setNotice(result.limitReached ? SITE_LIMIT_NOTICE : undefined);
    if (!result.limitReached) onChange(result.selected);
  };
  const deselect = (hosts: ReadonlyArray<string>) => {
    setNotice(undefined);
    onChange(deselectSites(selected, hosts));
  };
  const toggle = (host: string, checked: boolean) => (checked ? select([host]) : deselect([host]));
  const addSite = () => {
    const host = parseSiteInput(siteDraft);
    if (host === undefined) {
      setNotice("Enter one exact site, like pages.starkfuture.com.");
      return;
    }
    const result = selectSites(selected, [host]);
    setNotice(result.limitReached ? SITE_LIMIT_NOTICE : undefined);
    if (result.limitReached) return;
    onChange(result.selected);
    setSiteDraft("");
  };

  return (
    <section className="space-y-2">
      <p className="text-sm font-medium text-foreground">Choose sites</p>
      <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
        {groups.recommended.map((group) => (
          <SiteGroupRow
            key={group.id}
            group={group}
            selected={selected}
            onSelectAll={(checked) => (checked ? select(group.hosts) : deselect(group.hosts))}
            onToggleSite={toggle}
          />
        ))}
        <Collapsible open={othersOpen} onOpenChange={setOthersOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                othersOpen && "rotate-90",
              )}
            />
            <span className="min-w-0 flex-1">Other sites</span>
            {otherHosts.length > 0 ? (
              <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
                {otherSelected > 0
                  ? `${otherSelected} of ${otherHosts.length.toLocaleString()} selected`
                  : otherHosts.length.toLocaleString()}
              </span>
            ) : null}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="space-y-3 px-3 pt-1 pb-3">
              {otherHosts.length > 0 ? (
                <>
                  <Input
                    type="search"
                    size="sm"
                    placeholder="Filter sites"
                    aria-label="Filter other sites"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  <div className="max-h-48 space-y-2 overflow-auto">
                    {visible.map((host) => (
                      <SiteCheckbox
                        key={host}
                        host={host}
                        checked={selectedSet.has(host)}
                        onCheckedChange={(checked) => toggle(host, checked)}
                      />
                    ))}
                    {visible.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No sites match.</p>
                    ) : null}
                  </div>
                  {hiddenCount > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {hiddenCount.toLocaleString()} more. Filter to find them.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {domains === undefined
                    ? "This browser can't list its sites. Add the ones you want below."
                    : "No other sites were found in this profile."}
                </p>
              )}
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  addSite();
                }}
              >
                <label className="min-w-0 flex-1 text-xs text-muted-foreground">
                  Add a site that isn&rsquo;t listed
                  <Input
                    className="mt-1"
                    size="sm"
                    placeholder="pages.starkfuture.com"
                    value={siteDraft}
                    onChange={(event) => setSiteDraft(event.target.value)}
                  />
                </label>
                <Button type="submit" variant="outline" size="sm">
                  Add
                </Button>
              </form>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
      {notice ? (
        <p role="status" className="text-xs text-destructive">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

/**
 * A recommended set. Its checkbox copies every host in the set; the host
 * summary under the title opens the list so single hosts can be unticked.
 */
function SiteGroupRow({
  group,
  selected,
  onSelectAll,
  onToggleSite,
}: {
  readonly group: RecommendedSiteGroup;
  readonly selected: ReadonlyArray<string>;
  readonly onSelectAll: (checked: boolean) => void;
  readonly onToggleSite: (host: string, checked: boolean) => void;
}) {
  const state = siteGroupState(selected, group.hosts);
  const selectionLabel = siteGroupSelectionLabel(selected, group.hosts);
  return (
    <Collapsible>
      <div className="px-3 py-2.5">
        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            className="mt-0.5"
            checked={state === "all"}
            indeterminate={state === "some"}
            onCheckedChange={onSelectAll}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-sm font-medium text-foreground">{group.title}</span>
              {selectionLabel ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {selectionLabel}
                </span>
              ) : null}
            </span>
            {group.description ? (
              <span className="block text-xs text-muted-foreground">{group.description}</span>
            ) : null}
          </span>
        </label>
        <CollapsibleTrigger className="group ml-6 flex items-center gap-1 rounded-sm px-1 text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span className="min-w-0 wrap-anywhere">{group.hostsLabel}</span>
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="ml-7 max-h-48 space-y-2 overflow-auto pt-2">
            {group.hosts.map((host) => (
              <SiteCheckbox
                key={host}
                host={host}
                checked={selected.includes(host)}
                onCheckedChange={(checked) => onToggleSite(host, checked)}
              />
            ))}
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

/** One exact host and its own checkbox. */
function SiteCheckbox({
  host,
  checked,
  onCheckedChange,
}: {
  readonly host: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} />
      <span className="min-w-0 wrap-anywhere">{host}</span>
    </label>
  );
}

/**
 * What happens to copied sign-ins, next to the button that copies them: the two
 * lines that matter stay visible and the rest waits behind "More details". Each
 * line has to stay true to the import path: cookies are written into the
 * personal profile's partition on this machine (imports refuse to run without
 * OS-backed cookie encryption) and are never sent to the Stark server.
 */
function SignInSafetyNotes() {
  return (
    <section className="rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3">
      <p className="text-xs font-medium text-foreground">What happens to these sign-ins</p>
      <ul className="mt-2 space-y-1.5">
        {SIGN_IN_SAFETY_POINTS.map((point) => (
          <li key={point} className="flex items-start gap-2 text-xs text-foreground">
            <CheckIcon className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
            <span className="min-w-0">{point}</span>
          </li>
        ))}
      </ul>
      <Collapsible className="mt-2">
        <CollapsibleTrigger className="group -mx-1 flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          More details
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-1 pt-1.5 text-xs text-muted-foreground">
            {SIGN_IN_SAFETY_DETAILS.map((detail) => (
              <p key={detail}>{detail}</p>
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

const SIGN_IN_SAFETY_POINTS = [
  "Kept on this computer, in Stark Code's own profile.",
  "Not uploaded to Stark servers; used when you visit the selected websites.",
] as const;

const SIGN_IN_SAFETY_DETAILS = [
  "Encrypted with your system keychain. Agents can't open this profile.",
  "Clear it any time in Settings → Connected tools → Browser & privacy.",
  "A copied sign-in works like the original, so anyone using this computer account could use it inside Stark Code.",
  "Not passwords, history or bookmarks. One-time copy.",
] as const;

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
        <DialogTitle>Copying sign-ins</DialogTitle>
        <DialogDescription>This may take a moment.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 py-2">
          <Spinner size="md" tone="muted" />
          <span className="text-sm text-muted-foreground">Copying…</span>
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
