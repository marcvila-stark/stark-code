import { useMemo, useState } from "react";
import {
  BROWSER_IMPORT_MAX_DOMAINS,
  type BrowserImportSourceProfile,
} from "@starkfuture/contracts";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { browserImportSites, isStarkImportSite, normalizeImportSite } from "./browserImportSites";

const PAGE_SIZE = 100;

export function BrowserImportSitePicker({
  profile,
  selectedDomains,
  onSelectionChange,
  consent,
  onConsentChange,
}: {
  readonly profile: BrowserImportSourceProfile | undefined;
  readonly selectedDomains: readonly string[];
  readonly onSelectionChange: (sites: string[]) => void;
  readonly consent: boolean;
  readonly onConsentChange: (consent: boolean) => void;
}) {
  const { sites, complete, starkSites } = useMemo(() => browserImportSites(profile), [profile]);
  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [showAllSites, setShowAllSites] = useState(starkSites.length === 0);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [siteDraft, setSiteDraft] = useState("");
  const [siteError, setSiteError] = useState<string>();
  const selected = new Set(selectedDomains);
  const allSelected = complete && sites.length > 0 && sites.every((site) => selected.has(site));
  const listed = [...new Set([...sites, ...selectedDomains])].filter(
    (site) =>
      (!selectedOnly || selected.has(site)) &&
      (showAllSites || selectedOnly || query.trim() !== "" || isStarkImportSite(site)) &&
      site.includes(query.trim().toLowerCase()),
  );
  const changeSelection = (next: string[]) => {
    onConsentChange(false);
    setSiteError(undefined);
    onSelectionChange(next);
  };
  const addSite = () => {
    const host = normalizeImportSite(siteDraft);
    if (!host) {
      setSiteError("Enter a site such as pages.starkfuture.com, or paste its address.");
      return;
    }
    if (!selected.has(host) && selected.size >= BROWSER_IMPORT_MAX_DOMAINS) {
      setSiteError(`You can select up to ${BROWSER_IMPORT_MAX_DOMAINS.toLocaleString()} sites.`);
      return;
    }
    changeSelection([...new Set([...selectedDomains, host])]);
    setSiteDraft("");
    setQuery(host);
    setShowAllSites(true);
    setSelectedOnly(false);
  };

  return (
    <section className="space-y-3" aria-label="Sites to import">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Choose your sites</h3>
        <p className="text-xs text-muted-foreground">
          Choose individual sites, or use a shortcut. Nothing is copied until you confirm.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {starkSites.length > 0 ? (
          <Button
            variant="subtle-outline"
            size="sm"
            onClick={() => {
              changeSelection(starkSites);
              setShowAllSites(false);
              setSelectedOnly(false);
              setQuery("");
            }}
          >
            Select Stark sites ({starkSites.length})
          </Button>
        ) : null}
        {complete && sites.length > 0 ? (
          <Button
            variant="subtle-outline"
            size="sm"
            onClick={() => {
              changeSelection(sites);
              setShowAllSites(true);
              setSelectedOnly(false);
              setQuery("");
            }}
          >
            Select all {sites.length.toLocaleString()} sites
          </Button>
        ) : null}
        {selectedDomains.length > 0 ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              changeSelection([]);
              setSelectedOnly(false);
            }}
          >
            Clear selection
          </Button>
        ) : null}
      </div>
      {starkSites.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Stark sites are addresses under starkfuture.com. Add shared services or separate sign-in
          sites yourself.
        </p>
      ) : null}
      {!complete ? (
        <p className="text-xs text-muted-foreground">
          {profile?.domains === undefined
            ? "This browser cannot list its sites. Add the exact sites you want below."
            : "A complete site list isn’t available. Choose individual sites or add an exact site; select all is unavailable."}
        </p>
      ) : null}
      <Input
        type="search"
        size="default"
        aria-label="Search sites"
        placeholder="Search sites"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setVisibleCount(PAGE_SIZE);
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p aria-live="polite" role="status" className="text-muted-foreground">
          {selectedDomains.length === 0
            ? "0 sites selected"
            : `${selectedDomains.length.toLocaleString()} ${selectedDomains.length === 1 ? "site" : "sites"} selected`}
        </p>
        {starkSites.length > 0 && !selectedOnly && query.trim() === "" ? (
          <Button
            variant="quiet"
            size="compact"
            onClick={() => {
              setShowAllSites((value) => !value);
              setVisibleCount(PAGE_SIZE);
            }}
          >
            {showAllSites
              ? "Show Stark sites"
              : `Browse all ${sites.length.toLocaleString()} sites`}
          </Button>
        ) : null}
        {selectedDomains.length > 0 ? (
          <Button
            variant="quiet"
            size="compact"
            aria-pressed={selectedOnly}
            onClick={() => {
              setSelectedOnly((value) => !value);
              setVisibleCount(PAGE_SIZE);
            }}
          >
            {selectedOnly ? "Back to sites" : "Review selected"}
          </Button>
        ) : null}
      </div>
      <div className="max-h-48 overflow-auto rounded-lg border border-border p-2">
        {listed.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            {selectedOnly ? "No selected sites match your search." : "No sites match your search."}
          </p>
        ) : (
          <ul className="space-y-0.5" aria-label="Available sites">
            {listed.slice(0, visibleCount).map((site) => (
              <li key={site}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 hover:bg-accent">
                  <Checkbox
                    aria-label={site}
                    checked={selected.has(site)}
                    disabled={!selected.has(site) && selected.size >= BROWSER_IMPORT_MAX_DOMAINS}
                    onCheckedChange={(checked) =>
                      changeSelection(
                        checked
                          ? [...selectedDomains, site]
                          : selectedDomains.filter((item) => item !== site),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 wrap-anywhere text-sm">{site}</span>
                  {isStarkImportSite(site) ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Stark</span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      {listed.length > visibleCount ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Showing {visibleCount.toLocaleString()} of {listed.length.toLocaleString()} sites
          </p>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
          >
            Show more
          </Button>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground" htmlFor="browser-import-exact-site">
          Add a site that isn’t listed
        </label>
        <div className="flex items-start gap-2">
          <Input
            id="browser-import-exact-site"
            aria-label="Site domain"
            placeholder="pages.starkfuture.com"
            value={siteDraft}
            aria-invalid={siteError ? true : undefined}
            onChange={(event) => {
              setSiteDraft(event.target.value);
              setSiteError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addSite();
              }
            }}
          />
          <Button variant="subtle-outline" size="default" onClick={addSite}>
            Add site
          </Button>
        </div>
        {siteError ? (
          <p role="alert" className="text-xs text-destructive">
            {siteError}
          </p>
        ) : null}
      </div>
      <div className="space-y-3 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">
          {allSelected
            ? "All listed sites are selected, including personal sites. "
            : "Only selected sites will be copied. "}
          This copies sign-in cookies, not passwords, bookmarks or history. Some sites may still ask
          you to sign in.
        </p>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <Checkbox
            aria-label="Allow copying sign-ins for selected sites"
            checked={consent}
            onCheckedChange={(checked) => onConsentChange(checked === true)}
          />
          <span>
            {selectedDomains.length > 0
              ? `Copy sign-ins for these ${selectedDomains.length.toLocaleString()} ${selectedDomains.length === 1 ? "site" : "sites"} into my personal profile.`
              : "Allow copying sign-ins for the sites I select."}
          </span>
        </label>
        <p className="text-xs text-muted-foreground">
          Saved in Personal imported sessions. Agents cannot open this profile.
        </p>
      </div>
    </section>
  );
}
