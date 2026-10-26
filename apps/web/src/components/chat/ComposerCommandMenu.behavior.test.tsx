import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@starkfuture/contracts";
vi.mock("../ui/command", () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => (
    <span role="tooltip">{children}</span>
  ),
}));
vi.mock("./ComposerBanner", () => ({
  ComposerBanner: {
    Surface: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}));
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { composerCommandInsertion } from "./composerSessionCatalog";
import { PROVIDER_PERMISSION_WARNING } from "../../composerPermissionWarnings";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("shows Plugin and MCP source badges and a fallback footer, then only inserts on a pick", async () => {
  const insert = vi.fn();
  const send = vi.fn();
  const provider = ProviderDriverKind.make("claudeAgent");
  const plugin = {
    id: "plugin",
    type: "skill",
    provider,
    skill: {
      name: "deploy:ship",
      path: "/plugins/deploy/skills/ship/SKILL.md",
      enabled: true,
      pluginName: "deploy",
    },
    label: "/deploy:ship",
    description: "Ship the app",
  } satisfies ComposerCommandItem;
  const mcp = {
    id: "mcp",
    type: "provider-slash-command",
    provider,
    command: { name: "drive:search", source: "mcp", sourceName: "Drive" },
    label: "/drive:search",
    description: "Search docs",
  } satisfies ComposerCommandItem;
  const render = (live: boolean) => (
    <ComposerCommandMenu
      listId="catalog"
      items={[plugin, mcp]}
      resolvedTheme="dark"
      isLoading={false}
      triggerKind="slash-command"
      footerText={live ? undefined : "More commands appear once the session starts"}
      activeItemId={null}
      onHighlightedItemChange={() => {}}
      onSelect={(item) => {
        if (item.type === "skill" || item.type === "provider-slash-command")
          insert(composerCommandInsertion(item, "slash-command"));
      }}
    />
  );
  await act(async () => {
    renderer = create(render(false));
  });
  expect(
    renderer!.root.findAllByProps({ role: "tooltip" }).map((node) => node.children.join("")),
  ).toEqual([PROVIDER_PERMISSION_WARNING, "Plugin deploy", "MCP Drive"]);
  expect(
    renderer!.root
      .findAllByType("span")
      .some((node) => node.children.join("") === "May run tools without a Stark approval prompt."),
  ).toBe(true);
  expect(renderer!.root.findByType("p").children.join("")).toContain("More commands");
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  expect(insert).toHaveBeenCalledWith("/deploy:ship ");
  expect(send).not.toHaveBeenCalled();
  await act(async () => renderer!.update(render(true)));
  expect(renderer!.root.findAllByType("p")).toHaveLength(0);
});
