import {
  ArrowUpRightIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  ListChecksIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import styles from "./LocalPagesLibrary.module.css";

export interface LocalPageEntry {
  readonly slug: string;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly mtime: string;
}

export function localPagesFolderName(root: string) {
  return root.replaceAll("\\", "/").split("/").findLast(Boolean) ?? root;
}

function pageType(value: string) {
  const text = value.replaceAll("-", " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Page";
}

function editedDate(raw: string) {
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(timestamp);
}

export function LocalPagesLibrary({
  projectRoot,
  pages,
  loading,
  error,
  starting,
  onRefresh,
  onOpen,
}: {
  readonly projectRoot: string;
  readonly pages: readonly LocalPageEntry[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly starting: boolean;
  readonly onRefresh: () => void;
  readonly onOpen: (page: LocalPageEntry) => void;
}) {
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const filtered = pages.filter((page) =>
    `${page.title} ${page.slug} ${page.type}`.toLocaleLowerCase().includes(search),
  );
  const folder = localPagesFolderName(projectRoot);
  return (
    <section className={styles.library} aria-label="Local pages library">
      <div className={styles.content}>
        <header className={styles.heading}>
          <div>
            <h2>Local pages</h2>
            <p>Pages built on this Mac</p>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={loading || starting}
                  aria-label="Refresh local pages"
                  onClick={onRefresh}
                >
                  <RefreshCwIcon aria-hidden />
                </Button>
              }
            />
            <TooltipPopup>Refresh local pages</TooltipPopup>
          </Tooltip>
        </header>
        <div className={styles.folder}>
          <FolderIcon aria-hidden />
          <div>
            <span>Working folder</span>
            <strong>{folder}</strong>
            <p>{projectRoot}</p>
          </div>
        </div>
        <div className={styles.search}>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search local pages"
              placeholder="Search pages"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
        </div>
        {error ? (
          <div className={styles.empty}>
            <FileTextIcon aria-hidden />
            <h3>Pages are temporarily unavailable</h3>
            <p role="status">{error}</p>
            <Button size="sm" variant="outline" onClick={onRefresh}>
              Try again
            </Button>
          </div>
        ) : loading || starting ? (
          <div className={styles.loading} aria-busy="true">
            <p role="status">{starting ? "Starting Pages…" : "Looking for pages…"}</p>
            <div className={styles.grid} aria-hidden="true">
              {[0, 1, 2].map((key) => (
                <div className={styles.placeholder} key={key} />
              ))}
            </div>
          </div>
        ) : pages.length === 0 ? (
          <div className={styles.empty}>
            <FileTextIcon aria-hidden />
            <h3>Your first page starts in chat</h3>
            <p>
              Ask your agent to turn a report, decision or plan into a page. Pages saved in{" "}
              <strong>{folder}</strong> will appear here.
            </p>
            <div className={styles.example}>“Make a page from this report.”</div>
            <span>Local pages stay on this Mac until you choose to publish.</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className={styles.empty}>
            <SearchIcon aria-hidden />
            <h3>No matching pages</h3>
            <p>Try a different name or page type.</p>
            <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </div>
        ) : (
          <>
            <div className={styles.sectionHeading}>
              <h3>
                {search ? "Search results" : "Your pages"}
                <span>{filtered.length}</span>
              </h3>
              <span>Newest first</span>
            </div>
            <div className={styles.grid}>
              {filtered.map((page) => {
                const Icon =
                  page.type === "decision"
                    ? GitBranchIcon
                    : page.type === "plan"
                      ? ListChecksIcon
                      : FileTextIcon;
                const updated = editedDate(page.mtime);
                return (
                  <button
                    type="button"
                    key={page.slug}
                    className={styles.card}
                    onClick={() => onOpen(page)}
                    aria-label={`Open ${page.title || page.slug}`}
                  >
                    <div className={styles.cardTop}>
                      <span className={styles.icon}>
                        <Icon aria-hidden />
                      </span>
                      <span>{pageType(page.type)}</span>
                      {page.status === "draft" ? <span className={styles.draft}>Draft</span> : null}
                    </div>
                    <strong>{page.title || page.slug}</strong>
                    <div className={styles.cardBottom}>
                      <span>
                        {updated ? (
                          <>
                            Updated <time dateTime={page.mtime}>{updated}</time>
                          </>
                        ) : (
                          "Saved locally"
                        )}
                      </span>
                      <ArrowUpRightIcon aria-hidden />
                    </div>
                  </button>
                );
              })}
            </div>
            <p className={styles.footer}>Only pages in this working folder are shown.</p>
          </>
        )}
      </div>
    </section>
  );
}
