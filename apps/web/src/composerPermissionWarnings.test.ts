import { expect, it } from "vite-plus/test";
import {
  PROVIDER_PERMISSION_WARNING,
  activeComposerPermissionWarnings,
  permissionWarningForCatalogEntry,
} from "./composerPermissionWarnings";
it("does not invent a warning for skills without one; explicit warnings and plugin commands remain", () => {
  expect(
    permissionWarningForCatalogEntry({
      type: "skill",
      skill: { name: "deploy", path: "/skills/deploy/SKILL.md", enabled: true },
    }),
  ).toBeNull();
  expect(
    permissionWarningForCatalogEntry({
      type: "provider-slash-command",
      command: { name: "plugin:deploy", source: "plugin" },
    }),
  ).toBe(PROVIDER_PERMISSION_WARNING);
  expect(
    permissionWarningForCatalogEntry({
      type: "provider-slash-command",
      command: { name: "debug", source: "builtin", permissionWarning: PROVIDER_PERMISSION_WARNING },
    }),
  ).toBe(PROVIDER_PERMISSION_WARNING);
  expect(permissionWarningForCatalogEntry({ type: "slash-command" })).toBeNull();
});
it("removes legacy blanket notices for known skills but preserves provider warnings", () => {
  const entry = { reference: "$plain-english", warning: PROVIDER_PERMISSION_WARNING };
  const skill = { name: "plain-english", path: "/skills/plain/SKILL.md", enabled: true };
  expect(activeComposerPermissionWarnings("$plain-english Explain", [entry], [skill])).toEqual([]);
  expect(
    activeComposerPermissionWarnings(
      "$plain-english Explain",
      [entry],
      [{ ...skill, permissionWarning: PROVIDER_PERMISSION_WARNING }],
    ),
  ).toEqual([entry]);
});
it("keeps a warning while a selected reference is present, including arguments, without matching a different skill", () => {
  const entry = { reference: "$plugin:skill", warning: PROVIDER_PERMISSION_WARNING };
  expect(activeComposerPermissionWarnings("Use $plugin:skill for this", [entry])).toEqual([entry]);
  expect(activeComposerPermissionWarnings("$plugin:skill-other", [entry])).toEqual([]);
  expect(activeComposerPermissionWarnings("plain text", [entry])).toEqual([]);
});
