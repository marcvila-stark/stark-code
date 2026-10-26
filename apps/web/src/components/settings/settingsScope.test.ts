import { EnvironmentId, ProjectId } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { resolveSettingsScope, validateSettingsScopeSearch } from "./settingsScope";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "Laptop" },
  { environmentId: serverId, label: "Server" },
];

function member(id: string, environmentId: EnvironmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "Stark Code",
    workspaceRoot: `/repos/${id}`,
    physicalProjectKey: `${environmentId}:/repos/${id}`,
    environmentLabel:
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const first = member("first", laptopId);
const second = member("second", laptopId);
const third = member("third", serverId);
const other = member("other", serverId);

function group(
  projectKey: string,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey,
    displayName: projectKey,
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
  };
}

const groups = [group("starkcode", [first, second, third]), group("other", [other])];

describe("settings scope search", () => {
  it("ignores the retired scope key from older links", () => {
    expect(validateSettingsScopeSearch({ scope: "device", project: "starkcode" })).toEqual({
      project: "starkcode",
    });
    expect(validateSettingsScopeSearch({ scope: "all" })).toEqual({});
  });

  it("retains legacy project and machine links without inventing an explicit broad scope", () => {
    expect(
      validateSettingsScopeSearch({ project: "starkcode", machine: laptopId, unused: true }),
    ).toEqual({
      project: "starkcode",
      machine: laptopId,
    });
  });

  it("retains an orphan checkout so it cannot turn into all environments", () => {
    const search = validateSettingsScopeSearch({ checkout: first.physicalProjectKey });
    expect(search).toEqual({ checkout: first.physicalProjectKey });
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      reason: "project-required",
      members: [],
      environmentIds: [],
    });
  });
});

describe("settings scope resolution", () => {
  it("defaults to every environment with no project", () => {
    expect(resolveSettingsScope({}, groups, environments)).toMatchObject({
      kind: "all",
      members: [],
      environmentIds: [laptopId, serverId],
    });
  });

  it("resolves one environment without targeting its project overrides", () => {
    expect(resolveSettingsScope({ machine: serverId }, groups, environments)).toMatchObject({
      kind: "environment",
      environmentId: serverId,
      environmentIds: [serverId],
      members: [],
    });
  });

  it("keeps all physical members in a project aggregate, including several on one environment", () => {
    expect(resolveSettingsScope({ project: "starkcode" }, groups, environments)).toMatchObject({
      kind: "project",
      environmentId: null,
      members: [first, second, third],
      environmentIds: [laptopId, serverId],
    });
  });

  it("preserves legacy project plus machine aggregates with multiple checkouts", () => {
    expect(
      resolveSettingsScope({ project: "starkcode", machine: laptopId }, groups, environments),
    ).toMatchObject({
      kind: "project",
      environmentId: laptopId,
      label: "starkcode / Laptop",
      members: [first, second],
      environmentIds: [laptopId],
    });
  });

  it("narrows a checkout target to exactly one member, deriving its environment when omitted", () => {
    expect(
      resolveSettingsScope(
        { project: "starkcode", checkout: second.physicalProjectKey },
        groups,
        environments,
      ),
    ).toMatchObject({
      kind: "checkout",
      checkout: second,
      environmentId: laptopId,
      label: "starkcode / Laptop · /repos/second",
      members: [second],
      environmentIds: [laptopId],
    });
  });

  it.each([
    { project: "missing" },
    { machine: "removed" },
    { project: "starkcode", machine: "removed" },
    { project: "starkcode", checkout: "deleted" },
    { project: "other", machine: laptopId },
    { project: "other", checkout: first.physicalProjectKey },
    { project: "starkcode", machine: serverId, checkout: first.physicalProjectKey },
  ])("never widens an invalid or stale target: %j", (search) => {
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
    });
  });

  it("leaves a removed checkout unavailable while sibling checkouts remain", () => {
    const search = {
      project: "starkcode",
      machine: laptopId,
      checkout: first.physicalProjectKey,
    };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "checkout",
      members: [first],
    });
    expect(
      resolveSettingsScope(search, [group("starkcode", [second, third])], environments),
    ).toMatchObject({ kind: "unavailable", members: [], environmentIds: [] });
  });

  it("does not select another environment after removing a project's last local checkout", () => {
    const search = { project: "starkcode", machine: laptopId };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "project",
      members: [first, second],
    });
    expect(resolveSettingsScope(search, [group("starkcode", [third])], environments)).toMatchObject(
      {
        kind: "unavailable",
        members: [],
        environmentIds: [],
      },
    );
  });

  it("rejects a cached checkout whose environment was removed", () => {
    expect(
      resolveSettingsScope(
        { project: "starkcode", checkout: third.physicalProjectKey },
        groups,
        environments.slice(0, 1),
      ),
    ).toMatchObject({
      kind: "unavailable",
      reason: "environment-missing",
      members: [],
      environmentIds: [],
    });
  });
});
