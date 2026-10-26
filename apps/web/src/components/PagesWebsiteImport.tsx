import { useEffect, useRef, useState } from "react";
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
} from "../hooks/useSettings";
import { ensureLocalApi } from "../localApi";
import { BrowserImportWizard } from "./settings/BrowserImportWizard";
import { runBrowserImport } from "./settings/browserImport";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export function PagesWebsiteImport({
  environmentId,
  onClose,
  onImported,
}: {
  /** Must be resolved from the desktop bootstrap, never the active chat. */
  readonly environmentId: EnvironmentId | null;
  readonly onClose: () => void;
  readonly onImported: () => void;
}) {
  const bridge = window.desktopBridge?.preview;
  const settingsReady = useClientSettingsHydrated();
  const [destinationId] = useState(environmentId);
  const [sources, setSources] = useState<readonly BrowserImportSource[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [session, setSession] = useState<{
    source: BrowserImportSource;
    target: { id: string; name: string };
  } | null>(null);
  const inFlight = useRef(false);
  const destinationReady = destinationId !== null && environmentId === destinationId;

  useEffect(() => {
    if (!bridge || !destinationId) return;
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
        if (!disposed) setError("Could not find your browsers. Try again.");
      },
    );
    return () => {
      disposed = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The explicit retry reruns browser discovery even when its destination is unchanged.
  }, [bridge, destinationId, refresh]);

  if (session && bridge && destinationId) {
    return (
      <BrowserImportWizard
        layer="workspace"
        source={session.source}
        destinationEnvironmentName="Stark Code on this computer"
        targetProfiles={[session.target]}
        canCreateProfile={false}
        onImport={async (input) => {
          if (!settingsReady || !destinationReady)
            return { kind: "blocked", reason: "sessionUnavailable" };
          if (inFlight.current) return { kind: "blocked", reason: "readFailed" };
          inFlight.current = true;
          try {
            const result = await runBrowserImport(
              {
                bridge,
                getSettings: getClientSettings,
                persistSettingsUpdate: persistClientSettingsUpdate,
              },
              { source: session.source, environmentId: destinationId, ...input },
            );
            if (result.kind === "imported" && result.imported > 0) onImported();
            return result;
          } finally {
            inFlight.current = false;
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
        onClose={onClose}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup variant="brand" layer="workspace">
        <DialogHeader>
          <DialogTitle>Import sign-in from browser</DialogTitle>
          <DialogDescription>
            Choose your browser, then select the sites to copy into Stark Code.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {!bridge || !destinationReady ? (
              <p role="status" className="text-sm text-muted-foreground">
                Connect this computer before importing browser sign-ins.
              </p>
            ) : error ? (
              <div className="space-y-3">
                <p role="alert" className="text-sm text-muted-foreground">
                  {error}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setError(null);
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
                No supported browsers were found on this computer.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">Browser</p>
                <Select value={sourceId} onValueChange={(value) => setSourceId(value ?? "")}>
                  <SelectTrigger aria-label="Browser to import from">
                    <SelectValue>
                      {sources.find((source) => source.id === sourceId)?.name ?? "Choose a browser"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {sources.map((source) => (
                      <SelectItem key={source.id} value={source.id}>
                        {source.name}
                        {source.isDefault ? " (default browser)" : ""}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Nothing is selected automatically. Choose Stark sites for Pages; add Google only if
              you want to copy its sign-in too.
            </p>
            <p className="text-xs text-muted-foreground">
              This copies website sign-ins, not passwords or browsing history. The personal imported
              profile is unavailable to agents.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="brand"
            disabled={!bridge || !destinationReady || !settingsReady || !sourceId || error !== null}
            onClick={() => {
              const source = sources?.find((item) => item.id === sourceId);
              if (!source || !destinationReady || !settingsReady) return;
              const target = resolveBrowserProfiles(getClientSettings().browserProfiles).find(
                (profile) => profile.id === IMPORTED_BROWSER_PROFILE_ID,
              )!;
              setSession({ source, target });
            }}
          >
            Choose sites
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
