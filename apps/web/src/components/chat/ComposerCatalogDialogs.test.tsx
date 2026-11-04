// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ServerProviderSkill, ServerProviderSlashCommand } from "@starkfuture/contracts";

const state = vi.hoisted(() => ({ copy: vi.fn(), openExternal: vi.fn() }));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
import { ComposerSkillsDialog } from "./ComposerSkillsDialog";
import { ComposerSlashCommandsDialog } from "./ComposerSlashCommandsDialog";
import { PROVIDER_PERMISSION_WARNING } from "../../composerPermissionWarnings";
import { isInsideComposerFloatingLayer } from "./composerEventScope";

let root: Root;
let container: HTMLDivElement;
const selected = vi.fn<(skill: ServerProviderSkill) => boolean | void>();
const selectedCommand = vi.fn<(command: ServerProviderSlashCommand) => boolean | void>();
const close = vi.fn();
const skills: ServerProviderSkill[] = [
  {
    name: "ship",
    displayName: "Ship safely",
    path: "/plugins/release/SKILL.md",
    enabled: true,
    pluginName: "release-tools",
    permissionWarning: PROVIDER_PERMISSION_WARNING,
    description: "Review the release before publishing.",
  },
  { name: "private", path: "/skills/private/SKILL.md", enabled: true, userInvocable: false },
  { name: "disabled", path: "/skills/disabled/SKILL.md", enabled: false },
  {
    name: "test",
    path: "/skills/test/SKILL.md",
    enabled: true,
    scope: "project",
    permissionWarning: "Tests can write snapshots.",
  },
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.copy.mockReset().mockResolvedValue(undefined);
  state.openExternal.mockReset().mockResolvedValue(undefined);
  selected.mockReset();
  selectedCommand.mockReset();
  close.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (name: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === name,
  );
  if (!found) throw new Error(`Button missing: ${name}`);
  return found;
};
const click = (name: string) => act(() => button(name).click());
async function search(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Search missing: ${label}`);
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function renderSkills(providerKind = "claudeAgent", pending = false) {
  await act(() =>
    root.render(
      <ComposerSkillsDialog
        open
        onOpenChange={close}
        providerKind={providerKind}
        providerLabel={providerKind === "codex" ? "Codex" : "Claude"}
        skills={skills}
        isPending={pending}
        onSelect={selected}
      />,
    ),
  );
}

it("searches actual invocable skills by plugin and adds only the chosen skill to the draft", async () => {
  await renderSkills();
  expect(document.body.textContent).toContain(PROVIDER_PERMISSION_WARNING);
  expect(document.body.textContent).toContain("Tests can write snapshots.");
  expect(document.body.textContent).toContain("plugin manager");
  expect(document.body.textContent).not.toContain("private");
  expect(document.body.textContent).not.toContain("disabled");
  await search("Search skills", "release-tools");
  expect(document.querySelectorAll('[aria-label="Claude skills"] li')).toHaveLength(1);
  expect(document.body.textContent).toContain("Plugin · release-tools");
  expect(selected).not.toHaveBeenCalled();
  await click("Add Ship safely to draft");
  expect(selected).toHaveBeenCalledExactlyOnceWith(skills[0]);
  expect(close).toHaveBeenCalledWith(false);
  expect(state.copy).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("keeps the picker open if the draft rejects the skill and disables stale entries while loading", async () => {
  selected.mockReturnValue(false);
  await renderSkills();
  await click("Add Ship safely to draft");
  expect(close).not.toHaveBeenCalled();
  selected.mockClear();
  await renderSkills("claudeAgent", true);
  await click("Add Ship safely to draft");
  expect(selected).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Refreshing Claude");
});

it.each([
  ["claudeAgent", "/plugin", "https://code.claude.com/docs/en/discover-plugins"],
  [
    "codex",
    "/plugins",
    "https://learn.chatgpt.com/docs/developer-commands#browse-plugins-with-plugins",
  ],
])(
  "copies %s's native management command without invoking a skill or changing the draft",
  async (driver, command, docs) => {
    await renderSkills(driver);
    await click(`Copy ${command}`);
    expect(state.copy).toHaveBeenCalledExactlyOnceWith(command, "native plugin command");
    expect(document.body.textContent).toContain("It has not been run.");
    expect(document.body.textContent).toContain("Shell mode");
    expect(selected).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await click("Plugin guide");
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(docs);
  },
);

it("reports clipboard failure without claiming success", async () => {
  state.copy.mockRejectedValue(new Error("denied"));
  await renderSkills();
  await click("Copy /plugin");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not copy");
  expect(document.body.textContent).not.toContain("It has not been run.");
  expect(selected).not.toHaveBeenCalled();
});

it("searches command aliases, shows arguments and warnings, and inserts without executing", async () => {
  const commands: ServerProviderSlashCommand[] = [
    {
      name: "deploy",
      source: "plugin",
      sourceName: "release-tools",
      description: "Deploy a build",
      aliases: ["ship"],
      input: { hint: "environment" },
    },
    { name: "status", source: "builtin", description: "Inspect status" },
    { name: "logout", source: "builtin", description: "Sign out" },
    ...[
      "plugin",
      "plugins",
      "apps",
      "mcp",
      "reload-plugins",
      "clear",
      "resume",
      "exit",
      "rewind",
    ].map((name) => ({ name })),
  ];
  await act(() =>
    root.render(
      <ComposerSlashCommandsDialog
        open
        onOpenChange={close}
        providerLabel="Claude"
        commands={commands}
        isPending={false}
        onSelect={selectedCommand}
      />,
    ),
  );
  expect(document.body.textContent).not.toContain("/logout");
  expect(document.querySelectorAll('[aria-label="Claude commands"] li')).toHaveLength(2);
  await search("Search slash commands", "/ship");
  expect(document.querySelectorAll('[aria-label="Claude commands"] li')).toHaveLength(1);
  expect(document.body.textContent).toContain("Arguments: environment");
  expect(document.body.textContent).toContain(PROVIDER_PERMISSION_WARNING);
  expect(selectedCommand).not.toHaveBeenCalled();
  await click("Add /deploy to draft");
  expect(selectedCommand).toHaveBeenCalledOnce();
  expect(selectedCommand.mock.calls[0]?.[0].name).toBe("deploy");
  expect(close).toHaveBeenCalledWith(false);
  expect(state.copy).not.toHaveBeenCalled();
});

it("shows a usable empty state and changes the catalog when the provider changes", async () => {
  await act(() =>
    root.render(
      <ComposerSlashCommandsDialog
        open
        onOpenChange={close}
        providerLabel="Claude"
        commands={[{ name: "deploy" }]}
        isPending={false}
        onSelect={selectedCommand}
      />,
    ),
  );
  await search("Search slash commands", "missing");
  expect(document.body.textContent).toContain("No matching commands.");
  await act(() =>
    root.render(
      <ComposerSlashCommandsDialog
        open
        onOpenChange={close}
        providerLabel="Codex"
        commands={[{ name: "review" }]}
        isPending={false}
        onSelect={selectedCommand}
      />,
    ),
  );
  expect(button("Add /review to draft")).toBeDefined();
  expect(document.body.textContent).not.toContain("/deploy");
});

it("distinguishes app controls from provider command insertion", async () => {
  await act(() =>
    root.render(
      <ComposerSlashCommandsDialog
        open
        onOpenChange={close}
        providerLabel="Codex"
        commands={[
          { name: "model", source: "app" },
          { name: "review", source: "builtin" },
        ]}
        isPending={false}
        onSelect={selectedCommand}
      />,
    ),
  );
  expect(button("Use /model").textContent).toBe("Use");
  expect(button("Add /review to draft").textContent).toBe("Add to draft");
  expect(document.body.textContent).toContain("Change this chat's settings");
  await click("Use /model");
  expect(selectedCommand.mock.calls[0]?.[0]).toMatchObject({ name: "model", source: "app" });
});

it.each(["skills", "commands"])(
  "contains %s dialog Enter events without blocking its action buttons",
  async (kind) => {
    const parentKeyDown = vi.fn();
    const parentSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    await act(() =>
      root.render(
        <form onKeyDown={parentKeyDown} onSubmit={parentSubmit}>
          {kind === "skills" ? (
            <ComposerSkillsDialog
              open
              onOpenChange={close}
              providerKind="claudeAgent"
              providerLabel="Claude"
              skills={skills}
              isPending={false}
              onSelect={selected}
            />
          ) : (
            <ComposerSlashCommandsDialog
              open
              onOpenChange={close}
              providerLabel="Claude"
              commands={[{ name: "deploy" }]}
              isPending={false}
              onSelect={selectedCommand}
            />
          )}
        </form>,
      ),
    );
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(isInsideComposerFloatingLayer(input)).toBe(true);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(() => input.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(parentSubmit).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    expect(selectedCommand).not.toHaveBeenCalled();

    const action = button(kind === "skills" ? "Add Ship safely to draft" : "Add /deploy to draft");
    const buttonEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(() => action.dispatchEvent(buttonEnter));
    expect(buttonEnter.defaultPrevented).toBe(false);
    expect(parentKeyDown).not.toHaveBeenCalled();
    await act(() => action.click());
    expect(kind === "skills" ? selected : selectedCommand).toHaveBeenCalledOnce();
    expect(parentSubmit).not.toHaveBeenCalled();
  },
);
