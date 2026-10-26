import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import { PublishedPageCover } from "./PublishedPageCover";
import {
  publishedLibrarySearchResults,
  type PublishedLibraryPage,
  type PublishedProject,
} from "./publishedPagesNavigation";
import styles from "./PublishedPagesLibrary.module.css";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

const PAGE_SIZE = 12;

/** A bounded gallery: only visible covers load, and search runs on explicit submit. */
export function PublishedPagesLibrary({
  projects,
  busy,
  active,
  canSearch,
  onBrowse,
  onOpen,
}: {
  projects: readonly PublishedProject[];
  busy: boolean;
  active: boolean;
  canSearch: boolean;
  onBrowse: (project: PublishedProject) => void;
  onOpen: (page: PublishedLibraryPage) => void;
}) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ query: string; pages: PublishedLibraryPage[] } | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const filtered = projects.filter((project) =>
    `${project.title} ${project.root}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const start = Math.min(
    offset,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1) * PAGE_SIZE,
  );
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const search = async () => {
    const term = query.trim();
    const bridge = window.desktopBridge?.publishedPages;
    if (!bridge || !canSearch || term.length < 2 || term.length > 200 || searching) return;
    const request = ++generation.current;
    setSearching(true);
    setError(null);
    try {
      const answer = await bridge.read({
        tool: "pages_search",
        arguments: { query: term, limit: 20 },
      });
      if (request === generation.current)
        setResult({ query: term, pages: publishedLibrarySearchResults(answer, projects) });
    } catch {
      if (request === generation.current) setError("Couldn’t search Pages. Try again.");
    } finally {
      if (request === generation.current) setSearching(false);
    }
  };
  const changeQuery = (value: string) => {
    generation.current += 1;
    setQuery(value);
    setOffset(0);
    setResult(null);
    setSearching(false);
    setError(null);
  };
  const paginate = (next: number) => {
    setOffset(next);
    heading.current?.scrollIntoView({ block: "start" });
    heading.current?.focus({ preventScroll: true });
  };

  return (
    <div className={styles["pages-library"]}>
      <header className={styles["pages-library-intro"]}>
        <h2>Your library</h2>
        <p>Explore your team’s pages. Keep them beside your work.</p>
      </header>
      {projects.length > 0 ? (
        <form
          className={styles["pages-library-search"]}
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <SearchIcon aria-hidden size={17} />
          <input
            aria-label="Search pages and projects"
            placeholder={canSearch ? "Find a page, project or topic…" : "Find a project…"}
            value={query}
            maxLength={200}
            onChange={(event) => changeQuery(event.target.value)}
          />
          {query ? (
            <button type="button" aria-label="Clear Pages search" onClick={() => changeQuery("")}>
              <XIcon aria-hidden size={15} />
            </button>
          ) : null}
          {canSearch ? (
            <button
              type="submit"
              aria-label="Search all pages"
              disabled={searching || query.trim().length < 2}
            >
              <ArrowRightIcon aria-hidden size={18} />
            </button>
          ) : null}
        </form>
      ) : null}
      {searching ? (
        <p role="status" className={styles["pages-library-note"]}>
          Searching across Company pages…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className={styles["pages-library-note"]}>
          {error}{" "}
          <button type="button" onClick={() => void search()}>
            Retry search
          </button>
        </div>
      ) : null}
      {result ? (
        <div className={styles["pages-library-results"]}>
          <h3>
            Pages matching “{result.query}” <span>{result.pages.length}</span>
          </h3>
          {result.pages.length ? (
            <ul className={styles["pages-result-list"]} aria-label="Page search results">
              {result.pages.map((page) => (
                <li key={JSON.stringify([page.root, page.path])}>
                  <button
                    type="button"
                    className={styles["pages-result-card"]}
                    onClick={() => onOpen(page)}
                  >
                    <span className={styles["pages-result-collection"]}>{page.projectTitle}</span>
                    <strong>{page.title}</strong>
                    {page.excerpt ? (
                      <span className={styles["pages-result-excerpt"]}>{page.excerpt}</span>
                    ) : null}
                    <span className={styles["pages-result-open"]}>
                      Open page <ArrowRightIcon aria-hidden size={14} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles["pages-library-note"]}>
              No pages found. Try a different title or topic.
            </p>
          )}
          {result.pages.length === 20 ? (
            <p className={styles["pages-library-note"]}>
              Showing the first 20 results. Narrow your search to find more.
            </p>
          ) : null}
        </div>
      ) : query.trim().length >= 2 && canSearch ? (
        <button
          className={styles["pages-search-content"]}
          type="button"
          onClick={() => void search()}
          disabled={searching}
        >
          Search inside all pages for “{query.trim()}” <ArrowRightIcon aria-hidden size={14} />
        </button>
      ) : null}
      <div className={styles["pages-library-section-heading"]}>
        <h3 ref={heading} tabIndex={-1}>
          {query ? "Matching projects" : "Browse projects"} <span>{filtered.length}</span>
        </h3>
        <span>Open a page to read in full</span>
      </div>
      {busy ? (
        <p role="status" className={styles["pages-library-note"]}>
          Loading your library…
        </p>
      ) : visible.length ? (
        <ul className={styles["pages-library-grid"]} aria-label="Published projects">
          {visible.map((project) => (
            <li key={project.root} className={styles["pages-project-card"]}>
              <button
                type="button"
                className={styles["pages-project-open"]}
                aria-label={`Open ${project.title}`}
                onClick={() =>
                  onOpen({
                    root: project.root,
                    path: "index.html",
                    title: project.title,
                    projectTitle: project.title,
                    excerpt: null,
                  })
                }
              >
                <PublishedPageCover
                  root={project.root}
                  title={project.title}
                  enabled={active && !query.trim() && !searching && project.fileCount !== 0}
                />
                <span className={styles["pages-project-title"]}>{project.title}</span>
              </button>
              <div className={styles["pages-project-meta"]}>
                <span>{project.fileCount === 0 ? "No published files" : "Company page"}</span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`Search in ${project.title}`}
                        onClick={() => onBrowse(project)}
                      >
                        <SearchIcon aria-hidden size={14} />
                      </button>
                    }
                  />
                  <TooltipPopup positionMethod="fixed">Search in this project</TooltipPopup>
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles["pages-library-note"]}>
          {query
            ? "No projects match your search."
            : "No published projects are available for this account yet."}
        </p>
      )}
      {filtered.length > PAGE_SIZE ? (
        <nav className={styles["pages-library-pagination"]} aria-label="Library pages">
          <span>
            {start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div>
            <button
              type="button"
              aria-label="Previous projects"
              disabled={start === 0}
              onClick={() => paginate(Math.max(0, start - PAGE_SIZE))}
            >
              <ChevronLeftIcon aria-hidden size={17} />
            </button>
            <button
              type="button"
              aria-label="Next projects"
              disabled={start + PAGE_SIZE >= filtered.length}
              onClick={() => paginate(start + PAGE_SIZE)}
            >
              <ChevronRightIcon aria-hidden size={17} />
            </button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}
