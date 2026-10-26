import { expect, it } from "vite-plus/test";
import {
  publishedLibrarySearchResults,
  publishedPagePath,
  publishedPageTitle,
  publishedProjectCatalog,
  publishedSearchResults,
  type PublishedProject,
} from "./publishedPagesNavigation";
import type { StarkPublishedPagesReadResult } from "@starkfuture/contracts";
const response = (
  structuredContent: StarkPublishedPagesReadResult["structuredContent"],
): StarkPublishedPagesReadResult => ({ content: [], isError: false, structuredContent });

it("uses the observed project envelope, ignores malformed entries and deduplicates roots", () => {
  expect(
    publishedProjectCatalog(
      response({
        projects: [
          {
            root: "org/design-kit",
            file_count: 2,
            base_url: "https://pages.starkfuture.com/design/",
          },
          { root: 42 },
          { root: "org/design-kit", file_count: 3, base_url: "javascript:alert(1)" },
        ],
      }),
    ),
  ).toEqual([{ root: "org/design-kit", title: "design kit", fileCount: 3, url: null }]);
  expect(
    publishedProjectCatalog({
      content: [{ type: "text", text: '{"projects":[]}' }],
      isError: false,
    }),
  ).toEqual([]);
  expect(() => publishedProjectCatalog(response({ pages: [] }))).toThrow("project list");
  expect(() => publishedProjectCatalog({ ...response({ projects: [] }), isError: true })).toThrow(
    "could not complete",
  );
});

it("keeps scoped result titles and snippets while excluding other projects and unsafe paths", () => {
  expect(
    publishedSearchResults(
      response({
        results: [
          {
            root: "team",
            path: "launch/index.html",
            excerpt: { title: "Launch plan", text: "Project schedule" },
          },
          { root: "other", path: "private/index.html", excerpt: { title: "Other project" } },
          { root: "team", path: "../private/index.html" },
          { root: "team", path: "release-notes.html", excerpt: null },
        ],
      }),
      "team",
    ),
  ).toEqual([
    { path: "launch/index.html", title: "Launch plan", excerpt: "Project schedule" },
    { path: "release-notes.html", title: "release notes", excerpt: null },
  ]);
  expect(publishedSearchResults(response({ results: [] }), "team")).toEqual([]);
  expect(() => publishedSearchResults(response({ hits: [] }), "team")).toThrow("search results");
});

it("derives page names without treating arbitrary URLs or traversal as page paths", () => {
  expect(publishedPageTitle("index.html")).toBe("Home");
  expect(publishedPageTitle("my-page/index.html")).toBe("my page");
  expect(publishedPageTitle("notes/read-me.md")).toBe("read me");
  for (const path of [
    "/root.html",
    "../index.html",
    "x/../index.html",
    "https://example.com",
    "file:///a",
    "x\\index.html",
    "page.html?secret=1",
    "page.html#section",
  ])
    expect(publishedPagePath(path)).toBe(false);
  expect(publishedPagePath("project/page.html")).toBe(true);
});

const libraryProjects: readonly PublishedProject[] = [
  { root: "team-design", title: "Design", url: null, fileCount: 20 },
  { root: "team-launch", title: "Launch", url: null, fileCount: 12 },
];

it("keeps global results from allowed collections distinct when paths match", () => {
  expect(
    publishedLibrarySearchResults(
      response({
        results: [
          {
            root: "team-design",
            path: "notes/index.html",
            excerpt: { title: "Earlier title", text: "Earlier excerpt" },
          },
          {
            root: "team-launch",
            path: "notes/index.html",
            excerpt: { title: "Launch notes", text: "Owners and dates" },
          },
          {
            root: "team-design",
            path: "notes/index.html",
            excerpt: { title: "Design notes", text: "Ready for review" },
          },
          { root: "team-design", path: "release-notes.md", excerpt: { title: " ", text: " " } },
          { root: "other-team", path: "private.html", excerpt: { title: "Not in this catalog" } },
        ],
      }),
      libraryProjects,
    ),
  ).toEqual([
    {
      root: "team-design",
      path: "notes/index.html",
      projectTitle: "Design",
      title: "Design notes",
      excerpt: "Ready for review",
    },
    {
      root: "team-launch",
      path: "notes/index.html",
      projectTitle: "Launch",
      title: "Launch notes",
      excerpt: "Owners and dates",
    },
    {
      root: "team-design",
      path: "release-notes.md",
      projectTitle: "Design",
      title: "release notes",
      excerpt: null,
    },
  ]);
});

it("rejects malformed global roots and unsafe paths even if the catalog contains them", () => {
  const invalidRoots = [
    "",
    " ",
    " padded ",
    "team/design",
    "team\\design",
    "team\u0000",
    "team\u202e",
    "x".repeat(201),
  ];
  const invalidPaths = [
    "../index.html",
    "/index.html",
    "x\\index.html",
    "https://example.com/index.html",
    "page.html?secret=1",
    "page.html#section",
    "%2e%2e/index.html",
    "%252e%252e/index.html",
    "notes/%2e%2e/index.html",
    "notes/%00index.html",
    "notes/%E2%80%AEindex.html",
    "notes/%zz.html",
    "notes/file:secret",
    "x".repeat(2049),
  ];
  expect(
    publishedLibrarySearchResults(
      response({
        results: [
          null,
          { root: 42, path: "index.html" },
          { root: "team-design", path: 42 },
          ...invalidRoots.map((root) => ({ root, path: "index.html" })),
          ...invalidPaths.map((path) => ({ root: "team-design", path })),
          { root: "team-design", path: "roadmap/index.html" },
        ],
      }),
      [
        ...libraryProjects,
        ...invalidRoots.map((root) => ({ root, title: "Invalid", fileCount: null, url: null })),
      ],
    ),
  ).toEqual([
    {
      root: "team-design",
      path: "roadmap/index.html",
      projectTitle: "Design",
      title: "roadmap",
      excerpt: null,
    },
  ]);
});

it("requires a successful global-search envelope and does not surface results without a catalog", () => {
  const result = response({ results: [{ root: "team-design", path: "index.html" }] });
  expect(publishedLibrarySearchResults(result, [])).toEqual([]);
  expect(publishedLibrarySearchResults(response({ results: [] }), libraryProjects)).toEqual([]);
  expect(() => publishedLibrarySearchResults(response({ hits: [] }), libraryProjects)).toThrow(
    "search results",
  );
  expect(() =>
    publishedLibrarySearchResults({ ...result, isError: true }, libraryProjects),
  ).toThrow("could not complete");
  expect(
    publishedLibrarySearchResults(
      { content: [{ type: "text", text: '{"results":[]}' }], isError: false },
      libraryProjects,
    ),
  ).toEqual([]);
});
