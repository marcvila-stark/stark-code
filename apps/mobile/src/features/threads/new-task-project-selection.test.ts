import { EnvironmentId, ProjectId } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@starkfuture/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  filterProjectScopes,
  getProjectScopeSelectionTarget,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
} from "./new-task-project-selection";

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/starkfuture/starkcode",
    title: "Stark Code",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
  };
}

describe("getProjectScopeSelectionTarget", () => {
  it("keeps the current environment when it hosts the selected logical project", () => {
    const projects = [
      makeProject("starkcode-mac", "mac"),
      makeProject("starkcode-server", "server"),
    ];
    expect(getProjectScopeSelectionTarget(makeScope(projects), EnvironmentId.make("server"))).toBe(
      projects[1],
    );
  });

  it("falls back to the representative when the current environment does not host the project", () => {
    const projects = [
      makeProject("starkcode-mac", "mac"),
      makeProject("starkcode-server", "server"),
    ];
    expect(getProjectScopeSelectionTarget(makeScope(projects), EnvironmentId.make("other"))).toBe(
      projects[0],
    );
  });
});

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("starkcode", "mac", {
      repositoryKey: "github.com/starkfuture/starkcode",
    });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/starkfuture/other" }),
      makeProject("starkcode-clone", "server", {
        repositoryKey: "github.com/starkfuture/starkcode",
      }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("starkcode", "mac", { workspaceRoot: "/Users/me/starkcode" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/starkcode" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "starkcode" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("starkcode", "mac", {
      repositoryKey: "github.com/starkfuture/starkcode",
      workspaceRoot: "/Users/me/starkcode",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/starkcode",
      title: "starkcode",
      workspaceRoot: "/home/me/starkcode",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/starkcode" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    // Without any weaker match the fork is still the first-project fallback.
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });

  it("falls back to the first project on the target so the draft has a key to carry over to", () => {
    const selected = makeProject("starkcode", "mac", {
      repositoryKey: "github.com/starkfuture/starkcode",
    });
    const target = [makeProject("unrelated", "server"), makeProject("also-unrelated", "server")];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[0]);
    expect(resolveEnvironmentProjectMatch([], selected)).toBeNull();
  });
});

describe("resolveDraftProjectSelection", () => {
  it("preserves an explicit project selection", () => {
    const project = makeProject("starkcode");
    expect(
      resolveDraftProjectSelection("environment:starkcode", [project], [makeScope([project])]),
    ).toEqual({ kind: "preserve" });
  });

  it("selects the only physical project when no project was explicitly selected", () => {
    const project = makeProject("starkcode");
    expect(resolveDraftProjectSelection(null, [project], [makeScope([project])])).toEqual({
      kind: "select",
      project,
    });
  });

  it("selects one logical project even when it has multiple physical workspaces", () => {
    const projects = [
      makeProject("starkcode"),
      makeProject("starkcode-2"),
      makeProject("starkcode-3"),
    ];
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)])).toEqual({
      kind: "select",
      project: projects[0],
    });
  });

  it("does not preserve a project key that is missing from the catalog", () => {
    const project = makeProject("starkcode");
    expect(
      resolveDraftProjectSelection("environment:removed", [project], [makeScope([project])]),
    ).toEqual({
      kind: "select",
      project,
    });
  });
});

describe("filterProjectScopes", () => {
  const mac = makeProject("code", "mac", { title: "Desktop checkout" });
  const server = makeProject("remote-code", "server", { workspaceRoot: "/srv/remote-workspace" });
  const code = makeScope([mac, server]);
  const docs = { ...makeScope([makeProject("docs")]), key: "docs", title: "Documentation" };
  const scopes = [code, docs];

  it("keeps all projects for an empty or whitespace-only query", () => {
    expect(filterProjectScopes(scopes, "")).toBe(scopes);
    expect(filterProjectScopes(scopes, "  ")).toBe(scopes);
  });

  it("matches logical names and workspace names or paths without case sensitivity", () => {
    expect(filterProjectScopes(scopes, "  Stark CODE ")).toEqual([code]);
    expect(filterProjectScopes(scopes, "DESKTOP")).toEqual([code]);
    expect(filterProjectScopes(scopes, "REMOTE-WORKSPACE")).toEqual([code]);
    expect(filterProjectScopes(scopes, "documentation")).toEqual([docs]);
    expect(filterProjectScopes(scopes, "missing-project")).toEqual([]);
  });

  it("preserves the whole logical project and preferred environment when a workspace matches", () => {
    const matches = filterProjectScopes(scopes, "REMOTE-WORKSPACE");
    expect(matches[0]).toBe(code);
    expect(getProjectScopeSelectionTarget(matches[0]!, EnvironmentId.make("mac"))).toBe(mac);
    expect(code.projects).toEqual([mac, server]);
  });
});
