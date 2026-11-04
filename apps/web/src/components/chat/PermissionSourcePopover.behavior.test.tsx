import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type EffectivePermissions,
} from "@starkfuture/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) => (
    <render.type {...(render.props as object)}>{children}</render.type>
  ),
  PopoverPopup: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) => (
    <render.type {...(render.props as object)}>{children}</render.type>
  ),
  TooltipPopup: ({ children }: { children: ReactNode }) => <aside role="tooltip">{children}</aside>,
}));
vi.mock("./composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("./useComposerMenuState", () => ({ useComposerMenuState: () => [true, () => {}] }));
import { PermissionSourcePopover } from "./PermissionSourcePopover";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");

const permissions = (source: "inherit" | "override"): EffectivePermissions => ({
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  cwd: null,
  providerSessionId: null,
  requested: { permissionSource: source, preset: "approval-required", interactionMode: "default" },
  active: null,
  configured: null,
  rows: [],
});

const render = async (props: Partial<Parameters<typeof PermissionSourcePopover>[0]>) => {
  await act(async () => {
    renderer = create(
      <PermissionSourcePopover
        permissions={permissions("inherit")}
        runActive={false}
        canInherit
        canWriteSettings
        {...props}
      />,
    );
  });
};
const trigger = () =>
  renderer!.root.find(
    (node) => typeof node.type === "string" && node.props["data-permission-source"] !== undefined,
  );

it("names the chip for assistive tech and in a tooltip, and tells the two sources apart by icon", async () => {
  await render({ permissions: permissions("inherit") });
  expect(trigger().props["aria-label"]).toBe(
    "Permissions: Inherited. Uses Claude's own permission settings",
  );
  expect(text(renderer!.root.findAllByProps({ role: "tooltip" })[0]!)).toBe(
    "Inherited: Uses Claude's own permission settings",
  );
  const inheritedIcon = trigger().findByType("svg").props.className as string;
  await render({ permissions: permissions("override") });
  expect(trigger().props["aria-label"]).toBe("Permissions: Overridden. Set for this chat: Manual");
  expect(text(renderer!.root.findAllByProps({ role: "tooltip" })[0]!)).toBe(
    "Overridden: Set for this chat: Manual",
  );
  const overriddenIcon = trigger().findByType("svg").props.className as string;
  expect(inheritedIcon).toContain("lucide-shield-check");
  expect(overriddenIcon).toContain("lucide-shield-user");
});

it("explains Codex's raw running policy in a tooltip on the value", async () => {
  await render({
    permissions: {
      ...permissions("override"),
      driver: ProviderDriverKind.make("codex"),
      rows: [
        {
          id: "active",
          kind: "active",
          label: "Running now",
          value: "untrusted",
          nativeValue: "untrusted",
          origin: "provider-session",
        },
      ],
    },
  });
  const hint =
    "untrusted is Codex's own name for its approval policy: it asks before commands it does not trust.";
  const value = renderer!.root.find(
    (node) => typeof node.type === "string" && node.props["aria-description"] === hint,
  );
  expect(text(value)).toBe("untrusted");
  expect(value.props.tabIndex).toBe(0);
  expect(renderer!.root.findAllByProps({ role: "tooltip" }).map(text)).toContain(hint);
});

it("shows a change still on its way as the new source with a saving note", async () => {
  await render({ permissions: permissions("override"), changeSaving: true });
  expect(trigger().props["aria-label"]).toBe("Permissions: Overridden. Set for this chat: Manual");
  expect(text(renderer!.root.findByProps({ role: "status" }))).toBe("Saving this change…");
});

it("says what runs until a waiting change applies, and asks the server to stop and apply", async () => {
  const onStopAndApply = vi.fn();
  await render({
    permissions: permissions("override"),
    runActive: true,
    changePending: true,
    pendingRunning: { permissionSource: "override", runtimeMode: "auto-accept-edits" },
    onStopAndApply,
  });
  const status = renderer!.root.findByProps({ role: "status" });
  expect(text(status)).toContain("Applies after this run stops");
  expect(text(status)).toContain("Until then it runs as Accept edits.");
  const stop = status.findAll(
    (node) => node.type === "button" && text(node) === "Stop and apply now",
  )[0]!;
  await act(async () => stop.props.onClick());
  expect(onStopAndApply).toHaveBeenCalledTimes(1);
});
