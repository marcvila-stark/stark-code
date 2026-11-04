import type { StarkPublishedPagesReadResult } from "@starkfuture/contracts";
import { isOpenableStarkPageLink } from "@starkfuture/shared/starkPages";
import { decodePublishedPageText, pageRecord } from "./publishedPagesFields";

export interface PublishedProject {
  readonly root: string;
  readonly title: string;
  readonly url: string | null;
  readonly fileCount: number | null;
}

export interface PublishedPageEntry {
  readonly path: string;
  readonly title: string;
  readonly excerpt: string | null;
}

export interface PublishedLibraryPage extends PublishedPageEntry {
  readonly root: string;
  readonly projectTitle: string;
}

function resultValue(result: StarkPublishedPagesReadResult): unknown {
  if (result.isError) throw new Error("Pages could not complete this read. Try again.");
  if (result.structuredContent !== undefined) return result.structuredContent;
  for (const block of result.content) {
    const decoded = decodePublishedPageText(block.text);
    if (typeof decoded === "object" && decoded !== null) return decoded;
  }
  throw new Error("Pages returned a response this version cannot display.");
}

function publishedProjectTitle(root: string): string {
  return root.split("/").findLast(Boolean)?.replace(/[-_]+/g, " ") || root;
}

export function publishedProjectCatalog(result: StarkPublishedPagesReadResult): PublishedProject[] {
  const data = pageRecord(resultValue(result));
  if (!Array.isArray(data?.projects)) throw new Error("Pages did not return a project list.");
  const projects = new Map<string, PublishedProject>();
  for (const item of data.projects) {
    const project = pageRecord(item);
    if (typeof project?.root !== "string" || !project.root.trim()) continue;
    projects.set(project.root, {
      root: project.root,
      title: publishedProjectTitle(project.root),
      url: isOpenableStarkPageLink(project.base_url) ? project.base_url : null,
      fileCount:
        typeof project.file_count === "number" && Number.isFinite(project.file_count)
          ? project.file_count
          : null,
    });
  }
  return [...projects.values()];
}

export function publishedPageTitle(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const name = segments.at(-1) ?? path;
  return (/^index\.(html?|md)$/i.test(name) ? (segments.at(-2) ?? "Home") : name)
    .replace(/\.(?:html?|md|markdown)$/i, "")
    .replace(/[-_]+/g, " ");
}

export function publishedPagePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !/[\\?#]/.test(value) &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !value.split("/").some((segment) => segment === ".." || segment === ".") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value)
  );
}

export function publishedSearchResults(
  result: StarkPublishedPagesReadResult,
  root: string,
): PublishedPageEntry[] {
  const data = pageRecord(resultValue(result));
  if (!Array.isArray(data?.results)) throw new Error("Pages did not return search results.");
  const pages = new Map<string, PublishedPageEntry>();
  for (const item of data.results) {
    const hit = pageRecord(item);
    if (!hit || hit.root !== root || !publishedPagePath(hit.path)) continue;
    const excerpt = pageRecord(hit.excerpt);
    pages.set(hit.path, {
      path: hit.path,
      title:
        typeof excerpt?.title === "string" && excerpt.title.trim()
          ? excerpt.title
          : publishedPageTitle(hit.path),
      excerpt: typeof excerpt?.text === "string" && excerpt.text.trim() ? excerpt.text : null,
    });
  }
  return [...pages.values()];
}

function libraryProjectRoot(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}/\\]/u.test(value)
  );
}

function libraryPagePath(value: unknown): value is string {
  if (!publishedPagePath(value) || value.length > 2048) return false;
  try {
    const decoded = decodeURIComponent(value);
    return publishedPagePath(decoded) && !/[\p{Cc}\p{Cf}%:]/u.test(decoded);
  } catch {
    return false;
  }
}

/** Global search may return other roots; only the current account's catalog is navigable. */
export function publishedLibrarySearchResults(
  result: StarkPublishedPagesReadResult,
  projects: readonly PublishedProject[],
): PublishedLibraryPage[] {
  const data = pageRecord(resultValue(result));
  if (!Array.isArray(data?.results)) throw new Error("Pages did not return search results.");
  const allowedProjects = new Map(
    projects
      .filter((project) => libraryProjectRoot(project.root))
      .map((project) => [project.root, project]),
  );
  const pages = new Map<string, PublishedLibraryPage>();
  for (const item of data.results) {
    const hit = pageRecord(item);
    if (!hit || !libraryProjectRoot(hit.root) || !libraryPagePath(hit.path)) continue;
    const project = allowedProjects.get(hit.root);
    if (!project) continue;
    const excerpt = pageRecord(hit.excerpt);
    pages.set(JSON.stringify([hit.root, hit.path]), {
      root: hit.root,
      path: hit.path,
      projectTitle: project.title,
      title:
        typeof excerpt?.title === "string" && excerpt.title.trim()
          ? excerpt.title
          : publishedPageTitle(hit.path),
      excerpt: typeof excerpt?.text === "string" && excerpt.text.trim() ? excerpt.text : null,
    });
  }
  return [...pages.values()];
}
