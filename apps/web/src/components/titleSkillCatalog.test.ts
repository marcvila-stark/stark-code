// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@starkfuture/contracts";
import { rememberTitleSkills } from "./titleSkillCatalog";
import { resolveChatDisplayTitle } from "./composerDraftTitle";
const instanceId = ProviderInstanceId.make("codex");
const skill = (name: string) => ({ name, path: `/skills/${name}`, enabled: true });
const provider = {
  instanceId,
  skills: [skill("plain-english")],
  workspaceSnapshots: [
    {
      cwd: "/work",
      checkedAt: "2026-10-27T00:00:00Z",
      slashCommands: [],
      skills: [skill("project-audit")],
    },
  ],
};
const title = (value: string, environmentId = "local", cwd = "/work") =>
  resolveChatDisplayTitle({
    title: value,
    environmentId,
    cwd,
    providerInstanceId: instanceId,
    providers: [],
  });
beforeEach(() => localStorage.clear());
describe("remembered display-only skill metadata", () => {
  it("keeps known skill titles readable after the live catalog disappears", () => {
    rememberTitleSkills("local", [provider]);
    expect(title("$plain-english /project-audit Explain this")).toBe("Explain this");
    expect(localStorage.getItem("starkcode:title-skill-catalog:v1")).not.toContain("/skills/");
    expect(title("$new-skill Explain this")).toBe("$new-skill Explain this");
  });
  it("never applies another computer, provider or folder's skill metadata", () => {
    rememberTitleSkills("local", [provider]);
    expect(title("$plain-english Explain", "remote")).toBe("$plain-english Explain");
    expect(title("$project-audit Explain", "local", "/other")).toBe("$project-audit Explain");
    expect(
      resolveChatDisplayTitle({
        title: "$plain-english Explain",
        environmentId: "local",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providers: [],
      }),
    ).toBe("$plain-english Explain");
  });
  it("preserves literals and doesn't rewrite the saved input", () => {
    rememberTitleSkills("local", [provider]);
    for (const value of ["$HOME/file", "$50 budget", "Use $plain-english here"])
      expect(title(value)).toBe(value);
    expect(
      resolveChatDisplayTitle({
        title: "$plain-english command",
        literal: true,
        environmentId: "local",
        providerInstanceId: instanceId,
        providers: [],
      }),
    ).toBe("$plain-english command");
  });
});
