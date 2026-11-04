import { EnvironmentId, ProjectId } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  historyEnvironmentIds,
  historyFilters,
  historyOriginLabel,
  historyRowActions,
  importResultSummary,
  nextHistorySearch,
  parseHistorySearch,
} from "./history.logic";

const now = new Date(2026, 9, 29, 15, 30).getTime();

describe("History URL", () => {
  it("restores filters from the URL and drops what it cannot read", () => {
    expect(
      parseHistorySearch({
        q: "  release notes ",
        status: "archived",
        origin: "agent-session",
        updated: "30d",
        provider: "claudeAgent",
        environmentId: "env-a",
        projectId: "project-a",
        import: "1",
      }),
    ).toEqual({
      q: "  release notes ",
      status: "archived",
      origin: "agent-session",
      updated: "30d",
      provider: "claudeAgent",
      environmentId: "env-a",
      projectId: "project-a",
      import: true,
    });
    // A folder without its environment is ambiguous; it is ignored.
    expect(
      parseHistorySearch({ status: "all", origin: "elsewhere", updated: 7, projectId: "p" }),
    ).toEqual({});
  });

  it("keeps a numeric search as text and drops ids that are not ids", () => {
    expect(parseHistorySearch({ q: 2026, provider: "not an id!" })).toEqual({ q: "2026" });
  });

  it("clears a filter from the URL and closes the import link once used", () => {
    const current = parseHistorySearch({
      q: "deploy",
      status: "archived",
      environmentId: "env-a",
      projectId: "project-a",
      import: "1",
    });
    const next = nextHistorySearch(current, { status: undefined, projectId: undefined });
    expect(next).toStrictEqual({ q: "deploy" });
    expect(nextHistorySearch(current, { origin: "agent-session" })).toStrictEqual({
      q: "deploy",
      status: "archived",
      origin: "agent-session",
      environmentId: "env-a",
      projectId: "project-a",
    });
  });

  it("asks for everything, archived threads included, by default", () => {
    expect(historyFilters({}, now)).toEqual({ archived: "include" });
  });

  it("turns filters into one stable request", () => {
    const filters = historyFilters(
      {
        q: "deploy",
        status: "active",
        origin: "v1",
        updated: "7d",
        provider: "codex" as never,
        environmentId: "env-a" as never,
        projectId: "project-a" as never,
      },
      now,
    );
    expect(filters).toEqual({
      query: "deploy",
      archived: "exclude",
      origins: ["v1"],
      providerInstanceIds: ["codex"],
      projectIds: ["project-a"],
      updatedAfter: new Date(2026, 9, 22).toISOString(),
    });
    // The same day gives the same request, so the result is reused.
    expect(historyFilters({ updated: "7d" }, now + 60_000)).toEqual(
      historyFilters({ updated: "7d" }, now),
    );
    expect(historyFilters({ q: "d" }, now)).toEqual({ archived: "include" });
    // The box keeps what was typed, a space before the next word included.
    expect(historyFilters({ q: " release " }, now)).toEqual({
      query: "release",
      archived: "include",
    });
    expect(historyFilters({ q: " d " }, now)).toEqual({ archived: "include" });
  });

  it("searches only the folder's environment when a folder is chosen", () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const folder = { environmentId: envB, projectId: ProjectId.make("project-b") };
    expect(historyEnvironmentIds({}, [envA, envB])).toEqual([envA, envB]);
    expect(historyEnvironmentIds(folder, [envA, envB])).toEqual([envB]);
    expect(historyEnvironmentIds(folder, [envA])).toEqual([]);
    // A lone environment id names no folder.
    expect(historyEnvironmentIds({ environmentId: envB }, [envA, envB])).toEqual([envA, envB]);
  });
});

describe("History rows", () => {
  it("offers the actions each kind of thread supports", () => {
    expect(
      historyRowActions({ archivedAt: null, origin: "agent-session" }, { providerReady: true }),
    ).toEqual(["continue", "open"]);
    // Without a ready provider, the imported session cannot be resumed.
    expect(
      historyRowActions({ archivedAt: null, origin: "agent-session" }, { providerReady: false }),
    ).toEqual(["open"]);
    expect(
      historyRowActions(
        { archivedAt: "2026-10-01T00:00:00.000Z", origin: "agent-session" },
        { providerReady: true },
      ),
    ).toEqual(["open", "unarchive"]);
    expect(
      historyRowActions({ archivedAt: null, origin: "stark" }, { providerReady: true }),
    ).toEqual(["open"]);
  });

  it("names where imported history came from", () => {
    expect(historyOriginLabel("agent-session", "claudeAgent")).toBe("Imported from Claude Code");
    expect(historyOriginLabel("agent-session", "codex")).toBe("Imported from Codex");
    expect(historyOriginLabel("agent-session", null)).toBe("Imported from a CLI");
    expect(historyOriginLabel("v1", null)).toBe("From Stark V1");
    expect(historyOriginLabel("stark", "codex")).toBeNull();
  });
});

describe("import summary", () => {
  it("counts only new sessions as imported", () => {
    expect(
      importResultSummary({ importedCount: 5, alreadyImportedCount: 3, skippedCount: 1 }),
    ).toEqual({
      title: "Imported 2 sessions",
      description: "3 sessions already imported · 1 session skipped",
    });
    expect(
      importResultSummary({ importedCount: 2, alreadyImportedCount: 2, skippedCount: 0 }),
    ).toEqual({ title: "No new sessions", description: "2 sessions already imported" });
  });

  it("names sessions Stark Code ran apart from imported ones", () => {
    expect(
      importResultSummary({
        importedCount: 1,
        alreadyImportedCount: 0,
        alreadyRunByStarkCount: 2,
        skippedCount: 0,
      }),
    ).toEqual({ title: "Imported 1 session", description: "2 sessions already in Stark Code" });
  });

  it("does not claim sessions are new when an older server cannot tell", () => {
    expect(importResultSummary({ importedCount: 4, skippedCount: 0 })).toEqual({
      title: "4 sessions in History",
      description: null,
    });
    expect(importResultSummary({ importedCount: 0, skippedCount: 2 })).toEqual({
      title: "No sessions to import",
      description: "2 sessions skipped",
    });
  });
});
