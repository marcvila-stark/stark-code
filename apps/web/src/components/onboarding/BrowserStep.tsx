import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, GlobeIcon } from "lucide-react";
import {
  IMPORTED_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserImportSource,
  type EnvironmentId,
} from "@starkfuture/contracts";

import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { useEnvironments } from "../../state/environments";
import { resolveOnboardingLocalEnvironment } from "../../onboarding/targetEnvironment.logic";
import { BrowserImportWizard } from "../settings/BrowserImportWizard";
import { runBrowserImport } from "../settings/browserImport";
import { Button } from "../ui/button";
import styles from "./OnboardingLayout.module.css";

/** Reuses the regular import flow; opening setup only discovers browser metadata. */
export function BrowserStep({
  environmentId,
  onContinue,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly onContinue: () => void;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.preview;
  const { environments } = useEnvironments();
  const localEnvironment = resolveOnboardingLocalEnvironment(
    environments,
    typeof window === "undefined"
      ? []
      : (window.desktopBridge?.getLocalEnvironmentBootstraps?.() ?? []),
  );
  const environment = localEnvironment?.environmentId === environmentId ? localEnvironment : null;
  const importEnvironmentId = environment?.environmentId ?? null;
  const settingsReady = useClientSettingsHydrated();
  const [sources, setSources] = useState<readonly BrowserImportSource[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [choosingBrowser, setChoosingBrowser] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [imported, setImported] = useState(false);
  const [session, setSession] = useState<{
    source: BrowserImportSource;
    environmentId: EnvironmentId;
    target: { id: string; name: string };
  } | null>(null);
  const importInFlight = useRef(false);

  useEffect(() => {
    if (!bridge || !importEnvironmentId) return;
    let disposed = false;
    void bridge.listBrowserImportSources().then(
      (available) => {
        if (disposed) return;
        const installed = available.filter((source) => source.unavailable !== "notInstalled");
        setSources(installed);
        setSourceId((current) =>
          installed.some((source) => source.id === current)
            ? current
            : (installed.find((source) => source.isDefault)?.id ?? ""),
        );
      },
      () => {
        if (disposed) return;
        setError("Could not find your browsers. Try again.");
        setSources([]);
      },
    );
    return () => {
      disposed = true;
    };
  }, [bridge, importEnvironmentId, refresh]);

  const selectedSource = sources?.find((source) => source.id === sourceId);

  const beginImport = () => {
    const source = sources?.find((candidate) => candidate.id === sourceId);
    if (!source || !environment || !settingsReady) return;
    const settings = getClientSettings();
    const profiles = resolveBrowserProfiles(settings.browserProfiles);
    const target = profiles.find((profile) => profile.id === IMPORTED_BROWSER_PROFILE_ID)!;
    // Capture the destination before opening the dialog; a connection switch
    // while importing must not send the cookies to another environment.
    setSession({ source, environmentId: environment.environmentId, target });
  };

  return (
    <>
      <p
        className={`${styles.eyebrow} mb-3.25 text-3xs font-semibold text-muted-foreground uppercase`}
      >
        Optional
      </p>
      <h1 className={`${styles.title} mb-3.25 leading-tight font-semibold text-foreground`}>
        Bring your website sign-ins
      </h1>
      <p className={`${styles.intro} mb-6.5 max-w-[540px] text-muted-foreground`}>
        Copy the sign-ins of the sites you pick, like Stark Pages, into Stark Code&rsquo;s own
        browser profile on this computer, so they open already signed in. Agents cannot open that
        profile.
      </p>
      <div className="rounded-lg border border-border p-5 max-sm:p-4.25">
        {!bridge ? (
          <p className="text-sm text-muted-foreground">
            Browser import is available in the desktop app.
          </p>
        ) : !environment ? (
          <p className="text-sm text-muted-foreground">
            Browser import is available when setting up this computer. You can skip this step.
          </p>
        ) : error ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button
              variant="subtle-outline"
              size="comfortable"
              onClick={() => {
                setError("");
                setSources(null);
                setRefresh((value) => value + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : sources === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            Finding your browsers…
          </p>
        ) : sources.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            No supported browsers were found. You can import later in Settings.
          </p>
        ) : (
          <div className="space-y-4">
            {selectedSource ? (
              <div className={styles.browserChoice}>
                <GlobeIcon className="size-6 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={`${styles.browserName} font-medium leading-6`}>
                    {selectedSource.name}
                  </p>
                  <p className={`${styles.detail} mt-1.25 text-2xs text-muted-foreground`}>
                    {selectedSource.isDefault ? "Your default browser" : "Selected browser"}
                  </p>
                </div>
                <div className={styles.browserAction}>
                  <Button
                    variant="quiet"
                    size="comfortable"
                    onClick={() => setChoosingBrowser((value) => !value)}
                  >
                    <ChevronDownIcon aria-hidden />
                    {choosingBrowser ? "Done" : "Change browser"}
                  </Button>
                </div>
              </div>
            ) : null}
            {choosingBrowser || !selectedSource ? (
              <div className="space-y-2">
                <label htmlFor="onboarding-browser" className="text-sm font-medium">
                  Browser
                </label>
                <select
                  id="onboarding-browser"
                  value={sourceId}
                  onChange={(event) => {
                    setSourceId(event.target.value);
                    setChoosingBrowser(false);
                  }}
                  className="block h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <option value="" disabled>
                    Choose a browser
                  </option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                      {source.isDefault ? " (default browser)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {imported ? (
              <p role="status" className="text-sm text-muted-foreground">
                Browser sign-ins imported. You can continue setup.
              </p>
            ) : null}
          </div>
        )}
      </div>
      <div className={`${styles.detail} my-5.5 text-xs`}>
        <p className="my-2.75 flex items-start gap-2.25">
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          Website cookies &amp; signed-in sessions
        </p>
        <p className="my-2.75 pl-6.25 text-2xs text-muted-foreground">
          Not passwords, history or bookmarks. This is a one-time copy.
        </p>
      </div>
      <p
        className={`${styles.detail} mt-3.5 border-l-2 border-primary bg-accent px-3.5 py-3 text-2xs text-muted-foreground`}
      >
        Stark Pages connects separately through your browser. This import does not connect its MCP
        account.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5.75">
        <Button variant={imported ? "brand" : "quiet"} size="comfortable" onClick={onContinue}>
          {imported ? "Continue" : "Skip for now"}
        </Button>
        {!imported ? (
          <Button
            variant="brand"
            size="comfortable"
            disabled={!sourceId || !environment || !settingsReady}
            onClick={beginImport}
          >
            <ArrowUpIcon aria-hidden />
            Review before importing
          </Button>
        ) : null}
      </div>
      {session && bridge ? (
        <BrowserImportWizard
          source={session.source}
          destinationEnvironmentName="Stark Code"
          targetProfiles={[session.target]}
          canCreateProfile={false}
          onImport={async (input) => {
            if (!settingsReady || environment?.environmentId !== session.environmentId)
              return { kind: "blocked", reason: "sessionUnavailable" };
            if (importInFlight.current) return { kind: "blocked", reason: "readFailed" };
            importInFlight.current = true;
            try {
              const result = await runBrowserImport(
                {
                  bridge,
                  getSettings: getClientSettings,
                  persistSettingsUpdate: persistClientSettingsUpdate,
                },
                { source: session.source, environmentId: session.environmentId, ...input },
              );
              if (result.kind === "imported" && result.imported > 0) setImported(true);
              return result;
            } finally {
              importInFlight.current = false;
            }
          }}
          onRefreshSource={async () =>
            (await bridge.listBrowserImportSources()).find(
              (source) => source.id === session.source.id,
            )
          }
          onOpenFullDiskAccessSettings={() =>
            ensureLocalApi().shell.openSystemSettings("full-disk-access")
          }
          onCheckFullDiskAccess={
            window.desktopBridge?.checkSystemPermission
              ? () => window.desktopBridge!.checkSystemPermission!("full-disk-access")
              : undefined
          }
          onClose={() => setSession(null)}
        />
      ) : null}
    </>
  );
}
